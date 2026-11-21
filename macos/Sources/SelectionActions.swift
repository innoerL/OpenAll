import AppKit
import ApplicationServices
import Carbon
import Vision

enum SelectedContent {
    case text(String)
    case files([URL])
    case image(NSImage)

    var preview: String {
        switch self {
        case .text(let value): return value
        case .files(let urls):
            return urls.map(\.lastPathComponent).joined(separator: "\n")
        case .image(let image): return "图片 · \(Int(image.size.width)) × \(Int(image.size.height))"
        }
    }

    var summary: String {
        switch self {
        case .text(let value): return "选中的文本 · \(value.count) 字"
        case .files(let urls): return "选中的文件 · \(urls.count) 项"
        case .image: return "选中的图片"
        }
    }

    var category: String {
        switch self {
        case .image: return "image"
        case .files(let urls):
            return urls.count == 1 && ["png", "jpg", "jpeg", "heic", "tiff", "webp"].contains(urls[0].pathExtension.lowercased()) ? "imageFile" : "file"
        case .text(let value):
            let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
            if !clean.contains("\n"), let url = URL(string: clean), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { return "url" }
            if clean.hasPrefix("{") || clean.hasPrefix("[") { return "json" }
            return "text"
        }
    }
}

struct PasteboardSnapshot {
    let items: [[(NSPasteboard.PasteboardType, Data)]]

    init?(from board: NSPasteboard, maximumBytes: Int = 50_000_000) {
        let originals = board.pasteboardItems ?? []
        guard !(board.types ?? []).contains(NSPasteboard.PasteboardType("org.nspasteboard.ConcealedType")) else { return nil }
        var captured: [[(NSPasteboard.PasteboardType, Data)]] = []
        var size = 0
        for original in originals {
            var formats: [(NSPasteboard.PasteboardType, Data)] = []
            for type in original.types {
                guard let data = original.data(forType: type) else { return nil }
                size += data.count
                guard size <= maximumBytes else { return nil }
                formats.append((type, data))
            }
            captured.append(formats)
        }
        items = captured
    }

    func restore(to board: NSPasteboard) {
        board.clearContents()
        guard !items.isEmpty else { return }
        let copies = items.map { formats -> NSPasteboardItem in
            let item = NSPasteboardItem()
            for (type, data) in formats { item.setData(data, forType: type) }
            return item
        }
        board.writeObjects(copies)
    }
}

final class SelectionCapture {
    static func capture(from application: NSRunningApplication?, clipboardStore: ClipboardStore,
                        completion: @escaping (SelectedContent?, String?) -> Void) {
        guard let application, AXIsProcessTrusted() else {
            completion(nil, "读取其他应用的选中内容需要辅助功能权限。请在设置 → 权限中检查当前 OpenAll。")
            return
        }
        if let text = selectedText(processID: application.processIdentifier) {
            completion(.text(text), nil)
            return
        }
        let board = NSPasteboard.general
        guard let snapshot = PasteboardSnapshot(from: board) else {
            completion(nil, "当前剪贴板包含无法安全备份的内容；请先复制选中内容后再试。")
            return
        }
        let before = board.changeCount
        clipboardStore.suspendRecording(for: 1.0)
        let source = CGEventSource(stateID: .hidSystemState)
        for down in [true, false] {
            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_C), keyDown: down)
            event?.flags = .maskCommand
            event?.setIntegerValueField(.eventSourceUserData, value: 0x4F414C4C)
            event?.post(tap: .cghidEventTap)
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
            guard board.changeCount != before else {
                completion(nil, "未读取到选中文字或文件；请先在原应用中选中内容。")
                return
            }
            let files = board.pasteboardItems?.compactMap { $0.string(forType: .fileURL) }
                .compactMap(URL.init(string:)) ?? []
            let image = NSImage(pasteboard: board)
            let text = board.string(forType: .string)?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
            let copiedChange = board.changeCount
            DispatchQueue.main.async {
                if board.changeCount == copiedChange { snapshot.restore(to: board) }
                if !files.isEmpty { completion(.files(files), nil) }
                else if let image { completion(.image(image), nil) }
                else if !text.isEmpty { completion(.text(text), nil) }
                else { completion(nil, "当前选中内容不是文本、图片或文件。") }
            }
        }
    }

    private static func selectedText(processID: pid_t) -> String? {
        let application = AXUIElementCreateApplication(processID)
        var focused: CFTypeRef?
        guard AXUIElementCopyAttributeValue(application, kAXFocusedUIElementAttribute as CFString, &focused) == .success,
              let focused, CFGetTypeID(focused) == AXUIElementGetTypeID() else { return nil }
        let element = focused as! AXUIElement
        var value: CFTypeRef?
        guard AXUIElementCopyAttributeValue(element, kAXSelectedTextAttribute as CFString, &value) == .success,
              let text = value as? String, !text.isEmpty else { return nil }
        return text
    }
}

