import AVFoundation
import UIKit
import Capacitor
import Foundation
import WebKit

/// Most między stroną interkomu a natywnym dźwiękiem (window.Capacitor.Plugins.IkAudio).
@objc(IkAudioPlugin)
public class IkAudioPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "IkAudioPlugin"
    public let jsName = "IkAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "connect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "configure", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setMic", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "disconnect", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getButtons", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setButtons", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "learnButton", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "getServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resetServer", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "discover", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "speak", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "beep", returnType: CAPPluginReturnPromise),
    ]

    private var volumeObs: NSKeyValueObservation?
    private var volumeButtons = UserDefaults.standard.bool(forKey: "ik.volume")

    override public func load() {
        Task { @MainActor in
            IkEngine.shared.emit = { [weak self] name, data in self?.notifyListeners(name, data: data, retainUntilConsumed: true) }
        }
        watchVolume()
    }

    private func opts(_ call: CAPPluginCall) -> IkEngine.Opts {
        // pole po polu – jedno długie wyrażenie przekraczało czas sprawdzania typów w kompilatorze
        var o = IkEngine.Opts()
        o.voice = call.getBool("voice") ?? true
        o.vol = call.getDouble("vol") ?? 1.0
        o.prog = call.getBool("prog") ?? false
        o.progVol = call.getDouble("progVol") ?? 0.5
        o.progDuck = call.getBool("progDuck") ?? true
        o.duck = call.getDouble("duck") ?? 0.3
        o.canTalk = call.getBool("canTalk") ?? false
        o.progStereo = call.getBool("progStereo") ?? true
        o.hiFi = call.getBool("hiFi") ?? false
        return o
    }

    @objc func connect(_ call: CAPPluginCall) {
        guard let url = call.getString("url"), let token = call.getString("token") else { return call.reject("brak adresu serwera głosu lub tokenu") }
        let session = call.getString("session") ?? "", server = call.getString("server") ?? ""
        let o = opts(call)
        AVAudioSession.sharedInstance().requestRecordPermission { _ in // bez mikrofonu też da się słuchać
            Task { @MainActor in
                do { try await IkEngine.shared.connect(url: url, token: token, session: session, server: server, opts: o); call.resolve() }
                catch { call.reject(error.localizedDescription) }
            }
        }
    }

    @objc func configure(_ call: CAPPluginCall) {
        let o = opts(call)
        Task { @MainActor in IkEngine.shared.configure(o); call.resolve() }
    }

    @objc func setMic(_ call: CAPPluginCall) {
        let on = call.getBool("on") ?? false, id = call.getString("talkId")
        Task { @MainActor in IkEngine.shared.setMic(on, id); call.resolve() }
    }

    @objc func disconnect(_ call: CAPPluginCall) {
        Task { @MainActor in await IkEngine.shared.disconnect(); call.resolve() }
    }

    @objc func getButtons(_ call: CAPPluginCall) {
        Task { @MainActor in
            call.resolve(["platform": "ios", "media": IkEngine.shared.mediaButtons, "volume": self.volumeButtons, "mode": "toggle", "keyName": ""])
        }
    }

    @objc func setButtons(_ call: CAPPluginCall) {
        let media = call.getBool("media"), vol = call.getBool("volume")
        if let vol { volumeButtons = vol; UserDefaults.standard.set(vol, forKey: "ik.volume") }
        Task { @MainActor in
            if let media { IkEngine.shared.mediaButtons = media }
            call.resolve()
        }
    }

    @objc func learnButton(_ call: CAPPluginCall) {
        call.reject("Na iPhonie przyciski PTT Bluetooth działają jako przyciski multimedialne – wystarczy włączyć „Przyciski słuchawek / Bluetooth”.")
    }

    /// Przyciski głośności: iOS nie daje ich bezpośrednio – obserwujemy zmianę głośności (tylko gdy aplikacja jest na ekranie).
    private func watchVolume() {
        let s = AVAudioSession.sharedInstance()
        volumeObs = s.observe(\.outputVolume, options: [.new, .old]) { [weak self] _, ch in
            guard let self, self.volumeButtons, ch.oldValue != ch.newValue else { return }
            Task { @MainActor in
                guard UIApplication.shared.applicationState == .active else { return }
                IkEngine.shared.hwToggle()
            }
        }
    }

    // ---------------- lektor i sygnały (natywnie – działają w tle, w sesji dźwięku rozmów) ----------------
    private let synth = AVSpeechSynthesizer()
    private var beepPlayer: AVAudioPlayer?
    private lazy var beepWav: Data = IkAudioPlugin.makeBeep()

    @objc func speak(_ call: CAPPluginCall) {
        let text = call.getString("text") ?? "", vol = Float(call.getDouble("volume") ?? 1)
        DispatchQueue.main.async {
            guard !text.isEmpty else { return call.resolve() }
            let u = AVSpeechUtterance(string: text)
            u.voice = AVSpeechSynthesisVoice(language: "pl-PL")
            u.rate = min(AVSpeechUtteranceMaximumSpeechRate, AVSpeechUtteranceDefaultSpeechRate * 1.05)
            u.volume = max(0, min(1, vol))
            self.synth.speak(u)
            call.resolve()
        }
    }

    @objc func beep(_ call: CAPPluginCall) {
        let vol = Float(call.getDouble("volume") ?? 1)
        DispatchQueue.main.async {
            if let p = try? AVAudioPlayer(data: self.beepWav) { p.volume = max(0, min(1, vol)); p.play(); self.beepPlayer = p }
            call.resolve()
        }
    }

    /// Trzy krótkie piski 1100 Hz (jak w przeglądarce) jako WAV 16-bit mono 44,1 kHz.
    private static func makeBeep() -> Data {
        let sr = 44100.0, n = Int(sr * 0.62)
        var pcm = [Int16](repeating: 0, count: n)
        for i in 0 ..< n {
            let t = Double(i) / sr, k = t.truncatingRemainder(dividingBy: 0.22)
            guard k < 0.16 else { continue }
            let env = min(1, k / 0.02) * max(0, min(1, (0.16 - k) / 0.06))
            pcm[i] = Int16(sin(2 * .pi * 1100 * t) * env * 0.45 * 32767)
        }
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + n * 2)); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(44100); u32(88200); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(UInt32(n * 2))
        pcm.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }

    // ---------------- wybór serwera ----------------
    @objc func getServer(_ call: CAPPluginCall) {
        var r: [String: Any] = ["platform": "ios"]
        if let u = IkServer.current { r["url"] = u.absoluteString }
        if let d = getConfig().getString("defaultServer") { r["defaultUrl"] = d }
        call.resolve(r)
    }

    @objc func setServer(_ call: CAPPluginCall) {
        guard let u = IkServer.normalize(call.getString("url") ?? "") else { return call.reject("Nieprawidłowy adres serwera.") }
        IkServer.current = u
        call.resolve(["url": u.absoluteString])
        DispatchQueue.main.async { self.bridge?.webView?.load(URLRequest(url: u)) }
    }

    @objc func resetServer(_ call: CAPPluginCall) {
        call.resolve()
        DispatchQueue.main.async { self.command("reset") }
    }

    @objc func discover(_ call: CAPPluginCall) {
        let t = (call.getDouble("timeoutMs") ?? 3000) / 1000
        IkDiscovery().run(timeout: t) { list in call.resolve(["servers": list]) }
    }

    /// Nawigacja: wybrany serwer i Planning Center zostają w aplikacji; „ikapp://reset|retry” to polecenia ze stron bez dostępu do wtyczki.
    override public func shouldOverrideLoad(_ navigationAction: WKNavigationAction) -> NSNumber? {
        guard let u = navigationAction.request.url else { return nil }
        if u.scheme == "ikapp" {
            let cmd = u.host ?? ""
            DispatchQueue.main.async { self.command(cmd) }
            return true
        }
        if let h = u.host, u.scheme == "https" || u.scheme == "http", IkServer.allowed(h) { return false }
        return nil
    }

    private func command(_ cmd: String) {
        switch cmd {
        case "reset":
            IkServer.current = nil
            Task { @MainActor in await IkEngine.shared.disconnect() }
            if let l = bridge?.config.localURL { bridge?.webView?.load(URLRequest(url: l)) }
        case "retry": // ekran wyboru sprawdzi, który zapamiętany serwer odpowiada, i sam przejdzie dalej
            if let l = bridge?.config.localURL { bridge?.webView?.load(URLRequest(url: l)) }
        default: break
        }
    }
}
