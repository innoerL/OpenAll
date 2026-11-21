import AppKit
import QuartzCore
import CoreImage
import WebKit

// 装饰视图不接收鼠标、键盘或辅助功能焦点。
private class MaterialDecoration: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        setAccessibilityElement(false)
        autoresizingMask = [.width, .height]
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var mouseDownCanMoveWindow: Bool { false }
}

private final class PanelArtwork: MaterialDecoration, WindowThemeRefreshing {
    private static let imageContext = CIContext(options: [.cacheIntermediates: false])
    private var cachedFrost: NSImage?
    static func install(in view: NSView) -> PanelArtwork {
        let art = PanelArtwork(frame: view.bounds)
        view.addSubview(art, positioned: .below, relativeTo: nil)
        art.refreshWindowTheme()
        return art
    }
    func refreshWindowTheme() {
        cachedFrost = nil
        isHidden = !OpenAllTheme.usesGlass
        needsDisplay = true
    }
    // 只缓存应用自己的静态底纹，用逻辑点分辨率生成 16pt 的高斯模糊。
    // 所有卡片从同一张图按窗口坐标取样；鼠标移动、点击、滚动都不生成新底图。
    func drawFrost(in destination: NSView) {
        guard bounds.width > 0, bounds.height > 0 else { return }
        if cachedFrost?.size != bounds.size {
            let width = Int(ceil(bounds.width)), height = Int(ceil(bounds.height))
            guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
                bytesPerRow: 0, bitsPerPixel: 0), let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return }
            NSGraphicsContext.saveGraphicsState()
            NSGraphicsContext.current = context
            let base = superview?.layer?.backgroundColor.flatMap(NSColor.init(cgColor:)) ?? OpenAllTheme.canvas
            base.withAlphaComponent(1).setFill()
            bounds.fill()
            drawArtwork()
            NSGraphicsContext.restoreGraphicsState()
            guard let image = bitmap.cgImage else { return }
            let input = CIImage(cgImage: image)
            let blurred = input.clampedToExtent().applyingFilter("CIGaussianBlur", parameters: [kCIInputRadiusKey: 16])
            guard let result = Self.imageContext.createCGImage(blurred, from: input.extent) else { return }
            cachedFrost = NSImage(cgImage: result, size: bounds.size)
        }
        cachedFrost?.draw(in: destination.convert(bounds, from: self), from: .zero, operation: .sourceOver,
                          fraction: 1, respectFlipped: true, hints: nil)
    }
    override func draw(_ dirtyRect: NSRect) { drawArtwork() }
    private func drawArtwork() {
        // 色块随窗口坐标固定，输入和滚动不会触发纹理重建。
        let w = bounds.width, h = bounds.height
        let glow = NSBezierPath(ovalIn: NSRect(x: -w * 0.22, y: h * 0.25, width: w * 0.75, height: h * 1.13))
        let dusk = NSBezierPath(ovalIn: NSRect(x: w * 0.51, y: -h * 0.59, width: w * 0.78, height: h * 1.49))
        NSGradient(starting: OpenAllTheme.accent.withAlphaComponent(0.23), ending: OpenAllTheme.accent.withAlphaComponent(0))?.draw(in: glow, relativeCenterPosition: .zero)
        let blue = NSColor(srgbRed: 0.40, green: 0.60, blue: 0.83, alpha: 1)
        NSGradient(starting: blue.withAlphaComponent(0.26), ending: blue.withAlphaComponent(0))?.draw(in: dusk, relativeCenterPosition: .zero)
    }
}

private final class GlassBackplate: MaterialDecoration {
    override func draw(_ dirtyRect: NSRect) {
        let radius = superview?.layer?.cornerRadius ?? 8
        PanelMaterial.drawGlass(in: self, shape: NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius))
    }
}

enum PanelMaterial {
    private static let artworks = NSMapTable<NSWindow, PanelArtwork>.weakToWeakObjects()
    static func drawGlass(in view: NSView, shape: NSBezierPath) {
        NSGraphicsContext.saveGraphicsState()
        shape.addClip()
        if let window = view.window { artworks.object(forKey: window)?.drawFrost(in: view) }
        NSColor.white.withAlphaComponent(0.15).setFill()
        shape.fill()
        NSGraphicsContext.restoreGraphicsState()
    }

    private static let cards = NSMapTable<NSView, NSNumber>.weakToStrongObjects()
    static func registerCard(_ view: NSView, section: Bool) {
        cards.setObject(NSNumber(value: section), forKey: view)
        refreshCard(view)
    }
    static func refreshCard(_ view: NSView) {
        guard let section = cards.object(forKey: view)?.boolValue, let layer = view.layer else { return }
        let glass = OpenAllTheme.usesGlass
        layer.backgroundColor = (glass || section ? NSColor.clear : OpenAllTheme.surface).cgColor
        layer.borderColor = (glass ? NSColor.white.withAlphaComponent(0.30) : OpenAllTheme.rule).cgColor
        layer.borderWidth = glass ? 1 : section ? 0 : 0.5
        let existing = view.subviews.first { $0 is GlassBackplate }
        if glass {
            let plate = existing ?? GlassBackplate(frame: view.bounds)
            if existing == nil { view.addSubview(plate, positioned: .below, relativeTo: nil) }
            plate.needsDisplay = true
        } else { existing?.removeFromSuperview() }
    }

