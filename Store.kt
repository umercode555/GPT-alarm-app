package expo.modules.nudgealarm

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject
import java.io.File

object Store {
  private const val PREFS = "nudge_alarm"

  private fun prefs(c: Context) = c.getSharedPreferences(PREFS, Context.MODE_PRIVATE)

  fun soundFile(c: Context): File = File(c.filesDir, "alarm_tone")
  fun soundName(c: Context): String = prefs(c).getString("soundName", "") ?: ""
  fun setSoundName(c: Context, n: String) { prefs(c).edit().putString("soundName", n).commit() }

  // ---- scheduled day alarms (restored after reboot) ----
  @Synchronized fun getSchedule(c: Context): JSONArray =
    try { JSONArray(prefs(c).getString("schedule", "[]")) } catch (e: Exception) { JSONArray() }
  @Synchronized fun saveSchedule(c: Context, a: JSONArray) { prefs(c).edit().putString("schedule", a.toString()).commit() }

  // ---- active "keep ringing" chains, one per habit ----
  @Synchronized fun getChains(c: Context): JSONObject =
    try { JSONObject(prefs(c).getString("chains", "{}")) } catch (e: Exception) { JSONObject() }
  @Synchronized fun putChain(c: Context, habitId: String, o: JSONObject) {
    val all = getChains(c); all.put(habitId, o); prefs(c).edit().putString("chains", all.toString()).commit()
  }
  @Synchronized fun removeChain(c: Context, habitId: String) {
    val all = getChains(c); all.remove(habitId); prefs(c).edit().putString("chains", all.toString()).commit()
  }

  // ---- decisions made natively (alarm screen / notification buttons), uploaded later by JS ----
  @Synchronized fun addPending(c: Context, o: JSONObject) {
    val a = pendingArray(c); a.put(o); prefs(c).edit().putString("pending", a.toString()).commit()
  }
  @Synchronized fun pending(c: Context): String = pendingArray(c).toString()
  @Synchronized fun ack(c: Context, ids: Set<String>) {
    val a = pendingArray(c); val keep = JSONArray()
    for (i in 0 until a.length()) {
      val o = a.getJSONObject(i)
      if (!ids.contains(o.optString("id"))) keep.put(o)
    }
    prefs(c).edit().putString("pending", keep.toString()).commit()
  }
  private fun pendingArray(c: Context): JSONArray =
    try { JSONArray(prefs(c).getString("pending", "[]")) } catch (e: Exception) { JSONArray() }
}
