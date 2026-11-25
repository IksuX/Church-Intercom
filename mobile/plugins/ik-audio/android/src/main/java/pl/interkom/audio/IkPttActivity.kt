package pl.interkom.audio

import android.annotation.SuppressLint
import android.app.Activity
import android.app.KeyguardManager
import android.content.Intent
import android.graphics.Color
import android.graphics.drawable.GradientDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.util.TypedValue
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowInsets
import android.view.WindowManager
import android.widget.Button
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import kotlin.math.min

/**
 * Ekran „Przytrzymaj i mów” – otwierany z powiadomienia, także nad zablokowanym ekranem (bez odblokowania telefonu).
 * Pokazuje tylko kanał, mówiących i przycisk – żadnych wiadomości. Mikrofon jest otwarty tylko, gdy palec jest na przycisku.
 */
class IkPttActivity : Activity() {
    private lateinit var status: TextView
    private lateinit var chan: TextView
    private lateinit var who: TextView
    private lateinit var talk: Button
    private val bg = GradientDrawable().apply { shape = GradientDrawable.OVAL }
    private val h = Handler(Looper.getMainLooper())
    private var holding = false
    private val tick = object : Runnable { override fun run() { refresh(); h.postDelayed(this, 200) } }

    private fun dp(v: Int) = TypedValue.applyDimension(TypedValue.COMPLEX_UNIT_DIP, v.toFloat(), resources.displayMetrics).toInt()
    private fun text(size: Float, color: Int, bold: Boolean) = TextView(this).apply {
        textSize = size; setTextColor(color); gravity = Gravity.CENTER; maxLines = 2
        if (bold) setTypeface(typeface, android.graphics.Typeface.BOLD)
    }

    @SuppressLint("ClickableViewAccessibility")
    override fun onCreate(b: Bundle?) {
        super.onCreate(b)
        if (toApp(intent)) return
        if (Build.VERSION.SDK_INT >= 27) { setShowWhenLocked(true); setTurnScreenOn(true) }
        else @Suppress("DEPRECATION") window.addFlags(WindowManager.LayoutParams.FLAG_SHOW_WHEN_LOCKED or WindowManager.LayoutParams.FLAG_TURN_SCREEN_ON)
        IkEngine.init(applicationContext)
        val soft = 0xFFBFBFBF.toInt()
        status = text(17f, soft, false); chan = text(30f, Color.WHITE, true); who = text(17f, soft, false)
        talk = Button(this).apply {
            textSize = 28f; setTextColor(Color.WHITE); isAllCaps = false; background = bg; stateListAnimator = null
            setTypeface(typeface, android.graphics.Typeface.BOLD)
            setOnTouchListener { _, e ->
                when (e.actionMasked) {
                    MotionEvent.ACTION_DOWN -> if (!holding) { holding = IkEngine.screenTalk(true); refresh() }
                    MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> { release(); refresh() }
                }
                true // przesunięcie palca nie przerywa, przerywa puszczenie
            }
        }
        val close = Button(this).apply {
            text = "Zamknij"; textSize = 18f; isAllCaps = false; setTextColor(0xFFD9D9D9.toInt()); setBackgroundColor(Color.TRANSPARENT)
            minHeight = dp(48); setOnClickListener { finish() }
        }
        val side = min(min(resources.displayMetrics.widthPixels, resources.displayMetrics.heightPixels) * 72 / 100, dp(340))
        val col = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL; gravity = Gravity.CENTER_HORIZONTAL
            setBackgroundColor(0xFF0B0D12.toInt()); setPadding(dp(20), dp(28), dp(20), dp(16))
            addView(status); addView(chan); addView(who)
            addView(FrameLayout(this@IkPttActivity).apply { addView(talk, FrameLayout.LayoutParams(side, side, Gravity.CENTER)) },
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f))
            addView(close)
        }
        if (Build.VERSION.SDK_INT >= 30) col.setOnApplyWindowInsetsListener { v: View, i: WindowInsets ->
            val s = i.getInsets(WindowInsets.Type.systemBars() or WindowInsets.Type.displayCutout())
            v.setPadding(dp(20) + s.left, dp(28) + s.top, dp(20) + s.right, dp(16) + s.bottom); i
        }
        setContentView(col)
        refresh()
    }

    override fun onNewIntent(i: Intent) { super.onNewIntent(i); toApp(i) }

    /** Stuknięcie powiadomienia na odblokowanym telefonie = zwykłe otwarcie aplikacji. */
    private fun toApp(i: Intent?): Boolean {
        if (i?.getBooleanExtra(AUTO, false) != true || (getSystemService(KEYGUARD_SERVICE) as KeyguardManager).isKeyguardLocked) return false
        packageManager.getLaunchIntentForPackage(packageName)?.let { startActivity(it.addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP)) }
        finish()
        return true
    }

    companion object { const val AUTO = "ik.auto" }

    override fun onResume() { super.onResume(); if (::talk.isInitialized) h.post(tick) }
    // zablokowanie telefonu, wyjście, rozmowa przychodząca – od razu koniec mówienia
    override fun onPause() { h.removeCallbacks(tick); release(); super.onPause() }
    override fun onWindowFocusChanged(has: Boolean) { super.onWindowFocusChanged(has); if (!has) release() }

    private fun release() { if (holding) { holding = false; IkEngine.screenTalk(false) } }

    private fun refresh() {
        if (holding && !IkEngine.talking) holding = false // przerwane z zewnątrz (reżyser, limit)
        val on = IkEngine.isConnected; val can = IkEngine.opts.canTalk; val ready = on && can
        status.text = if (!on) "Brak połączenia – otwórz Interkom" else if (!can) "Nie masz prawa mówienia" else if (holding) "Mówisz na kanale" else "Kanał mówienia"
        chan.text = IkEngine.channelName.ifEmpty { "Interkom" }
        who.text = if (IkEngine.talkerNames.isEmpty()) " " else "Mówi: " + IkEngine.talkerNames.joinToString(", ")
        talk.isEnabled = ready || holding
        talk.text = if (holding) "MÓWISZ\npuść, aby skończyć" else "Przytrzymaj\ni mów"
        bg.setColor(if (holding) 0xFFC71F1F.toInt() else if (ready) 0xFFC24000.toInt() else 0xFF333333.toInt())
    }
}
