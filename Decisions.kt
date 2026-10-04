package expo.modules.nudgealarm

import android.app.AlarmManager
import android.app.Notification
import android.app.PendingIntent
import android.app.RemoteInput
import android.content.Context
import android.content.Intent
import android.graphics.drawable.Icon
import android.os.Build
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale
import java.util.TimeZone
import java.util.UUID

object Decisions {
  const val KEY_REPLY = "nudge_reply"
  const val ACTION_RETRY = "expo.modules.nudgealarm.RETRY"
  private var lastKey = ""
  private var lastAt = 0L

  // "4 October 2026, 10:05 PM"
  fun stamp(ms: Long): String = SimpleDateFormat("d MMMM yyyy, h:mm a", Locale.US).format(Date(ms))

  private fun buildMessage(name: String, activity: String, decision: String, custom: String?, snoozeMin: Int, ts: Long): String {
    val st = stamp(ts)
    val act = activity.trim().ifEmpty { "doing $name" }
    return when (decision) {
      "custom" -> "${custom?.trim().orEmpty()} — $st"
      "going" -> "I'm $act now — $st."
      "not_going" -> "I'm not $act today — $st."
      else -> "I'm snoozing $name for $snoozeMin minutes — $st."
    }
  }

  /**
   * Called when the user answers on the alarm screen or the notification.
   * Stores the answer (pending), stops the alarm / chain, starts a snooze if needed. Fast, main-thread safe.
   * Returns the stored item to upload, or null (duplicate tap / test alarm).
   */
  fun handle(c: Context, habitId: String, name: String, decision: String, snoozeMin: Int, repeatSec: Int, custom: String? = null): JSONObject? {
    val now = System.currentTimeMillis()
    val key = habitId + decision + (custom ?: "")
    if (key == lastKey && now - lastAt < 8000) return null
    lastKey = key; lastAt = now
    Scheduler.cancelChain(c, habitId)
    if (decision == "snoozed") {
      Scheduler.scheduleChain(c, habitId, name, repeatSec, snoozeMin, 0, now + snoozeMin * 60000L)
    }
    AlarmService.stopFor(c, habitId)
    if (habitId == AlarmService.TEST_ID) return null

    val meta = Store.getMeta(c, habitId)
    val o = JSONObject()
    o.put("id", UUID.randomUUID().toString())
    o.put("habitId", habitId)
    o.put("habitName", name)
    o.put("decision", decision)
    o.put("ts", now)
    o.put("message", buildMessage(name, meta?.optString("activity") ?: "", decision, custom, snoozeMin, now))
    o.put("chatUrl", meta?.optString("chatUrl") ?: "")
    Store.addPending(c, o)
    return o
  }

  /** Blocking (call from a background thread). True = stored in Supabase. Failure = stays saved, retried later. */
  fun upload(c: Context, o: JSONObject): Boolean {
    if (o.optBoolean("up")) return true
    if (o.optString("chatUrl").isEmpty() || Store.sbUrl(c).isEmpty()) return false
    val ok = Uploader.insert(c, o)
    if (ok) Store.markUp(c, o.optString("id")) else scheduleRetry(c)
    return ok
  }

  /** Upload everything still waiting. Returns how many remain. */
  fun flushAll(c: Context): Int {
    var left = 0
    for (o in Store.pendingList(c)) {
      if (o.optBoolean("up") || o.optString("chatUrl").isEmpty()) continue
      if (Uploader.insert(c, o)) Store.markUp(c, o.optString("id")) else left++
    }
    return left
  }

  fun scheduleRetry(c: Context) {
    val n = Store.retryCount(c)
    if (n >= 12) return
    Store.setRetryCount(c, n + 1)
    val mins = minOf(30, 1 shl minOf(n, 5))
    val i = Intent(c, AlarmReceiver::class.java).setAction(ACTION_RETRY)
    val pi = PendingIntent.getBroadcast(c, 9001, i, PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE)
    try {
      (c.getSystemService(Context.ALARM_SERVICE) as AlarmManager)
        .setAndAllowWhileIdle(AlarmManager.RTC_WAKEUP, System.currentTimeMillis() + mins * 60000L, pi)
    } catch (e: Exception) { }
  }

