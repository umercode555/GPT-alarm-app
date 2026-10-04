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

  // ---- habit info needed to build + upload a message natively (activity text, chat url) ----
  @Synchronized fun putMeta(c: Context, habitId: String, activity: String, chatUrl: String) {
    val all = try { JSONObject(prefs(c).getString("meta", "{}")) } catch (e: Exception) { JSONObject() }
    val o = JSONObject(); o.put("activity", activity); o.put("chatUrl", chatUrl)
    all.put(habitId, o)
    prefs(c).edit().putString("meta", all.toString()).commit()
  }
  @Synchronized fun getMeta(c: Context, habitId: String): JSONObject? =
    try { JSONObject(prefs(c).getString("meta", "{}")).optJSONObject(habitId) } catch (e: Exception) { null }

  // ---- Supabase credentials for native upload (sent by JS after sign-in) ----
  @Synchronized fun setAuth(c: Context, url: String, key: String, email: String, pw: String) {
    prefs(c).edit().putString("sb_url", url.trim().trimEnd('/')).putString("sb_key", key.trim())
      .putString("sb_email", email.trim()).putString("sb_pw", pw)
      .remove("sb_token").remove("sb_exp").commit()
  }
  fun sbUrl(c: Context): String = prefs(c).getString("sb_url", "") ?: ""
  fun sbKey(c: Context): String = prefs(c).getString("sb_key", "") ?: ""
  fun sbEmail(c: Context): String = prefs(c).getString("sb_email", "") ?: ""
  fun sbPw(c: Context): String = prefs(c).getString("sb_pw", "") ?: ""
  fun token(c: Context): String = prefs(c).getString("sb_token", "") ?: ""
  fun tokenExp(c: Context): Long = prefs(c).getLong("sb_exp", 0L)
  @Synchronized fun setToken(c: Context, t: String, exp: Long) { prefs(c).edit().putString("sb_token", t).putLong("sb_exp", exp).commit() }

  // ---- upload retry counter ----
  fun retryCount(c: Context): Int = prefs(c).getInt("retry_n", 0)
  fun setRetryCount(c: Context, n: Int) { prefs(c).edit().putInt("retry_n", n).commit() }

  // ---- decisions made natively (alarm screen / notification), uploaded natively or later by JS ----
  @Synchronized fun addPending(c: Context, o: JSONObject) {
    val a = pendingArray(c); a.put(o); prefs(c).edit().putString("pending", a.toString()).commit()
  }
  @Synchronized fun pending(c: Context): String = pendingArray(c).toString()
  @Synchronized fun pendingList(c: Context): List<JSONObject> {
    val a = pendingArray(c); val l = ArrayList<JSONObject>()
    for (i in 0 until a.length()) l.add(a.getJSONObject(i))
    return l
  }
  /** Mark an item as already stored in Supabase (JS still reads it once for snooze bookkeeping, then acks). */
  @Synchronized fun markUp(c: Context, id: String) {
    val a = pendingArray(c)
    for (i in 0 until a.length()) { val o = a.getJSONObject(i); if (o.optString("id") == id) o.put("up", true) }
    prefs(c).edit().putString("pending", a.toString()).commit()
  }
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
