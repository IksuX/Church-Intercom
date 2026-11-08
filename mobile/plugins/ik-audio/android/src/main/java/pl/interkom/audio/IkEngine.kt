package pl.interkom.audio

import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.Build
import android.os.VibrationEffect
import android.os.Vibrator
import android.os.VibratorManager
import android.util.Log
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import com.getcapacitor.JSObject
import io.livekit.android.AudioOptions
import io.livekit.android.AudioType
import io.livekit.android.ConnectOptions
import io.livekit.android.LiveKit
import io.livekit.android.LiveKitOverrides
import io.livekit.android.RoomOptions
import io.livekit.android.events.RoomEvent
import io.livekit.android.events.collect
import io.livekit.android.room.Room
import io.livekit.android.room.track.LocalTrackPublication
import io.livekit.android.room.track.RemoteAudioTrack
import io.livekit.android.room.track.RemoteTrackPublication
import io.livekit.android.room.track.Track
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext
import org.json.JSONObject
import java.io.ByteArrayOutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.nio.ByteBuffer
import java.nio.ByteOrder

/**
 * Silnik dźwięku interkomu (jeden na aplikację). Działa w usłudze pierwszoplanowej, więc także przy zablokowanym
 * ekranie, gdy strona (WebView) jest uśpiona. Kogo słychać, mówi serwer (wiadomość „hear” kanałem danych LiveKit).
 */
object IkEngine {
    private const val TAG = "IkAudio"
    const val PROGRAM = "ik-program"

    interface Listener { fun onEvent(name: String, data: JSObject) }

    data class Opts(
        val voice: Boolean = true, val vol: Double = 1.0, val prog: Boolean = false, val progVol: Double = 0.5,
        val progDuck: Boolean = true, val duck: Double = 0.3, val canTalk: Boolean = false,
        val progStereo: Boolean = true,
        // jakość muzyczna: zwykły tryb dźwięku Androida (nie „rozmowa telefoniczna”), słuchawki Bluetooth w trybie
        // muzycznym (A2DP), wyjście stereo; mówi się wtedy do mikrofonu telefonu
        val hiFi: Boolean = false,
    )

