package pl.interkom.audio

import android.content.Context
import android.net.Uri
import android.net.nsd.NsdManager
import android.net.nsd.NsdServiceInfo
import android.os.Handler
import android.os.Looper
import com.getcapacitor.CapConfig
import com.getcapacitor.JSArray
import com.getcapacitor.JSObject

/** Wybrany serwer interkomu (zapamiętany w telefonie) i wyszukiwanie serwerów w sieci lokalnej (mDNS). */
object IkServer {
    private const val PREFS = "ik_server"

    fun get(ctx: Context): String? = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).getString("url", null)

    fun set(ctx: Context, url: String?) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit().apply { if (url == null) remove("url") else putString("url", url) }.commit()
    }

    /** Konfiguracja aplikacji dla zapamiętanego serwera; null = ekran wyboru serwera (wbudowana strona). Wołane z MainActivity. */
    /** Po uruchomieniu aplikacji najpierw ekran wyboru (sprawdza, czy zapamiętany serwer odpowiada); dopiero potem serwer. */
    @JvmStatic var go = false

    @JvmStatic
    fun config(ctx: Context): CapConfig? {
        if (!go) return null
        val url = get(ctx) ?: return null
        val host = Uri.parse(url).host ?: return null
        return CapConfig.Builder(ctx)
            .setServerUrl(url)
            .setErrorPath("error.html")
            .setAllowNavigation(arrayOf(host, "planningcenteronline.com", "*.planningcenteronline.com"))
            .create()
    }

    /** „interkom.parafia.pl”, „192.168.1.10”, „https://…/coś” → https://host[:port] */
    fun normalize(s: String): String? {
        var t = s.trim()
        if (t.isEmpty()) return null
        if (!t.contains("://")) t = "https://$t"
        val u = Uri.parse(t)
        val host = u.host ?: return null
        if (host.isEmpty() || (u.scheme != "https" && u.scheme != "http")) return null
        return u.scheme + "://" + host + (if (u.port > 0) ":${u.port}" else "")
    }

    /** Szuka usług „_interkom._tcp” (ogłasza je avahi na serwerze). */
    fun discover(ctx: Context, timeoutMs: Long, done: (JSArray) -> Unit) {
        val nsd = ctx.getSystemService(Context.NSD_SERVICE) as NsdManager
        val main = Handler(Looper.getMainLooper())
        val found = LinkedHashMap<String, JSObject>()
        val queue = ArrayDeque<NsdServiceInfo>()
        var resolving = false
        var finished = false

        fun next() {
            if (resolving || finished) return
            val s = queue.removeFirstOrNull() ?: return
            resolving = true
            @Suppress("DEPRECATION")
            nsd.resolveService(s, object : NsdManager.ResolveListener {
                override fun onResolveFailed(si: NsdServiceInfo, errorCode: Int) { main.post { resolving = false; next() } }
                override fun onServiceResolved(si: NsdServiceInfo) {
                    main.post {
                        val a = si.attributes
                        val url = a["url"]?.let { String(it) }
                        if (url != null) {
                            val o = JSObject().put("name", si.serviceName).put("url", url)
                            a["org"]?.let { o.put("org", String(it)) }
                            a["v"]?.let { o.put("v", String(it)) }
                            found[si.serviceName] = o
                        }
                        resolving = false; next()
                    }
                }
            })
        }

        val listener = object : NsdManager.DiscoveryListener {
            override fun onDiscoveryStarted(serviceType: String) {}
            override fun onDiscoveryStopped(serviceType: String) {}
            override fun onStartDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onStopDiscoveryFailed(serviceType: String, errorCode: Int) {}
            override fun onServiceLost(si: NsdServiceInfo) {}
            override fun onServiceFound(si: NsdServiceInfo) { main.post { queue.add(si); next() } }
        }
        try { nsd.discoverServices("_interkom._tcp", NsdManager.PROTOCOL_DNS_SD, listener) } catch (_: Throwable) {}
        main.postDelayed({
            finished = true
            try { nsd.stopServiceDiscovery(listener) } catch (_: Throwable) {}
            done(JSArray().apply { found.values.forEach { put(it) } })
        }, timeoutMs)
    }
}
