import AppKit
import ApplicationServices
import Carbon

final class PasteStackMonitor {
    private let store: ClipboardStore
    private var tap: CFMachPort?
    private var source: CFRunLoopSource?
    var pasteHandledByHotkey = false

    init(store: ClipboardStore) { self.store = store }

    func start() -> Bool {
        if let tap {
            if !CGEvent.tapIsEnabled(tap: tap) { CGEvent.tapEnable(tap: tap, enable: true) }
            return CGEvent.tapIsEnabled(tap: tap)
        }
        let mask = CGEventMask(1 << CGEventType.keyDown.rawValue)
        guard let port = CGEvent.tapCreate(tap: .cgSessionEventTap, place: .headInsertEventTap,
                                           options: .defaultTap, eventsOfInterest: mask,
                                           callback: { _, type, event, info in
            guard let info else { return Unmanaged.passUnretained(event) }
            let monitor = Unmanaged<PasteStackMonitor>.fromOpaque(info).takeUnretainedValue()
            if type == .tapDisabledByTimeout || type == .tapDisabledByUserInput {
                if let tap = monitor.tap { CGEvent.tapEnable(tap: tap, enable: true) }
                return Unmanaged.passUnretained(event)
            }
            guard type == .keyDown, monitor.store.stackActive,
                  event.getIntegerValueField(.eventSourceUserData) != 0x4F414C4C,
                  event.getIntegerValueField(.keyboardEventAutorepeat) == 0,
                  event.flags.intersection([.maskCommand, .maskShift, .maskAlternate, .maskControl]) == .maskCommand else {
                return Unmanaged.passUnretained(event)
            }
            let key = event.getIntegerValueField(.keyboardEventKeycode)
            if key == Int64(kVK_ANSI_C) {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.06) { monitor.store.poll() }
            } else if key == Int64(kVK_ANSI_V), !monitor.pasteHandledByHotkey {
                monitor.store.poll()
                if monitor.store.prepareNextStackItem(), monitor.store.stackIDs.isEmpty {
                    DispatchQueue.main.async { monitor.store.endStack() }
                }
            }
            return Unmanaged.passUnretained(event)
        }, userInfo: Unmanaged.passUnretained(self).toOpaque()) else { return false }
        tap = port
        source = CFMachPortCreateRunLoopSource(kCFAllocatorDefault, port, 0)
        if let source { CFRunLoopAddSource(CFRunLoopGetMain(), source, .commonModes) }
        CGEvent.tapEnable(tap: port, enable: true)
        return true
    }

    func stop() {
        if let source { CFRunLoopRemoveSource(CFRunLoopGetMain(), source, .commonModes) }
        if let tap { CGEvent.tapEnable(tap: tap, enable: false) }
        source = nil
        tap = nil
    }
}

final class StackPanel: NSPanel {
    override var canBecomeKey: Bool { true }
}

final class StackRow: NSButton {
    override func draw(_ dirtyRect: NSRect) {}
}

final class PasteStackWindow: NSObject {
    private let store: ClipboardStore
    private lazy var monitor = PasteStackMonitor(store: store)
    private var panel: StackPanel?
    private var list: NSView!
    private var status: NSTextField!
    private var tapAvailable = false
    private var pasteHotkeyAvailable = false
    private var targetApplication: NSRunningApplication?

    init(store: ClipboardStore) {
        self.store = store
        super.init()
        store.addObserver { [weak self] in self?.reload() }
    }

