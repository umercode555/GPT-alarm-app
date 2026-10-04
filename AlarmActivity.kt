package expo.modules.nudgealarm

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import android.widget.Toast
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AlarmActivity : Activity() {
  private var habitId = ""
  private var habitName = "Nudge"
  private var repeatSec = 300
  private var snoozeMin = 15
  private var busy = false
  private val ui = Handler(Looper.getMainLooper())
  private var input: EditText? = null

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    readExtras(intent)
    setupWindow()
    if (!handleIntent(intent)) showScreen()
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    if (intent == null) return
    setIntent(intent)
    readExtras(intent)
    handleIntent(intent)
  }

  override fun onDestroy() {
    ui.removeCallbacksAndMessages(null)
    super.onDestroy()
  }

  private fun readExtras(i: Intent?) {
    if (i == null) return
    habitId = i.getStringExtra("habitId") ?: habitId
    habitName = i.getStringExtra("name") ?: habitName
    repeatSec = i.getIntExtra("repeatSec", repeatSec)
    snoozeMin = i.getIntExtra("snoozeMin", snoozeMin)
  }

  /** true = this intent carried an answer (button on the notification, or typed text from the notification) */
  private fun handleIntent(i: Intent): Boolean {
    val d = i.getStringExtra("decision") ?: return false
    if (d == "custom") {
      val txt = RemoteInput.getResultsFromIntent(i)?.getCharSequence(Decisions.KEY_REPLY)?.toString()?.trim().orEmpty()
      if (txt.isEmpty()) return false
      act("custom", txt)
    } else act(d, null)
    return true
  }

  private fun act(decision: String, custom: String?) {
    if (busy) return
    busy = true
    showStatus("#2B2B45", "…", "Sending…", habitName)
    val item = Decisions.handle(this, habitId, habitName, decision, snoozeMin, repeatSec, custom)
    val app = applicationContext
    Thread {
      val ok = try { if (item == null) true else Decisions.upload(app, item) } catch (e: Exception) { false }
      ui.post {
        if (isFinishing || isDestroyed) return@post
        val msg = item?.optString("message") ?: ""
        val title = when {
          !ok -> "Saved on your phone"
          decision == "snoozed" -> "Snoozed $snoozeMin min"
          else -> "Message sent to your laptop"
        }
        val sub = when {
          !ok -> "It will be sent automatically when you are online.\n\n$msg"
          decision == "snoozed" -> "Message sent to your laptop.\n\n$msg"
          else -> msg
        }
        showStatus("#17A05D", "✓", title, sub)
        ui.postDelayed({ finish() }, 2400)
      }
    }.start()
  }

  @Suppress("DEPRECATION")
  private fun setupWindow() {
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
    window.setSoftInputMode(WindowManager.LayoutParams.SOFT_INPUT_ADJUST_RESIZE)
  }

  private fun showStatus(bg: String, icon: String, title: String, sub: String) {
    input = null
    val root = LinearLayout(this)
    root.orientation = LinearLayout.VERTICAL
    root.gravity = Gravity.CENTER
    root.setBackgroundColor(Color.parseColor(bg))
    root.setPadding(dp(28), dp(40), dp(28), dp(40))
    root.addView(label(icon, 88f, "#FFFFFF", true, 0))
    root.addView(label(title, 26f, "#FFFFFF", true, 12))
    if (sub.isNotEmpty()) root.addView(label(sub, 16f, "#E8FFF3", false, 14))
    setContentView(root)
  }

  private fun showScreen() {
    val root = LinearLayout(this)
    root.orientation = LinearLayout.VERTICAL
    root.gravity = Gravity.CENTER_HORIZONTAL
    root.setBackgroundColor(Color.parseColor("#14141F"))
    root.setPadding(dp(24), dp(72), dp(24), dp(32))

    root.addView(label("NUDGE", 13f, "#8E8EF0", true, 0))
    root.addView(label(habitName, 34f, "#FFFFFF", true, 8))
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date())
    root.addView(label("It's $time — are you going?", 16f, "#9A9AB5", false, 8))

    val spacer = View(this)
    spacer.layoutParams = LinearLayout.LayoutParams(0, 0, 1f)
    root.addView(spacer)

    root.addView(button("I'M GOING", "#1E9E63") { act("going", null) })
    root.addView(button("I'M NOT GOING", "#D64545") { act("not_going", null) })
    root.addView(button("SNOOZE $snoozeMin MIN", "#C27A06") { act("snoozed", null) })

    // 4th option: type your own answer
    val et = EditText(this)
    et.hint = "Or type your own answer…"
    et.setHintTextColor(Color.parseColor("#7C7C98"))
    et.setTextColor(Color.WHITE)
    et.textSize = 16f
    et.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE or InputType.TYPE_TEXT_FLAG_CAP_SENTENCES
    et.minLines = 2
    et.maxLines = 4
    et.gravity = Gravity.TOP or Gravity.START
    val bg = GradientDrawable()
    bg.setColor(Color.parseColor("#23233A"))
    bg.cornerRadius = dp(16).toFloat()
    bg.setStroke(dp(1), Color.parseColor("#3A3A5C"))
    et.background = bg
    et.setPadding(dp(16), dp(12), dp(16), dp(12))
    val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    lp.topMargin = dp(22)
    et.layoutParams = lp
    root.addView(et)
    input = et

    root.addView(button("SEND MY ANSWER", "#5B5BD6") {
      val t = et.text.toString().trim()
      if (t.isEmpty()) Toast.makeText(this, "Type your answer first", Toast.LENGTH_SHORT).show() else act("custom", t)
    })

    val sv = ScrollView(this)
    sv.isFillViewport = true
    sv.setBackgroundColor(Color.parseColor("#14141F"))
    sv.addView(root, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
    sv.setOnApplyWindowInsetsListener { _, ins ->
      @Suppress("DEPRECATION")
      val top = ins.systemWindowInsetTop
      @Suppress("DEPRECATION")
      val bottom = ins.systemWindowInsetBottom
      root.setPadding(dp(24), if (top > 0) top + dp(40) else dp(72), dp(24), dp(32) + bottom)
      ins
    }
    setContentView(sv)
  }

  private fun label(text: String, size: Float, color: String, bold: Boolean, topDp: Int): TextView {
    val t = TextView(this)
    t.text = text
    t.textSize = size
    t.setTextColor(Color.parseColor(color))
    t.gravity = Gravity.CENTER
    if (bold) t.setTypeface(null, Typeface.BOLD)
    val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT)
    lp.topMargin = dp(topDp)
    t.layoutParams = lp
    return t
  }

  private fun button(text: String, color: String, onClick: () -> Unit): Button {
    val b = Button(this)
    b.text = text
    b.textSize = 16f
    b.setTextColor(Color.WHITE)
    b.setTypeface(null, Typeface.BOLD)
    val g = GradientDrawable()
    g.setColor(Color.parseColor(color))
    g.cornerRadius = dp(18).toFloat()
    b.background = g
    val lp = LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, dp(62))
    lp.topMargin = dp(12)
    b.layoutParams = lp
    b.setOnClickListener { onClick() }
    return b
  }
}