enum SelectionActionKind: String {
    case open, reveal, preview, copy, translate, comparison, json, jsonFormat, jsonCompact
    case markdown, unicode, snippet, openURL, copyDomain, recognizeText, imageTool, converter
}

struct SelectionAction {
    let kind: SelectionActionKind
    let title: String
    let detail: String
}

final class ActionOrderStore {
    private let file: URL
    private var orders: [String: [String]] = [:]

    init(file: URL? = nil) {
        self.file = file ?? DesignPreview.home
            .appendingPathComponent("Library/Application Support/OpenAll/action-order.json")
        if let data = try? Data(contentsOf: self.file),
           let saved = try? JSONDecoder().decode([String: [String]].self, from: data) { orders = saved }
    }

    func sorted(_ actions: [SelectionAction], category: String) -> [SelectionAction] {
        let order = orders[category] ?? []
        return actions.enumerated().sorted { left, right in
            let a = order.firstIndex(of: left.element.kind.rawValue) ?? order.count + left.offset
            let b = order.firstIndex(of: right.element.kind.rawValue) ?? order.count + right.offset
            return a < b
        }.map(\.element)
    }

    func move(_ kind: SelectionActionKind, category: String, actions: [SelectionAction], delta: Int) {
        var order = actions.map { $0.kind.rawValue }
        guard let index = order.firstIndex(of: kind.rawValue), order.indices.contains(index + delta) else { return }
        order.swapAt(index, index + delta)
        orders[category] = order
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(orders) { try? data.write(to: file, options: .atomic) }
    }
}

enum ImageTextRecognizer {
    static func recognize(_ image: NSImage, completion: @escaping (String?, String?) -> Void) {
        guard let tiff = image.tiffRepresentation,
              let bitmap = NSBitmapImageRep(data: tiff), let cgImage = bitmap.cgImage else {
            completion(nil, "无法读取图片像素")
            return
        }
        DispatchQueue.global(qos: .userInitiated).async {
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            do {
                try VNImageRequestHandler(cgImage: cgImage).perform([request])
                let observations = (request.results ?? []).sorted {
                    if abs($0.boundingBox.midY - $1.boundingBox.midY) > 0.025 {
                        return $0.boundingBox.midY > $1.boundingBox.midY
                    }
                    return $0.boundingBox.minX < $1.boundingBox.minX
                }
                let text = observations.compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
                DispatchQueue.main.async { completion(text.isEmpty ? nil : text, text.isEmpty ? "未识别到文字" : nil) }
            } catch {
                DispatchQueue.main.async { completion(nil, "识别失败：\(error.localizedDescription)") }
            }
        }
    }
}

final class SelectionActionPanel: NSPanel {
    var onDismiss: (() -> Void)?
    var onAccept: (() -> Void)?
    override var canBecomeKey: Bool { true }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { onDismiss?(); return }
        if event.keyCode == 36 || event.keyCode == 76 { onAccept?(); return }
        super.keyDown(with: event)
    }
}