    var listener: Listener? = null
    lateinit var app: Context
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)

    private var room: Room? = null
    private var eventsJob: Job? = null
    private var beatJob: Job? = null
    private var url = ""; private var token = ""; var session = ""; var server = ""
    @Volatile var opts = Opts()
    private var hear: Set<String> = emptySet()
    private var othersTalking = false
    private var wanted = false
    @Volatile var foreground = true

    // mówienie
    @Volatile var talking = false
    private var talkId: String? = null
    private var hwTalk = false
    private var muteJob: Job? = null

    fun init(ctx: Context) {
        if (!::app.isInitialized) { app = ctx.applicationContext; IkPrefs.init(app); createChannels() }
    }

    private fun emit(name: String, data: JSObject = JSObject()) { scope.launch { listener?.onEvent(name, data) } }
    private fun emitState(s: String) = emit("state", JSObject().put("state", s))

    // ---------------- połączenie ----------------
    private var lastProgLive: Boolean? = null

    suspend fun connect(url: String, token: String, session: String, server: String, o: Opts) {
        lastProgLive = null
        this.url = url; this.token = token; this.session = session; this.server = server.trimEnd('/'); opts = o
        wanted = true
        disconnectRoom()
        val r = LiveKit.create(
            app,
            RoomOptions(adaptiveStream = false, dynacast = false),
            LiveKitOverrides(audioOptions = AudioOptions(
                audioOutputType = if (o.hiFi) AudioType.MediaAudioType() else AudioType.CallAudioType(),
                javaAudioDeviceModuleCustomizer = { b ->
                    // kopia mikrofonu do transkrypcji (zbierana tylko w trakcie mówienia)
                    b.setSamplesReadyCallback { s -> Recorder.feed(s.data, s.sampleRate, s.channelCount) }
                    if (o.hiFi) b.setUseStereoOutput(true)
                },
            )),
        )
        room = r
        eventsJob = scope.launch { r.events.collect { onRoomEvent(it) } }
        emitState("connecting")
        r.connect(url, token, ConnectOptions(autoSubscribe = true))
        emitState("connected")
        if (opts.canTalk) prepareMic()
        IkService.start(app)
        startBeat()
        applyGates()
    }

    fun disconnect() {
        wanted = false
        beatJob?.cancel()
        scope.launch(Dispatchers.IO) { post("/api/native/bye", JSONObject()) }
        disconnectRoom()
        IkService.stop(app)
        emitState("disconnected")
    }

    private fun disconnectRoom() {
        eventsJob?.cancel(); eventsJob = null
        try { room?.disconnect() } catch (_: Throwable) {}
        try { room?.release() } catch (_: Throwable) {}
        room = null
    }

    fun configure(o: Opts) {
        val couldTalk = opts.canTalk
        val hiFiChanged = o.hiFi != opts.hiFi
        opts = o
        // tryb dźwięku ustawia się przy tworzeniu połączenia – zmiana „jakości muzycznej” = szybkie ponowne połączenie
        if (hiFiChanged && wanted && room != null) { scope.launch { reconnect() }; return }
        applyGates()
        if (o.canTalk && !couldTalk) scope.launch { prepareMic() }
        if (!o.canTalk && talking) setMic(false, null)
        scope.launch(Dispatchers.IO) { beat() } // serwer od razu przeliczy, kogo słychać (głos wł./wył., transmisja)
    }

    private suspend fun prepareMic() {
        val r = room ?: return
        try {
            r.localParticipant.setMicrophoneEnabled(true)
            micPub()?.muted = !talking // gotowy, ale wyciszony – włączenie jest natychmiastowe
        } catch (e: Throwable) { Log.w(TAG, "mikrofon", e); emit("notice", JSObject().put("message", "Brak dostępu do mikrofonu – zezwól w ustawieniach telefonu.")) }
    }

    private fun micPub() = room?.localParticipant?.getTrackPublication(Track.Source.MICROPHONE) as? LocalTrackPublication

    private suspend fun onRoomEvent(e: RoomEvent) {
        when (e) {
            is RoomEvent.TrackSubscribed, is RoomEvent.TrackPublished, is RoomEvent.TrackUnpublished,
            is RoomEvent.ParticipantConnected, is RoomEvent.ParticipantDisconnected, is RoomEvent.TrackMuted, is RoomEvent.TrackUnmuted -> applyGates()
            is RoomEvent.DataReceived -> if (e.topic == "ik") onServerData(String(e.data, Charsets.UTF_8))
            is RoomEvent.Reconnecting -> emitState("reconnecting")
            is RoomEvent.Reconnected -> { emitState("connected"); applyGates() }
            is RoomEvent.Disconnected -> {
                emitState("disconnected")
                if (wanted) scope.launch { delay(3000); if (wanted && room?.state != Room.State.CONNECTED) reconnect() }
            }
            else -> {}
        }
    }

    private suspend fun reconnect() {
        try { connect(url, token, session, server, opts) } catch (t: Throwable) { Log.w(TAG, "ponowne łączenie", t); scope.launch { delay(5000); if (wanted) reconnect() } }
    }

    // ---------------- kogo słychać ----------------
    private fun onServerData(s: String) {
        try {
            val j = JSONObject(s)
            when (j.optString("t")) {
                "hear" -> {
                    val a = j.optJSONArray("ids"); val set = HashSet<String>()
                    if (a != null) for (i in 0 until a.length()) set.add(a.getString(i))
                    hear = set; othersTalking = j.optBoolean("talking"); applyGates()
                }
                "notify" -> Notify.show(app, j)
                "forceMute" -> { // reżyser / administrator wyciszył mój mikrofon
                    val by = j.optString("by", "Reżyser")
                    if (talking) { if (hwTalk) hwTalk(false) else setMic(false, null) }
                    emit("forceMute", JSObject().put("by", by))
                    Notify.show(app, JSONObject().put("title", "🔇 Wyciszono Twój mikrofon").put("body", "$by wyłączył(a) Twoje mówienie – mikrofon był włączony.").put("urgent", true).put("tag", "mute").put("vib", "urgent"))
                }
                "moveTo" -> { // przeniesiono mnie na inny kanał (serwer już ustawił kanał mówienia)
                    val by = j.optString("by", "Reżyser")
                    emit("moveTo", JSObject().put("channel", j.optString("channel")).put("by", by))
                    Notify.show(app, JSONObject().put("title", "↪ Zmiana kanału").put("body", "$by przeniósł(a) Cię na inny kanał.").put("urgent", true).put("tag", "move").put("vib", "urgent"))
                }
            }
        } catch (t: Throwable) { Log.w(TAG, "dane z serwera", t) }
    }

    fun applyGates() {
        val r = room ?: return
        var progLive = false
        for (p in r.remoteParticipants.values) {
            val id = p.identity?.value ?: continue
            for (pub in p.trackPublications.values) {
                if (pub.kind != Track.Kind.AUDIO || pub !is RemoteTrackPublication) continue
                val isProg = id == PROGRAM
                if (isProg) progLive = true
                val on = if (isProg) opts.prog else opts.voice && hear.contains(id)
                try { pub.setEnabled(on) } catch (_: Throwable) {}
                val vol = if (isProg) opts.progVol * (if (opts.progDuck && (othersTalking || talking)) opts.duck else 1.0) else opts.vol
                (pub.track as? RemoteAudioTrack)?.setVolume(vol) // LiveKit: 0 = cisza, 1 = bez zmian
            }
        }
        if (progLive != lastProgLive) { lastProgLive = progLive; emit("program", JSObject().put("live", progLive)) } // tylko zmiana
    }

    // ---------------- mówienie ----------------
    /** Ze strony (przycisk na ekranie) – stronę już powiadomiła serwer przez WebSocket. */
    fun setMic(on: Boolean, id: String?) {
        if (on) {
            muteJob?.cancel()
            talking = true; talkId = id
            Recorder.start()
            micPub()?.muted = false
        } else {
            if (!talking) return
            talking = false
            val tid = talkId; talkId = null
            muteJob = scope.launch { delay(250); if (!talking) micPub()?.muted = true } // nie ucinaj końcówki
            scope.launch(Dispatchers.IO) { delay(450); val wav = Recorder.stop(); if (tid != null && wav != null) upload(tid, wav) }
        }
        applyGates() // ściszanie transmisji, gdy sam mówisz
    }

    /** Z przycisku sprzętowego – serwer powiadamiamy sami (strona może spać). */
    fun hwTalk(on: Boolean) {
        if (on == hwTalk && on == talking) return
        if (on) {
            if (!opts.canTalk || room == null) { buzz(longArrayOf(0, 80, 60, 80)); return }
            hwTalk = true
            buzz(longArrayOf(0, 25))
            Recorder.start(); micPub()?.muted = false; talking = true
            scope.launch(Dispatchers.IO) {
                val res = post("/api/native/ptt", JSONObject().put("on", true))
                val id = res?.optString("talkId")
                withContext(Dispatchers.Main) {
                    if (res == null || id.isNullOrEmpty()) { hwTalk = false; setMic(false, null); buzz(longArrayOf(0, 80, 60, 80)); return@withContext }
                    talkId = id
                    emit("ptt", JSObject().put("on", true).put("talkId", id))
                }
            }
        } else {
            hwTalk = false
            setMic(false, null)
            scope.launch(Dispatchers.IO) { post("/api/native/ptt", JSONObject().put("on", false)) }
            emit("ptt", JSObject().put("on", false))
            buzz(longArrayOf(0, 15))
        }
    }

    // ---------------- przyciski: słuchawki / Bluetooth / głośność / przypisany PTT ----------------
    private var downAt = 0L
    private var learning: ((Int, String) -> Unit)? = null

    fun learn(cb: ((Int, String) -> Unit)?) { learning = cb }

    /** Zwraca true, jeśli zdarzenie zostało obsłużone (np. przycisk głośności nie zmieni wtedy głośności). */
    fun handleKey(code: Int, down: Boolean, repeat: Int, fromMediaSession: Boolean): Boolean {
        learning?.let { cb ->
            if (down && repeat == 0) { learning = null; val name = KeyEvent.keyCodeToString(code).removePrefix("KEYCODE_"); IkPrefs.keyCode = code; IkPrefs.keyName = name; cb(code, name) }
            return true
        }
        val isMedia = code == KeyEvent.KEYCODE_HEADSETHOOK || code == KeyEvent.KEYCODE_MEDIA_PLAY_PAUSE || code == KeyEvent.KEYCODE_MEDIA_PLAY || code == KeyEvent.KEYCODE_MEDIA_PAUSE
        val isVol = code == KeyEvent.KEYCODE_VOLUME_UP || code == KeyEvent.KEYCODE_VOLUME_DOWN
        val mine = (IkPrefs.keyCode != -1 && code == IkPrefs.keyCode) || (isMedia && IkPrefs.media) || (isVol && IkPrefs.volume && !fromMediaSession)
        if (!mine) return false
        if (repeat > 0) return true
        if (IkPrefs.mode == "toggle") { if (down) hwTalk(!talking) }
        else if (down) { downAt = System.currentTimeMillis(); if (!talking) hwTalk(true) else hwTalk(false) }
        else {
            // zwykłe słuchawki często wysyłają tylko krótkie „kliknięcie” – wtedy działa jak włącz/wyłącz
            if (System.currentTimeMillis() - downAt > 350 && talking && hwTalk) hwTalk(false)
        }
        return true
    }

    // ---------------- zgłaszanie się serwerowi ----------------
    private fun startBeat() {
        beatJob?.cancel()
        beatJob = scope.launch(Dispatchers.IO) { while (isActive) { beat(); delay(20000) } }
    }

    private suspend fun beat() {
        val res = post("/api/native/beat", JSONObject().put("voice", opts.voice).put("prog", opts.prog)) ?: return
        val a = res.optJSONArray("hear")
        if (a != null) { val set = HashSet<String>(); for (i in 0 until a.length()) set.add(a.getString(i)); withContext(Dispatchers.Main) { hear = set; applyGates() } }
        val can = res.optBoolean("canTalk", opts.canTalk)
        if (can != opts.canTalk) withContext(Dispatchers.Main) { configure(opts.copy(canTalk = can)) }
    }

    private fun post(path: String, body: JSONObject): JSONObject? = try {
        val c = URL(server + path).openConnection() as HttpURLConnection
        c.requestMethod = "POST"; c.connectTimeout = 5000; c.readTimeout = 8000; c.doOutput = true
        c.setRequestProperty("content-type", "application/json"); c.setRequestProperty("authorization", "Bearer $session")
        c.outputStream.use { it.write(body.toString().toByteArray()) }
        val txt = (if (c.responseCode < 400) c.inputStream else c.errorStream)?.bufferedReader()?.readText() ?: ""
        if (c.responseCode >= 400) { Log.w(TAG, "$path → ${c.responseCode} $txt"); null } else JSONObject(txt.ifEmpty { "{}" })
    } catch (t: Throwable) { Log.w(TAG, "$path", t); null }

    private fun upload(talkId: String, wav: ByteArray) {
        try {
            val c = URL("$server/api/stt/$talkId").openConnection() as HttpURLConnection
            c.requestMethod = "POST"; c.connectTimeout = 5000; c.readTimeout = 20000; c.doOutput = true
            c.setRequestProperty("content-type", "audio/wav"); c.setRequestProperty("authorization", "Bearer $session")
            c.outputStream.use { it.write(wav) }
            c.responseCode
        } catch (t: Throwable) { Log.w(TAG, "transkrypcja", t) }
    }

    fun buzz(p: LongArray) {
        try {
            val v = if (Build.VERSION.SDK_INT >= 31) (app.getSystemService(Context.VIBRATOR_MANAGER_SERVICE) as VibratorManager).defaultVibrator
            else @Suppress("DEPRECATION") (app.getSystemService(Context.VIBRATOR_SERVICE) as Vibrator)
            v.vibrate(VibrationEffect.createWaveform(p, -1))
        } catch (_: Throwable) {}
    }

    private fun createChannels() {
        if (Build.VERSION.SDK_INT < 26) return
        val nm = app.getSystemService(NotificationManager::class.java)
        nm.createNotificationChannel(NotificationChannel(Notify.CH_SERVICE, "Interkom działa w tle", NotificationManager.IMPORTANCE_LOW))
        nm.createNotificationChannel(NotificationChannel(Notify.CH_MSG, "Wiadomości", NotificationManager.IMPORTANCE_DEFAULT).apply { enableVibration(true) })
        nm.createNotificationChannel(NotificationChannel(Notify.CH_URGENT, "Wezwania i PILNE", NotificationManager.IMPORTANCE_HIGH).apply { enableVibration(true); vibrationPattern = longArrayOf(0, 600, 200, 600, 200, 600) })
    }
}