    static func install(on window: NSWindow, artworkSurface: NSView? = nil) {
        guard let root = window.contentView else { return }
        artworks.setObject(PanelArtwork.install(in: artworkSurface ?? root), forKey: window)
        PointerLight.install(in: root)
        if mouseMonitor == nil {
            mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
                showRipple(for: event)
                return event
            }
            NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification,
                object: nil, queue: .main) { _ in WindowChrome.refreshAllWindows() }
        }
    }

    private static var mouseMonitor: Any?
    private static let roots = NSHashTable<NSView>.weakObjects()
    fileprivate static func register(_ root: NSView) { roots.add(root) }

    private static func showRipple(for event: NSEvent) {
        guard let root = event.window?.contentView, roots.contains(root),
              !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
              !NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast else { return }
        let hit = root.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
        var view = root.hitTest(hit)
        while let current = view {
            if let button = current as? NSButton {
                guard button.isEnabled, button.action != nil else { return }
                Ripple.play(on: button, point: button.convert(event.locationInWindow, from: nil))
                return
            }
            view = current.superview
        }
    }
}

private final class PointerLight: MaterialDecoration, WindowThemeRefreshing {
    private let light = CAGradientLayer()
    private var area: NSTrackingArea?
    private var enabled = false

    static func install(in root: NSView) {
        let overlay = PointerLight(frame: root.bounds)
        overlay.wantsLayer = true
        overlay.layer?.masksToBounds = true
        overlay.layer?.cornerRadius = root.layer?.cornerRadius ?? 0
        overlay.layer?.zPosition = 50
        overlay.light.type = .radial
        overlay.light.startPoint = CGPoint(x: 0.5, y: 0.5)
        overlay.light.endPoint = CGPoint(x: 1, y: 1)
        overlay.light.colors = [NSColor.white.withAlphaComponent(0.055).cgColor, NSColor.white.withAlphaComponent(0.018).cgColor, NSColor.white.withAlphaComponent(0).cgColor]
        overlay.light.locations = [0, 0.49, 1]
        overlay.light.bounds = CGRect(x: 0, y: 0, width: 292, height: 292)
        overlay.light.opacity = 0
        overlay.layer?.addSublayer(overlay.light)
        root.addSubview(overlay)
        PanelMaterial.register(root)
        overlay.refreshWindowTheme()
    }

    func refreshWindowTheme() {
        enabled = !OpenAllTheme.isLight && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && !NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        isHidden = !enabled
        if !enabled { light.removeAllAnimations(); light.opacity = 0 }
        updateTrackingAreas()
    }
    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        if let area { removeTrackingArea(area); self.area = nil }
        guard enabled else { return }
        let next = NSTrackingArea(rect: .zero, options: [.inVisibleRect, .activeAlways, .mouseMoved, .mouseEnteredAndExited], owner: self, userInfo: nil)
        addTrackingArea(next)
        area = next
    }
    override func mouseMoved(with event: NSEvent) {
        guard enabled, let root = superview else { return }
        // 网页工具管理自己的面板反馈，编辑正文与系统共享输入框保持稳定。
        let pointer = root.superview?.convert(event.locationInWindow, from: nil) ?? event.locationInWindow
        var node = root.hitTest(pointer)
        while let view = node {
            if view is WKWebView || view is NSTextView {
                if light.opacity != 0 { fade(to: 0) }
                return
            }
            node = view.superview
        }
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        light.position = convert(event.locationInWindow, from: nil)
        CATransaction.commit()
        if light.opacity == 0 { fade(to: 1) }
    }
    override func mouseEntered(with event: NSEvent) { mouseMoved(with: event) }
    override func mouseExited(with event: NSEvent) { fade(to: 0) }
    private func fade(to value: Float) {
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = light.presentation()?.opacity ?? light.opacity
        fade.toValue = value
        fade.duration = value == 0 ? 0.16 : 0.10
        CATransaction.begin()
        CATransaction.setDisableActions(true)
        light.opacity = value
        light.add(fade, forKey: "visibility")
        CATransaction.commit()
    }
}

private final class Ripple: MaterialDecoration {
    static func play(on button: NSButton, point: CGPoint) {
        for old in button.subviews where old is Ripple { old.removeFromSuperview() }
        let clip = Ripple(frame: button.bounds)
        clip.wantsLayer = true
        clip.layer?.masksToBounds = true
        clip.layer?.cornerRadius = button.layer?.cornerRadius ?? 6
        let dot = CALayer()
        let radius = hypot(max(point.x, button.bounds.width - point.x), max(point.y, button.bounds.height - point.y)) / 4
        dot.bounds = CGRect(x: 0, y: 0, width: 2 * radius, height: 2 * radius)
        dot.cornerRadius = radius
        dot.position = point
        dot.backgroundColor = NSColor.white.withAlphaComponent(OpenAllTheme.isLight ? 0.36 : 0.18).cgColor
        dot.opacity = 0
        button.addSubview(clip)
        clip.layer?.addSublayer(dot)
        let scale = CABasicAnimation(keyPath: "transform.scale")
        scale.fromValue = 0; scale.toValue = 4
        let fade = CABasicAnimation(keyPath: "opacity")
        fade.fromValue = 1; fade.toValue = 0
        let group = CAAnimationGroup()
        group.animations = [scale, fade]
        group.duration = 0.6
        group.timingFunction = CAMediaTimingFunction(name: .easeOut)
        CATransaction.begin()
        CATransaction.setCompletionBlock { [weak clip] in clip?.removeFromSuperview() }
        dot.add(group, forKey: "press")
        CATransaction.commit()
    }
}
