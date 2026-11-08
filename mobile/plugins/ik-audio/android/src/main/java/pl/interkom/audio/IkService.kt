package pl.interkom.audio

import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.media.session.MediaSession
import android.media.session.PlaybackState
import android.os.Build
import android.os.IBinder
import android.os.PowerManager
import android.view.KeyEvent
import androidx.core.app.NotificationCompat
import androidx.core.content.ContextCompat

/**
 * Usługa pierwszoplanowa: utrzymuje rozmowy przy zablokowanym ekranie (ikona „Interkom” w powiadomieniach)
 * i odbiera przyciski słuchawek / Bluetooth (MediaSession) – także gdy telefon leży w kieszeni.
 */
class IkService : Service() {
    private var session: MediaSession? = null
    private var wake: PowerManager.WakeLock? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val n = NotificationCompat.Builder(this, Notify.CH_SERVICE)
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setContentTitle("Interkom")
            .setContentText("Połączony – słuchasz także przy zablokowanym ekranie")
            .setOngoing(true)
            .setContentIntent(Notify.openAppIntent(this))
            .build()
        try {
            if (Build.VERSION.SDK_INT >= 30) startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE or ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK)
            else startForeground(1, n)
        } catch (t: Throwable) { // np. brak zgody na mikrofon – wtedy tylko odtwarzanie
            if (Build.VERSION.SDK_INT >= 30) try { startForeground(1, n, ServiceInfo.FOREGROUND_SERVICE_TYPE_MEDIA_PLAYBACK) } catch (_: Throwable) {}
        }
        if (session == null) setupMediaSession()
        if (wake == null) wake = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "interkom:audio").apply { setReferenceCounted(false); acquire() }
        return START_STICKY
    }

    private fun setupMediaSession() {
        val s = MediaSession(this, "Interkom")
        s.setCallback(object : MediaSession.Callback() {
            override fun onMediaButtonEvent(intent: Intent): Boolean {
                @Suppress("DEPRECATION")
                val ev: KeyEvent = (if (Build.VERSION.SDK_INT >= 33) intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT, KeyEvent::class.java) else intent.getParcelableExtra(Intent.EXTRA_KEY_EVENT)) ?: return false
                return IkEngine.handleKey(ev.keyCode, ev.action == KeyEvent.ACTION_DOWN, ev.repeatCount, true)
            }
        })
        // stan „odtwarza” – dzięki temu system kieruje przyciski multimediów do interkomu
        s.setPlaybackState(PlaybackState.Builder()
            .setActions(PlaybackState.ACTION_PLAY_PAUSE or PlaybackState.ACTION_PLAY or PlaybackState.ACTION_PAUSE)
            .setState(PlaybackState.STATE_PLAYING, 0, 1f).build())
        s.isActive = true
        session = s
    }

    override fun onDestroy() {
        session?.run { isActive = false; release() }; session = null
        wake?.let { if (it.isHeld) it.release() }; wake = null
        super.onDestroy()
    }

    companion object {
        fun start(ctx: Context) { ContextCompat.startForegroundService(ctx, Intent(ctx, IkService::class.java)) }
        fun stop(ctx: Context) { ctx.stopService(Intent(ctx, IkService::class.java)) }
    }
}
