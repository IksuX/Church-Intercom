// Interkom – generator ikony i ekranu startowego (CoreGraphics, bez zewnętrznych narzędzi).
// Rysuje ten sam znak co app/public/icon.svg: ciemne tło, pomarańczowe koło, biały mikrofon.
// Użycie (na Macu):  swift mobile/resources/make-icons.swift mobile/resources
// Wynik: icon.png (1024×1024, bez przezroczystości – wymóg App Store), icon-foreground.png (Android, warstwa
// przednia ikony adaptacyjnej z marginesem), splash.png (2732×2732, ekran startowy).
import AppKit
import CoreGraphics
import Foundation

let outDir = CommandLine.arguments.count > 1 ? CommandLine.arguments[1] : "."
let bg = CGColor(srgbRed: 0x0b / 255, green: 0x0d / 255, blue: 0x12 / 255, alpha: 1)
let accent = CGColor(srgbRed: 1, green: 0x56 / 255, blue: 0, alpha: 1)
let white = CGColor(srgbRed: 1, green: 1, blue: 1, alpha: 1)

/// Znak w układzie 100×100 (jak w icon.svg), przeskalowany do `size` i przesunięty o `origin`.
func drawMark(_ c: CGContext, origin: CGPoint, size: CGFloat) {
    let s = size / 100
    func p(_ x: CGFloat, _ y: CGFloat) -> CGPoint { CGPoint(x: origin.x + x * s, y: origin.y + (100 - y) * s) } // SVG: oś Y w dół
    c.setFillColor(accent)
    c.fillEllipse(in: CGRect(x: origin.x + 16 * s, y: origin.y + 16 * s, width: 68 * s, height: 68 * s))
    // kapsuła mikrofonu: x 40–60, y 29–59, promień 10
    c.setFillColor(white)
    let capsule = CGPath(roundedRect: CGRect(x: origin.x + 40 * s, y: origin.y + (100 - 59) * s, width: 20 * s, height: 30 * s), cornerWidth: 10 * s, cornerHeight: 10 * s, transform: nil)
    c.addPath(capsule); c.fillPath()
    // pałąk (łuk) i nóżka
    c.setStrokeColor(white); c.setLineWidth(4.5 * s); c.setLineCap(.round)
    c.addArc(center: p(50, 50), radius: 17 * s, startAngle: .pi, endAngle: 0, clockwise: false)
    c.strokePath()
    c.move(to: p(50, 67)); c.addLine(to: p(50, 74)); c.strokePath()
}

func render(width: Int, height: Int, alpha: Bool, _ draw: (CGContext) -> Void) -> CGImage {
    let cs = CGColorSpace(name: CGColorSpace.sRGB)!
    let info = alpha ? CGImageAlphaInfo.premultipliedLast.rawValue : CGImageAlphaInfo.noneSkipLast.rawValue
    let c = CGContext(data: nil, width: width, height: height, bitsPerComponent: 8, bytesPerRow: 0, space: cs, bitmapInfo: info)!
    c.setShouldAntialias(true); c.interpolationQuality = .high
    draw(c)
    return c.makeImage()!
}

func save(_ img: CGImage, _ name: String) {
    let rep = NSBitmapImageRep(cgImage: img)
    let data = rep.representation(using: .png, properties: [:])!
    let url = URL(fileURLWithPath: outDir).appendingPathComponent(name)
    try! data.write(to: url)
    print("zapisano \(url.path) (\(img.width)×\(img.height))")
}

// Ikona: pełne tło (system sam zaokrągla rogi), znak nieco powiększony – koło wypełnia ok. 80% ikony.
save(render(width: 1024, height: 1024, alpha: false) { c in
    c.setFillColor(bg); c.fill(CGRect(x: 0, y: 0, width: 1024, height: 1024))
    drawMark(c, origin: CGPoint(x: -100, y: -100), size: 1224)
}, "icon.png")

// Android – warstwa przednia ikony adaptacyjnej: przezroczyste tło, znak w bezpiecznym obszarze (66% środka).
save(render(width: 1024, height: 1024, alpha: true) { c in
    drawMark(c, origin: CGPoint(x: 112, y: 112), size: 800)
}, "icon-foreground.png")

// Ekran startowy: ciemne tło i mały znak na środku.
save(render(width: 2732, height: 2732, alpha: false) { c in
    c.setFillColor(bg); c.fill(CGRect(x: 0, y: 0, width: 2732, height: 2732))
    drawMark(c, origin: CGPoint(x: 1366 - 300, y: 1366 - 300), size: 600)
}, "splash.png")
