import AVFoundation
import Foundation
import LiveKit
import MediaPlayer
import UIKit
import UserNotifications

/// Silnik dźwięku interkomu na iPhonie. Działa także przy zablokowanym ekranie (tryb audio w tle):
/// mikrofon jest stale „przygotowany” (wyciszony), więc aplikacja nie jest usypiana, a mówienie startuje od razu.
/// Kogo słychać, mówi serwer (wiadomość „hear” kanałem danych LiveKit) – strona w tle nie musi działać.
@MainActor
final class IkEngine: NSObject, RoomDelegate {
    static let shared = IkEngine()
    static let program = "ik-program"

    struct Opts {
        var voice = true, vol = 1.0, prog = false, progVol = 0.5, progDuck = true, duck = 0.3, canTalk = false
        var channel = "" // nazwa kanału mówienia (karta na ekranie blokady)
        var progStereo = true // transmisja przez własny odtwarzacz stereo (odtwarzanie LiveKit/WebRTC na iPhonie jest zawsze mono)
        var hiFi = false // jakość muzyczna: bez obróbki rozmowy iPhone'a (VPIO) i bez trybu rozmowy słuchawek Bluetooth
    }

    var emit: ((String, [String: Any]) -> Void)?
    private(set) var room: Room?
    private var url = "", token = "", session = "", server = ""
    var opts = Opts()
    private var hear = Set<String>()
    private var othersTalking = false
    private var lastProgLive: Bool?
    private var wanted = false
    private var beatTask: Task<Void, Never>?

    // mówienie
    private(set) var talking = false
    private var talkId: String?
    private var hwTalk = false
    private var screenHold = false // mówienie przytrzymanym przyciskiem na ekranie – kończy się razem z wyjściem z aplikacji
    private var muteTask: Task<Void, Never>?
    private var guardTask: Task<Void, Never>?
    private var limits = IkTalkLimits()
    private let tone = IkTone()

    // stan dla karty na ekranie blokady i ekranu „Przytrzymaj i mów”
    private(set) var channelName = ""
    private(set) var talkerNames: [String] = []
    var isConnected: Bool { room?.connectionState == .connected }
    private let recorder = MicRecorder()
    private var rendererAdded = false

    // transmisja w stereo
    private let progPlayer = ProgramPlayer()
    private weak var progTrack: RemoteAudioTrack?
    private var sessionMode: Bool? // nil = jeszcze nie ustawiono, true = własna konfiguracja (Bluetooth stereo)

    // ---------------- połączenie ----------------
    func connect(url: String, token: String, session: String, server: String, opts: Opts) async throws {
        self.url = url; self.token = token; self.session = session
        lastProgLive = nil
        self.server = server.hasSuffix("/") ? String(server.dropLast()) : server
        self.opts = opts
        wanted = true
        await disconnectRoom()
        if !opts.channel.isEmpty { channelName = opts.channel }
        setupRemoteCommands()
        watchApp()
        requestNotifications()
        AudioManager.shared.isSpeakerOutputPreferred = true // głośnik, gdy nie ma słuchawek
        if #available(iOS 17.0, *) { AudioManager.shared.duckingLevel = .min } // obróbka głosu iPhone'a jak najmniej ścisza odtwarzacz transmisji
        applySession()
        // wcześniejsza wersja testowa (AirPods) mogła zostawić mikrofon wyciszony w systemie – zawsze odciszamy
        if #available(iOS 17.0, *) { try? AVAudioApplication.shared.setInputMuted(false) }
        let r = Room(delegate: self)
        room = r
        emit?("state", ["state": "connecting"])
        // jedno połączenie WebRTC (nadawanie + odbiór): biblioteka zgłasza wtedy odbiór stereo dla wszystkich ścieżek
        // naraz. Przy dwóch połączeniach dopisywała stereo tylko ścieżce transmisji, iOS odrzucał taki opis
        // („All codecs must share the same … parameters”) i biblioteka wracała do mono.
        try await r.connect(url: url, token: token, connectOptions: ConnectOptions(autoSubscribe: true), roomOptions: RoomOptions(singlePeerConnection: true))
        emit?("state", ["state": "connected"])
        if !rendererAdded { AudioManager.shared.add(localAudioRenderer: recorder); rendererAdded = true }
        if opts.canTalk { await prepareMic() }
        startBeat()
        applyGates()
        refreshCards()
    }