/** Powiadomienia z serwera (gdy aplikacja jest w tle albo ekran jest zablokowany). */
object Notify {
    const val CH_SERVICE = "ik_service"; const val CH_MSG = "ik_msg"; const val CH_URGENT = "ik_urgent"
    private var n = 100
    private val VIB = mapOf(
        "call" to longArrayOf(0, 600, 200, 600, 200, 600, 200, 600), "urgent" to longArrayOf(0, 400, 150, 400, 150, 400),
        "timer" to longArrayOf(0, 250, 120, 250, 120, 700), "msg" to longArrayOf(0, 150, 80, 150), "soft" to longArrayOf(0, 120),
    )

    fun openAppIntent(ctx: Context): PendingIntent? {
        val i = ctx.packageManager.getLaunchIntentForPackage(ctx.packageName)?.apply { addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP) } ?: return null
        return PendingIntent.getActivity(ctx, 0, i, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    }

    fun show(ctx: Context, j: JSONObject) {
        if (IkEngine.foreground) return // aplikacja na ekranie – komunikat pokaże strona
        val urgent = j.optBoolean("urgent")
        val vib = VIB[j.optString("vib")] ?: VIB["soft"]!!
        val b = NotificationCompat.Builder(ctx, if (urgent) CH_URGENT else CH_MSG)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle(j.optString("title", "Interkom"))
            .setContentText(j.optString("body"))
            .setStyle(NotificationCompat.BigTextStyle().bigText(j.optString("body")))
            .setPriority(if (urgent) NotificationCompat.PRIORITY_HIGH else NotificationCompat.PRIORITY_DEFAULT)
            .setCategory(if (j.optString("vib") == "call") NotificationCompat.CATEGORY_CALL else NotificationCompat.CATEGORY_MESSAGE)
            .setAutoCancel(true)
            .setContentIntent(openAppIntent(ctx))
        if (Build.VERSION.SDK_INT < 26) b.setVibrate(vib)
        try {
            val nm = ctx.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            val tag = j.optString("tag")
            nm.notify(tag.ifEmpty { null }, if (tag.isEmpty()) n++ else 1, b.build())
        } catch (_: SecurityException) {}
        IkEngine.buzz(vib)
    }
}

