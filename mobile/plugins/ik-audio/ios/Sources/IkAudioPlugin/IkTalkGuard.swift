import AVFoundation
import Foundation

/// Zabezpieczenie przed zapomnianym mikrofonem (mówienie włączane bez przytrzymywania): limity z panelu serwera.
struct IkTalkLimits: Equatable {
    var max = 60.0, silence = 8.0, remind = 10.0 // sekundy; silence / remind: 0 = wyłączone

    static func from(_ j: [String: Any]) -> IkTalkLimits {
        func n(_ k: String, _ d: Double) -> Double { (j[k] as? NSNumber)?.doubleValue ?? d }
        let d = IkTalkLimits()
        return IkTalkLimits(max: Swift.max(10, n("max", d.max)), silence: n("silence", d.silence), remind: n("remind", d.remind))
    }
}

/// Wykrywanie mowy: głośność wyraźnie ponad tłem (tło dopasowuje się samo – w głośnym miejscu próg rośnie).
/// Gdy tło jest bardzo głośne i zmienne, ciszy nie da się rozpoznać – wtedy działa limit czasu.
struct IkVoiceMeter {
    private var floor: Float = 0.01
    private(set) var lastVoice = Date()
    private var ignoreUntil = Date.distantPast

    mutating func reset() { floor = 0.01; lastVoice = Date(); ignoreUntil = .distantPast }
    mutating func ignore(_ seconds: Double) { ignoreUntil = Date().addingTimeInterval(seconds) } // własny sygnał to nie mowa
    mutating func feed(rms: Float, seconds: Float) {
        let now = Date()
        guard now > ignoreUntil else { return }
        floor = rms < floor ? rms : min(0.05, floor + (rms - floor) * min(1, seconds * 0.15))
        if rms > Swift.max(0.006, floor * 2.2) { lastVoice = now }
    }
}

/// Krótkie sygnały (start, koniec, przypomnienie, wyłączenie samoczynne) – grane w sesji dźwięku rozmów, działają w tle.
@MainActor
final class IkTone {
    enum Kind { case start, stop, remind, auto }
    private var player: AVAudioPlayer?
    private var cache: [String: Data] = [:]

    func play(_ k: Kind) {
        let notes: [(Double, Double)] // Hz, sekundy (0 Hz = cisza)
        switch k {
        case .start: notes = [(880, 0.07), (1320, 0.09)]
        case .stop: notes = [(1320, 0.07), (880, 0.09)]
        case .remind: notes = [(1000, 0.07)]
        case .auto: notes = [(660, 0.14), (0, 0.08), (660, 0.14), (0, 0.08), (440, 0.25)]
        }
        let key = "\(k)"
        let data = cache[key] ?? IkTone.wav(notes)
        cache[key] = data
        guard let p = try? AVAudioPlayer(data: data) else { return }
        p.volume = k == .auto ? 0.8 : 0.35
        p.play()
        player = p
    }

    /// WAV 16-bit mono 44,1 kHz.
    static func wav(_ notes: [(Double, Double)]) -> Data {
        let sr = 44100.0
        var pcm: [Int16] = []
        for (hz, sec) in notes {
            let n = Int(sr * sec)
            for i in 0 ..< n {
                let t = Double(i) / sr, env = Swift.min(1, t / 0.008) * Swift.min(1, (sec - t) / 0.02)
                pcm.append(hz > 0 ? Int16(sin(2 * .pi * hz * t) * env * 0.5 * 32767) : 0)
            }
        }
        var d = Data()
        func u32(_ v: UInt32) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 4)) }
        func u16(_ v: UInt16) { var x = v.littleEndian; d.append(Data(bytes: &x, count: 2)) }
        d.append("RIFF".data(using: .ascii)!); u32(UInt32(36 + pcm.count * 2)); d.append("WAVE".data(using: .ascii)!)
        d.append("fmt ".data(using: .ascii)!); u32(16); u16(1); u16(1); u32(44100); u32(88200); u16(2); u16(16)
        d.append("data".data(using: .ascii)!); u32(UInt32(pcm.count * 2))
        pcm.withUnsafeBufferPointer { d.append(Data(buffer: $0)) }
        return d
    }
}
