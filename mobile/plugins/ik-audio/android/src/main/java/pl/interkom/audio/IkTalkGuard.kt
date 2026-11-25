package pl.interkom.audio

import android.media.AudioManager
import android.media.ToneGenerator
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.delay
import kotlinx.coroutines.launch
import org.json.JSONObject
import kotlin.math.max
import kotlin.math.min

/** Zabezpieczenie przed zapomnianym mikrofonem (mówienie włączane bez przytrzymywania): limity z panelu serwera, w sekundach. */
data class IkTalkLimits(val max: Int = 60, val silence: Int = 8, val remind: Int = 10) {
    companion object {
        fun from(j: JSONObject) = IkTalkLimits(max(10, j.optInt("max", 60)), j.optInt("silence", 8), j.optInt("remind", 10))
    }
}

/**
 * Wykrywanie mowy: głośność wyraźnie ponad tłem (tło dopasowuje się samo – w głośnym miejscu próg rośnie).
 * Gdy tło jest bardzo głośne i zmienne, ciszy nie da się rozpoznać – wtedy działa limit czasu.
 */
class IkVoiceMeter {
    private var floor = 0.01f
    private var ignoreUntil = 0L
    @Volatile var lastVoice = 0L; private set

    @Synchronized fun reset(now: Long) { floor = 0.01f; lastVoice = now; ignoreUntil = 0 }
    @Synchronized fun ignore(now: Long, ms: Long) { ignoreUntil = now + ms } // własny sygnał to nie mowa
    @Synchronized fun feed(rms: Float, seconds: Float, now: Long) {
        if (now < ignoreUntil) return
        floor = if (rms < floor) rms else min(0.05f, floor + (rms - floor) * min(1f, seconds * 0.15f))
        if (rms > max(0.006f, floor * 2.2f)) lastVoice = now
    }
}

/** Krótkie sygnały: start, koniec, przypomnienie, wyłączenie samoczynne. */
object IkTone {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Default)
    fun start() = play(35, ToneGenerator.TONE_PROP_ACK to 150)
    fun stop() = play(35, ToneGenerator.TONE_PROP_PROMPT to 150)
    fun remind() = play(35, ToneGenerator.TONE_PROP_BEEP to 70)
    fun auto() = play(80, ToneGenerator.TONE_PROP_NACK to 250, ToneGenerator.TONE_PROP_NACK to 250)

    private fun play(vol: Int, vararg notes: Pair<Int, Int>) {
        scope.launch {
            try {
                val tg = ToneGenerator(AudioManager.STREAM_VOICE_CALL, vol)
                for ((t, ms) in notes) { tg.startTone(t, ms); delay(ms + 90L) }
                tg.release()
            } catch (_: Throwable) {}
        }
    }
}