private final class SelectionRowView: NSTableRowView {
    override func draw(_ dirtyRect: NSRect) {
        OpenAllTheme.canvas.setFill()
        bounds.fill()
        guard isSelected else { return }
        OpenAllTheme.accent.withAlphaComponent(0.18).setFill()
        let highlight = NSRect(x: 8, y: 3, width: max(0, bounds.width - 16), height: max(0, bounds.height - 6))
        NSBezierPath(roundedRect: highlight, xRadius: 6, yRadius: 6).fill()
        let mark = NSAttributedString(string: "↵", attributes: [
            .font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: OpenAllTheme.accentText
        ])
        mark.draw(at: NSPoint(x: highlight.maxX - 26, y: round(highlight.midY - mark.size().height / 2)))
    }
}

final class SelectionActionWindow: NSObject, NSTableViewDataSource, NSTableViewDelegate, NSWindowDelegate {
    private var panel: SelectionActionPanel?
    private var preview: NSTextView!
    private var previewScroll: NSScrollView!
    private var imagePreview: NSImageView!
    private var contextLabel: NSTextField!
    private var emptyState: NSTextField!
    private var progress: NSProgressIndicator!
    private var status: NSTextField!
    private var table: NSTableView!
    private var actionHeading: NSTextField!
    private var actionScroll: NSScrollView!
    private var cancelButton: NSButton!
    private var actions: [SelectionAction] = []
    private var content: SelectedContent?
    private let orderStore = ActionOrderStore()
    var onChoose: ((SelectionActionKind, SelectedContent) -> Void)?
    var isVisible: Bool { panel?.isVisible == true }
    private(set) var displayToken = 0

    func hide() { displayToken += 1; panel?.orderOut(nil) }

    func focusPreviewThenActionsForDesign() -> Bool {
        guard DesignPreview.enabled else { return false }
        panel?.makeFirstResponder(preview)
        panel?.makeFirstResponder(table)
        for row in 0..<table.numberOfRows {
            table.rowView(atRow: row, makeIfNecessary: false)?.needsDisplay = true
        }
        return table.selectedRow == 0 && table.selectedRowIndexes.count == 1
    }

    func show(_ content: SelectedContent?, message: String? = nil, image: NSImage? = nil) {
        if panel == nil { build() }
        displayToken += 1
        self.content = content
        actions = content.map { orderStore.sorted(Self.availableActions(for: $0), category: $0.category) } ?? []
        let loading = message?.hasPrefix("正在识别") == true
        let hasImage = image != nil || content?.category == "image"
        let height: CGFloat = loading ? 360 : hasImage && actions.count <= 3 ? 410 : max(360, 204 + CGFloat(min(7, actions.count)) * 34)
        panel?.setContentSize(NSSize(width: 640, height: height))
        panel?.contentView?.viewWithTag(301)?.frame.origin.y = height - 43
        contextLabel.frame.origin.y = height - 35
        if case .image(let selectedImage) = content {
            contextLabel.stringValue = "选中的图片 · \(Int(selectedImage.size.width)) × \(Int(selectedImage.size.height))"
        } else {
            contextLabel.stringValue = content?.summary ?? (loading ? "图片文字识别" : "当前状态")
        }
        preview.string = content?.preview ?? (loading ? "" : "暂未读取到选中内容")
        preview.textColor = content != nil || loading ? OpenAllTheme.ink : OpenAllTheme.muted
        if case .image(let selectedImage) = content { imagePreview.image = selectedImage }
        else { imagePreview.image = loading ? image : nil }
        imagePreview.isHidden = imagePreview.image == nil
        previewScroll.isHidden = !imagePreview.isHidden
        if loading {
            imagePreview.frame = NSRect(x: 20, y: 140, width: 600, height: 140)
            actionHeading.isHidden = true
            actionScroll.isHidden = true
            progress.frame = NSRect(x: 172, y: 94, width: 24, height: 24)
            emptyState.frame = NSRect(x: 210, y: 91, width: 360, height: 28)
            emptyState.alignment = .left
            cancelButton.frame.origin.y = 49
        } else if imagePreview.image != nil {
            emptyState.alignment = .center
            imagePreview.frame = NSRect(x: 20, y: height - 196, width: 600, height: 140)
            actionHeading.frame.origin.y = height - 224
            actionHeading.isHidden = false
            actionScroll.frame = NSRect(x: 14, y: 42, width: 612, height: height - 272)
            actionScroll.isHidden = false
        } else {
            previewScroll.frame = NSRect(x: 20, y: height - 134, width: 600, height: 80)
            actionHeading.frame.origin.y = height - 160
            actionHeading.isHidden = false
            actionScroll.frame = NSRect(x: 14, y: 42, width: 612, height: height - 204)
            actionScroll.isHidden = false
        }
        if let image = imagePreview.image {
            let width = min(600, imagePreview.frame.height * image.size.width / max(1, image.size.height))
            imagePreview.frame.origin.x = (640 - width) / 2
            imagePreview.frame.size.width = width
        }
        status.stringValue = loading ? "Esc 取消 · 识别完成后自动显示文字与可用操作" :
            (message ?? (actions.isEmpty ? "Esc 关闭" : "↑↓ 选择　双击或回车执行　Esc 关闭"))
        table.deselectAll(nil)
        table.reloadData()
        emptyState.isHidden = !actions.isEmpty
        emptyState.stringValue = loading ? "正在从图片中提取文字…" : "请在原应用中选择文本、图片或文件后重试"
        progress.isHidden = !loading
        cancelButton.isHidden = !loading
        if loading { progress.startAnimation(nil) } else { progress.stopAnimation(nil) }
        if !actions.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        if let frame = screen?.visibleFrame {
            panel?.setFrameOrigin(NSPoint(x: frame.midX - 320, y: frame.midY - height / 2))
        }
        if DesignPreview.enabled { DesignPreview.lastWindow = panel; return }
        panel?.makeKeyAndOrderFront(nil)
        WindowChrome.activate()
        panel?.makeFirstResponder(table)
    }

