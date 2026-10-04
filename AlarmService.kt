package expo.modules.nudgealarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.AudioAttributes
import android.media.MediaPlayer
import android.media.RingtoneManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager

class AlarmService : Service() {
  companion object {
    const val CHANNEL = "nudge_alarm_v1"
    const val TEST_ID = "__test__"
    @Volatile var instance: AlarmService? = null

    fun notifId(habitId: String): Int = 1000 + (habitId.hashCode() and 0xffff)

    fun stopFor(c: Context, habitId: String) {
      val s = instance
      if (s != null && s.habitId == habitId) s.shutdown()
      val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      nm.cancel(notifId(habitId))
    }
  }

  private val handler = Handler(Looper.getMainLooper())
  private var player: MediaPlayer? = null
  private var wake: PowerManager.WakeLock? = null
  @Volatile var habitId: String = ""
  private var name: String = "Nudge"
  private var repeatSec = 300
  private var snoozeMin = 15

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    instance = this
    if (intent == null) { stopSelf(); return START_NOT_STICKY }

    // a different habit may already be ringing: silence it, this one takes over
    handler.removeCallbacksAndMessages(null)
    releaseMedia()

    habitId = intent.getStringExtra("habitId") ?: ""
    name = intent.getStringExtra("name") ?: "Nudge"
    repeatSec = intent.getIntExtra("repeatSec", 300).coerceAtLeast(60)
    snoozeMin = intent.getIntExtra("snoozeMin", 15)
    val chain = intent.getIntExtra("chain", 0)
    val isTest = intent.getBooleanExtra("test", false) || habitId == TEST_ID

    createChannel()
    val n = ringingNotification()
    try {
      if (Build.VERSION.SDK_INT >= 29) {
        startForeground(notifId(habitId), n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
      } else {
        startForeground(notifId(habitId), n)
      }
    } catch (e: Exception) {
      try { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(notifId(habitId), n) } catch (e2: Exception) { }
    }

    val ringSec = if (isTest) 30 else minOf(60, repeatSec)
    acquireWake(ringSec * 1000L + 5000L)
    startSound()
    vibrate(true)

    // schedule the next reminder right away (survives process death); answering cancels it
    if (!isTest) {
      val maxChain = (7200 / repeatSec).coerceIn(6, 30)
      if (chain + 1 < maxChain) {
        Scheduler.scheduleChain(this, habitId, name, repeatSec, snoozeMin, chain + 1, System.currentTimeMillis() + repeatSec * 1000L)
      }
    }

    handler.postDelayed({ onRingTimeout() }, ringSec * 1000L)
    return START_NOT_STICKY
  }

  private fun onRingTimeout() {
    releaseMedia()
    vibrate(false)
    try {
      stopForeground(Service.STOP_FOREGROUND_DETACH)
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(notifId(habitId), missedNotification())
    } catch (e: Exception) { }
    stopSelf()
  }

  fun shutdown() {
    handler.removeCallbacksAndMessages(null)
    releaseMedia()
    vibrate(false)
    try { stopForeground(Service.STOP_FOREGROUND_REMOVE) } catch (e: Exception) { }
    try { (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).cancel(notifId(habitId)) } catch (e: Exception) { }
    habitId = ""
    stopSelf()
  }

  override fun onDestroy() {
    handler.removeCallbacksAndMessages(null)
    releaseMedia()
    vibrate(false)
    if (instance === this) instance = null
    super.onDestroy()
  }

