// Karta Interkomu na ekranie blokady (Live Activity). Plik kopiuje scripts/ios-setup.sh do ios/App/InterkomLive/.
// Stuknięcie karty otwiera aplikację na ekranie „Przytrzymaj i mów” (interkom://mow).
import ActivityKit
import SwiftUI
import WidgetKit

// Taka sama struktura jest w plugins/ik-audio/ios/.../IkLive.swift – zmieniaj obie naraz.
struct IkLiveAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var channel: String
        var talking: Bool
        var who: String
        var canTalk: Bool
        var online: Bool
    }
}

private let openTalk = URL(string: "interkom://mow")!
private let accent = Color(red: 0.76, green: 0.25, blue: 0)
private let live = Color(red: 0.78, green: 0.12, blue: 0.12)
private let dark = Color(red: 0.043, green: 0.051, blue: 0.071)

@main struct InterkomLive: Widget {
    var body: some WidgetConfiguration {
        ActivityConfiguration(for: IkLiveAttributes.self) { c in
            Card(s: c.state, stale: c.isStale)
                .activityBackgroundTint(dark)
                .activitySystemActionForegroundColor(.white)
                .widgetURL(openTalk)
        } dynamicIsland: { c in
            DynamicIsland {
                DynamicIslandExpandedRegion(.center) { Card(s: c.state, stale: c.isStale) }
            } compactLeading: {
                Image(systemName: "mic.fill").foregroundStyle(c.state.talking ? .red : .orange)
            } compactTrailing: {
                if c.state.talking { Text("MÓWISZ").font(.caption2.bold()).foregroundStyle(.red) }
                else if !c.state.who.isEmpty { Image(systemName: "speaker.wave.2.fill").foregroundStyle(.green) }
            } minimal: {
                Image(systemName: "mic.fill").foregroundStyle(c.state.talking ? .red : .orange)
            }
            .widgetURL(openTalk)
        }
    }
}

private struct Card: View {
    let s: IkLiveAttributes.ContentState
    let stale: Bool

    private var off: Bool { stale || !s.online }
    private var title: String { off ? "Interkom" : s.talking ? "🔴 MÓWISZ" : s.channel.isEmpty ? "Interkom" : s.channel }
    private var line: String {
        if stale { return "Aplikacja zamknięta – stuknij, aby otworzyć" }
        if !s.online { return "Łączenie z serwerem…" }
        if s.talking { return s.channel }
        return s.who.isEmpty ? "Połączono – mikrofon wyłączony" : "Mówi: \(s.who)"
    }

    var body: some View {
        HStack(spacing: 12) {
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.headline).foregroundStyle(.white).lineLimit(1)
                Text(line).font(.subheadline).foregroundStyle(.white.opacity(0.75)).lineLimit(2)
            }
            Spacer(minLength: 8)
            if s.canTalk && !off {
                Label("Mów", systemImage: "mic.fill")
                    .font(.title3.bold()).foregroundStyle(.white)
                    .padding(.horizontal, 18).padding(.vertical, 12)
                    .background(s.talking ? live : accent, in: Capsule())
            }
        }
        .padding(16)
        .accessibilityElement(children: .combine)
        .accessibilityHint("Otwiera ekran mówienia")
    }
}
