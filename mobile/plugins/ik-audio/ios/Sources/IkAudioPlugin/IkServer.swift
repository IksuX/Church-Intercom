import Foundation
import Network

/// Wybrany serwer interkomu (zapamiętany w telefonie) i wyszukiwanie serwerów w sieci lokalnej (Bonjour / mDNS).
enum IkServer {
    private static let key = "ik.server"

    static var current: URL? {
        get { UserDefaults.standard.string(forKey: key).flatMap(URL.init(string:)) }
        set { UserDefaults.standard.set(newValue?.absoluteString, forKey: key) }
    }

    /// Strony, które mogą się otwierać w aplikacji: wybrany serwer i logowanie Planning Center.
    static func allowed(_ host: String) -> Bool {
        if let h = current?.host, host.caseInsensitiveCompare(h) == .orderedSame { return true }
        return host == "planningcenteronline.com" || host.hasSuffix(".planningcenteronline.com")
    }

    /// „interkom.parafia.pl”, „192.168.1.10”, „https://…/coś” → https://host[:port]
    static func normalize(_ s: String) -> URL? {
        var t = s.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !t.isEmpty else { return nil }
        if !t.contains("://") { t = "https://" + t }
        guard var c = URLComponents(string: t), let host = c.host, !host.isEmpty,
              c.scheme == "https" || c.scheme == "http" else { return nil }
        c.path = ""; c.query = nil; c.fragment = nil; c.user = nil; c.password = nil
        return c.url
    }
}

/// Szuka usług „_interkom._tcp” ogłaszanych przez serwery (avahi na serwerze, instalowany przez install.sh).
final class IkDiscovery: @unchecked Sendable {
    private let q = DispatchQueue(label: "pl.interkom.discovery")
    private var browser: NWBrowser?
    private var found: [String: [String: String]] = [:]

    func run(timeout: Double, done: @escaping ([[String: String]]) -> Void) {
        q.async {
            let b = NWBrowser(for: .bonjourWithTXTRecord(type: "_interkom._tcp", domain: nil), using: NWParameters())
            self.browser = b
            b.browseResultsChangedHandler = { [weak self] results, _ in
                guard let self else { return }
                for r in results {
                    guard case let .service(name, _, _, _) = r.endpoint else { continue }
                    var e = ["name": name]
                    if case let .bonjour(txt) = r.metadata { for (k, v) in txt.dictionary { e[k] = v } }
                    if e["url"] != nil { self.found[name] = e }
                }
            }
            b.start(queue: self.q)
            self.q.asyncAfter(deadline: .now() + timeout) {
                b.cancel()
                self.browser = nil
                done(Array(self.found.values))
            }
        }
    }
}
