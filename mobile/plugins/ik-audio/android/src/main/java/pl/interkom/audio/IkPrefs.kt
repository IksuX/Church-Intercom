package pl.interkom.audio

import android.content.Context
import android.content.SharedPreferences

/** Ustawienia przycisków sprzętowych (zapamiętane w telefonie). */
object IkPrefs {
    private lateinit var p: SharedPreferences
    fun init(ctx: Context) { p = ctx.getSharedPreferences("ik_audio", Context.MODE_PRIVATE) }
    var media: Boolean get() = p.getBoolean("media", true); set(v) = p.edit().putBoolean("media", v).apply()
    var volume: Boolean get() = p.getBoolean("volume", false); set(v) = p.edit().putBoolean("volume", v).apply()
    var mode: String get() = p.getString("mode", "hold") ?: "hold"; set(v) = p.edit().putString("mode", v).apply()
    var keyCode: Int get() = p.getInt("keyCode", -1); set(v) = p.edit().putInt("keyCode", v).apply()
    var keyName: String get() = p.getString("keyName", "") ?: ""; set(v) = p.edit().putString("keyName", v).apply()
}
