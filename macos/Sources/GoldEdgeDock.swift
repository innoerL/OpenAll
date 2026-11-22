import AppKit

private final class GoldRailPanel: NSPanel {
    override var canBecomeKey: Bool { false }
    override var canBecomeMain: Bool { false }
}

private final class GoldRailView: NSView, WindowThemeRefreshing {
    var onOpen: (() -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        let tab = NSRect(x: bounds.midX - 8, y: bounds.midY - 12, width: 16, height: 24)
        OpenAllTheme.accent.setFill()
        NSBezierPath(roundedRect: tab, xRadius: 5, yRadius: 5).fill()
        // 两层金锭在窄边条上保留一个像素的间隙。
        let mark = NSBezierPath()
        for (x, y) in [(CGFloat(5), CGFloat(12.5)), (1.5, 8), (8.5, 8)] {
            mark.move(to: NSPoint(x: tab.minX + x, y: tab.minY + y))
            mark.line(to: NSPoint(x: tab.minX + x + 6, y: tab.minY + y))
            mark.line(to: NSPoint(x: tab.minX + x + 5, y: tab.minY + y + 3.5))
            mark.line(to: NSPoint(x: tab.minX + x + 1, y: tab.minY + y + 3.5))
            mark.close()
        }
        OpenAllTheme.onAccent.setFill()
        mark.fill()
    }

    override func mouseDown(with event: NSEvent) { onOpen?() }
    override func accessibilityPerformPress() -> Bool { onOpen?(); return true }
    func refreshWindowTheme() { needsDisplay = true }
}

/// 左右边缘吸附与悬停展开由 AppKit 管理，不依赖网页或其他应用进程。
final class GoldEdgeDock {
    let window: NSPanel
    let rail: NSPanel
    private(set) var side: String?
    private(set) var collapsed = false
    private(set) var enabled = false
    private(set) var suspended = false
    private(set) var updatingFrame = false
    var pinned: () -> Bool = { true }
    var persistPosition: ((NSRect) -> Void)?
    var onMotion: ((String?, Bool) -> Void)?
    private var timer: Timer?
    private var animation: Timer?
    private var progress: CGFloat = 1
    private var hoverSince: TimeInterval?
    private var leftSince: TimeInterval?
    private var lastMove: TimeInterval?
    private var requireExit = false