    func disconnect() async {
        wanted = false
        if talking { if hwTalk { hwTalkSet(false) } else { setMic(false, nil) } }
        IkLive.end()
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        beatTask?.cancel()
        _ = await post("/api/native/bye", [:])
        await disconnectRoom()
        progPlayer.stop()
        try? await AudioManager.shared.setRecordingAlwaysPreparedMode(false)
        emit?("state", ["state": "disconnected"])
    }

    private func disconnectRoom() async {
        if let r = room { await r.disconnect() }
        room = nil
        progTrack?.remove(audioRenderer: progPlayer); progTrack = nil
    }

    /// Sesja dźwięku. Domyślnie ustawia ją LiveKit: tryb rozmowy z obróbką głosu iPhone'a (usuwanie echa) – wtedy iOS
    /// gra wszystko „jak w rozmowie telefonicznej”, a słuchawki Bluetooth przechodzą w tryb rozmowy (mono, z ich mikrofonem).
    /// „Jakość muzyczna” (do słuchawek): bez obróbki iPhone'a (zostaje programowe usuwanie echa WebRTC), zwykły tryb
    /// odtwarzania, słuchawki Bluetooth w trybie muzycznym (A2DP) – mówi się wtedy do mikrofonu telefonu.
    private func applySession() {
        let want = opts.hiFi
        guard sessionMode != want else { return }
        sessionMode = want
        do { try AudioManager.shared.setPlatformVoiceProcessingAllowed(!want) } catch { NSLog("[ik] obróbka głosu: \(error)") }
        AudioManager.shared.audioSession.isAutomaticConfigurationEnabled = !want
        guard want else { return }
        let s = AVAudioSession.sharedInstance()
        do {
            try s.setCategory(.playAndRecord, mode: .default, options: [.defaultToSpeaker, .allowBluetoothA2DP, .allowAirPlay])
            try s.setActive(true)
        } catch { NSLog("[ik] sesja dźwięku: \(error)") }
        progPlayer.restart()
    }

    func configure(_ o: Opts) {
        let could = opts.canTalk, hi = opts.hiFi
        opts = o
        if !o.channel.isEmpty { channelName = o.channel }
        refreshCards()
        if o.hiFi != hi { applySession() }
        applyGates()
        if o.canTalk && !could { Task { await prepareMic() } }
        if !o.canTalk && talking { setMic(false, nil) }
        Task { await beat() } // serwer od razu przeliczy, kogo słychać
    }

    private func prepareMic() async {
        guard let r = room else { return }
        do {
            // mikrofon stale gotowy (wyciszony): mówienie startuje bez opóźnienia, a iOS nie usypia aplikacji w tle
            try await AudioManager.shared.setRecordingAlwaysPreparedMode(true)
            let pub = try await r.localParticipant.setMicrophone(enabled: true)
            if !talking { try await pub?.mute() }
        } catch {
            emit?("notice", ["message": "Brak dostępu do mikrofonu – zezwól w Ustawienia → Interkom."])
        }
    }

    private var micPub: LocalTrackPublication? {
        room?.localParticipant.firstAudioPublication as? LocalTrackPublication
    }

