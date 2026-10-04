package expo.modules.nudgealarm

import android.content.Context
import android.content.Intent
import org.json.JSONObject
import java.util.UUID

object Decisions {
  private var lastKey = ""
  private var lastAt = 0L

  /** Called when the user taps GOING / NOT GOING / SNOOZE on the alarm screen or the notification. */
  fun handle(c: Context, habitId: String, name: String, decision: String, snoozeMin: Int, repeatSec: Int) {
    val now = System.currentTimeMillis()
    val key = habitId + decision
    if (key == lastKey && now - lastAt < 8000) return
    lastKey = key; lastAt = now
    val o = JSONObject()
    o.put("id", UUID.randomUUID().toString())
    o.put("habitId", habitId)
    o.put("habitName", name)
    o.put("decision", decision)
    o.put("ts", now)
    Store.addPending(c, o)
    Scheduler.cancelChain(c, habitId)
    if (decision == "snoozed") {
      Scheduler.scheduleChain(c, habitId, name, repeatSec, snoozeMin, 0, now + snoozeMin * 60000L)
    }
    AlarmService.stopFor(c, habitId)
  }

  fun openApp(c: Context) {
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    try { c.startActivity(launch) } catch (e: Exception) { }
  }
}
