import UIKit

/// Ekran „Przytrzymaj i mów” – otwierany z karty na ekranie blokady. Natywny, więc działa od razu, także gdy strona
/// dopiero się wczytuje. Mikrofon jest otwarty tylko, gdy palec jest na przycisku.
@MainActor
final class IkPttScreen: UIViewController {
    private static weak var shown: IkPttScreen?
    private let status = UILabel(), chan = UILabel(), who = UILabel()
    private let talk = UIButton(type: .custom)
    private var timer: Timer?
    private var holding = false

    static func open(over host: UIViewController?) {
        guard shown == nil, let host else { return }
        var top = host
        while let p = top.presentedViewController, !p.isBeingDismissed { top = p }
        let vc = IkPttScreen()
        vc.modalPresentationStyle = .fullScreen
        vc.modalTransitionStyle = .crossDissolve
        shown = vc
        top.present(vc, animated: false)
    }

    override var preferredStatusBarStyle: UIStatusBarStyle { .lightContent }

    override func viewDidLoad() {
        super.viewDidLoad()
        overrideUserInterfaceStyle = .dark
        view.backgroundColor = UIColor(red: 0.043, green: 0.051, blue: 0.071, alpha: 1)
        for (l, size, weight) in [(status, 17.0, UIFont.Weight.semibold), (chan, 30.0, .bold), (who, 17.0, .regular)] {
            l.font = UIFontMetrics.default.scaledFont(for: .systemFont(ofSize: size, weight: weight), maximumPointSize: size * 1.5)
            l.adjustsFontForContentSizeCategory = true
            l.textColor = .white; l.textAlignment = .center; l.numberOfLines = 2
        }
        status.textColor = UIColor(white: 0.75, alpha: 1); who.textColor = UIColor(white: 0.75, alpha: 1)
        talk.setTitleColor(.white, for: .normal)
        talk.setTitleColor(UIColor(white: 1, alpha: 0.5), for: .disabled)
        talk.titleLabel?.font = .systemFont(ofSize: 30, weight: .bold)
        talk.titleLabel?.numberOfLines = 3; talk.titleLabel?.textAlignment = .center
        talk.isExclusiveTouch = true
        talk.addTarget(self, action: #selector(down), for: .touchDown)
        // wysunięcie palca poza przycisk nie przerywa – przerywa puszczenie palca albo przejęcie dotyku przez system
        for ev: UIControl.Event in [.touchUpInside, .touchUpOutside, .touchCancel] { talk.addTarget(self, action: #selector(up), for: ev) }
        talk.accessibilityHint = "Przytrzymaj, aby mówić. Puść, aby skończyć."
        let close = UIButton(type: .system)
        close.setTitle("Otwórz Interkom", for: .normal)
        close.titleLabel?.font = .systemFont(ofSize: 18, weight: .semibold)
        close.tintColor = UIColor(white: 0.85, alpha: 1)
        close.addTarget(self, action: #selector(closeTap), for: .touchUpInside)
        for v in [status, chan, who, talk, close] { v.translatesAutoresizingMaskIntoConstraints = false; view.addSubview(v) }
        let g = view.safeAreaLayoutGuide
        let side = talk.widthAnchor.constraint(equalTo: g.widthAnchor, multiplier: 0.78)
        side.priority = .defaultHigh
        NSLayoutConstraint.activate([
            status.topAnchor.constraint(equalTo: g.topAnchor, constant: 28),
            chan.topAnchor.constraint(equalTo: status.bottomAnchor, constant: 6),
            who.topAnchor.constraint(equalTo: chan.bottomAnchor, constant: 10),
            talk.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            talk.centerYAnchor.constraint(equalTo: g.centerYAnchor, constant: 40),
            side, talk.heightAnchor.constraint(equalTo: talk.widthAnchor),
            talk.widthAnchor.constraint(lessThanOrEqualToConstant: 360),
            talk.topAnchor.constraint(greaterThanOrEqualTo: who.bottomAnchor, constant: 16),
            talk.bottomAnchor.constraint(lessThanOrEqualTo: close.topAnchor, constant: -16),
            close.centerXAnchor.constraint(equalTo: g.centerXAnchor),
            close.bottomAnchor.constraint(equalTo: g.bottomAnchor, constant: -16),
            close.heightAnchor.constraint(greaterThanOrEqualToConstant: 48),
        ] + [status, chan, who].flatMap { [$0.leadingAnchor.constraint(equalTo: g.leadingAnchor, constant: 20), $0.trailingAnchor.constraint(equalTo: g.trailingAnchor, constant: -20)] })
        timer = Timer.scheduledTimer(withTimeInterval: 0.2, repeats: true) { [weak self] _ in Task { @MainActor in self?.refresh() } }
        refresh()
    }

    override func viewDidLayoutSubviews() { super.viewDidLayoutSubviews(); talk.layer.cornerRadius = talk.bounds.width / 2 }
    override func viewWillDisappear(_ animated: Bool) { super.viewWillDisappear(animated); release(); timer?.invalidate() }

    private func refresh() {
        let e = IkEngine.shared
        if holding, !e.talking { holding = false } // przerwane z zewnątrz (reżyser, limit, zablokowanie)
        let ready = e.isConnected && e.opts.canTalk
        status.text = !e.isConnected ? "Łączenie…" : !e.opts.canTalk ? "Nie masz prawa mówienia" : holding ? "Mówisz na kanale" : "Kanał mówienia"
        chan.text = e.channelName.isEmpty ? "Interkom" : e.channelName
        who.text = e.talkerNames.isEmpty ? " " : "Mówi: \(e.talkerNames.joined(separator: ", "))"
        talk.isEnabled = ready || holding
        talk.setTitle(holding ? "MÓWISZ\npuść, aby skończyć" : "Przytrzymaj\ni mów", for: .normal)
        talk.backgroundColor = holding ? UIColor(red: 0.78, green: 0.12, blue: 0.12, alpha: 1) : ready ? UIColor(red: 0.76, green: 0.25, blue: 0, alpha: 1) : UIColor(white: 0.2, alpha: 1)
    }

    @objc private func down() { guard !holding else { return }; holding = IkEngine.shared.screenTalk(true); refresh() }
    @objc private func up() { release(); refresh() }
    private func release() { guard holding else { return }; holding = false; _ = IkEngine.shared.screenTalk(false) }
    @objc private func closeTap() { release(); dismiss(animated: true) }
}