    // ---------------- zdarzenia LiveKit ----------------
    nonisolated func room(_ room: Room, didUpdateConnectionState connectionState: ConnectionState, from oldConnectionState: ConnectionState) {
        Task { @MainActor in
            switch connectionState {
            case .connected: self.emit?("state", ["state": "connected"]); self.applyGates(); self.refreshCards()
            case .reconnecting: self.emit?("state", ["state": "reconnecting"]); self.refreshCards()
            case .disconnected:
                self.emit?("state", ["state": "disconnected"])
                if self.wanted { self.refreshCards() }
                if self.wanted, self.room === room { self.scheduleReconnect() }
            default: break
            }
        }
    }
    nonisolated func room(_ room: Room, participant: RemoteParticipant, didSubscribeTrack publication: RemoteTrackPublication) { Task { @MainActor in self.applyGates() } }
    nonisolated func room(_ room: Room, participant: RemoteParticipant, didPublishTrack publication: RemoteTrackPublication) { Task { @MainActor in self.applyGates() } }
    nonisolated func room(_ room: Room, participant: RemoteParticipant, didUnpublishTrack publication: RemoteTrackPublication) { Task { @MainActor in self.applyGates() } }
    nonisolated func room(_ room: Room, participantDidConnect participant: RemoteParticipant) { Task { @MainActor in self.applyGates() } }
    nonisolated func room(_ room: Room, participantDidDisconnect participant: RemoteParticipant) { Task { @MainActor in self.applyGates() } }
    nonisolated func room(_ room: Room, participant: RemoteParticipant?, didReceiveData data: Data, forTopic topic: String, encryptionType: EncryptionType) {
        guard topic == "ik" else { return }
        Task { @MainActor in self.onServerData(data) }
    }

    private func scheduleReconnect() {
        Task {
            try? await Task.sleep(nanoseconds: 3_000_000_000)
            guard wanted, room?.connectionState != .connected else { return }
            do { try await connect(url: url, token: token, session: session, server: server, opts: opts) }
            catch { scheduleReconnect() }
        }
    }