    private func build() {
        let window = SelectionActionPanel(contentRect: NSRect(x: 0, y: 0, width: 640, height: 510),
                                          styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel],
                                          backing: .buffered, defer: false)
        window.title = "OpenAll 操作"
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.standardWindowButton(.closeButton)?.isHidden = true
        window.standardWindowButton(.miniaturizeButton)?.isHidden = true
        window.standardWindowButton(.zoomButton)?.isHidden = true
        window.level = .floating
        window.hidesOnDeactivate = true
        window.delegate = self
        window.onDismiss = { [weak self] in self?.hide() }
        window.onAccept = { [weak self] in self?.activate() }
        let root = NSView(frame: window.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.cornerRadius = 15
        root.layer?.masksToBounds = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.layer?.borderWidth = 1
        root.layer?.borderColor = OpenAllTheme.rule.cgColor
        window.contentView = root
        ButtonPressFeedback.install(on: window)
        let title = NSTextField(labelWithString: "对选中内容执行操作")
        title.tag = 301
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = OpenAllTheme.ink
        title.frame = NSRect(x: 24, y: 467, width: 278, height: 30)
        root.addSubview(title)
        contextLabel = NSTextField(labelWithString: "当前选中内容")
        contextLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        contextLabel.alignment = .right
        contextLabel.textColor = OpenAllTheme.muted
        contextLabel.frame = NSRect(x: 308, y: 475, width: 308, height: 20)
        root.addSubview(contextLabel)
        let previewScroll = NSScrollView(frame: NSRect(x: 20, y: 330, width: 600, height: 105))
        previewScroll.drawsBackground = true
        previewScroll.backgroundColor = OpenAllTheme.surface
        previewScroll.hasVerticalScroller = true
        previewScroll.autohidesScrollers = true
        previewScroll.wantsLayer = true
        previewScroll.layer?.cornerRadius = 9
        previewScroll.layer?.borderWidth = 1
        previewScroll.layer?.borderColor = OpenAllTheme.rule.cgColor
        preview = NSTextView(frame: previewScroll.bounds)
        preview.isEditable = false
        preview.isSelectable = true
        preview.drawsBackground = false
        preview.font = .systemFont(ofSize: 12.5)
        preview.textColor = OpenAllTheme.ink
        preview.textContainerInset = NSSize(width: 8, height: 8)
        preview.isVerticallyResizable = true
        preview.textContainer?.widthTracksTextView = true
        previewScroll.documentView = preview
        root.addSubview(previewScroll)
        self.previewScroll = previewScroll
        imagePreview = NSImageView(frame: previewScroll.frame)
        imagePreview.imageScaling = .scaleProportionallyUpOrDown
        imagePreview.wantsLayer = true
        imagePreview.layer?.cornerRadius = 9
        imagePreview.layer?.backgroundColor = NSColor.clear.cgColor
        imagePreview.isHidden = true
        root.addSubview(imagePreview)
        actionHeading = NSTextField(labelWithString: "可用操作")
        actionHeading.font = .systemFont(ofSize: 11, weight: .medium)
        actionHeading.textColor = OpenAllTheme.muted
        actionHeading.frame = NSRect(x: 24, y: 304, width: 200, height: 18)
        root.addSubview(actionHeading)
        let scroll = NSScrollView(frame: NSRect(x: 14, y: 42, width: 612, height: 257))
        actionScroll = scroll
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        table = NSTableView(frame: scroll.bounds)
        table.headerView = nil
        table.rowHeight = 34
        table.intercellSpacing = .zero
        table.backgroundColor = .clear
        table.selectionHighlightStyle = .none
        table.setAccessibilityLabel("可用操作")
        table.allowsMultipleSelection = false
        table.addTableColumn(NSTableColumn(identifier: NSUserInterfaceItemIdentifier("action")))
        table.tableColumns.first?.width = 610
        table.delegate = self
        table.dataSource = self
        table.target = self
        table.doubleAction = #selector(activate)
        let menu = NSMenu(title: "调整顺序")
        menu.addItem(withTitle: "上移此操作", action: #selector(moveActionUp), keyEquivalent: "").target = self
        menu.addItem(withTitle: "下移此操作", action: #selector(moveActionDown), keyEquivalent: "").target = self
        table.menu = menu
        scroll.documentView = table
        root.addSubview(scroll)
        emptyState = NSTextField(labelWithString: "")
        emptyState.font = .systemFont(ofSize: 13, weight: .medium)
        emptyState.textColor = OpenAllTheme.muted
        emptyState.alignment = .center
        emptyState.frame = NSRect(x: 34, y: 162, width: 570, height: 30)
        root.addSubview(emptyState)
        progress = NSProgressIndicator(frame: NSRect(x: 298, y: 196, width: 36, height: 36))
        progress.style = .spinning
        progress.controlSize = .regular
        progress.isDisplayedWhenStopped = false
        progress.isHidden = true
        root.addSubview(progress)
        cancelButton = NSButton(title: "取消识别", target: self, action: #selector(cancelRecognition))
        cancelButton.frame = NSRect(x: 260, y: 89, width: 120, height: 30)
        WindowChrome.styleAction(cancelButton)
        cancelButton.isHidden = true
        root.addSubview(cancelButton)
        status = NSTextField(labelWithString: "")
        status.font = .systemFont(ofSize: 12)
        status.textColor = OpenAllTheme.muted
        status.frame = NSRect(x: 24, y: 18, width: 580, height: 20)
        root.addSubview(status)
        panel = window
    }

    static func availableActions(for content: SelectedContent) -> [SelectionAction] {
        func action(_ kind: SelectionActionKind, _ title: String, _ detail: String) -> SelectionAction {
            SelectionAction(kind: kind, title: title, detail: detail)
        }
        switch content.category {
        case "url":
            return [action(.openURL, "打开网址", "使用默认浏览器"),
                    action(.copy, "复制链接", "保留完整网址"),
                    action(.copyDomain, "复制域名", "仅复制 host，不含路径"),
                    action(.translate, "翻译链接文本", "用有道翻译打开")]
        case "json":
            return [action(.jsonFormat, "格式化并校验 JSON", "在 JSON 工具中查看结果或错误"),
                    action(.jsonCompact, "压缩 JSON", "生成紧凑文本"),
                    action(.copy, "复制原文", "保持输入不变"),
                    action(.comparison, "文本对比", "放入左侧编辑区")]
        case "image":
            return [action(.recognizeText, "识别图片文字", "识别后继续翻译、复制或处理"),
                    action(.imageTool, "图片快处理", "调整尺寸、格式和压缩质量"),
                    action(.copy, "复制图片", "保留图片内容")]
        case "imageFile":
            return [action(.imageTool, "图片快处理", "调整尺寸、格式和压缩质量"),
                    action(.recognizeText, "识别图片文字", "提取图片中的文字"),
                    action(.open, "打开文件", "使用默认应用"),
                    action(.reveal, "在访达中显示", "定位原文件"),
                    action(.copy, "复制路径", "复制文件完整路径")]
        case "file":
            return [action(.open, "打开文件", "使用默认应用"),
                    action(.reveal, "在访达中显示", "定位所选文件"),
                    action(.preview, "快速预览", "预览第一项"),
                    action(.copy, "复制路径", "多项以换行分隔")]
        default:
            return [action(.copy, "复制文本", "保留选中内容"),
                    action(.translate, "翻译", "用有道翻译打开"),
                    action(.comparison, "文本对比", "放入左侧编辑区"),
                    action(.json, "JSON 工具", "格式化、校验、转义"),
                    action(.markdown, "Markdown 预览", "作为 Markdown 打开"),
                    action(.unicode, "Unicode 转换", "编码或解码"),
                    action(.snippet, "存为常用片段", "之后用 ;关键词 唤起")]
        }
    }

    @objc private func moveActionUp() { moveAction(-1) }
    @objc private func moveActionDown() { moveAction(1) }

    private func moveAction(_ delta: Int) {
        guard let content else { return }
        let index = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
        guard actions.indices.contains(index) else { return }
        let selected = actions[index].kind
        orderStore.move(selected, category: content.category, actions: actions, delta: delta)
        actions = orderStore.sorted(Self.availableActions(for: content), category: content.category)
        table.reloadData()
        if let next = actions.firstIndex(where: { $0.kind == selected }) {
            table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
        }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { actions.count }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { SelectionRowView() }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let action = actions[row]
        let cell = NSTableCellView(frame: NSRect(x: 0, y: 0, width: 560, height: 41))
        let iconNames: [SelectionActionKind: String] = [
            .open: "arrow.up.right.square", .reveal: "folder", .preview: "eye", .copy: "doc.on.doc",
            .translate: "character.book.closed", .comparison: "rectangle.split.2x1", .json: "curlybraces",
            .jsonFormat: "curlybraces", .jsonCompact: "curlybraces", .markdown: "text.book.closed",
            .unicode: "number", .snippet: "text.badge.plus", .openURL: "globe",
            .copyDomain: "link", .recognizeText: "text.viewfinder", .imageTool: "photo",
            .converter: "chevron.left.forwardslash.chevron.right"
        ]
        let icon = NSImageView(frame: NSRect(x: 15, y: 9, width: 18, height: 18))
        icon.image = NSImage(systemSymbolName: iconNames[action.kind] ?? "circle", accessibilityDescription: action.title)
        icon.image?.isTemplate = true
        icon.contentTintColor = OpenAllTheme.muted
        cell.addSubview(icon)
        let title = NSTextField(labelWithString: action.title)
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.textColor = OpenAllTheme.ink
        title.frame = NSRect(x: 43, y: 9, width: 200, height: 21)
        let detail = NSTextField(labelWithString: action.detail)
        detail.font = .systemFont(ofSize: 12)
        detail.textColor = OpenAllTheme.muted
        detail.alignment = .left
        detail.frame = NSRect(x: 240, y: 9, width: 316, height: 21)
        cell.addSubview(title)
        cell.addSubview(detail)
        return cell
    }

    @objc private func activate() {
        guard actions.indices.contains(table.selectedRow), let content else { return }
        let kind = actions[table.selectedRow].kind
        hide()
        onChoose?(kind, content)
    }

    @objc private func cancelRecognition() { hide() }

    func windowDidResignKey(_ notification: Notification) { hide() }
}
