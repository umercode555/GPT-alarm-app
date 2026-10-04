package expo.modules.nudgealarm

import android.app.Activity
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.view.WindowManager
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

class AlarmActivity : Activity() {
  private var habitId = ""
  private var habitName = "Nudge"
  private var repeatSec = 300
  private var snoozeMin = 15

  private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

  override fun onCreate(savedInstanceState: Bundle?) {
    super.onCreate(savedInstanceState)
    readExtras(intent)
    val decision = intent?.getStringExtra("decision")
    if (decision != null) { act(decision); return }
    showScreen()
  }

  override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    if (intent == null) return
    setIntent(intent)
    readExtras(intent)
    val decision = intent.getStringExtra("decision")
    if (decision != null) act(decision)
  }

  private fun readExtras(i: Intent?) {
    if (i == null) return
    habitId = i.getStringExtra("habitId") ?: habitId
    habitName = i.getStringExtra("name") ?: habitName
    repeatSec = i.getIntExtra("repeatSec", repeatSec)
    snoozeMin = i.getIntExtra("snoozeMin", snoozeMin)
  }

  private fun act(decision: String) {
    Decisions.handle(this, habitId, habitName, decision, snoozeMin, repeatSec)
    Decisions.openApp(this)
    finish()
  }

  @Suppress("DEPRECATION")
  private fun showScreen() {
    if (Build.VERSION.SDK_INT >= 27) {
      setShowWhenLocked(true)
      setTurnScreenOn(true)
    } else {
      window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
    }
    window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)

    val root = LinearLayout(this)
    root.orientation = LinearLayout.VERTICAL
    root.gravity = Gravity.CENTER_HORIZONTAL
    root.setBackgroundColor(Color.parseColor("#14141F"))
    root.setPadding(dp(24), dp(96), dp(24), dp(40))

    root.addView(label("NUDGE", 13f, "#8E8EF0", true, 0))
    root.addView(label(habitName, 34f, "#FFFFFF", true, 8))
    val time = SimpleDateFormat("h:mm a", Locale.getDefault()).format(Date())
    root.addView(label("It's $time — are you going?", 16f, "#9A9AB5", false, 8))

    val spacer = View(this)
    spacer.layoutParams = LinearLayout.LayoutParams(0, 0, 1f)
    root.addView(spacer)

    root.addView(button("I'M GOING", "#1E9E63", "going"))
    root.addView(button("I'M NOT GOING", "#D64545", "not_going"))
    root.addView(button("SNOOZE $snoozeMin MIN", "#C27A06", "snoozed"))
    setContentView(root)
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

  private fun button(text: String, color: String, decision: String): Button {
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
    b.setOnClickListener { act(decision) }
    return b
  }
}