    // ---------------- kogo słychać ----------------
    private func onServerData(_ data: Data) {
        guard let j = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return }
        switch j["t"] as? String {
        case "hear":
            hear = Set((j["ids"] as? [String]) ?? [])
            othersTalking = (j["talking"] as? Bool) ?? false
            talkerNames = (j["names"] as? [String]) ?? []
            refreshCards()
            applyGates()
        case "notify":
            showNotification(j)
        case "forceMute": // reżyser / administrator wyciszył mój mikrofon
            let by = j["by"] as? String ?? "Reżyser"
            if talking { if hwTalk { hwTalkSet(false) } else { setMic(false, nil) } }
            haptic(false)
            let limit = j["limit"] as? Bool ?? false // serwer: przekroczony limit czasu nadawania
            emit?("forceMute", ["by": by, "limit": limit])
            if limit { tone.play(.auto) }
            showNotification(["title": limit ? "🎙️ Mikrofon wyłączony" : "🔇 Wyciszono Twój mikrofon", "body": limit ? "Minął limit czasu nadawania." : "\(by) wyłączył(a) Twoje mówienie – mikrofon był włączony.", "urgent": true, "tag": "mute"])
        case "moveTo": // przeniesiono mnie na inny kanał (serwer już ustawił kanał mówienia)
            let by = j["by"] as? String ?? "Reżyser", ch = j["channel"] as? String ?? ""
            emit?("moveTo", ["channel": ch, "by": by])
            showNotification(["title": "↪ Zmiana kanału", "body": "\(by) przeniósł(a) Cię na inny kanał.", "urgent": true, "tag": "move"])
        default: break
        }
    }

    func applyGates() {
        guard let r = room else { return }
        var progLive = false
        for (identity, p) in r.remoteParticipants {
            let id = identity.stringValue
            let isProg = id == IkEngine.program
            for case let pub as RemoteTrackPublication in p.trackPublications.values where pub.kind == .audio {
                if isProg { progLive = true }
                let on = isProg ? opts.prog : (opts.voice && hear.contains(id))
                if pub.isEnabled != on { Task { try? await pub.set(enabled: on) } }
                let vol = isProg ? opts.progVol * ((opts.progDuck && (othersTalking || talking)) ? opts.duck : 1.0) : opts.vol
                let track = pub.track as? RemoteAudioTrack
                if isProg { progStereo(track, on: on, vol: vol) } else { track?.volume = vol }
            }
        }
        if !progLive { progStereo(nil, on: false, vol: 0) }
        if progLive != lastProgLive { lastProgLive = progLive; emit?("program", ["live": progLive]) } // tylko zmiana
    }

    /// Transmisja: dekoder LiveKit daje stereo, ale wbudowane odtwarzanie WebRTC miksuje je do mono – dlatego
    /// dźwięk transmisji idzie do własnego odtwarzacza (osobny AVAudioEngine), a w LiveKit ma głośność 0.
    private func progStereo(_ track: RemoteAudioTrack?, on: Bool, vol: Double) {
        if progTrack !== track {
            progTrack?.remove(audioRenderer: progPlayer)
            progTrack = track
            if opts.progStereo { track?.add(audioRenderer: progPlayer) }
        }
        guard let track else { progPlayer.stop(); return }
        if opts.progStereo && on {
            track.volume = 0
            progPlayer.volume = Float(vol)
            progPlayer.start()
        } else {
            progPlayer.stop()
            track.volume = vol
        }
        if opts.progStereo { track.add(audioRenderer: progPlayer) } else { track.remove(audioRenderer: progPlayer) } // przełącznik w ustawieniach
    }

    // ---------------- mówienie ----------------
    /// Ze strony (przycisk na ekranie) – strona już powiadomiła serwer.
    func setMic(_ on: Bool, _ id: String?, hold: Bool = false) {
        if on {
            muteTask?.cancel(); guardTask?.cancel()
            talking = true; talkId = id; screenHold = hold; hwTalk = false
            recorder.start()
            Task { try? await micPub?.unmute() }
        } else {
            guard talking else { return }
            talking = false; hwTalk = false; screenHold = false
            guardTask?.cancel()
            let tid = talkId; talkId = nil
            muteTask = Task { try? await Task.sleep(nanoseconds: 250_000_000); if !talking { try? await micPub?.mute() } } // nie ucinaj końcówki
            Task {
                try? await Task.sleep(nanoseconds: 450_000_000)
                if let tid, let wav = recorder.stop() { await upload(tid, wav) }
            }
        }
        applyGates()
        refreshCards()
    }

    /// Z przycisku słuchawek / Bluetooth – serwer powiadamiamy sami (strona może spać).
    func hwToggle() { hwTalkSet(!talking) }

    /// Ekran „Przytrzymaj i mów”: mikrofon tylko przy palcu na przycisku (bez sygnałów i limitów trybu włącz/wyłącz).
    func screenTalk(_ on: Bool) -> Bool {
        if on { guard opts.canTalk, isConnected, !talking else { haptic(false); return false } }
        else { guard talking else { return false } }
        hwTalkSet(on, hold: true)
        return on
    }

    func hwTalkSet(_ on: Bool, hold: Bool = false) {
        if on {
            guard opts.canTalk, room != nil else { haptic(false); return }
            muteTask?.cancel()
            let toggle = !hold
            hwTalk = true; talking = true; screenHold = hold; talkId = nil
            talkSeq += 1
            let seq = talkSeq
            recorder.start()
            Task { try? await micPub?.unmute() }
            haptic(true)
            if toggle { tone.play(.start); startGuard() }
            let prev = pttPost
            pttPost = Task { // po kolei: krótkie naciśnięcie nie może wysłać „koniec” przed „mówię”
                await prev?.value
                let res = await post("/api/native/ptt", ["on": true, "mode": toggle ? "toggle" : "hold"])
                guard seq == talkSeq, talking else { return } // już puszczone
                guard let id = res?["talkId"] as? String else { setMic(false, nil); haptic(false); return }
                talkId = id
                emit?("ptt", ["on": true, "talkId": id])
            }
            applyGates()
            refreshCards()
        } else {
            let wasToggle = hwTalk && !screenHold
            talkSeq += 1
            setMic(false, nil)
            if wasToggle { tone.play(.stop) }
            let prev = pttPost
            pttPost = Task { await prev?.value; _ = await post("/api/native/ptt", ["on": false]) }
            emit?("ptt", ["on": false])
        }
    }
    private var talkSeq = 0
    private var pttPost: Task<Void, Never>?

    // ---------------- zabezpieczenie przed zapomnianym mikrofonem ----------------
    /// Tryb włącz/wyłącz (słuchawki, pilot, pauza na ekranie blokady): sygnał co kilka sekund, wyłączenie po ciszy i po limicie czasu.
    private func startGuard() {
        guardTask?.cancel()
        recorder.resetVoice()
        recorder.ignoreVoice(0.6) // sygnał startu
        let t0 = Date()
        var reminded = t0
        guardTask = Task {
            while !Task.isCancelled {
                try? await Task.sleep(nanoseconds: 300_000_000)
                guard !Task.isCancelled, talking, hwTalk, !screenHold else { return }
                let now = Date()
                if now.timeIntervalSince(t0) >= limits.max { return autoStop("max") }
                if limits.silence > 0, now.timeIntervalSince(recorder.lastVoice) >= limits.silence { return autoStop("silence") }
                if limits.remind > 0, now.timeIntervalSince(reminded) >= limits.remind {
                    reminded = now
                    recorder.ignoreVoice(0.5)
                    tone.play(.remind)
                }
            }
        }
    }

    private func autoStop(_ reason: String) {
        hwTalkSet(false)
        tone.play(.auto)
        haptic(false)
        emit?("talkEnded", ["reason": reason])
        showNotification(["title": "🎙️ Mikrofon wyłączony", "body": reason == "silence" ? "Była cisza – nadawanie zakończone." : "Minął limit czasu nadawania.", "urgent": true, "tag": "mute"])
    }

    private var appWatched = false
    private func watchApp() {
        guard !appWatched else { return }
        appWatched = true
        // wyjście z aplikacji / zablokowanie telefonu w trakcie przytrzymywania przycisku na ekranie = koniec mówienia;
        // pilnuje tego część natywna, bo strona mogła już zostać uśpiona
        NotificationCenter.default.addObserver(forName: UIApplication.willResignActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in IkEngine.shared.endScreenHold() }
        }
        NotificationCenter.default.addObserver(forName: UIApplication.didBecomeActiveNotification, object: nil, queue: .main) { _ in
            Task { @MainActor in IkEngine.shared.refreshCards() } // kartę można utworzyć tylko z aplikacji na ekranie
        }
        // zamknięcie aplikacji (przesunięcie w górę): od razu, w tym samym wywołaniu – na Task nie ma już czasu
        NotificationCenter.default.addObserver(forName: UIApplication.willTerminateNotification, object: nil, queue: nil) { _ in IkLive.endNow() }
    }

    private func endScreenHold() {
        guard talking, screenHold else { return }
        hwTalkSet(false)
    }

    // ---------------- karta na ekranie blokady i karta odtwarzacza ----------------
    private var lastNow = ""
    func refreshCards() {
        guard wanted else { return }
        IkLive.update(channel: channelName, talking: talking, who: talkerNames.joined(separator: ", "), canTalk: opts.canTalk, online: isConnected,
                      foreground: UIApplication.shared.applicationState == .active)
        let title = talking ? "🔴 MÓWISZ\(channelName.isEmpty ? "" : " – \(channelName)")" : "Interkom\(channelName.isEmpty ? "" : " – \(channelName)")"
        let line = !mediaButtons || !opts.canTalk ? (isConnected ? "Połączony" : "Łączenie…") : talking ? "Naciśnij przycisk, aby skończyć" : "Przycisk = mów / koniec"
        guard title + line != lastNow else { return }
        lastNow = title + line
        MPNowPlayingInfoCenter.default().nowPlayingInfo = [MPMediaItemPropertyTitle: title, MPMediaItemPropertyArtist: line, MPNowPlayingInfoPropertyPlaybackRate: 1.0]
    }

    func setLive(_ on: Bool) {
        IkLive.enabled = on
        UserDefaults.standard.set(on, forKey: "ik.live")
        if on { refreshCards() } else { IkLive.end() }
    }

    // przyciski słuchawek i Bluetooth (play/pauza) – iOS przekazuje je jako „naciśnięcie”, bez puszczenia
    private var commandsReady = false
    var mediaButtons = UserDefaults.standard.object(forKey: "ik.media") as? Bool ?? true {
        didSet { UserDefaults.standard.set(mediaButtons, forKey: "ik.media"); refreshCards() }
    }
    private func setupRemoteCommands() {
        guard !commandsReady else { return }
        commandsReady = true
        UIApplication.shared.beginReceivingRemoteControlEvents()
        let c = MPRemoteCommandCenter.shared()
        let handler: (MPRemoteCommandEvent) -> MPRemoteCommandHandlerStatus = { [weak self] _ in
            guard let self, self.mediaButtons, self.wanted else { return .commandFailed }
            self.hwToggle()
            return .success
        }
        c.togglePlayPauseCommand.isEnabled = true; c.togglePlayPauseCommand.addTarget(handler: handler)
        c.playCommand.isEnabled = true; c.playCommand.addTarget(handler: handler)
        c.pauseCommand.isEnabled = true; c.pauseCommand.addTarget(handler: handler)
        refreshCards()
    }

    // ---------------- zgłaszanie się serwerowi ----------------
    private func startBeat() {
        beatTask?.cancel()
        beatTask = Task { while !Task.isCancelled { await beat(); try? await Task.sleep(nanoseconds: 20_000_000_000) } }
    }

    private func beat() async {
        guard let res = await post("/api/native/beat", ["voice": opts.voice, "prog": opts.prog]) else { refreshCards(); return }
        if let ids = res["hear"] as? [String] { hear = Set(ids); applyGates() }
        if let g = res["talkGuard"] as? [String: Any] { limits = .from(g) }
        if let n = res["targetName"] as? String, !n.isEmpty { channelName = n }
        if let n = res["names"] as? [String] { talkerNames = n }
        refreshCards() // co 20 s: karta wie, że aplikacja żyje
        if let can = res["canTalk"] as? Bool, can != opts.canTalk { var o = opts; o.canTalk = can; configure(o) }
    }

    private func post(_ path: String, _ body: [String: Any]) async -> [String: Any]? {
        guard let u = URL(string: server + path) else { return nil }
        var rq = URLRequest(url: u, timeoutInterval: 8)
        rq.httpMethod = "POST"
        rq.setValue("application/json", forHTTPHeaderField: "content-type")
        rq.setValue("Bearer \(session)", forHTTPHeaderField: "authorization")
        rq.httpBody = try? JSONSerialization.data(withJSONObject: body)
        guard let (data, resp) = try? await URLSession.shared.data(for: rq), let h = resp as? HTTPURLResponse, h.statusCode < 400 else { return nil }
        return (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] ?? [:]
    }

    private func upload(_ talkId: String, _ wav: Data) async {
        guard let u = URL(string: "\(server)/api/stt/\(talkId)") else { return }
        var rq = URLRequest(url: u, timeoutInterval: 20)
        rq.httpMethod = "POST"
        rq.setValue("audio/wav", forHTTPHeaderField: "content-type")
        rq.setValue("Bearer \(session)", forHTTPHeaderField: "authorization")
        _ = try? await URLSession.shared.upload(for: rq, from: wav)
    }

    // ---------------- powiadomienia ----------------
    private func requestNotifications() {
        Task.detached { _ = try? await UNUserNotificationCenter.current().requestAuthorization(options: [.alert, .sound, .badge]) } // bez domknięcia – wywołanie zwrotne przychodzi poza wątkiem głównym
    }

    private func showNotification(_ j: [String: Any]) {
        guard UIApplication.shared.applicationState != .active else { return } // na ekranie komunikat pokaże strona
        let c = UNMutableNotificationContent()
        c.title = j["title"] as? String ?? "Interkom"
        c.body = j["body"] as? String ?? ""
        let urgent = j["urgent"] as? Bool ?? false
        c.sound = .default
        if #available(iOS 15.0, *) { c.interruptionLevel = urgent ? .timeSensitive : .active }
        let tag = (j["tag"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        UNUserNotificationCenter.current().add(UNNotificationRequest(identifier: tag, content: c, trigger: nil))
    }

    private func haptic(_ ok: Bool) {
        let g = UINotificationFeedbackGenerator()
        g.notificationOccurred(ok ? .success : .error)
    }
}

/// Kopia mikrofonu do transkrypcji: zbierana w trakcie mówienia, zamieniana na WAV 16 kHz mono.
final class MicRecorder: NSObject, AudioRenderer, @unchecked Sendable {
    private let lock = NSLock()
    private var on = false
    private var samples: [Float] = []
    private var rate: Double = 48000
    private let maxSeconds = 120.0
    private var meter = IkVoiceMeter()

    var lastVoice: Date { lock.lock(); defer { lock.unlock() }; return meter.lastVoice }
    func resetVoice() { lock.lock(); meter.reset(); lock.unlock() }
    func ignoreVoice(_ s: Double) { lock.lock(); meter.ignore(s); lock.unlock() }

    private func measure(_ b: AVAudioPCMBuffer) { // wywoływane pod blokadą
        let n = Int(b.frameLength); guard n > 0 else { return }
        var sum: Float = 0
        if let f = b.floatChannelData { for k in 0 ..< n { sum += f[0][k] * f[0][k] } }
        else if let i = b.int16ChannelData { for k in 0 ..< n { let v = Float(i[0][k]) / 32768; sum += v * v } }
        else { return }
        meter.feed(rms: (sum / Float(n)).squareRoot(), seconds: Float(Double(n) / b.format.sampleRate))
    }

    func start() { lock.lock(); samples.removeAll(keepingCapacity: true); on = true; lock.unlock() }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        lock.lock(); defer { lock.unlock() }
        guard on else { return }
        measure(pcmBuffer)
        guard Double(samples.count) < rate * maxSeconds else { return }
        rate = pcmBuffer.format.sampleRate
        let n = Int(pcmBuffer.frameLength)
        if let f = pcmBuffer.floatChannelData { samples.append(contentsOf: UnsafeBufferPointer(start: f[0], count: n)) }
        else if let i = pcmBuffer.int16ChannelData { for k in 0 ..< n { samples.append(Float(i[0][k]) / 32768) } }
    }

    func stop() -> Data? {
        lock.lock(); on = false; let src = samples; let sr = rate; samples.removeAll(); lock.unlock()
        guard Double(src.count) > sr * 0.5 else { return nil } // krócej niż pół sekundy – bez transkrypcji
        let ratio = sr / 16000, outN = Int(Double(src.count) / ratio)
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + outN * 2)); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(16000); u32(32000); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(UInt32(outN * 2))
        for i in 0 ..< outN { // uśrednianie okna – prosty filtr przed zmniejszeniem częstotliwości
            let a = Int(Double(i) * ratio), b = max(a + 1, min(src.count, Int(Double(i + 1) * ratio)))
            var s: Float = 0; for k in a ..< b { s += src[k] }
            let v = Int16(max(-1, min(1, s / Float(b - a))) * 32767)
            u16(UInt16(bitPattern: v))
        }
        return d
    }
}

