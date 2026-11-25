import ActivityKit
import Foundation

/// Karta na ekranie blokady (Live Activity, iOS 16.2+). Widok karty: resources/ios-live (rozszerzenie InterkomLive) –
/// nazwa i pola tej struktury muszą być takie same w obu miejscach.
/// Przycisk na karcie tylko otwiera aplikację na ekranie „Przytrzymaj i mów”: iOS nie uruchamia przycisków karty na
/// zablokowanym telefonie (ani „Mów”, ani „Koniec”), a przytrzymania w ogóle nie zgłasza.
@available(iOS 16.2, *)
struct IkLiveAttributes: ActivityAttributes {
    struct ContentState: Codable, Hashable {
        var channel: String
        var talking: Bool
        var who: String
        var canTalk: Bool
        var online: Bool
    }
}

@MainActor
enum IkLive {
    static var enabled = UserDefaults.standard.object(forKey: "ik.live") as? Bool ?? true
    private static var current: Any?
    private static var last: Any?
    private static var lastAt = Date.distantPast
    private static var startedAt = Date.distantPast
    private static var offlineSince: Date?
    private static var dismissed = false // użytkownik usunął kartę – nie wraca do następnego uruchomienia lub zalogowania

    /// Pokaż lub odśwież. Nową kartę iOS pozwala utworzyć tylko, gdy aplikacja jest na ekranie – nieudaną próbę ponawia kolejne wywołanie.
    static func update(channel: String, talking: Bool, who: String, canTalk: Bool, online: Bool, foreground: Bool) {
        guard #available(iOS 16.2, *) else { return }
        guard enabled, ActivityAuthorizationInfo().areActivitiesEnabled else { return end() }
        offlineSince = online ? nil : offlineSince ?? Date()
        if let t = offlineSince, Date().timeIntervalSince(t) > 600 { return end() } // długo bez serwera – karta nie wisi bez sensu
        if let a = current as? Activity<IkLiveAttributes>, a.activityState == .dismissed { dismissed = true; current = nil }
        guard !dismissed else { return }
        let st = IkLiveAttributes.ContentState(channel: channel, talking: talking, who: who, canTalk: canTalk, online: online)
        // gdy aplikacja przestanie odświeżać kartę (zamknięta, zawieszona), karta sama pokaże, że Interkom jest zamknięty
        let content = ActivityContent(state: st, staleDate: Date().addingTimeInterval(100))
        // system kończy kartę po 8 godzinach – gdy aplikacja jest na ekranie, zaczynamy ją od nowa wcześniej
        if let a = current as? Activity<IkLiveAttributes>, a.activityState == .active || a.activityState == .stale, !(foreground && Date().timeIntervalSince(startedAt) > 4 * 3600) {
            if last as? IkLiveAttributes.ContentState == st, Date().timeIntervalSince(lastAt) < 30 { return }
            last = st; lastAt = Date()
            Task { await a.update(content) }
            return
        }
        guard foreground, online else { return }
        let old = Activity<IkLiveAttributes>.activities // także po poprzednim uruchomieniu aplikacji
        Task { for a in old { await a.end(nil, dismissalPolicy: .immediate) } }
        do {
            current = try Activity.request(attributes: IkLiveAttributes(), content: content)
            last = st; lastAt = Date(); startedAt = Date()
        } catch { current = nil; NSLog("[ik] karta na ekranie blokady: \(error)") }
    }

    /// Nowe zalogowanie / połączenie ze strony: karta może wrócić.
    static func allow() { dismissed = false; offlineSince = nil }

    /// Zamykanie aplikacji: iOS kończy proces zaraz po powiadomieniu, więc czekamy, aż system przyjmie usunięcie karty.
    nonisolated static func endNow() {
        guard #available(iOS 16.2, *) else { return }
        let done = DispatchSemaphore(value: 0)
        Task.detached {
            for a in Activity<IkLiveAttributes>.activities { await a.end(nil, dismissalPolicy: .immediate) }
            done.signal()
        }
        _ = done.wait(timeout: .now() + 2)
    }

    static func end() {
        guard #available(iOS 16.2, *) else { return }
        current = nil; last = nil
        let all = Activity<IkLiveAttributes>.activities
        guard !all.isEmpty else { return }
        Task { for a in all { await a.end(nil, dismissalPolicy: .immediate) } }
    }
}
