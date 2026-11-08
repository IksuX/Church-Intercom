package pl.interkom.audio

import android.Manifest
import android.media.AudioManager
import android.media.ToneGenerator
import android.os.Bundle
import android.speech.tts.TextToSpeech
import java.util.Locale
import android.net.Uri
import android.os.Build
import android.view.KeyEvent
import android.view.Window
import com.getcapacitor.JSObject
import com.getcapacitor.PermissionState
import com.getcapacitor.Plugin
import com.getcapacitor.PluginCall
import com.getcapacitor.PluginMethod
import com.getcapacitor.annotation.CapacitorPlugin
import com.getcapacitor.annotation.Permission
import com.getcapacitor.annotation.PermissionCallback
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.launch

/** Most między stroną interkomu a natywnym dźwiękiem (window.Capacitor.Plugins.IkAudio). */
@CapacitorPlugin(
    name = "IkAudio",
    permissions = [
        Permission(strings = [Manifest.permission.RECORD_AUDIO], alias = "microphone"),
        Permission(strings = [Manifest.permission.POST_NOTIFICATIONS], alias = "notifications"),
        Permission(strings = [Manifest.permission.BLUETOOTH_CONNECT], alias = "bluetooth"),
    ],
)
class IkAudioPlugin : Plugin(), IkEngine.Listener {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    override fun load() {
        IkEngine.init(context.applicationContext)
        IkEngine.listener = this
        installKeyHook()
    }

    override fun onEvent(name: String, data: JSObject) { notifyListeners(name, data, true) }

    override fun handleOnResume() { IkEngine.foreground = true }
    override fun handleOnPause() { IkEngine.foreground = false }

    // przyciski (głośność, przypisany przycisk PTT) – gdy aplikacja jest na ekranie
    private fun installKeyHook() {
        val w = activity?.window ?: return
        val orig = w.callback ?: return
        if (orig is KeyHook) return
        w.callback = KeyHook(orig)
    }

    private class KeyHook(val orig: Window.Callback) : Window.Callback by orig {
        override fun dispatchKeyEvent(event: KeyEvent): Boolean {
            if (event.action == KeyEvent.ACTION_DOWN || event.action == KeyEvent.ACTION_UP) {
                if (IkEngine.handleKey(event.keyCode, event.action == KeyEvent.ACTION_DOWN, event.repeatCount, false)) return true
            }
            return orig.dispatchKeyEvent(event)
        }
    }

    private fun opts(call: PluginCall) = IkEngine.Opts(
        voice = call.getBoolean("voice", true) ?: true,
        vol = call.getDouble("vol") ?: 1.0,
        prog = call.getBoolean("prog", false) ?: false,
        progVol = call.getDouble("progVol") ?: 0.5,
        progDuck = call.getBoolean("progDuck", true) ?: true,
        duck = call.getDouble("duck") ?: 0.3,
        canTalk = call.getBoolean("canTalk", false) ?: false,
        progStereo = call.getBoolean("progStereo", true) ?: true,
        hiFi = call.getBoolean("hiFi", false) ?: false,
    )

    @PluginMethod
    fun connect(call: PluginCall) {
        val need = mutableListOf<String>()
        if (getPermissionState("microphone") != PermissionState.GRANTED) need += "microphone"
        if (Build.VERSION.SDK_INT >= 33 && getPermissionState("notifications") != PermissionState.GRANTED) need += "notifications"
        if (Build.VERSION.SDK_INT >= 31 && getPermissionState("bluetooth") != PermissionState.GRANTED) need += "bluetooth"
        if (need.isNotEmpty()) requestPermissionForAliases(need.toTypedArray(), call, "afterPermissions") else doConnect(call)
    }

    @PermissionCallback
    private fun afterPermissions(call: PluginCall) { doConnect(call) } // bez mikrofonu też da się słuchać

    private fun doConnect(call: PluginCall) {
        val url = call.getString("url") ?: return call.reject("brak adresu serwera głosu")
        val token = call.getString("token") ?: return call.reject("brak tokenu")
        val session = call.getString("session") ?: ""
        val server = call.getString("server") ?: ""
        val o = opts(call)
        scope.launch {
            try { IkEngine.connect(url, token, session, server, o); call.resolve() }
            catch (t: Throwable) { call.reject(t.message ?: "nie udało się połączyć") }
        }
    }

    @PluginMethod fun configure(call: PluginCall) { IkEngine.configure(opts(call)); call.resolve() }
    @PluginMethod fun setMic(call: PluginCall) { IkEngine.setMic(call.getBoolean("on", false) == true, call.getString("talkId")); call.resolve() }
    @PluginMethod fun disconnect(call: PluginCall) { IkEngine.disconnect(); call.resolve() }