/** Kopia mikrofonu do transkrypcji: zbierana w trakcie mówienia, zamieniana na WAV 16 kHz mono. */
object Recorder {
    private val buf = ByteArrayOutputStream()
    @Volatile private var on = false
    @Volatile private var rate = 48000
    private const val MAX_BYTES = 48000 * 2 * 120 // do 2 minut

    fun start() { synchronized(buf) { buf.reset(); on = true } }

    fun feed(data: ByteArray, sampleRate: Int, channels: Int) {
        if (!on) return
        synchronized(buf) {
            if (!on || buf.size() > MAX_BYTES) return
            rate = sampleRate
            if (channels <= 1) buf.write(data)
            else { // tylko pierwszy kanał
                val bb = ByteBuffer.wrap(data).order(ByteOrder.LITTLE_ENDIAN); val step = channels * 2
                var i = 0; while (i + 1 < data.size) { buf.write(data[i].toInt()); buf.write(data[i + 1].toInt()); i += step }
                bb.clear()
            }
        }
    }

    fun stop(): ByteArray? {
        val pcm: ByteArray; val sr: Int
        synchronized(buf) { on = false; pcm = buf.toByteArray(); sr = rate; buf.reset() }
        if (pcm.size < sr * 2 * 0.5) return null // krócej niż pół sekundy – bez transkrypcji
        val src = ByteBuffer.wrap(pcm).order(ByteOrder.LITTLE_ENDIAN).asShortBuffer()
        val n = src.remaining(); val outN = (n.toLong() * 16000 / sr).toInt()
        val out = ByteBuffer.allocate(44 + outN * 2).order(ByteOrder.LITTLE_ENDIAN)
        // nagłówek WAV
        out.put("RIFF".toByteArray()); out.putInt(36 + outN * 2); out.put("WAVE".toByteArray())
        out.put("fmt ".toByteArray()); out.putInt(16); out.putShort(1); out.putShort(1); out.putInt(16000); out.putInt(32000); out.putShort(2); out.putShort(16)
        out.put("data".toByteArray()); out.putInt(outN * 2)
        val ratio = sr.toDouble() / 16000
        for (i in 0 until outN) { // uśrednianie próbek z okna – prosty filtr przed zmniejszeniem częstotliwości
            val a = (i * ratio).toInt(); val b = minOf(n, ((i + 1) * ratio).toInt().coerceAtLeast(a + 1))
            var s = 0L; for (k in a until b) s += src.get(k); out.putShort((s / (b - a)).toInt().toShort())
        }
        return out.array()
    }
}