  // ---------------------------------------------------------------- sound
  private fun startSound() {
    val f = Store.soundFile(this)
    val attrs = AudioAttributes.Builder()
      .setUsage(AudioAttributes.USAGE_ALARM)
      .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC)
      .build()
    var mp: MediaPlayer? = null
    if (f.exists() && f.length() > 0) {
      try {
        mp = MediaPlayer()
        mp.setAudioAttributes(attrs)
        mp.setDataSource(f.absolutePath)
        mp.isLooping = true
        mp.prepare()
      } catch (e: Exception) { try { mp?.release() } catch (e2: Exception) { }; mp = null }
    }
    if (mp == null) {
      try {
        mp = MediaPlayer()
        mp.setAudioAttributes(attrs)
        mp.setDataSource(this, defaultTone())
        mp.isLooping = true
        mp.prepare()
      } catch (e: Exception) { try { mp?.release() } catch (e2: Exception) { }; mp = null }
    }
    try { mp?.start() } catch (e: Exception) { }
    player = mp
  }

  private fun defaultTone(): Uri =
    RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_NOTIFICATION)
      ?: RingtoneManager.getDefaultUri(RingtoneManager.TYPE_RINGTONE)

  private fun releaseMedia() {
    try { player?.stop() } catch (e: Exception) { }
    try { player?.release() } catch (e: Exception) { }
    player = null
    try { if (wake?.isHeld == true) wake?.release() } catch (e: Exception) { }
    wake = null
  }

  private fun acquireWake(ms: Long) {
    try {
      val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
      wake = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "nudge:alarm")
      wake?.acquire(ms)
    } catch (e: Exception) { }
  }

  @Suppress("DEPRECATION")
  private fun vibrate(on: Boolean) {
    try {
      val v: Vibrator = if (Build.VERSION.SDK_INT >= 31) {
        (getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
      } else {
        getSystemService(Context.VIBRATOR_SERVICE) as Vibrator
      }
      if (!on) { v.cancel(); return }
      val pattern = longArrayOf(0, 700, 500)
      if (Build.VERSION.SDK_INT >= 26) v.vibrate(VibrationEffect.createWaveform(pattern, 0)) else v.vibrate(pattern, 0)
    } catch (e: Exception) { }
  }

  // ---------------------------------------------------------------- notifications
  private fun createChannel() {
    if (Build.VERSION.SDK_INT >= 26) {
      val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      if (nm.getNotificationChannel(CHANNEL) == null) {
        val ch = NotificationChannel(CHANNEL, "Habit alarms", NotificationManager.IMPORTANCE_HIGH)
        ch.description = "Rings until you answer"
        ch.setSound(null, null)
        ch.enableVibration(false)
        ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
        nm.createNotificationChannel(ch)
      }
    }
  }

  private fun builder(): Notification.Builder =
    if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)

  private fun activityPi(slot: Int, decision: String?): PendingIntent {
    val i = Intent(this, AlarmActivity::class.java)
    i.putExtra("habitId", habitId)
    i.putExtra("name", name)
    i.putExtra("repeatSec", repeatSec)
    i.putExtra("snoozeMin", snoozeMin)
    if (decision != null) i.putExtra("decision", decision)
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    return PendingIntent.getActivity(this, notifId(habitId) * 10 + slot, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  @Suppress("DEPRECATION")
  private fun withActions(b: Notification.Builder): Notification.Builder {
    val icon = android.R.drawable.ic_lock_idle_alarm
    b.addAction(icon, "I'M GOING", activityPi(1, "going"))
    b.addAction(icon, "I'M NOT GOING", activityPi(2, "not_going"))
    b.addAction(icon, "SNOOZE", activityPi(3, "snoozed"))
    return b
  }

  private fun ringingNotification(): Notification {
    val ui = activityPi(0, null)
    val b = builder()
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(name)
      .setContentText("Time for $name — are you going?")
      .setCategory(Notification.CATEGORY_ALARM)
      .setPriority(Notification.PRIORITY_MAX)
      .setOngoing(true)
      .setAutoCancel(false)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(ui)
      .setFullScreenIntent(ui, true)
    return withActions(b).build()
  }

  private fun missedNotification(): Notification {
    val ui = activityPi(0, null)
    val b = builder()
      .setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(name)
      .setContentText("Still waiting for your answer — I'll remind you again.")
      .setCategory(Notification.CATEGORY_REMINDER)
      .setPriority(Notification.PRIORITY_HIGH)
      .setOngoing(false)
      .setAutoCancel(false)
      .setOnlyAlertOnce(true)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(ui)
    return withActions(b).build()
  }
}