  /** Notification action with an inline text box. Typed text arrives in AlarmActivity as decision "custom". */
  fun replyAction(c: Context, habitId: String, name: String, repeatSec: Int, snoozeMin: Int, base: Int): Notification.Action {
    val i = Intent(c, AlarmActivity::class.java)
    i.putExtra("habitId", habitId); i.putExtra("name", name)
    i.putExtra("repeatSec", repeatSec); i.putExtra("snoozeMin", snoozeMin)
    i.putExtra("decision", "custom")
    i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP)
    val flags = PendingIntent.FLAG_UPDATE_CURRENT or (if (Build.VERSION.SDK_INT >= 31) PendingIntent.FLAG_MUTABLE else 0)
    val pi = PendingIntent.getActivity(c, base + 4, i, flags)
    val ri = RemoteInput.Builder(KEY_REPLY).setLabel("Type your answer").build()
    return Notification.Action.Builder(Icon.createWithResource(c, android.R.drawable.ic_menu_edit), "TYPE ANSWER", pi)
      .addRemoteInput(ri).build()
  }

  fun openApp(c: Context) {
    val launch = c.packageManager.getLaunchIntentForPackage(c.packageName) ?: return
    launch.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_RESET_TASK_IF_NEEDED)
    try { c.startActivity(launch) } catch (e: Exception) { }
  }
}

/** Plain HTTPS calls to Supabase (no libraries). Idempotent: same id can never create a second row. */
object Uploader {
  private fun call(method: String, url: String, headers: Map<String, String>, body: String?): Pair<Int, String> {
    val con = URL(url).openConnection() as HttpURLConnection
    return try {
      con.requestMethod = method
      con.connectTimeout = 6000
      con.readTimeout = 8000
      for ((k, v) in headers) con.setRequestProperty(k, v)
      if (body != null) {
        con.doOutput = true
        OutputStreamWriter(con.outputStream, Charsets.UTF_8).use { it.write(body) }
      }
      val code = con.responseCode
      val stream = if (code >= 400) con.errorStream else con.inputStream
      val text = try { stream?.bufferedReader()?.readText() ?: "" } catch (e: Exception) { "" }
      Pair(code, text)
    } finally { con.disconnect() }
  }

  private fun token(c: Context, force: Boolean): String? {
    val now = System.currentTimeMillis()
    val t = Store.token(c)
    if (!force && t.isNotEmpty() && Store.tokenExp(c) - now > 30000) return t
    val email = Store.sbEmail(c); val pw = Store.sbPw(c)
    if (email.isNotEmpty() && pw.isNotEmpty()) {
      try {
        val body = JSONObject().put("email", email).put("password", pw).toString()
        val (code, text) = call("POST", "${Store.sbUrl(c)}/auth/v1/token?grant_type=password",
          mapOf("apikey" to Store.sbKey(c), "Content-Type" to "application/json"), body)
        if (code in 200..299) {
          val j = JSONObject(text)
          val at = j.getString("access_token")
          Store.setToken(c, at, now + j.optLong("expires_in", 3600L) * 1000L)
          return at
        }
      } catch (e: Exception) { }
    }
    return if (!force && t.isNotEmpty() && Store.tokenExp(c) > now) t else null
  }

  private fun iso(ms: Long): String {
    val f = SimpleDateFormat("yyyy-MM-dd'T'HH:mm:ss.SSS'Z'", Locale.US)
    f.timeZone = TimeZone.getTimeZone("UTC")
    return f.format(Date(ms))
  }

  private fun post(c: Context, token: String, o: JSONObject, decision: String): Pair<Int, String> {
    val row = JSONObject()
    row.put("id", o.optString("id"))
    row.put("habit_id", o.optString("habitId"))
    row.put("habit_name", o.optString("habitName"))
    row.put("decision", decision)
    row.put("message", o.optString("message"))
    row.put("chat_url", o.optString("chatUrl"))
    row.put("decided_at", iso(o.optLong("ts")))
    return call("POST", "${Store.sbUrl(c)}/rest/v1/decisions?on_conflict=id",
      mapOf(
        "apikey" to Store.sbKey(c), "Authorization" to "Bearer $token",
        "Content-Type" to "application/json", "Prefer" to "resolution=ignore-duplicates,return=minimal",
      ), row.toString())
  }

  fun insert(c: Context, o: JSONObject): Boolean {
    if (Store.sbUrl(c).isEmpty() || Store.sbKey(c).isEmpty()) return false
    for (attempt in 0..1) {
      try {
        val t = token(c, attempt > 0) ?: return false
        val dec = o.optString("decision")
        var r = post(c, t, o, dec)
        // if the table only allows going/not_going/snoozed, store a typed answer as "going" (message text is what counts)
        if (r.first == 400 && dec == "custom" && r.second.contains("23514")) r = post(c, t, o, "going")
        if (r.first in 200..299 || r.first == 409) return true
        if (r.first == 401 && attempt == 0) continue
        return false
      } catch (e: Exception) { return false }
    }
    return false
  }
}
