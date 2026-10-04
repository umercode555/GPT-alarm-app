package expo.modules.nudgealarm

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.RingtoneManager
import android.os.Build

class AlarmReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    if (intent.action == Decisions.ACTION_RETRY) {
      val pr = goAsync()
      Thread {
        try {
          val left = Decisions.flushAll(context)
          if (left > 0) Decisions.scheduleRetry(context) else Store.setRetryCount(context, 0)
        } catch (e: Exception) { } finally { pr.finish() }
      }.start()
      return
    }
    val i = Intent(context, AlarmService::class.java)
    i.putExtras(intent)
    try {
      if (Build.VERSION.SDK_INT >= 26) context.startForegroundService(i) else context.startService(i)
    } catch (e: Exception) {
      // Android refused to start the ringing service: fall back to an insistent full-screen alarm notification
      try { Fallback.notify(context, intent) } catch (e2: Exception) { }
    }
  }
}

class BootReceiver : BroadcastReceiver() {
  override fun onReceive(context: Context, intent: Intent) {
    try { Scheduler.restore(context) } catch (e: Exception) { }
    try { Decisions.scheduleRetry(context) } catch (e: Exception) { }
  }
}

object Fallback {
  private const val CH = "nudge_alarm_fb_v1"

  fun notify(c: Context, src: Intent) {
    val habitId = src.getStringExtra("habitId") ?: ""
    val name = src.getStringExtra("name") ?: "Nudge"
    val repeat = src.getIntExtra("repeatSec", 300).coerceAtLeast(60)
    val snooze = src.getIntExtra("snoozeMin", 15)
    val chain = src.getIntExtra("chain", 0)
    val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager

    if (Build.VERSION.SDK_INT >= 26 && nm.getNotificationChannel(CH) == null) {
      val ch = NotificationChannel(CH, "Habit alarms (backup)", NotificationManager.IMPORTANCE_HIGH)
      val attrs = AudioAttributes.Builder()
        .setUsage(AudioAttributes.USAGE_ALARM)
        .setContentType(AudioAttributes.CONTENT_TYPE_SONIFICATION)
        .build()
      ch.setSound(RingtoneManager.getDefaultUri(RingtoneManager.TYPE_ALARM), attrs)
      ch.enableVibration(true)
      ch.lockscreenVisibility = Notification.VISIBILITY_PUBLIC
      nm.createNotificationChannel(ch)
    }

    val base = AlarmService.notifId(habitId) * 10
    fun pi(slot: Int, decision: String?): PendingIntent {
      val a = Intent(c, AlarmActivity::class.java)
      a.putExtra("habitId", habitId); a.putExtra("name", name)
      a.putExtra("repeatSec", repeat); a.putExtra("snoozeMin", snooze)
      if (decision != null) a.putExtra("decision", decision)
      a.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
      return PendingIntent.getActivity(c, base + slot, a, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    val b = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(c, CH) else Notification.Builder(c)
    b.setSmallIcon(android.R.drawable.ic_lock_idle_alarm)
      .setContentTitle(name)
      .setContentText("Time for $name — are you going?")
      .setCategory(Notification.CATEGORY_ALARM)
      .setPriority(Notification.PRIORITY_MAX)
      .setVisibility(Notification.VISIBILITY_PUBLIC)
      .setContentIntent(pi(0, null))
      .setFullScreenIntent(pi(0, null), true)
    @Suppress("DEPRECATION")
    b.addAction(android.R.drawable.ic_lock_idle_alarm, "I'M GOING", pi(1, "going"))
    @Suppress("DEPRECATION")
    b.addAction(android.R.drawable.ic_lock_idle_alarm, "I'M NOT GOING", pi(2, "not_going"))
    b.addAction(Decisions.replyAction(c, habitId, name, repeat, snooze, base))
    val n = b.build()
    n.flags = n.flags or Notification.FLAG_INSISTENT or Notification.FLAG_NO_CLEAR
    nm.notify(AlarmService.notifId(habitId), n)

    if (habitId != AlarmService.TEST_ID) {
      val maxChain = (7200 / repeat).coerceIn(6, 30)
      if (chain + 1 < maxChain) {
        Scheduler.scheduleChain(c, habitId, name, repeat, snooze, chain + 1, System.currentTimeMillis() + repeat * 1000L)
      }
    }
  }
}