/// Odtwarzacz transmisji w stereo. Dostaje zdekodowany dźwięk ścieżki (10 ms naraz) i gra go przez własny AVAudioEngine.
/// Kolejka ograniczona do ok. 120 ms – gdy rośnie (różnica zegarów), nadmiar jest pomijany, żeby opóźnienie nie narastało.
final class ProgramPlayer: NSObject, AudioRenderer, @unchecked Sendable {
    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private let fmt = AVAudioFormat(standardFormatWithSampleRate: 48000, channels: 2)!
    private let lock = NSLock()
    private var running = false
    private var queued: AVAudioFrameCount = 0
    private var conv: AVAudioConverter?
    private var convFrom: AVAudioFormat?
    private let maxQueue: AVAudioFrameCount = 5760 // 120 ms
    private let cushion: AVAudioFrameCount = 1440  // 30 ms ciszy po przerwie – zapas na nierówne porcje

    var volume: Float = 1 { didSet { node.volume = volume } }

    override init() {
        super.init()
        engine.attach(node)
        engine.connect(node, to: engine.mainMixerNode, format: fmt)
        NotificationCenter.default.addObserver(self, selector: #selector(configChanged), name: .AVAudioEngineConfigurationChange, object: engine)
    }

    @objc private func configChanged() { // zmiana słuchawek / wyjścia / częstotliwości – silnik zatrzymuje się sam
        lock.lock(); let was = running; running = false; queued = 0; lock.unlock()
        guard was else { return }
        DispatchQueue.main.async {
            // stare porcje są zaplanowane w starym układzie – wyczyść i połącz od nowa z aktualnym sprzętem
            self.node.stop(); self.engine.stop()
            self.lock.lock(); self.queued = 0; self.lock.unlock()
            self.start()
        }
    }

    func start() { // tylko z wątku głównego; silnik uruchamiany poza blokadą (jego powiadomienia też ją biorą)
        lock.lock(); let already = running; lock.unlock()
        guard !already else { return }
        do {
            if !engine.isRunning { rewireOutput(); engine.prepare(); try engine.start() }
            node.play()
            lock.lock(); running = true; queued = 0; lock.unlock()
        } catch { NSLog("[ik] odtwarzacz transmisji: \(error)") }
    }

    /// Połączenie mikser → wyjście musi mieć częstotliwość sprzętu. Po zmianie trasy (AirPods przechodzą z A2DP 48 kHz
    /// w tryb rozmowy 16/24 kHz, inne słuchawki, ustawienia WebRTC) stare połączenie zostawało na starej częstotliwości
    /// i transmisja grała za szybko / za wolno – zmieniała się wysokość dźwięku.
    private func rewireOutput() {
        let hw = engine.outputNode.outputFormat(forBus: 0)
        guard hw.sampleRate > 0, hw.channelCount > 0 else { return }
        let cur = engine.outputNode.inputFormat(forBus: 0)
        if cur.sampleRate == hw.sampleRate && cur.channelCount == min(hw.channelCount, 2) { return }
        guard let f = AVAudioFormat(standardFormatWithSampleRate: hw.sampleRate, channels: min(hw.channelCount, 2)) else { return }
        engine.disconnectNodeInput(engine.outputNode)
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: f)
        NSLog("[ik] odtwarzacz transmisji: wyjście \(Int(hw.sampleRate)) Hz, \(f.channelCount) kan.")
    }

