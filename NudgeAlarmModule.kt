package expo.modules.nudgealarm

import android.app.AlarmManager
import android.app.NotificationManager
import android.content.Context
import android.content.Intent
import android.media.MediaPlayer
import android.net.Uri
import android.os.Build
import android.os.PowerManager
import android.provider.Settings
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

class NudgeAlarmModule : Module() {
  private fun ctx(): Context = appContext.reactContext ?: throw IllegalStateException("React context unavailable")

  override fun definition() = ModuleDefinition {
    Name("NudgeAlarm")

    Function("setSchedule") { json: String ->
      Scheduler.applyAll(ctx(), json)
      true
    }

    Function("stop") { habitId: String ->
      Scheduler.cancelChain(ctx(), habitId)
      AlarmService.stopFor(ctx(), habitId)
      true
    }

    Function("snooze") { habitId: String, name: String, atMs: Double, repeatSec: Int, snoozeMin: Int ->
      Scheduler.scheduleChain(ctx(), habitId, name, repeatSec, snoozeMin, 0, atMs.toLong())
      true
    }

    Function("getPending") { ->
      Store.pending(ctx())
    }

    Function("ackPending") { idsJson: String ->
      val arr = JSONArray(idsJson)
      val ids = HashSet<String>()
      for (i in 0 until arr.length()) ids.add(arr.getString(i))
      Store.ack(ctx(), ids)
      true
    }

    AsyncFunction("setSound") { uri: String, name: String ->
      val c = ctx()
      val target = Store.soundFile(c)
      val tmp = File(c.filesDir, "alarm_tone.tmp")
      val input = c.contentResolver.openInputStream(Uri.parse(uri)) ?: throw IllegalArgumentException("Cannot open that file")
      input.use { ins -> tmp.outputStream().use { out -> ins.copyTo(out) } }
      try {
        val mp = MediaPlayer()
        mp.setDataSource(tmp.absolutePath)
        mp.prepare()
        mp.release()
      } catch (e: Exception) {
        tmp.delete()
        throw IllegalArgumentException("That file is not a playable audio file")
      }
      if (target.exists()) target.delete()
      tmp.renameTo(target)
      Store.setSoundName(c, name)
      name
    }

    Function("clearSound") { ->
      val c = ctx()
      val f = Store.soundFile(c)
      if (f.exists()) f.delete()
      Store.setSoundName(c, "")
      true
    }

    Function("getSoundName") { ->
      val c = ctx()
      if (Store.soundFile(c).exists()) Store.soundName(c) else ""
    }

    Function("testAlarm") { delayMs: Double ->
      val c = ctx()
      if (delayMs <= 0) {
        val i = Intent(c, AlarmService::class.java)
        i.putExtra("habitId", AlarmService.TEST_ID)
        i.putExtra("name", "Test alarm")
        i.putExtra("test", true)
        if (Build.VERSION.SDK_INT >= 26) c.startForegroundService(i) else c.startService(i)
      } else {
        Scheduler.scheduleChain(c, AlarmService.TEST_ID, "Test alarm", 60, 15, 0, System.currentTimeMillis() + delayMs.toLong())
      }
      true
    }

    Function("status") { ->
      val c = ctx()
      val o = JSONObject()
      val am = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager
      val nm = c.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
      val pm = c.getSystemService(Context.POWER_SERVICE) as PowerManager
      o.put("exact", if (Build.VERSION.SDK_INT >= 31) am.canScheduleExactAlarms() else true)
      o.put("fullScreen", if (Build.VERSION.SDK_INT >= 34) nm.canUseFullScreenIntent() else true)
      o.put("notifications", nm.areNotificationsEnabled())
      o.put("battery", pm.isIgnoringBatteryOptimizations(c.packageName))
      o.toString()
    }

    Function("openSettings") { kind: String ->
      val c = ctx()
      val pkg = c.packageName
      val uri = Uri.parse("package:$pkg")
      val primary: Intent = when (kind) {
        "fullscreen" -> if (Build.VERSION.SDK_INT >= 34) Intent(Settings.ACTION_MANAGE_APP_USE_FULL_SCREEN_INTENT, uri) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
        "exact" -> if (Build.VERSION.SDK_INT >= 31) Intent(Settings.ACTION_REQUEST_SCHEDULE_EXACT_ALARM, uri) else Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
        "battery" -> Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS, uri)
        "notifications" -> Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, pkg)
        else -> Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
      }
      primary.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        c.startActivity(primary)
      } catch (e: Exception) {
        val fallback = Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, uri)
        fallback.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        try { c.startActivity(fallback) } catch (e2: Exception) { }
      }
      true
    }
  }
}
