package expo.modules.nudgealarm

import android.app.AlarmManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import org.json.JSONArray
import org.json.JSONObject

object Scheduler {
  const val ACTION_FIRE = "expo.modules.nudgealarm.FIRE"

  private fun dayCode(habitId: String, at: Long): Int = ("$habitId|$at").hashCode() and 0x3fffffff
  private fun chainCode(habitId: String): Int = (habitId.hashCode() and 0x3fffffff) or 0x40000000

  private fun am(c: Context) = c.getSystemService(Context.ALARM_SERVICE) as AlarmManager

  private fun fireIntent(c: Context): Intent = Intent(c, AlarmReceiver::class.java).setAction(ACTION_FIRE)

  private fun showPi(c: Context): PendingIntent {
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: Intent(c, AlarmActivity::class.java)
    return PendingIntent.getActivity(c, 7, launch, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
  }

  private fun setExact(c: Context, at: Long, code: Int, o: JSONObject, chain: Int) {
    val i = fireIntent(c)
    i.putExtra("habitId", o.optString("habitId"))
    i.putExtra("name", o.optString("name"))
    i.putExtra("repeatSec", o.optInt("repeatSec", 300))
    i.putExtra("snoozeMin", o.optInt("snoozeMin", 15))
    i.putExtra("chain", chain)
    val pi = PendingIntent.getBroadcast(c, code, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    val manager = am(c)
    try {
      manager.setAlarmClock(AlarmManager.AlarmClockInfo(at, showPi(c)), pi)
    } catch (e: SecurityException) {
      manager.setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, at, pi)
    }
  }

  private fun cancelCode(c: Context, code: Int) {
    val pi = PendingIntent.getBroadcast(c, code, fireIntent(c), PendingIntent.FLAG_NO_CREATE or PendingIntent.FLAG_IMMUTABLE)
    if (pi != null) { am(c).cancel(pi); pi.cancel() }
  }

  /** Replace every scheduled day alarm with the list JS sends: [{habitId,name,at,repeatSec,snoozeMin}] */
  @Synchronized fun applyAll(c: Context, json: String) {
    val old = Store.getSchedule(c)
    for (i in 0 until old.length()) cancelCode(c, old.getJSONObject(i).optInt("code"))
    val arr = JSONArray(json)
    val saved = JSONArray()
    val now = System.currentTimeMillis()
    for (i in 0 until arr.length()) {
      val o = arr.getJSONObject(i)
      val at = o.optLong("at")
      if (at <= now + 500) continue
      val code = dayCode(o.optString("habitId"), at)
      o.put("code", code)
      setExact(c, at, code, o, 0)
      saved.put(o)
    }
    Store.saveSchedule(c, saved)
  }

  /** The next ring of a "keep reminding until answered" chain. */
  @Synchronized fun scheduleChain(c: Context, habitId: String, name: String, repeatSec: Int, snoozeMin: Int, chain: Int, at: Long) {
    val o = JSONObject()
    o.put("habitId", habitId); o.put("name", name); o.put("repeatSec", repeatSec); o.put("snoozeMin", snoozeMin)
    o.put("at", at); o.put("chain", chain)
    Store.putChain(c, habitId, o)
    setExact(c, at, chainCode(habitId), o, chain)
  }

  @Synchronized fun cancelChain(c: Context, habitId: String) {
    cancelCode(c, chainCode(habitId))
    Store.removeChain(c, habitId)
  }

  /** After reboot / app update / clock change. */
  @Synchronized fun restore(c: Context) {
    val now = System.currentTimeMillis()
    val sched = Store.getSchedule(c)
    for (i in 0 until sched.length()) {
      val o = sched.getJSONObject(i)
      val at = o.optLong("at")
      if (at > now + 500) setExact(c, at, o.optInt("code"), o, 0)
    }
    val chains = Store.getChains(c)
    val keys = chains.keys()
    while (keys.hasNext()) {
      val k = keys.next()
      val o = chains.getJSONObject(k)
      val at = o.optLong("at")
      if (at > now + 500) setExact(c, at, chainCode(k), o, o.optInt("chain"))
    }
  }
}
.