    func stop() {
        lock.lock()
        let active = running || engine.isRunning
        running = false; queued = 0
        lock.unlock()
        guard active else { return }
        // poza blokadą: node.stop() od razu wywołuje „zakończenie” zaplanowanych porcji, które same biorą blokadę
        // (wcześniej to zawieszało aplikację przy wyłączaniu stereo / słuchania)
        node.stop(); engine.stop()
        lock.lock(); queued = 0; lock.unlock()
    }

    func restart() {
        lock.lock(); let was = running; lock.unlock()
        guard was else { return }
        stop(); start()
    }

    func render(pcmBuffer: AVAudioPCMBuffer) {
        lock.lock()
        let ok = running && queued < maxQueue
        let empty = queued == 0
        lock.unlock()
        guard ok, pcmBuffer.frameLength > 0, let out = convert(pcmBuffer) else { return }
        if empty, let pad = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cushion) {
            pad.frameLength = cushion // zera = cisza
            schedule(pad)
        }
        schedule(out)
    }

    private func schedule(_ b: AVAudioPCMBuffer) {
        let n = b.frameLength
        lock.lock(); queued += n; lock.unlock()
        node.scheduleBuffer(b) { [weak self] in
            guard let self else { return }
            self.lock.lock(); self.queued = self.queued >= n ? self.queued - n : 0; self.lock.unlock()
        }
    }

    private func convert(_ inBuf: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        let f = inBuf.format
        if f == fmt { return inBuf.copy() as? AVAudioPCMBuffer }
        if conv == nil || convFrom != f { conv = AVAudioConverter(from: f, to: fmt); convFrom = f }
        guard let conv else { return nil }
        let cap = AVAudioFrameCount(Double(inBuf.frameLength) * fmt.sampleRate / f.sampleRate) + 32
        guard let out = AVAudioPCMBuffer(pcmFormat: fmt, frameCapacity: cap) else { return nil }
        var given = false
        var err: NSError?
        _ = conv.convert(to: out, error: &err) { _, status in
            if given { status.pointee = .noDataNow; return nil }
            given = true; status.pointee = .haveData; return inBuf
        }
        return err == nil && out.frameLength > 0 ? out : nil
    }
}
