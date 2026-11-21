import AppKit
import QuartzCore

/// 仅观察已注册窗口的鼠标按下，交互和焦点交给原控件。
enum ButtonPressFeedback {
    private static let windows = NSHashTable<NSWindow>.weakObjects()
    private static var mouseMonitor: Any?

    static func install(on window: NSWindow) {
        windows.add(window)
        guard mouseMonitor == nil else { return }
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { event in
            showRipple(for: event)
            return event
        }
    }

    private static func showRipple(for event: NSEvent) {
        guard let window = event.window, windows.contains(window), let root = window.contentView,
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

private final class Ripple: NSView {
    override init(frame: NSRect) {
        super.init(frame: frame)
        autoresizingMask = [.width, .height]
        setAccessibilityElement(false)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }
    override func hitTest(_ point: NSPoint) -> NSView? { nil }
    override var mouseDownCanMoveWindow: Bool { false }

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