    func show(target: NSRunningApplication?) {
        if let target, target.bundleIdentifier != Bundle.main.bundleIdentifier { targetApplication = target }
        if panel == nil { build() }
        if !AXIsProcessTrusted() {
            let options = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: true] as CFDictionary
            _ = AXIsProcessTrustedWithOptions(options)
        }
        tapAvailable = monitor.start()
        if !store.stackActive {
            store.beginStack(captureCurrent: false)
            captureSelectionOnOpen()
        }
        reload()
        panel?.orderFrontRegardless()
        targetApplication?.activate(options: [])
    }

    func showForDesign() {
        guard DesignPreview.enabled else { return }
        if panel == nil { build() }
        reload()
        WindowChrome.present(panel)
    }

    func toggle(target: NSRunningApplication?) {
        if store.stackActive { store.endStack() }
        else { show(target: target) }
    }

    func setPasteHotkeyActive(_ active: Bool) {
        pasteHotkeyAvailable = active
        monitor.pasteHandledByHotkey = active
        refreshStatus()
    }

    func takeNextFromHotkey() {
        if store.stackIDs.isEmpty {
            store.endStack()
            sendPaste()
        } else { takeNext() }
    }

    private func captureSelectionOnOpen() {
        guard targetApplication != nil, AXIsProcessTrusted() else {
            store.poll(force: true, allowOwnApp: true)
            return
        }
        let previousCount = store.stackIDs.count
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) { [weak self] in
            guard let self, self.store.stackActive else { return }
            let source = CGEventSource(stateID: .hidSystemState)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: down)
                event?.flags = .maskCommand
                event?.setIntegerValueField(.eventSourceUserData, value: 0x4F414C4C)
                event?.post(tap: .cghidEventTap)
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.22) { [weak self] in
                guard let self, self.store.stackActive else { return }
                self.store.poll(force: true, allowOwnApp: true)
                if self.store.stackIDs.count > previousCount {
                    self.store.moveStackItemToFront(at: self.store.stackIDs.count - 1)
                }
            }
        }
    }

    private func build() {
        let w = StackPanel(contentRect: NSRect(x: 0, y: 0, width: 340, height: 180),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        w.level = .floating
        w.isFloatingPanel = true
        w.hidesOnDeactivate = false
        w.hasShadow = true
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        let root = NSVisualEffectView(frame: w.contentView!.bounds)
        root.material = .hudWindow
        root.blendingMode = .behindWindow
        root.appearance = OpenAllTheme.appearance
        root.autoresizingMask = [.width, .height]
        root.wantsLayer = true
        root.layer?.cornerRadius = 14
        root.layer?.masksToBounds = true
        root.layer?.borderWidth = 1
        root.layer?.borderColor = OpenAllTheme.rule.cgColor
        w.contentView = root
        let surface = NSView(frame: root.bounds)
        surface.autoresizingMask = [.width, .height]
        surface.wantsLayer = true
        surface.layer?.backgroundColor = OpenAllTheme.sidebar.withAlphaComponent(0.97).cgColor
        root.addSubview(surface)
        PanelMaterial.install(on: w, artworkSurface: surface)
        let title = NSTextField(labelWithString: "复制堆栈")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = OpenAllTheme.ink
        title.frame = NSRect(x: 18, y: 140, width: 160, height: 24)
        title.tag = 41
        root.addSubview(title)
        let end = NSButton(title: "结束堆栈", target: self, action: #selector(endStack))
        end.frame = NSRect(x: 237, y: 140, width: 86, height: 26)
        WindowChrome.styleOutputAction(end)
        end.contentTintColor = OpenAllTheme.muted
        end.tag = 42
        end.toolTip = "结束本次队列，内容仍保留在剪贴板历史中"
        root.addSubview(end)
        list = NSView(frame: NSRect(x: 16, y: 56, width: 308, height: 78))
        root.addSubview(list)
        status = NSTextField(labelWithString: "")
        status.font = .systemFont(ofSize: 11)
        status.textColor = OpenAllTheme.muted
        status.frame = NSRect(x: 18, y: 46, width: 290, height: 22)
        status.tag = 44
        root.addSubview(status)
        let next = NSButton(title: "粘贴下一项", target: self, action: #selector(takeNext))
        next.frame = NSRect(x: 214, y: 12, width: 110, height: 30)
        WindowChrome.styleAction(next, primary: true)
        next.tag = 45
        next.toolTip = "在目标应用按 ⌘V，依次粘贴下一项"
        root.addSubview(next)
        panel = w
    }

    private func reload() {
        guard let panel else { return }
        if !store.stackActive {
            monitor.stop()
            panel.orderOut(nil)
            return
        }
        let records = store.stackRecords()
        let shown = Array(records.prefix(6))
        let rowHeight: CGFloat = 44
        let height = CGFloat(130) + CGFloat(max(1, shown.count)) * rowHeight
        let root = panel.contentView!
        root.frame.size.height = height
        root.viewWithTag(41)?.frame.origin.y = height - 40
        root.viewWithTag(42)?.frame.origin.y = height - 42
        list.frame = NSRect(x: 16, y: 79, width: 308, height: CGFloat(max(1, shown.count)) * rowHeight)
        list.subviews.forEach { $0.removeFromSuperview() }
        if shown.isEmpty {
            let waiting = NSTextField(labelWithString: "等待 ⌘C 复制内容…")
            waiting.textColor = .secondaryLabelColor
            waiting.frame = NSRect(x: 8, y: 8, width: 290, height: 22)
            list.addSubview(waiting)
        }
        for (index, item) in shown.enumerated() {
            let y = list.frame.height - CGFloat(index + 1) * rowHeight
            let row = StackRow(frame: NSRect(x: 0, y: y, width: 308, height: 40))
            row.isBordered = false
            row.title = item.title
            row.tag = index
            row.target = self
            row.action = #selector(selectNext(_:))
            row.wantsLayer = true
            row.layer?.cornerRadius = 7
            row.layer?.backgroundColor = (index == 0 ? OpenAllTheme.accent.withAlphaComponent(0.13) : NSColor.clear).cgColor
            if index == 0 {
                let marker = NSView(frame: NSRect(x: 0, y: 5, width: 3, height: 30))
                marker.wantsLayer = true
                marker.layer?.backgroundColor = OpenAllTheme.accent.cgColor
                marker.toolTip = "下一项将粘贴此内容"
                row.addSubview(marker)
            }
            let indexLabel = NSTextField(labelWithString: "\(index + 1)")
            indexLabel.font = .systemFont(ofSize: 11, weight: .semibold)
            indexLabel.textColor = .secondaryLabelColor
            indexLabel.frame = NSRect(x: 10, y: 9, width: 18, height: 18)
            row.addSubview(indexLabel)
            let preview = NSTextField(labelWithString: item.kind == "image" ? "图片" : item.title)
            preview.lineBreakMode = .byWordWrapping
            preview.maximumNumberOfLines = 2
            preview.textColor = OpenAllTheme.ink
            preview.frame = NSRect(x: 36, y: 4, width: 218, height: 32)
            row.addSubview(preview)
            let remove = NSButton(title: "×", target: self, action: #selector(removeRow(_:)))
            remove.tag = index
            remove.isBordered = false
            remove.toolTip = "从待粘贴队列中移除此项"
            remove.frame = NSRect(x: 271, y: 8, width: 28, height: 25)
            row.addSubview(remove)
            list.addSubview(row)
        }
        refreshStatus()
        if !shown.isEmpty { status.stringValue = "下一项：第 1 条 · 共 \(records.count) 条待粘贴" }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            panel.setFrame(NSRect(x: visible.maxX - 360, y: visible.maxY - height - 20,
                                  width: 340, height: height), display: true)
        }
    }

    private func refreshStatus() {
        guard status != nil else { return }
        let count = store.stackIDs.count
        if let next = panel?.contentView?.viewWithTag(45) as? NSButton {
            let authorized = AXIsProcessTrusted()
            next.isEnabled = authorized
            next.title = authorized ? "粘贴下一项" : "授权后可粘贴"
            WindowChrome.styleAction(next, primary: authorized)
        }
        if pasteHotkeyAvailable || tapAvailable {
            status.stringValue = "待粘贴 \(count) 项 · ⌘V 依次取出"
        } else if AXIsProcessTrusted() {
            status.stringValue = "待粘贴 \(count) 项 · 点击下方按钮取出"
        } else {
            status.stringValue = "\(count) 项 · 请授权辅助功能后重开堆栈"
        }
    }

    @objc private func endStack() { store.endStack() }
    @objc private func removeRow(_ sender: NSButton) { store.removeStackItem(at: sender.tag) }
    @objc private func selectNext(_ sender: NSButton) { store.moveStackItemToFront(at: sender.tag) }

    @objc private func takeNext() {
        guard AXIsProcessTrusted() else { return }
        guard store.prepareNextStackItem() else { return }
        let finished = store.stackIDs.isEmpty
        sendPaste()
        if finished { DispatchQueue.main.asyncAfter(deadline: .now() + 0.15) { self.store.endStack() } }
    }

    private func sendPaste() {
        guard AXIsProcessTrusted() else { return }
        targetApplication?.activate(options: [])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.12) {
            let source = CGEventSource(stateID: .hidSystemState)
            for down in [true, false] {
                let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: down)
                event?.flags = .maskCommand
                event?.setIntegerValueField(.eventSourceUserData, value: 0x4F414C4C)
                event?.post(tap: .cghidEventTap)
            }
        }
    }
}