    @PluginMethod
    fun getButtons(call: PluginCall) {
        call.resolve(JSObject().put("platform", "android").put("media", IkPrefs.media).put("volume", IkPrefs.volume)
            .put("mode", IkPrefs.mode).put("keyName", IkPrefs.keyName))
    }

    @PluginMethod
    fun setButtons(call: PluginCall) {
        call.getBoolean("media")?.let { IkPrefs.media = it }
        call.getBoolean("volume")?.let { IkPrefs.volume = it }
        call.getString("mode")?.let { IkPrefs.mode = if (it == "toggle") "toggle" else "hold" }
        call.resolve()
    }

    @PluginMethod
    fun learnButton(call: PluginCall) {
        val ms = (call.getInt("timeoutMs") ?: 10000).toLong()
        var done = false
        IkEngine.learn { _, name -> if (!done) { done = true; call.resolve(JSObject().put("keyName", name)) } }
        scope.launch { kotlinx.coroutines.delay(ms); if (!done) { done = true; IkEngine.learn(null); call.reject("Nie wykryto przycisku – spróbuj ponownie.") } }
    }

    // ---------------- wybór serwera ----------------
    @PluginMethod
    fun getServer(call: PluginCall) {
        val r = JSObject().put("platform", "android")
        IkServer.get(context)?.let { r.put("url", it) }
        getConfig().getString("defaultServer")?.let { r.put("defaultUrl", it) }
        call.resolve(r)
    }

    @PluginMethod
    fun setServer(call: PluginCall) {
        val url = IkServer.normalize(call.getString("url") ?: "") ?: return call.reject("Nieprawidłowy adres serwera.")
        IkServer.set(context, url)
        IkServer.go = true
        call.resolve(JSObject().put("url", url))
        restart()
    }

    @PluginMethod
    fun resetServer(call: PluginCall) { call.resolve(); command("reset") }

    @PluginMethod
    fun discover(call: PluginCall) {
        val ms = (call.getInt("timeoutMs") ?: 3000).toLong()
        IkServer.discover(context, ms) { list -> call.resolve(JSObject().put("servers", list)) }
    }

    /** „ikapp://reset|retry” – polecenia ze stron, które nie mają dostępu do wtyczki (np. strona błędu połączenia). */
    override fun shouldOverrideLoad(url: Uri): Boolean? {
        if (url.scheme != "ikapp") return null
        command(url.host ?: "")
        return true
    }

    private fun command(cmd: String) {
        when (cmd) {
            "reset" -> { IkServer.set(context, null); IkServer.go = false; IkEngine.disconnect(); restart() }
            "retry" -> { IkServer.go = false; restart() } // ekran wyboru sprawdzi serwer i sam przejdzie dalej
        }
    }

    /** Aplikacja wczytuje się od nowa z nowym adresem (MainActivity czyta go przy starcie). */
    private fun restart() { activity?.runOnUiThread { activity?.recreate() } }

    // ---------------- lektor i sygnały (natywnie – działają w tle) ----------------
    private var tts: TextToSpeech? = null
    private var ttsReady = false
    private val pending = mutableListOf<Pair<String, Float>>()

    private fun ensureTts() {
        if (tts != null) return
        tts = TextToSpeech(context.applicationContext) { st ->
            if (st == TextToSpeech.SUCCESS) {
                tts?.language = Locale("pl", "PL")
                tts?.setSpeechRate(1.1f)
                ttsReady = true
                pending.forEach { (t, v) -> say(t, v) }; pending.clear()
            }
        }
    }

    private fun say(text: String, vol: Float) {
        val p = Bundle().apply { putFloat(TextToSpeech.Engine.KEY_PARAM_VOLUME, vol) }
        tts?.speak(text, TextToSpeech.QUEUE_ADD, p, "ik" + System.nanoTime())
    }

    @PluginMethod
    fun speak(call: PluginCall) {
        val text = call.getString("text") ?: ""
        val vol = (call.getDouble("volume") ?: 1.0).toFloat().coerceIn(0f, 1f)
        if (text.isNotEmpty()) { ensureTts(); if (ttsReady) say(text, vol) else pending += text to vol }
        call.resolve()
    }

    @PluginMethod
    fun beep(call: PluginCall) {
        val vol = ((call.getDouble("volume") ?: 1.0) * 100).toInt().coerceIn(0, 100)
        if (vol > 0) scope.launch {
            try {
                val tg = ToneGenerator(AudioManager.STREAM_VOICE_CALL, vol)
                repeat(3) { tg.startTone(ToneGenerator.TONE_PROP_BEEP, 160); kotlinx.coroutines.delay(220) }
                tg.release()
            } catch (_: Throwable) {}
        }
        call.resolve()
    }

    override fun handleOnDestroy() { tts?.shutdown(); tts = null; ttsReady = false }
}