    init(window: NSPanel) {
        self.window = window
        rail = GoldRailPanel(contentRect: NSRect(x: 0, y: 0, width: 16, height: 68),
            styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        rail.title = "OpenAll 金价贴边条"
        rail.isReleasedWhenClosed = false
        rail.isOpaque = false
        rail.backgroundColor = .clear
        rail.hasShadow = false
        rail.hidesOnDeactivate = false
        rail.level = .floating
        rail.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary, .ignoresCycle]
        let view = GoldRailView(frame: NSRect(x: 0, y: 0, width: 16, height: 68))
        view.setAccessibilityElement(true)
        view.setAccessibilityRole(.button)
        view.setAccessibilityLabel("展开 OpenAll 金价")
        view.onOpen = { [weak self] in self?.expand() }
        rail.contentView = view
        let timer = Timer(timeInterval: 0.05, repeats: true) { [weak self] _ in self?.poll() }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    static func area(for bounds: NSRect) -> NSRect {
        let screen = NSScreen.screens.max { left, right in
            let lhs = left.visibleFrame.intersection(bounds)
            let rhs = right.visibleFrame.intersection(bounds)
            return lhs.width * lhs.height < rhs.width * rhs.height
        } ?? NSScreen.main
        return screen?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
    }

    static func edgeSide(_ bounds: NSRect, area: NSRect, distance: CGFloat = 18) -> String? {
        let left = abs(bounds.minX - area.minX)
        let right = abs(bounds.maxX - area.maxX)
        guard min(left, right) <= distance else { return nil }
        return left <= right ? "left" : "right"
    }

    static func edgeBounds(_ bounds: NSRect, area: NSRect, side: String) -> NSRect {
        let width = min(bounds.width, area.width)
        let height = min(bounds.height, area.height)
        return NSRect(x: side == "left" ? area.minX : area.maxX - width,
            y: min(max(bounds.minY, area.minY), area.maxY - height), width: width, height: height)
    }

    static func railBounds(_ panel: NSRect, area: NSRect, side: String) -> NSRect {
        let height = min(68, area.height)
        return NSRect(x: side == "left" ? area.minX : area.maxX - 16,
            y: min(max((panel.midY - height / 2).rounded(), area.minY), area.maxY - height),
            width: 16, height: height)
    }

    func noteMove() {
        guard !updatingFrame, !collapsed, !suspended else { return }
        lastMove = ProcessInfo.processInfo.systemUptime
        leftSince = nil
        persistPosition?(window.frame)
    }

    func checkPlacement() {
        guard enabled, !collapsed, !suspended, !window.isMiniaturized else { return }
        side = Self.edgeSide(window.frame, area: Self.area(for: window.frame), distance: side == nil ? 18 : 34)
        leftSince = nil
        if side != nil { collapse(first: true) }
        else { syncOnTop(); onMotion?(nil, false) }
    }

    func setEnabled(_ enabled: Bool) {
        self.enabled = enabled
        if !enabled {
            if collapsed { expand() }
            side = nil
            leftSince = nil
            syncOnTop()
            onMotion?(nil, false)
        } else { checkPlacement() }
    }

    func syncOnTop() { window.level = side != nil || pinned() ? .floating : .normal }

    func reflow(_ bounds: NSRect) {
        guard !collapsed else { return }
        setFrame(side.map { Self.edgeBounds(bounds, area: Self.area(for: bounds), side: $0) } ?? bounds)
    }

    private func setFrame(_ bounds: NSRect) {
        updatingFrame = true
        window.setFrame(bounds, display: true)
        updatingFrame = false
    }

    func collapse(first: Bool = false) {
        guard let side, !collapsed, !suspended, !window.isMiniaturized else { return }
        let area = Self.area(for: window.frame)
        let full = Self.edgeBounds(window.frame, area: area, side: side)
        setFrame(full)
        rail.setFrame(Self.railBounds(full, area: area, side: side), display: true)
        persistPosition?(full)
        lastMove = nil
        hoverSince = nil
        leftSince = nil
        requireExit = first && rail.frame.contains(NSEvent.mouseLocation)
        transition(toCollapsed: true)
    }

    func expand() {
        guard collapsed else { return }
        leftSince = nil
        hoverSince = nil
        transition(toCollapsed: false)
    }

    private func transition(toCollapsed: Bool) {
        animation?.invalidate()
        collapsed = toCollapsed
        onMotion?(side, collapsed)
        if toCollapsed {
            window.ignoresMouseEvents = true
            rail.orderFrontRegardless()
        } else {
            window.ignoresMouseEvents = false
            syncOnTop()
            // 非激活面板悬停展开时保留原应用的键盘焦点。
            window.orderFrontRegardless()
        }
        let target: CGFloat = toCollapsed ? 0 : 1
        let from = progress
        let duration = NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0 :
            (toCollapsed ? 0.215 : 0.240) * Double(abs(target - from))
        guard duration > 0 else { finishTransition(); return }
        let start = ProcessInfo.processInfo.systemUptime
        let timer = Timer(timeInterval: 1 / 60, repeats: true) { [weak self] _ in
            guard let self else { return }
            let elapsed = min(1, (ProcessInfo.processInfo.systemUptime - start) / duration)
            let eased = elapsed * elapsed * (3 - 2 * elapsed)
            self.applyOpacity(from + (target - from) * CGFloat(eased))
            if elapsed >= 1 { self.finishTransition() }
        }
        animation = timer
        RunLoop.main.add(timer, forMode: .common)
    }

    private func applyOpacity(_ value: CGFloat) {
        progress = value
        window.alphaValue = value
        rail.alphaValue = 1 - value
    }

    private func finishTransition() {
        animation?.invalidate()
        animation = nil
        applyOpacity(collapsed ? 0 : 1)
        if collapsed { window.orderOut(nil) }
        else {
            rail.orderOut(nil)
            window.ignoresMouseEvents = false
            syncOnTop()
            onMotion?(side, false)
        }
    }

    func prepareForMinimize() {
        collapsed = false
        finishTransition()
        leftSince = nil
    }

    func suspend() {
        suspended = true
        animation?.invalidate()
        animation = nil
        collapsed = false
        applyOpacity(1)
        window.ignoresMouseEvents = false
        rail.orderOut(nil)
        lastMove = nil
        leftSince = nil
        hoverSince = nil
    }

    func resume() { suspended = false; leftSince = nil }

    private func poll() {
        guard !suspended, !window.isMiniaturized else { return }
        let now = ProcessInfo.processInfo.systemUptime
        if let lastMove {
            guard now - lastMove >= 0.415 else { return }
            self.lastMove = nil
            checkPlacement()
        }
        checkHover(at: NSEvent.mouseLocation, now: now)
    }

    /// 预览用固定坐标驱动同一悬停状态机，避免移动用户的真实鼠标。
    func checkHoverForDesign(at point: NSPoint, now: TimeInterval) {
        guard DesignPreview.enabled else { return }
        checkHover(at: point, now: now)
    }

    private func checkHover(at point: NSPoint, now: TimeInterval) {
        guard side != nil, !suspended, !window.isMiniaturized else { return }
        if collapsed {
            let inside = rail.frame.insetBy(dx: -2, dy: 0).contains(point)
            if !inside { requireExit = false }
            hoverSince = inside && !requireExit ? hoverSince ?? now : nil
            if let hoverSince, now - hoverSince >= 0.080 { expand() }
        } else if window.isVisible {
            leftSince = window.frame.insetBy(dx: -5, dy: -5).contains(point) ? nil : leftSince ?? now
            if let leftSince, now - leftSince >= 0.340 { collapse() }
        }
    }

    func stop() {
        timer?.invalidate()
        timer = nil
        animation?.invalidate()
        animation = nil
        rail.orderOut(nil)
        rail.close()
    }

    deinit { timer?.invalidate(); animation?.invalidate() }
}
