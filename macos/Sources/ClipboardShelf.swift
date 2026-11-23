import AppKit
import ApplicationServices
import Carbon
import ImageIO
import QuartzCore

protocol ClipboardTextPasteReceiving: AnyObject {
    func pasteClipboardText(_ text: String) -> Bool
}

/// 抽屉抢占焦点前保存实际输入位置，内部投递不模拟全局快捷键。
private final class ClipboardLocalDestination {
    weak var window: NSWindow?
    weak var responder: NSResponder?
    weak var control: NSControl?
    let selection: NSRange?

    init(window: NSWindow) {
        self.window = window
        responder = window.firstResponder
        let text = responder as? NSTextView
        control = text?.isFieldEditor == true ? text?.delegate as? NSControl : nil
        selection = text?.selectedRange()
    }

    func deliver(from board: NSPasteboard) -> Bool {
        guard let window, DesignPreview.enabled || window.isVisible,
              let responder, let view = ((control as NSResponder?) ?? responder) as? NSView, view.window === window else { return false }
        if !DesignPreview.enabled { window.makeKeyAndOrderFront(nil); WindowChrome.activate() }
        guard window.makeFirstResponder((control as NSResponder?) ?? responder) else { return false }
        if let text = window.firstResponder as? NSTextView {
            guard text.isEditable, let value = board.string(forType: .string) else { return false }
            let range = selection ?? text.selectedRange()
            guard NSMaxRange(range) <= (text.string as NSString).length else { return false }
            text.insertText(value, replacementRange: range)
            return true
        }
        if let receiver = window.delegate as? ClipboardTextPasteReceiving, let value = board.string(forType: .string) {
            return receiver.pasteClipboardText(value)
        }
        // 其余原生视图沿自己的响应链处理图片、文件或富文本粘贴。
        return board === NSPasteboard.general && responder.tryToPerform(NSSelectorFromString("paste:"), with: nil)
    }
}

final class ShelfPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
    var focusChanged: (() -> Void)?

    @discardableResult override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let accepted = super.makeFirstResponder(responder)
        if accepted { focusChanged?() }
        return accepted
    }
}

final class ShelfPreviewWindow: NSWindow {
    var onClose: (() -> Void)?
    override func close() {
        super.close()
        onClose?()
        onClose = nil
    }
    override func cancelOperation(_ sender: Any?) { performClose(nil) }
    override func keyDown(with event: NSEvent) {
        if event.keyCode == 53 { performClose(nil); return }
        super.keyDown(with: event)
    }
}

final class ShelfSearchField: NSSearchField, WindowThemeRefreshing {
    var onTab: ((Int) -> Void)?

    override func becomeFirstResponder() -> Bool {
        let accepted = super.becomeFirstResponder()
        if accepted { refreshWindowTheme() }
        return accepted
    }

    func refreshWindowTheme() {
        textColor = OpenAllTheme.ink
        backgroundColor = OpenAllTheme.editorCanvas
        drawsBackground = false
        placeholderAttributedString = NSAttributedString(string: placeholderString ?? "搜索剪贴板", attributes: [
            .foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.9),
            .font: font ?? NSFont.systemFont(ofSize: 13)])
        superview?.layer?.backgroundColor = OpenAllTheme.editorCanvas.cgColor
        let editor = currentEditor() as? NSTextView
        superview?.layer?.borderColor = (editor == nil ? OpenAllTheme.rule : OpenAllTheme.accentText).cgColor
        superview?.layer?.borderWidth = editor == nil ? 1 : 1.5
        guard let editor else { return }
        // NSSearchField 聚焦后由窗口共享的 NSTextView 绘字；同时更新已有文字和后续输入属性。
        editor.drawsBackground = false
        editor.backgroundColor = OpenAllTheme.editorCanvas
        editor.textColor = OpenAllTheme.ink
        editor.insertionPointColor = OpenAllTheme.accentText
        var typing = editor.typingAttributes
        typing[.foregroundColor] = OpenAllTheme.ink
        editor.typingAttributes = typing
        var selection = editor.selectedTextAttributes
        selection[.foregroundColor] = OpenAllTheme.ink
        selection[.backgroundColor] = OpenAllTheme.accent.withAlphaComponent(0.32)
        editor.selectedTextAttributes = selection
        editor.needsDisplay = true
        needsDisplay = true
    }

    override func keyDown(with event: NSEvent) {
        if event.keyCode == 48 {
            onTab?(event.modifierFlags.contains(.shift) ? -1 : 1)
            return
        }
        super.keyDown(with: event)
    }
}

enum BoardPalette {
    static let choices: [(String, String, NSColor)] = [
        ("blue", "蓝色", NSColor(calibratedRed: 0.34, green: 0.48, blue: 0.61, alpha: 1)),
        ("red", "红色", NSColor(calibratedRed: 0.62, green: 0.38, blue: 0.39, alpha: 1)),
        ("orange", "橙色", NSColor(calibratedRed: 0.68, green: 0.49, blue: 0.32, alpha: 1)),
        ("yellow", "黄色", NSColor(calibratedRed: 0.70, green: 0.58, blue: 0.34, alpha: 1)),
        ("green", "绿色", NSColor(calibratedRed: 0.37, green: 0.56, blue: 0.44, alpha: 1)),
        ("teal", "青色", NSColor(calibratedRed: 0.32, green: 0.55, blue: 0.54, alpha: 1)),
        ("purple", "紫色", NSColor(calibratedRed: 0.51, green: 0.43, blue: 0.60, alpha: 1)),
        ("gray", "灰色", NSColor(calibratedWhite: 0.47, alpha: 1))
    ]
    static func color(_ name: String) -> NSColor { choices.first { $0.0 == name }?.2 ?? .systemBlue }
}

final class ColorSwatch: NSButton {
    let swatchColor: NSColor
    var selected = false
    var onPick: (() -> Void)?
    init(frame: NSRect, color: NSColor) {
        swatchColor = color
        super.init(frame: frame)
        isBordered = false
        focusRingType = .none
        target = self
        action = #selector(pick)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }
    @objc private func pick() { onPick?() }
    override func draw(_ dirtyRect: NSRect) {
        let circle = NSBezierPath(ovalIn: bounds.insetBy(dx: 5, dy: 5))
        swatchColor.setFill()
        circle.fill()
        if selected {
            NSColor.white.setStroke()
            circle.lineWidth = 2
            circle.stroke()
        }
    }
}

final class BoardRenameField: NSTextField, NSTextFieldDelegate {
    var onCommit: ((String) -> Void)?
    var onCancel: (() -> Void)?
    private var finished = false

    override init(frame: NSRect) {
        super.init(frame: frame)
        delegate = self
        target = self
        action = #selector(commit)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    @objc private func commit() {
        guard !finished else { return }
        finished = true
        onCommit?(stringValue)
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if selector == #selector(NSResponder.cancelOperation(_:)) {
            finished = true
            onCancel?()
            return true
        }
        if selector == #selector(NSResponder.insertNewline(_:)) { commit(); return true }
        return false
    }
}

final class ShelfTab: NSButton {
    var titleText: String { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var dotColor: NSColor { didSet { needsDisplay = true } }
    var selected = false {
        didSet {
            needsDisplay = true
            setAccessibilityValue(selected ? "已选中" : "未选中")
        }
    }
    var isAdd = false { didSet { invalidateIntrinsicContentSize(); needsDisplay = true } }
    var onChoose: (() -> Void)?
    var onContext: (() -> NSMenu?)?
    var onContextEnd: (() -> Void)?
    var onRename: ((String) -> Void)?

    init(title: String, color: NSColor) {
        titleText = title
        dotColor = color
        super.init(frame: .zero)
        isBordered = false
        focusRingType = .none
        self.title = title
        target = self
        action = #selector(choose)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    override var intrinsicContentSize: NSSize {
        NSSize(width: isAdd ? 108 : max(82, CGFloat(titleText.count) * 13 + 40), height: 32)
    }
    override var acceptsFirstResponder: Bool { true }
    @objc private func choose() { onChoose?() }
    override func rightMouseDown(with event: NSEvent) {
        guard let menu = onContext?() else { return }
        NSMenu.popUpContextMenu(menu, with: event, for: self)
        onContextEnd?()
    }
    override func draw(_ dirtyRect: NSRect) {
        if selected {
            OpenAllTheme.accent.withAlphaComponent(0.15).setFill()
            NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 2), xRadius: 8, yRadius: 8).fill()
        }
        if isAdd {
            ("＋ 新建标签" as NSString).draw(in: NSRect(x: 8, y: 7, width: 96, height: 22),
                                        withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium),
                                                         .foregroundColor: OpenAllTheme.ink.withAlphaComponent(0.8)])
        } else {
            dotColor.setFill()
            NSBezierPath(ovalIn: NSRect(x: 12, y: 11, width: 11, height: 11)).fill()
            (titleText as NSString).draw(in: NSRect(x: 30, y: 7, width: bounds.width - 35, height: 22),
                                         withAttributes: [.font: NSFont.systemFont(ofSize: 13, weight: selected ? .semibold : .medium),
                                                          .foregroundColor: OpenAllTheme.ink.withAlphaComponent(selected ? 1 : 0.76)])
        }
    }

    func startRenaming() {
        guard let stack = superview as? NSStackView,
              let index = stack.arrangedSubviews.firstIndex(of: self) else { return }
        let field = BoardRenameField(frame: NSRect(x: 0, y: 0, width: max(105, bounds.width), height: 28))
        field.stringValue = titleText
        field.font = .systemFont(ofSize: 13)
        field.translatesAutoresizingMaskIntoConstraints = false
        field.widthAnchor.constraint(equalToConstant: max(105, bounds.width)).isActive = true
        field.onCommit = { [self] value in onRename?(value) }
        field.onCancel = { [self, weak field, weak stack] in
            guard let stack, let field else { return }
            stack.removeArrangedSubview(field)
            field.removeFromSuperview()
            stack.insertArrangedSubview(self, at: index)
        }
        stack.removeArrangedSubview(self)
        removeFromSuperview()
        stack.insertArrangedSubview(field, at: index)
        stack.window?.makeFirstResponder(field)
        field.selectText(nil)
    }
}

private enum ClipTypePalette {
    // 与 Windows 类型栏使用同一组 sRGB 色值，颜色描述内容，文字保留具体格式。
    private static let backgrounds: [String: (light: NSColor, dark: NSColor)] = [
        "文本": ("#DCE1E7", "#485361"), "JSON": ("#C1D9FC", "#345E99"),
        "Markdown": ("#DECCE9", "#655080"), "HTML": ("#F4C6AC", "#83492C"),
        "富文本": ("#F0BED1", "#8A4660"), "链接": ("#B4DDD8", "#226666"),
        "图片": ("#EBD38D", "#7C621C"), "文件": ("#C6D7AB", "#4C692F")
    ].mapValues { (OpenAllTheme.color($0.0)!, OpenAllTheme.color($0.1)!) }
    static let lightInk = OpenAllTheme.color("#20232B")!
    static let darkInk = OpenAllTheme.color("#FAF9F6")!

    static func background(for format: String, light: Bool) -> NSColor {
        let colors = backgrounds[format] ?? backgrounds["文本"]!
        return light ? colors.light : colors.dark
    }
}

private final class ShelfListDocument: NSView {
    override var isFlipped: Bool { true }
}

final class ClipCard: NSButton, NSDraggingSource, WindowThemeRefreshing {
    func refreshWindowTheme() { needsDisplay = true }
    private static let imageCache: NSCache<NSString, NSImage> = {
        let cache = NSCache<NSString, NSImage>()
        cache.countLimit = 80
        return cache
    }()
    private static let filePreviewQueue: OperationQueue = {
        let queue = OperationQueue()
        queue.maxConcurrentOperationCount = 2
        queue.qualityOfService = .utility
        return queue
    }()
    private var fileRequest: Operation?
    private var filePreviews: [Int: ClipboardFilePreview] = [:]
    var item: ClipboardRecord! {
        didSet {
            textPreview = nil
            cachedFormat = nil
            setFilePreviewVisible(false)
        }
    }

    func setFilePreviewVisible(_ visible: Bool) {
        guard visible else {
            fileRequest?.cancel()
            fileRequest = nil
            filePreviews.removeAll()
            return
        }
        guard fileRequest == nil, let item, item.kind == "files", !item.filePaths.isEmpty else { return }
        let paths = Array(item.filePaths.prefix(3))
        let maxPixels = !compact && paths.count == 1 ? 448 : 64
        let request = BlockOperation()
        request.addExecutionBlock { [weak self, weak request] in
            for (index, path) in paths.enumerated() {
                guard request?.isCancelled == false else { return }
                guard let preview = ClipboardFilePreview.load(path: path, maxPixels: maxPixels) else { continue }
                DispatchQueue.main.async { [weak self, weak request] in
                    guard let self, let request, self.fileRequest === request, !request.isCancelled else { return }
                    self.filePreviews[index] = preview
                    self.needsDisplay = true
                }
            }
        }
        fileRequest = request
        Self.filePreviewQueue.addOperation(request)
    }

    private func drawFilePreview(at index: Int, in rect: NSRect) {
        let path = item.filePaths[index] as NSString
        let ext = path.pathExtension.lowercased()
        let symbol: String
        if ext == "app" { symbol = "app" }
        else if item.folderIndices?.contains(index) == true { symbol = "folder.fill" }
        else if ["zip","7z","rar","gz","bz2","xz","tgz","tar","zst","dmg","pkg"].contains(ext) { symbol = "doc.zipper" }
        else { symbol = "doc.text" }
        let image = filePreviews[index]?.image ??
            NSImage(systemSymbolName: symbol, accessibilityDescription: nil)?.withSymbolConfiguration(
                NSImage.SymbolConfiguration(paletteColors: [OpenAllTheme.muted]))
        guard let image else { return }
        let ratio = min(rect.width / max(1, image.size.width), rect.height / max(1, image.size.height))
        let size = NSSize(width: image.size.width * ratio, height: image.size.height * ratio)
        let fitted = NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2, width: size.width, height: size.height)
        image.draw(in: fitted, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
    }

    private func drawFileName(at index: Int, in rect: NSRect, style: NSParagraphStyle) {
        let name = (item.filePaths[index] as NSString).lastPathComponent
        let font = NSFont.systemFont(ofSize: compact ? 14 : cardTextSize.points, weight: compact && selected ? .medium : .regular)
        let text = NSMutableAttributedString(string: name, attributes: [
            .paragraphStyle: style, .foregroundColor: OpenAllTheme.ink, .font: font])
        if !searchTerm.isEmpty {
            let match = (name as NSString).range(of: searchTerm, options: .caseInsensitive)
            if match.location != NSNotFound { text.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: match) }
        }
        text.draw(in: rect)
    }

    private func drawFiles(in rect: NSRect) {
        let paths = item.filePaths
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingMiddle
        let count = min(3, paths.count)
        let single = count == 1
        let largeThumbnail = single && filePreviews[0]?.isThumbnail == true
        let size: CGFloat = single ? (largeThumbnail ? rect.height - 25 : 52) : 24
        let height: CGFloat = single ? size + 25 : CGFloat(count) * 29 + (paths.count > count ? 18 : 0)
        // NSButton 和承载它的列表可以使用不同的坐标方向。
        func originY(_ offset: CGFloat, _ elementHeight: CGFloat) -> CGFloat {
            isFlipped ? rect.midY - height / 2 + offset : rect.midY + height / 2 - offset - elementHeight
        }
        style.alignment = single ? .center : .left
        for index in 0..<count {
            let offset = CGFloat(index) * 29
            let width = largeThumbnail ? rect.width : size
            let iconRect = NSRect(x: single ? rect.midX - width / 2 : rect.minX, y: originY(offset, size), width: width, height: size)
            drawFilePreview(at: index, in: iconRect)
            let x = single ? rect.minX : iconRect.maxX + 8
            let label = NSRect(x: x, y: originY(single ? size + 5 : offset + 3, 20), width: rect.maxX - x, height: 20)
            drawFileName(at: index, in: label, style: style)
        }
        if paths.count > count {
            ("另 \(paths.count - count) 项" as NSString).draw(in: NSRect(x: rect.minX + 31, y: originY(CGFloat(count) * 29, 17), width: rect.width - 31, height: 17),
                withAttributes: [.foregroundColor: OpenAllTheme.muted, .font: NSFont.systemFont(ofSize: 11)])
        }
    }
    private var cachedFormat: String?
    private var formatLabel: String {
        if let cachedFormat { return cachedFormat }
        let label = ClipboardFormat.label(for: item)
        cachedFormat = label
        return label
    }
    var searchTerm = ""
    var compact = false
    var cardTextSize: ClipboardCardTextSize = .large
    private var textPreview: (text: String, truncated: Bool)?
    private static let jsonKey = try! NSRegularExpression(pattern: #""(?:[^"\\]|\\.)*"(?=\s*:)"#)
    private static let markdownHeading = try! NSRegularExpression(pattern: #"(?m)^#{1,6}[^\n]*"#)
    var imageURL: URL?
    private var previewImage: NSImage?
    private var loadingImage = false
    var boardColor: NSColor?
    var sourceIcon: NSImage?
    var selected = false {
        didSet {
            needsDisplay = true
            setAccessibilityValue(selected ? "已选中" : "未选中")
        }
    }
    var onChoose: ((ClipboardRecord, Bool, NSEvent.ModifierFlags) -> Void)?
    var onPreview: (() -> Void)?
    var onContext: ((ClipboardRecord, NSEvent) -> Void)?
    var onKey: ((NSEvent) -> Void)?
    var onStartDrag: ((ClipboardRecord, NSEvent, ClipCard) -> Void)?
    var onDragEnd: ((Bool) -> Void)?
    private var mouseDownPoint: NSPoint?
    private var morePreviewRect: NSRect?
    private var hovering = false

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }
    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override var acceptsFirstResponder: Bool { true }
    override func resetCursorRects() {
        super.resetCursorRects()
        if let morePreviewRect { addCursorRect(morePreviewRect, cursor: .pointingHand) }
    }
    override func keyDown(with event: NSEvent) { onKey?(event) }
    override init(frame frameRect: NSRect) {
        super.init(frame: frameRect)
        isBordered = false
        focusRingType = .none
        wantsLayer = true
        layerContentsRedrawPolicy = .onSetNeedsDisplay
        target = self
        action = #selector(choose)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }
    @objc private func choose() {
        let event = NSApp.currentEvent
        onChoose?(item, (event?.clickCount ?? 1) >= 2, event?.modifierFlags ?? [])
    }
    override func mouseDown(with event: NSEvent) {
        mouseDownPoint = convert(event.locationInWindow, from: nil)
    }
    override func mouseDragged(with event: NSEvent) {
        guard let origin = mouseDownPoint else { return }
        let point = convert(event.locationInWindow, from: nil)
        guard hypot(point.x - origin.x, point.y - origin.y) >= 7 else { return }
        mouseDownPoint = nil
        onStartDrag?(item, event, self)
    }
    override func mouseUp(with event: NSEvent) {
        guard let pressedPoint = mouseDownPoint else { return }
        mouseDownPoint = nil
        if let morePreviewRect,
           morePreviewRect.contains(pressedPoint),
           morePreviewRect.contains(convert(event.locationInWindow, from: nil)),
           event.modifierFlags.intersection([.command, .shift, .control]).isEmpty {
            onPreview?()
            return
        }
        onChoose?(item, event.clickCount >= 2, event.modifierFlags)
    }
    func startDrag(writers: [NSPasteboardWriting], event: NSEvent) {
        guard !writers.isEmpty else { return }
        let preview = NSImage(size: bounds.size)
        preview.lockFocus()
        draw(bounds)
        preview.unlockFocus()
        let items = writers.enumerated().map { index, writer -> NSDraggingItem in
            let item = NSDraggingItem(pasteboardWriter: writer)
            item.setDraggingFrame(bounds.offsetBy(dx: CGFloat(index) * 3, dy: CGFloat(index) * 3), contents: preview)
            return item
        }
        beginDraggingSession(with: items, event: event, source: self)
    }
    func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .copy }
    func draggingSession(_ session: NSDraggingSession, endedAt screenPoint: NSPoint, operation: NSDragOperation) {
        onDragEnd?(operation != [])
    }
    override func rightMouseDown(with event: NSEvent) { onContext?(item, event) }

    override func prepareForReuse() {
        super.prepareForReuse()
        item = nil
        previewImage = nil
        loadingImage = false
        imageURL = nil
        onChoose = nil
        onPreview = nil
        morePreviewRect = nil
        onContext = nil
        onKey = nil
        onStartDrag = nil
        onDragEnd = nil
        mouseDownPoint = nil
        hovering = false
    }

    private var ageText: String {
        let age = max(0, Date().timeIntervalSince(item.date))
        return age < 60 ? "刚刚" : age < 3600 ? "\(Int(age / 60)) 分钟前" :
            age < 86400 ? "\(Int(age / 3600)) 小时前" : "\(Int(age / 86400)) 天前"
    }

    private func drawListFiles(in rect: NSRect) {
        let paths = item.filePaths
        let count = min(3, paths.count)
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingMiddle
        let font = NSFont.systemFont(ofSize: 14, weight: selected ? .medium : .regular)
        let suffix = paths.count > count ? "另 \(paths.count - count) 项" as NSString : "" as NSString
        let suffixStyle: [NSAttributedString.Key: Any] = [.font: NSFont.systemFont(ofSize: 11), .foregroundColor: OpenAllTheme.muted]
        let suffixWidth = ceil(suffix.size(withAttributes: suffixStyle).width)
        let end = rect.maxX - suffixWidth
        var x = rect.minX
        for index in 0..<count {
            let available = max(0, (end - x) / CGFloat(count - index))
            let iconSize = min(24, available)
            drawFilePreview(at: index, in: NSRect(x: x, y: floor(rect.midY - iconSize / 2), width: iconSize, height: iconSize))
            let name = (paths[index] as NSString).lastPathComponent as NSString
            let width = min(ceil(name.size(withAttributes: [.font: font]).width) + 1, max(0, available - iconSize - 14))
            drawFileName(at: index, in: NSRect(x: x + iconSize + 5, y: floor(rect.midY - 9), width: width, height: 19), style: style)
            x += iconSize + 14 + width
        }
        suffix.draw(at: NSPoint(x: min(x, end), y: floor(rect.midY - 7)), withAttributes: suffixStyle)
    }

    private func drawListRow() {
        let row = bounds.insetBy(dx: 1, dy: 1)
        if selected || hovering {
            let color = selected ? OpenAllTheme.accent.withAlphaComponent(0.19) : OpenAllTheme.raised
            color.setFill()
            let shape = NSBezierPath(roundedRect: row, xRadius: 5, yRadius: 5)
            shape.fill()
            if selected && window?.firstResponder === self {
                OpenAllTheme.accentText.withAlphaComponent(0.72).setStroke()
                shape.stroke()
            }
        }
        let format = formatLabel
        let type = item.kind == "files" ? "文件" : format
        let label = (item.pinned ? "★ " : "") + format
        let labelFont = NSFont.systemFont(ofSize: 11, weight: .medium)
        let chipWidth = min(102, ceil((label as NSString).size(withAttributes: [.font: labelFont]).width) + 14)
        let chip = NSRect(x: 9, y: floor(row.midY - 10), width: chipWidth, height: 20)
        let background = boardColor ?? ClipTypePalette.background(for: type, light: OpenAllTheme.isLight)
        let chipInk = boardColor == nil ? (OpenAllTheme.isLight ? ClipTypePalette.lightInk : ClipTypePalette.darkInk)
            : OpenAllTheme.readableText(OpenAllTheme.ink, on: [background])
        background.setFill()
        NSBezierPath(roundedRect: chip, xRadius: 4, yRadius: 4).fill()
        let style = NSMutableParagraphStyle()
        style.lineBreakMode = .byTruncatingTail
        style.alignment = .center
        (label as NSString).draw(in: chip.insetBy(dx: 3, dy: 2), withAttributes: [
            .font: NSFont.systemFont(ofSize: 11, weight: .medium), .foregroundColor: chipInk, .paragraphStyle: style])
        style.alignment = .right
        let age = NSRect(x: row.maxX - 92, y: floor(row.midY - 8), width: 80, height: 17)
        (ageText as NSString).draw(in: age, withAttributes: [
            .font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), .foregroundColor: OpenAllTheme.muted, .paragraphStyle: style])
        let showSource = row.width >= 670
        let source = NSRect(x: age.minX - (showSource ? 140 : 22), y: floor(row.midY - 8), width: 16, height: 16)
        sourceIcon?.draw(in: source, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        style.alignment = .left
        if showSource {
            (item.sourceName as NSString).draw(in: NSRect(x: source.maxX + 6, y: source.minY, width: 104, height: 17), withAttributes: [
                .font: NSFont.systemFont(ofSize: 12), .foregroundColor: OpenAllTheme.muted, .paragraphStyle: style])
        }
        let contentRect = NSRect(x: 122, y: floor(row.midY - 9), width: max(0, source.minX - 134), height: 19)
        if item.kind == "files", !item.filePaths.isEmpty {
            drawListFiles(in: contentRect)
            return
        }
        let text = item.text.isEmpty ? item.title : item.text
        let preview = text.prefix(260).split(whereSeparator: \.isNewline).joined(separator: " ")
        let content = NSMutableAttributedString(string: preview, attributes: [
            .font: NSFont.systemFont(ofSize: 14, weight: selected ? .medium : .regular),
            .foregroundColor: OpenAllTheme.ink, .paragraphStyle: style])
        if !searchTerm.isEmpty, searchTerm.utf16.count <= 260 {
            let match = (preview as NSString).range(of: searchTerm, options: .caseInsensitive)
            if match.location != NSNotFound { content.addAttribute(.underlineStyle, value: NSUnderlineStyle.single.rawValue, range: match) }
        }
        content.draw(in: contentRect)
    }

    override func draw(_ dirtyRect: NSRect) {
        guard item != nil else { return }
        if compact { drawListRow(); return }
        let bounds = self.bounds.insetBy(dx: 4, dy: 4)
        let card = NSBezierPath(roundedRect: bounds, xRadius: 12, yRadius: 12)
        let fill = selected ? OpenAllTheme.raised.blended(withFraction: 0.055, of: OpenAllTheme.accent) : nil
        (fill ?? OpenAllTheme.raised).setFill()
        card.fill()
        (selected ? OpenAllTheme.accent : hovering ? OpenAllTheme.accent.withAlphaComponent(0.55) : OpenAllTheme.rule).setStroke()
        card.lineWidth = selected ? 2.5 : hovering ? 1.5 : 1
        card.stroke()

        // 保留彩色类型栏，类型、时间与来源图标分别占用明确的区域。
        let head = NSBezierPath(roundedRect: NSRect(x: 5, y: bounds.maxY - 31, width: bounds.width - 4, height: 30),
                                xRadius: 9, yRadius: 9)
        let light = OpenAllTheme.isLight
        let format = item.kind == "files" ? "文件" : formatLabel
        let barInk: NSColor
        if let boardColor {
            let base = OpenAllTheme.raised.blended(withFraction: 0.24, of: boardColor) ?? OpenAllTheme.raised
            barInk = OpenAllTheme.readableText(OpenAllTheme.ink, on: [base])
            boardColor.withAlphaComponent(0.24).setFill()
        } else {
            barInk = light ? ClipTypePalette.lightInk : ClipTypePalette.darkInk
            ClipTypePalette.background(for: format, light: light).setFill()
        }
        head.fill()
        let heading = (item.pinned ? "★ " : "") + formatLabel
        let ageFont = NSFont.systemFont(ofSize: 11)
        let ageWidth = ceil((ageText as NSString).size(withAttributes: [.font: ageFont]).width)
        let iconRect = NSRect(x: bounds.maxX - 32, y: bounds.maxY - 27, width: 19, height: 19)
        let ageRect = NSRect(x: iconRect.minX - 10 - ageWidth, y: bounds.maxY - 21,
                             width: ageWidth, height: 16)
        let typeStyle = NSMutableParagraphStyle()
        typeStyle.lineBreakMode = .byTruncatingTail
        (heading as NSString).draw(in: NSRect(x: 15, y: bounds.maxY - 22, width: max(0, ageRect.minX - 25), height: 18),
                                  withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .semibold),
                                                   .foregroundColor: barInk,
                                                   .paragraphStyle: typeStyle])
        (ageText as NSString).draw(in: ageRect,
                                  withAttributes: [.font: ageFont,
                                                   .foregroundColor: barInk.withAlphaComponent(boardColor == nil ? 0.90 : 1)])
        let icon = sourceIcon?.isTemplate == true
            ? sourceIcon?.withSymbolConfiguration(NSImage.SymbolConfiguration(paletteColors: [barInk])) ?? sourceIcon : sourceIcon
        icon?.draw(in: iconRect, from: .zero, operation: .sourceOver, fraction: 1,
                         respectFlipped: true, hints: nil)
        let preview = NSRect(x: 17, y: 17, width: bounds.width - 34, height: bounds.height - 57)
        var nextMoreRect: NSRect?
        if item.kind == "files", !item.filePaths.isEmpty {
            drawFiles(in: preview)
        } else if item.kind == "image", let imageURL {
            let image = previewImage ?? Self.imageCache.object(forKey: imageURL.path as NSString)
            if image == nil { loadPreviewImage(from: imageURL) }
            if let image {
                let area = preview.insetBy(dx: 3, dy: 3)
                let size = image.size
                let ratio = min(area.width / max(1, size.width), area.height / max(1, size.height))
                let fitted = NSRect(x: area.midX - size.width * ratio / 2, y: area.midY - size.height * ratio / 2,
                                    width: size.width * ratio, height: size.height * ratio)
                // 透明网格只显示在图片内，不改变缩放和居中位置。
                NSGraphicsContext.saveGraphicsState()
                NSBezierPath(rect: fitted).addClip()
                for row in 0..<Int(ceil(fitted.height / 12)) {
                    for column in 0..<Int(ceil(fitted.width / 12)) where (row + column).isMultiple(of: 2) {
                        NSColor.white.withAlphaComponent(0.07).setFill()
                        NSRect(x: fitted.minX + CGFloat(column * 12), y: fitted.minY + CGFloat(row * 12),
                               width: 12, height: 12).fill()
                    }
                }
                NSGraphicsContext.restoreGraphicsState()
                image.draw(in: fitted, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
            }
        } else {
            let content = item.text
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = item.kind == "link" ? .byCharWrapping : .byWordWrapping
            paragraph.lineSpacing = 2
            let format = formatLabel
            let attrs: [NSAttributedString.Key: Any] = [.font: format == "JSON" ? NSFont.monospacedSystemFont(ofSize: cardTextSize.monospacedPoints, weight: .regular) : NSFont.systemFont(ofSize: cardTextSize.points),
                                                        .foregroundColor: OpenAllTheme.ink,
                                                        .paragraphStyle: paragraph]
            if textPreview == nil {
                // 预览只处理有界内容，长剪贴板条目不会在每次重绘时重新遍历全文。
                let source = content.isEmpty ? item.title : content
                let formatted = format == "JSON" && source.utf8.count <= 16_384 ? JSONPrettyPrinter.format(source) ?? source : source
                let prefix = String(formatted.prefix(301))
                textPreview = (String(prefix.prefix(300)), prefix.count > 300)
            }
            let display = textPreview!.text
            let required = (display as NSString).boundingRect(with: NSSize(width: preview.width, height: .greatestFiniteMagnitude),
                                                               options: [.usesLineFragmentOrigin, .usesFontLeading],
                                                               attributes: attrs).height
            var textRect = preview
            if required > preview.height + 2 || textPreview!.truncated {
                textRect.size.height -= 24
                let indicator = NSRect(x: preview.maxX - 84, y: preview.maxY - 20, width: 84, height: 20)
                nextMoreRect = indicator
                let hintStyle = NSMutableParagraphStyle()
                hintStyle.alignment = .right
                ("查看全文 ↗" as NSString).draw(in: indicator,
                    withAttributes: [.font: NSFont.systemFont(ofSize: 11, weight: .medium),
                                     .foregroundColor: OpenAllTheme.accentText, .paragraphStyle: hintStyle])
            }
            NSGraphicsContext.saveGraphicsState()
            NSBezierPath(rect: textRect).addClip()
            let styled = NSMutableAttributedString(string: display, attributes: attrs)
            let full = NSRange(location: 0, length: styled.length)
            if format == "JSON" {
                Self.jsonKey.matches(in: display, range: full).forEach {
                    styled.addAttribute(.foregroundColor, value: OpenAllTheme.isLight ? NSColor(calibratedRed: 0.12, green: 0.34, blue: 0.46, alpha: 1) : NSColor(calibratedRed: 0.62, green: 0.76, blue: 0.84, alpha: 1), range: $0.range)
                }
            } else if format == "Markdown" {
                Self.markdownHeading.matches(in: display, range: full).forEach {
                    styled.addAttributes([.font: NSFont.systemFont(ofSize: cardTextSize.points, weight: .semibold), .foregroundColor: OpenAllTheme.accentText], range: $0.range)
                }
            }
            if !searchTerm.isEmpty, searchTerm.utf16.count <= 300 {
                let match = (display as NSString).range(of: searchTerm, options: .caseInsensitive)
                if match.location != NSNotFound {
                    styled.addAttributes([.foregroundColor: OpenAllTheme.ink,
                                          .backgroundColor: OpenAllTheme.accent.withAlphaComponent(0.26),
                                          .underlineStyle: NSUnderlineStyle.single.rawValue], range: match)
                }
            }
            styled.draw(with: textRect, options: [.usesLineFragmentOrigin, .usesFontLeading, .truncatesLastVisibleLine])
            NSGraphicsContext.restoreGraphicsState()
        }
        if morePreviewRect != nextMoreRect {
            morePreviewRect = nextMoreRect
            window?.invalidateCursorRects(for: self)
        }
    }

    func clickFullTextForDesign(startOutside: Bool = false) -> Bool {
        guard DesignPreview.enabled, let window,
              let bitmap = bitmapImageRepForCachingDisplay(in: bounds) else { return false }
        cacheDisplay(in: bounds, to: bitmap)
        guard let morePreviewRect else { return false }
        let point = convert(NSPoint(x: startOutside ? morePreviewRect.minX + 2 : morePreviewRect.midX,
                                    y: morePreviewRect.midY), to: nil)
        let pressedPoint = startOutside ? convert(NSPoint(x: morePreviewRect.minX - 2, y: morePreviewRect.midY), to: nil) : point
        guard let down = NSEvent.mouseEvent(with: .leftMouseDown, location: pressedPoint, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1),
              let up = NSEvent.mouseEvent(with: .leftMouseUp, location: point, modifierFlags: [],
            timestamp: 0, windowNumber: window.windowNumber, context: nil, eventNumber: 1, clickCount: 1, pressure: 0) else { return false }
        mouseDown(with: down)
        mouseUp(with: up)
        return true
    }

    private func loadPreviewImage(from url: URL) {
        guard !loadingImage else { return }
        loadingImage = true
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let options = [kCGImageSourceCreateThumbnailFromImageAlways: true,
                           kCGImageSourceThumbnailMaxPixelSize: 400] as CFDictionary
            let source = CGImageSourceCreateWithURL(url as CFURL, nil)
            let thumbnail = source.flatMap { CGImageSourceCreateThumbnailAtIndex($0, 0, options) }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.imageURL == url else { return }
                self.loadingImage = false
                if let thumbnail {
                    let image = NSImage(cgImage: thumbnail, size: NSSize(width: thumbnail.width, height: thumbnail.height))
                    Self.imageCache.setObject(image, forKey: url.path as NSString)
                    self.previewImage = image
                    self.needsDisplay = true
                }
            }
        }
    }
}

final class ClipboardEditAction: NSObject {
    let action: () -> Void
    init(_ action: @escaping () -> Void) { self.action = action }
    @objc func run() { action() }
}

final class ClipboardShelfWindow: NSObject, NSSearchFieldDelegate, NSWindowDelegate {
    private let store: ClipboardStore
    var snippets: SnippetStore?
    var onSendToTool: ((String, String) -> Void)?
    var onOpenActions: ((SelectedContent) -> Void)?
    private var panel: ShelfPanel?
    private var searchOutline: NSView!
    private var search: ShelfSearchField!
    private var tabs: NSStackView!
    private var scroll: NSScrollView!
    private var cards: NSView!
    private var status: NSTextField!
    private var keyboardHint: NSTextField!
    private var layoutButton: NSButton!
    var onCompareText: ((String, String) -> Void)?
    private var previewButton: NSButton!
    private var previewWindow: NSWindow?
    private var previewRecord: ClipboardRecord?
    private var previewHint: NSTextField?
    private var typeFilter: NSPopUpButton!
    private var selectedID: UUID?
    private var selectedIDs: Set<UUID> = []
    private var activeBoard: String? = nil
    private var targetApplication: NSRunningApplication?
    private var localDestination: ClipboardLocalDestination?
    private var presentingDialog = false
    private var closing = false
    private let shelfHeight: CGFloat = 300
    private var shelfFrame = NSRect.zero
    private var newBoardField: NSTextField?
    private var pendingRenameBoard: String?
    private var cachedSourceIcons: [String: NSImage] = [:]
    private var displayedItems: [ClipboardRecord] = []
    private var visibleCards: [Int: ClipCard] = [:]
    private var reusableCards: [ClipCard] = []
    private var scrollObserver: NSObjectProtocol?
    private var reloading = false
    private var editAction: ClipboardEditAction?
    private var editPopover: NSPopover?
    private let rowHeight: CGFloat = 34
    private let cardHeight: CGFloat = 182
    private let cardWidth: CGFloat = 240
    private var cardStep: CGFloat { cardWidth + 12 }
    private var isCompact: Bool { store.preferences.shelfLayout == .list }

    init(store: ClipboardStore) {
        self.store = store
        super.init()
        store.addObserver { [weak self] in
            if self?.panel?.isVisible == true && self?.newBoardField == nil { self?.reload() }
        }
        NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didActivateApplicationNotification,
                                                           object: nil, queue: .main) { [weak self] notification in
            guard let self, let panel = self.panel, panel.isVisible, !self.presentingDialog,
                  let application = notification.userInfo?[NSWorkspace.applicationUserInfoKey] as? NSRunningApplication,
                  application.bundleIdentifier != Bundle.main.bundleIdentifier else { return }
            self.hide()
        }
    }

    deinit {
        if let scrollObserver { NotificationCenter.default.removeObserver(scrollObserver) }
    }

    func show(target: NSRunningApplication?, localWindow: NSWindow? = nil) {
        // 每次唤起重新选择目标，不能沿用上一次外部应用。
        if localWindow == nil || (localWindow !== panel && localWindow !== previewWindow) {
            localDestination = localWindow.map { ClipboardLocalDestination(window: $0) }
            targetApplication = localWindow == nil ? target : nil
        }
        if panel == nil { build() }
        activeBoard = nil
        selectedID = nil
        selectedIDs.removeAll()
        search.stringValue = ""
        typeFilter?.selectItem(at: 0)
        closing = false
        moveToBottom()
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        reload()
        if DesignPreview.enabled {
            panel?.setFrame(shelfFrame, display: false)
            focusFirstCard()
            DesignPreview.lastWindow = panel
            return
        }
        panel?.level = .screenSaver
        panel?.makeKeyAndOrderFront(nil)
        WindowChrome.activate()
        focusFirstCard()
        if let panel {
            if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
                panel.setFrame(shelfFrame, display: true)
                return
            }
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.32
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                panel.animator().setFrame(shelfFrame, display: false)
            }
        }
    }

    func showSearchForDesign(_ query: String) {
        guard DesignPreview.enabled, panel != nil else { return }
        search.stringValue = query
        selectedID = nil
        selectedIDs.removeAll()
        scroll.contentView.scroll(to: .zero)
        reload()
        DesignPreview.lastWindow = panel
    }

    @MainActor func verifySearchFocusForDesign() throws -> Bool {
        guard DesignPreview.enabled, let panel else { return false }
        guard searchOutline.bounds.contains(search.frame),
              tabs.frame.minX >= searchOutline.frame.maxX + 12 else { return false }
        showSearchForDesign("")
        guard panel.makeFirstResponder(search),
              let editor = search.currentEditor() as? NSTextView,
              panel.firstResponder === editor,
              let searchCell = search.cell as? NSSearchFieldCell,
              searchCell.searchButtonCell == nil, searchCell.cancelButtonCell != nil,
              editor.string.isEmpty else { return false }
        try DesignPreview.capture(panel, name: "02-clipboard-search-focused")
        // 走真实的共享文本编辑器，覆盖输入法提交文字后以及清空后的聚焦状态。
        editor.insertText("JSON中文", replacementRange: NSRange(location: 0, length: 0))
        guard search.stringValue == "JSON中文", editor.string == "JSON中文" else { return false }
        try DesignPreview.capture(panel, name: "02-clipboard-search-typing")
        editor.insertText("", replacementRange: NSRange(location: 0, length: (editor.string as NSString).length))
        guard search.stringValue.isEmpty, editor.string.isEmpty,
              panel.firstResponder === editor else { return false }
        try DesignPreview.capture(panel, name: "02-clipboard-search-cleared")
        focusFirstCard()
        return true
    }

    @MainActor func verifySearchAppearanceForDesign() -> Bool {
        guard DesignPreview.enabled, let panel else { return false }
        let originalQuery = search.stringValue
        defer { panel.makeFirstResponder(nil); showSearchForDesign(originalQuery) }
        showSearchForDesign("JSON 中文")
        guard panel.makeFirstResponder(search), let editor = search.currentEditor() as? NSTextView else { return false }
        let selection = NSRange(location: 2, length: 3)
        editor.setSelectedRange(selection)
        func matches(_ color: NSColor?, _ expected: NSColor) -> Bool {
            guard let color else { return false }
            return OpenAllTheme.hex(color) == OpenAllTheme.hex(expected) && abs(color.alphaComponent - expected.alphaComponent) < 0.01
        }
        func check(focused: Bool) -> Bool {
            guard matches(search.textColor, OpenAllTheme.ink),
                  matches(searchOutline.layer?.backgroundColor.flatMap(NSColor.init(cgColor:)), OpenAllTheme.editorCanvas),
                  matches(search.placeholderAttributedString?.attribute(.foregroundColor, at: 0, effectiveRange: nil) as? NSColor,
                          OpenAllTheme.muted.withAlphaComponent(0.9)),
                  search.stringValue == "JSON 中文", !search.drawsBackground,
                  searchOutline.bounds.contains(search.frame), tabs.frame.minX >= searchOutline.frame.maxX + 12 else { return false }
            guard focused else { return search.currentEditor() == nil }
            guard search.currentEditor() === editor, editor.selectedRange() == selection,
                  matches(editor.textColor, OpenAllTheme.ink),
                  matches(editor.typingAttributes[.foregroundColor] as? NSColor, OpenAllTheme.ink),
                  matches(editor.selectedTextAttributes[.foregroundColor] as? NSColor, OpenAllTheme.ink),
                  matches(editor.selectedTextAttributes[.backgroundColor] as? NSColor, OpenAllTheme.accent.withAlphaComponent(0.32)),
                  matches(editor.insertionPointColor, OpenAllTheme.accentText), !editor.drawsBackground else { return false }
            var visibleText = true
            editor.textStorage?.enumerateAttribute(.foregroundColor, in: NSRange(location: 0, length: editor.string.utf16.count)) { value, _, _ in
                if !matches(value as? NSColor, OpenAllTheme.ink) { visibleText = false }
            }
            return visibleText
        }
        // 覆盖聚焦/失焦切换、默认深色与亮色/自定义色往返，查询和选区须保持不变。
        return OpenAllTheme.withTemporaryBackgroundForDesign(nil) {
            for focused in [true, false, true] {
                guard panel.makeFirstResponder(focused ? search : nil) else { return false }
                if focused { editor.setSelectedRange(selection) }
                guard check(focused: focused) else { return false }
                guard OpenAllTheme.withTemporaryBackgroundForDesign(OpenAllTheme.color("#2D4D63")!, perform: {
                    guard check(focused: focused) else { return false }
                    for light in [NSColor.white, OpenAllTheme.color("#F2F2EF")!] {
                        guard OpenAllTheme.withTemporaryBackgroundForDesign(light, perform: { check(focused: focused) }),
                              check(focused: focused) else { return false }
                    }
                    return true
                }), check(focused: focused) else { return false }
            }
            editor.insertText("可见", replacementRange: selection)
            return editor.string == "JS可见中文" && search.stringValue == editor.string &&
                matches(editor.typingAttributes[.foregroundColor] as? NSColor, OpenAllTheme.ink)
        }
    }

    @MainActor func verifyFocusedDeletionForDesign() throws -> Bool {
        guard DesignPreview.enabled, let panel else { return false }
        let previousLayout = store.preferences.shelfLayout
        store.setShelfLayout(.cards)
        store.seedPreviewRecords()
        show(target: nil)
        defer {
            // 验证只使用隔离预览数据，结束后还原样例供后续工具截图使用。
            previewWindow?.close()
            store.setShelfLayout(previousLayout)
            store.seedPreviewRecords()
            show(target: nil)
        }
        guard try verifyShelfLayoutsForDesign(panel) else { return false }
        let originalIDs = Set(store.records.map(\.id))
        guard panel.makeFirstResponder(search), let initialEditor = search.currentEditor() as? NSTextView,
              keyboardHint.stringValue == "↓ 选择卡片，再按空格预览",
              control(search, textView: initialEditor, doCommandBy: #selector(NSResponder.moveDown(_:))),
              panel.firstResponder is ClipCard, keyboardHint.stringValue.contains("↵ 粘贴"),
              panel.makeFirstResponder(search), let editor = search.currentEditor() as? NSTextView else { return false }
        editor.insertText("JSONx", replacementRange: NSRange(location: 0, length: 0))
        editor.setSelectedRange(NSRange(location: 5, length: 0))
        editor.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        guard editor.string == "JSON", search.stringValue == "JSON",
              Set(store.records.map(\.id)) == originalIDs else { return false }
        editor.insertText("", replacementRange: NSRange(location: 0, length: (editor.string as NSString).length))
        editor.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        guard editor.string.isEmpty, Set(store.records.map(\.id)) == originalIDs else { return false }
        editor.setMarkedText("拼音", selectedRange: NSRange(location: 2, length: 0),
                             replacementRange: NSRange(location: 0, length: 0))
        editor.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        guard Set(store.records.map(\.id)) == originalIDs else { return false }
        editor.unmarkText()
        editor.insertText("", replacementRange: NSRange(location: 0, length: (editor.string as NSString).length))

        let rename = BoardRenameField(frame: NSRect(x: 400, y: shelfHeight - 50, width: 150, height: 24))
        rename.stringValue = "标签名"
        panel.contentView?.addSubview(rename)
        defer { rename.removeFromSuperview() }
        guard panel.makeFirstResponder(rename), let renameEditor = rename.currentEditor() as? NSTextView else { return false }
        renameEditor.setSelectedRange(NSRange(location: 3, length: 0))
        renameEditor.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        guard renameEditor.string == "标签", Set(store.records.map(\.id)) == originalIDs else { return false }
        rename.removeFromSuperview()
        showSearchForDesign("")
        guard displayedItems.count >= 3,
              let backspace = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                  windowNumber: panel.windowNumber, context: nil, characters: "\u{7f}",
                  charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51) else { return false }
        let firstID = displayedItems[0].id
        let deletedID = displayedItems[1].id
        let nextID = displayedItems[2].id
        select(displayedItems[0], paste: false)
        select(displayedItems[1], paste: false, modifiers: .command)
        guard selectedIDs.count == 2, let focused = panel.firstResponder as? ClipCard else { return false }
        focused.keyDown(with: backspace)
        guard !store.records.contains(where: { $0.id == deletedID }),
              store.records.contains(where: { $0.id == firstID }), store.records.count == originalIDs.count - 1,
              (panel.firstResponder as? ClipCard)?.item.id == nextID else { return false }

        store.setPinboard(nextID, name: store.preferences.pinboards.first ?? "收藏")
        reload()
        focusFirstCard()
        guard let pinned = panel.firstResponder as? ClipCard else { return false }
        pinned.keyDown(with: backspace)
        guard store.records.contains(where: { $0.id == nextID && $0.pinned }),
              store.records.count == originalIDs.count - 1 else { return false }
        store.setPinboard(nextID, name: nil)
        reload()
        focusFirstCard()
        guard let first = displayedItems.first(where: { $0.id == firstID }),
              let next = displayedItems.first(where: { $0.id == nextID }) else { return false }
        select(first, paste: false)
        // 取消唯一选择时仍保留该卡片；取消多选中的焦点卡时焦点必须回到可见选择。
        select(first, paste: false, modifiers: .command)
        guard selectedIDs == [firstID], (panel.firstResponder as? ClipCard)?.item.id == firstID else { return false }
        select(next, paste: false, modifiers: .command)
        select(next, paste: false, modifiers: .command)
        guard selectedIDs == [firstID], selectedID == firstID,
              let remaining = panel.firstResponder as? ClipCard, remaining.item.id == firstID else { return false }
        remaining.keyDown(with: backspace)
        guard !store.records.contains(where: { $0.id == firstID }),
              store.records.contains(where: { $0.id == nextID }) else { return false }
        guard displayedItems.count >= 2 else { return false }
        let beforeContextID = displayedItems[0].id
        let contextTarget = displayedItems[1]
        select(displayedItems[0], paste: false)
        selectForContext(contextTarget)
        guard selectedIDs == [contextTarget.id], selectedID == contextTarget.id,
              let contextFocus = panel.firstResponder as? ClipCard, contextFocus.item.id == contextTarget.id else { return false }
        contextFocus.keyDown(with: backspace)
        guard !store.records.contains(where: { $0.id == contextTarget.id }),
              store.records.contains(where: { $0.id == beforeContextID }) else { return false }
        while let card = panel.firstResponder as? ClipCard {
            let count = store.records.count
            card.keyDown(with: backspace)
            guard store.records.count == count - 1 else { return false }
        }
        guard store.records.isEmpty, search.currentEditor() === panel.firstResponder else { return false }
        (search.currentEditor() as? NSTextView)?.doCommand(by: #selector(NSResponder.deleteBackward(_:)))
        return store.records.isEmpty
    }

    @MainActor private func verifyShelfLayoutsForDesign(_ panel: NSPanel) throws -> Bool {
        for config in [#"{"maxItems":48}"#, #"{"maxItems":48,"shelfLayout":"future"}"#] {
            let options = try JSONDecoder().decode(ClipboardPreferences.self, from: Data(config.utf8))
            guard options.shelfLayout == .cards, options.maxItems == 48 else { return false }
        }
        guard !isCompact, displayedItems.count >= 3, layoutButton.toolTip == "切换为紧凑列表" else { return false }
        try DesignPreview.capture(panel, name: "02-clipboard-cards")
        select(displayedItems[1], paste: false, modifiers: .command)
        let members = selectedIDs
        let primary = selectedID
        layoutButton.performClick(nil)
        guard isCompact, members.count == 2, selectedIDs == members, selectedID == primary,
              let row = panel.firstResponder as? ClipCard, row.item.id == primary,
              row.compact, cards.isFlipped, scroll.hasVerticalScroller, !scroll.hasHorizontalScroller,
              let firstRow = visibleCards[0], firstRow.frame.maxY == row.frame.minY,
              firstRow.frame.width > cardWidth, keyboardHint.toolTip?.contains("↑ ↓ 浏览") == true else { return false }
        try DesignPreview.capture(panel, name: "02-clipboard-compact")
        guard let down = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
              windowNumber: panel.windowNumber, context: nil, characters: "\u{f701}",
              charactersIgnoringModifiers: "\u{f701}", isARepeat: false, keyCode: 125) else { return false }
        row.keyDown(with: down)
        guard selectedIDs == [displayedItems[2].id] else { return false }
        moveCard(direction: 1, modifiers: .command, focusCard: true)
        guard let last = displayedItems.last, selectedID == last.id,
              cards.visibleRect.intersects(itemFrame(at: displayedItems.count - 1)) else { return false }
        previewSelected()
        guard previewRecord?.id == last.id else { return false }
        previewWindow?.close()
        showSearchForDesign("Markdown")
        guard panel.makeFirstResponder(search), let editor = search.currentEditor() as? NSTextView else { return false }
        let selection = NSRange(location: 2, length: 2)
        editor.setSelectedRange(selection)
        let filtered = displayedItems.map(\.id)
        let selected = selectedIDs
        layoutButton.performClick(nil)
        guard !isCompact, !filtered.isEmpty, filtered == displayedItems.map(\.id),
              selected == selectedIDs, panel.firstResponder === editor, editor.selectedRange() == selection,
              scroll.hasHorizontalScroller, !scroll.hasVerticalScroller else { return false }
        layoutButton.performClick(nil)
        show(target: nil)
        guard isCompact, ClipboardStore().preferences.shelfLayout == .list,
              let focused = panel.firstResponder as? ClipCard, focused.compact,
              let backspace = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: [], timestamp: 0,
                windowNumber: panel.windowNumber, context: nil, characters: "\u{7f}",
                charactersIgnoringModifiers: "\u{7f}", isARepeat: false, keyCode: 51) else { return false }
        let deleted = focused.item.id
        focused.keyDown(with: backspace)
        guard !store.records.contains(where: { $0.id == deleted }) else { return false }
        layoutButton.performClick(nil)
        store.seedPreviewRecords()
        show(target: nil)
        return !isCompact && ClipboardStore().preferences.shelfLayout == .cards
    }

    func verifySearchSelectionForDesign() -> Bool {
        guard DesignPreview.enabled, panel != nil else { return false }
        showSearchForDesign("Markdown")
        guard displayedItems.count > 1 else { return false }
        let editor = NSTextView()
        let navigated = control(search, textView: editor, doCommandBy: #selector(NSResponder.moveRight(_:))) &&
            selectedID == displayedItems[1].id &&
            control(search, textView: editor, doCommandBy: #selector(NSResponder.moveLeft(_:))) &&
            selectedID == displayedItems[0].id
        let shiftStatus = control(search, textView: editor, doCommandBy: #selector(NSResponder.moveRightAndModifySelection(_:))) &&
            selectedIDs.count == 2 && status.stringValue == "\(displayedItems.count) 条匹配 · 2 项已选"
        guard let countCell = status.cell,
              countCell.titleRect(forBounds: status.bounds).width >= ceil(countCell.attributedStringValue.size().width),
              status.frame.maxX < keyboardHint.frame.minX else { return false }
        let singleStatus = control(search, textView: editor, doCommandBy: #selector(NSResponder.moveLeft(_:))) &&
            selectedIDs.count == 1 && status.stringValue == "\(displayedItems.count) 条匹配 · 1 项已选"
        selectedID = displayedItems.last?.id
        selectedIDs = [displayedItems.last!.id]
        search.stringValue = "json"
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        let firstSelected = !displayedItems.isEmpty && selectedID == displayedItems.first?.id &&
            selectedIDs == [displayedItems.first!.id]
        search.stringValue = "绝无此卡片-OpenAll"
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        let emptyCleared = displayedItems.isEmpty && selectedID == nil && selectedIDs.isEmpty &&
            status.stringValue == "0 条匹配" && keyboardHint.stringValue.isEmpty && !previewButton.isEnabled
        search.stringValue = ""
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: search))
        guard displayedItems.count >= 3 else { return false }
        let resetSelection = selectedID == displayedItems.first?.id
        select(displayedItems[1], paste: false, modifiers: .command)
        selectForContext(displayedItems[0])
        let keptMultiple = selectedIDs.count == 2 && status.stringValue.hasPrefix("\(displayedItems.count) 条记录 · 2 项已选")
        selectForContext(displayedItems[2])
        let contextStatus = selectedIDs == [displayedItems[2].id] &&
            status.stringValue.hasPrefix("\(displayedItems.count) 条记录 · 1 项已选")
        select(displayedItems[0], paste: false)
        previewRecord = nil
        let outsideIgnored = visibleCards[0]?.clickFullTextForDesign(startOutside: true) == true && previewRecord == nil
        let fullTextOpens = visibleCards[0]?.clickFullTextForDesign() == true && previewRecord?.id == displayedItems[0].id
        let expectedText = displayedItems[0].text
        let previousHandler = onOpenActions
        var deliveredText: String?
        onOpenActions = { if case .text(let text) = $0 { deliveredText = text } }
        defer { onOpenActions = previousHandler }
        // 预览打开后切换抽屉选区，操作按钮仍应投递预览原文。
        select(displayedItems[1], paste: false)
        let action = previewWindow?.contentView?.subviews.compactMap { $0 as? NSButton }.first { $0.title == "对内容操作" }
        action?.performClick(nil)
        let openedActions = previewWindow == nil && deliveredText == expectedText
        previewWindow?.close()
        return navigated && shiftStatus && singleStatus && firstSelected && emptyCleared &&
            resetSelection && keptMultiple && contextStatus && outsideIgnored && fullTextOpens && openedActions
    }

    func dismiss() { hide() }
    @MainActor func captureEditingForDesign() throws {
        guard DesignPreview.enabled, let panel else { return }
        startAddingBoard()
        try DesignPreview.capture(panel, name: "02-clipboard-new-tag")
        newBoardField?.stringValue = ""
        commitNewBoard()
        if let item = displayedItems.first(where: { !$0.text.isEmpty }) { select(item, paste: false) }
        editSelectedBeforePaste()
        guard let editor = DesignPreview.lastWindow, editor !== panel else {
            throw NSError(domain: "ClipboardEditorPreview", code: 1)
        }
        try DesignPreview.capture(editor, name: "02-clipboard-edit-before-paste")
        editPopover = nil
        editAction = nil
        DesignPreview.lastWindow = panel
    }

    func showSelectedPreviewForDesign() {
        guard DesignPreview.enabled else { return }
        previewSelected()
    }
    var isVisible: Bool { panel?.isVisible == true }
    var currentCard: ClipboardRecord? {
        guard isVisible else { return nil }
        return selectedRecord()
    }

    func windowDidResignKey(_ notification: Notification) {
        if !presentingDialog { hide() }
    }

    func windowDidChangeOcclusionState(_ notification: Notification) {
        updateVisibleFilePreviews()
    }

    private func updateVisibleFilePreviews() {
        guard let scroll else { return }
        let shown = DesignPreview.enabled || panel?.occlusionState.contains(.visible) == true
        let viewport = scroll.contentView.bounds
        for card in visibleCards.values {
            card.setFilePreviewVisible(shown && viewport.intersects(card.frame))
        }
    }

    // 用户确认的布局：底部通栏、大卡片、彩色类型栏；细节优化保留这些结构。
    private func build() {
        let w = ShelfPanel(contentRect: NSRect(x: 0, y: 0, width: 1200, height: shelfHeight),
                           styleMask: [.borderless, .nonactivatingPanel], backing: .buffered, defer: false)
        w.delegate = self
        w.isFloatingPanel = false
        w.hidesOnDeactivate = true
        w.hasShadow = false
        w.collectionBehavior = [.canJoinAllSpaces, .fullScreenAuxiliary]
        w.level = .screenSaver
        let root = NSVisualEffectView(frame: w.contentView!.bounds)
        root.material = .hudWindow
        root.blendingMode = .behindWindow
        root.state = .active
        root.appearance = OpenAllTheme.appearance
        root.wantsLayer = true
        root.layer?.cornerRadius = 0
        root.layer?.masksToBounds = true
        root.layer?.borderWidth = 1
        root.layer?.borderColor = OpenAllTheme.rule.cgColor
        w.contentView = root
        let surface = NSView(frame: root.bounds)
        surface.autoresizingMask = [.width, .height]
        surface.wantsLayer = true
        surface.layer?.backgroundColor = OpenAllTheme.sidebar.withAlphaComponent(0.98).cgColor
        root.addSubview(surface)
        ButtonPressFeedback.install(on: w)
        search = ShelfSearchField(frame: NSRect(x: 18, y: shelfHeight - 48, width: 220, height: 28))
        search.placeholderString = "搜索剪贴板"
        search.font = .systemFont(ofSize: 13)
        search.isBezeled = false
        search.drawsBackground = false
        search.focusRingType = .none
        // 无边框搜索的原生放大镜在聚焦时会覆盖占位文字；移除图标，保留原生清空按钮。
        (search.cell as? NSSearchFieldCell)?.searchButtonCell = nil
        search.setAccessibilityLabel("搜索剪贴板")
        search.delegate = self
        search.onTab = { [weak self] delta in self?.switchTab(delta) }
        searchOutline = NSView(frame: search.frame)
        searchOutline.wantsLayer = true
        searchOutline.layer?.cornerRadius = 6
        searchOutline.layer?.backgroundColor = OpenAllTheme.editorCanvas.cgColor
        searchOutline.layer?.borderWidth = 1
        searchOutline.layer?.borderColor = OpenAllTheme.rule.cgColor
        search.frame = searchOutline.bounds.insetBy(dx: 8, dy: 4)
        searchOutline.addSubview(search)
        root.addSubview(searchOutline)
        search.refreshWindowTheme()
        tabs = NSStackView(frame: NSRect(x: 254, y: shelfHeight - 50, width: 810, height: 32))
        tabs.orientation = .horizontal
        tabs.spacing = 6
        tabs.wantsLayer = true
        tabs.layer?.masksToBounds = true
        root.addSubview(tabs)
        layoutButton = NSButton(title: "", target: self, action: #selector(toggleShelfLayout))
        layoutButton.frame = NSRect(x: 1007, y: shelfHeight - 50, width: 30, height: 28)
        ClipboardShelfStyle.action(layoutButton)
        layoutButton.imagePosition = .imageOnly
        root.addSubview(layoutButton)
        typeFilter = NSPopUpButton(frame: NSRect(x: 1044, y: shelfHeight - 50, width: 96, height: 28), pullsDown: false)
        for title in ["全部", "文本", "链接", "图片", "文件"] { typeFilter.addItem(withTitle: title) }
        typeFilter.toolTip = "按内容类型筛选"
        typeFilter.isBordered = false
        typeFilter.font = .systemFont(ofSize: 12)
        typeFilter.target = self
        typeFilter.action = #selector(typeFilterChanged)
        root.addSubview(typeFilter)
        let close = NSButton(title: "×", target: self, action: #selector(hide))
        close.toolTip = "关闭剪贴板（Esc）"
        close.setAccessibilityLabel("关闭剪贴板")
        close.isBordered = false
        close.font = .systemFont(ofSize: 23, weight: .light)
        close.frame = NSRect(x: 1150, y: shelfHeight - 50, width: 32, height: 32)
        root.addSubview(close)
        scroll = NSScrollView(frame: NSRect(x: 18, y: 46, width: 1164, height: shelfHeight - 102))
        scroll.hasHorizontalScroller = true
        scroll.hasVerticalScroller = false
        scroll.drawsBackground = false
        scroll.horizontalScrollElasticity = .allowed
        cards = NSView(frame: NSRect(x: 0, y: 0, width: 1164, height: 190))
        scroll.documentView = cards
        scroll.contentView.postsBoundsChangedNotifications = true
        scrollObserver = NotificationCenter.default.addObserver(forName: NSView.boundsDidChangeNotification,
                                                                 object: scroll.contentView, queue: .main) { [weak self] _ in
            self?.updateVisibleCards()
        }
        root.addSubview(scroll)
        status = NSTextField(labelWithString: "")
        status.font = .monospacedDigitSystemFont(ofSize: 12, weight: .medium)
        status.textColor = OpenAllTheme.ink
        status.lineBreakMode = .byTruncatingTail
        root.addSubview(status)
        keyboardHint = NSTextField(labelWithString: "")
        keyboardHint.font = .systemFont(ofSize: 12)
        keyboardHint.textColor = OpenAllTheme.muted
        keyboardHint.alignment = .right
        keyboardHint.lineBreakMode = .byTruncatingTail
        root.addSubview(keyboardHint)
        previewButton = NSButton(title: "预览卡片", target: self, action: #selector(previewSelected))
        previewButton.frame = NSRect(x: 18, y: 11, width: 92, height: 30)
        ClipboardShelfStyle.action(previewButton)
        previewButton.toolTip = "查看完整内容（空格）"
        root.addSubview(previewButton)
        panel = w
        w.focusChanged = { [weak self] in
            self?.updateSelectionStatus()
            if self?.isCompact == true { self?.visibleCards.values.forEach { $0.needsDisplay = true } }
        }
    }

    private func moveToBottom() {
        guard let panel else { return }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        guard let screen else { return }
        let width = screen.frame.width
        shelfFrame = NSRect(x: screen.frame.minX, y: screen.frame.minY, width: width, height: shelfHeight)
        panel.setFrame(NSRect(x: shelfFrame.minX, y: shelfFrame.minY - shelfFrame.height,
                              width: width, height: shelfFrame.height), display: false)
        let root = panel.contentView!
        searchOutline.frame.size.width = min(300, width * 0.2)
        search.frame = searchOutline.bounds.insetBy(dx: 8, dy: 4)
        tabs.frame.origin.x = searchOutline.frame.maxX + 15
        typeFilter.frame.origin.x = width - 145
        layoutButton.frame.origin.x = typeFilter.frame.minX - 36
        tabs.frame.size.width = max(0, layoutButton.frame.minX - tabs.frame.minX - 12)
        root.subviews.compactMap { $0 as? NSButton }.first { $0.title == "×" }?.frame.origin.x = width - 42
        scroll.frame.size.width = width - 36
        if cards.frame.width < scroll.frame.width { cards.frame.size.width = scroll.frame.width }
        updateSelectionStatus()
    }

    func controlTextDidChange(_ notification: Notification) {
        if notification.object as? NSControl === search {
            selectedID = nil
            selectedIDs.removeAll()
            scroll.contentView.scroll(to: .zero)
            reload()
        }
    }
    func controlTextDidBeginEditing(_ notification: Notification) {
        guard notification.object as? NSControl === search else { return }
        search.refreshWindowTheme()
        updateSelectionStatus()
    }
    func controlTextDidEndEditing(_ notification: Notification) {
        if notification.object as? NSControl === search {
            searchOutline.layer?.borderColor = OpenAllTheme.rule.cgColor
            searchOutline.layer?.borderWidth = 1
            updateSelectionStatus()
        }
        if let field = notification.object as? NSTextField, field === newBoardField { commitNewBoard() }
    }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        if control === newBoardField {
            if selector == #selector(NSResponder.insertNewline(_:)) { commitNewBoard(); return true }
            if selector == #selector(NSResponder.cancelOperation(_:)) { newBoardField = nil; reload(); return true }
            return false
        }
        if control === search {
            if selector == #selector(NSResponder.moveDown(_:)), !textView.hasMarkedText(), !displayedItems.isEmpty {
                focusFirstCard()
                return true
            }
            // 搜索框的删除始终交给共享文本编辑器，空查询和输入法组合文字也不例外。
            if selector == #selector(NSResponder.deleteBackward(_:)) || selector == #selector(NSResponder.deleteForward(_:)) {
                return false
            }
            if selector == #selector(NSResponder.insertNewline(_:)) {
                pasteSelected()
                return true
            }
            if selector == #selector(NSResponder.moveLeft(_:)) {
                moveCard(direction: -1, modifiers: [], focusCard: false)
                return true
            }
            if selector == #selector(NSResponder.moveRight(_:)) {
                moveCard(direction: 1, modifiers: [], focusCard: false)
                return true
            }
            if selector == #selector(NSResponder.moveLeftAndModifySelection(_:)) {
                moveCard(direction: -1, modifiers: .shift, focusCard: false)
                return true
            }
            if selector == #selector(NSResponder.moveRightAndModifySelection(_:)) {
                moveCard(direction: 1, modifiers: .shift, focusCard: false)
                return true
            }
        }
        if selector == #selector(NSResponder.insertTab(_:)) { switchTab(1); return true }
        if selector == #selector(NSResponder.insertBacktab(_:)) { switchTab(-1); return true }
        if selector == #selector(NSResponder.cancelOperation(_:)) { hide(); return true }
        return false
    }
    private func rebuildTabs() {
        tabs.arrangedSubviews.forEach { tabs.removeArrangedSubview($0); $0.removeFromSuperview() }
        let history = ShelfTab(title: "历史", color: NSColor.white.withAlphaComponent(0.72))
        history.selected = activeBoard == nil
        history.onChoose = { [weak self] in self?.selectBoard(nil) }
        tabs.addArrangedSubview(history)
        for board in store.preferences.pinboards {
            let tab = ShelfTab(title: board, color: BoardPalette.color(store.preferences.pinboardColors[board] ?? "blue"))
            tab.selected = activeBoard == board
            tab.onChoose = { [weak self] in self?.selectBoard(board) }
            tab.onContext = { [weak self] in
                self?.presentingDialog = true
                return self?.menuForBoard(board)
            }
            tab.onContextEnd = { [weak self] in self?.finishBoardContextMenu() }
            tab.onRename = { [weak self] name in self?.renameBoard(board, to: name) }
            tabs.addArrangedSubview(tab)
        }
        let add = ShelfTab(title: "＋", color: .white)
        add.isAdd = true
        add.toolTip = "新增剪贴板标签"
        add.onChoose = { [weak self] in self?.startAddingBoard() }
        tabs.addArrangedSubview(add)
    }

    private func selectBoard(_ board: String?) {
        activeBoard = board
        selectedID = nil
        reload()
        focusFirstCard()
    }

    private func menuForBoard(_ board: String) -> NSMenu {
        let menu = NSMenu()
        let rename = NSMenuItem(title: "重命名", action: #selector(renameBoardFromMenu(_:)), keyEquivalent: "")
        rename.target = self
        rename.representedObject = board
        menu.addItem(rename)
        let delete = NSMenuItem(title: "删除", action: #selector(deleteBoardFromMenu(_:)), keyEquivalent: "")
        delete.target = self
        delete.representedObject = board
        menu.addItem(delete)
        menu.addItem(NSMenuItem.separator())
        let colors = NSView(frame: NSRect(x: 0, y: 0, width: 274, height: 42))
        for (index, choice) in BoardPalette.choices.enumerated() {
            let swatch = ColorSwatch(frame: NSRect(x: CGFloat(index) * 33 + 5, y: 5, width: 32, height: 32), color: choice.2)
            swatch.title = choice.1
            swatch.selected = store.preferences.pinboardColors[board] == choice.0
            swatch.onPick = { [weak self, weak menu] in
                menu?.cancelTracking()
                DispatchQueue.main.async { self?.store.setPinboardColor(board, color: choice.0) }
            }
            colors.addSubview(swatch)
        }
        let palette = NSMenuItem()
        palette.view = colors
        menu.addItem(palette)
        return menu
    }

    @objc private func renameBoardFromMenu(_ sender: NSMenuItem) {
        guard let board = sender.representedObject as? String else { return }
        pendingRenameBoard = board
    }

    private func finishBoardContextMenu() {
        guard let board = pendingRenameBoard else { presentingDialog = false; return }
        pendingRenameBoard = nil
        DispatchQueue.main.async { [weak self] in
            guard let self else { return }
            self.panel?.makeKeyAndOrderFront(nil)
            self.tabs.arrangedSubviews.compactMap { $0 as? ShelfTab }.first { $0.titleText == board }?.startRenaming()
            self.presentingDialog = false
        }
    }

    private func renameBoard(_ oldName: String, to requested: String) {
        let name = requested.trimmingCharacters(in: .whitespacesAndNewlines)
        guard store.renamePinboard(oldName, to: name) else { message("名称为空或已存在，请重试"); return }
        if activeBoard == oldName { activeBoard = name }
        reload()
        message("已重命名为“\(name)”")
    }

    @objc private func deleteBoardFromMenu(_ sender: NSMenuItem) {
        guard let board = sender.representedObject as? String else { return }
        store.removePinboard(board)
        if activeBoard == board { activeBoard = nil }
        reload()
        message("已删除“\(board)”；内容仍在历史记录中")
    }

    private func startAddingBoard() {
        guard newBoardField == nil else { return }
        if let add = tabs.arrangedSubviews.compactMap({ $0 as? ShelfTab }).first(where: { $0.isAdd }) {
            tabs.removeArrangedSubview(add)
            add.removeFromSuperview()
        }
        let field = NSTextField(frame: NSRect(x: 0, y: 0, width: 130, height: 28))
        field.placeholderString = "新标签名称"
        field.setAccessibilityLabel("新标签名称")
        field.widthAnchor.constraint(equalToConstant: 128).isActive = true
        field.font = .systemFont(ofSize: 13)
        field.focusRingType = .none
        field.wantsLayer = true
        field.layer?.borderWidth = 1
        field.layer?.borderColor = OpenAllTheme.accent.cgColor
        field.layer?.cornerRadius = 4
        field.delegate = self
        field.target = self
        field.action = #selector(commitNewBoard)
        tabs.addArrangedSubview(field)
        let save = NSButton(title: "↵ 创建", target: self, action: #selector(commitNewBoard))
        save.setAccessibilityLabel("创建标签")
        WindowChrome.styleAction(save)
        save.widthAnchor.constraint(equalToConstant: 64).isActive = true
        tabs.addArrangedSubview(save)
        let spacer = NSView()
        spacer.setContentHuggingPriority(.defaultLow, for: .horizontal)
        tabs.addArrangedSubview(spacer)
        newBoardField = field
        panel?.makeFirstResponder(field)
    }

    @objc private func commitNewBoard() {
        guard let field = newBoardField else { return }
        let name = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        if name.isEmpty { newBoardField = nil; reload(); return }
        guard store.addPinboard(name, color: BoardPalette.choices[store.preferences.pinboards.count % BoardPalette.choices.count].0) else {
            message("标签名称已存在，请换一个名称")
            return
        }
        newBoardField = nil
        activeBoard = name
        reload()
        focusFirstCard()
    }

    private func switchTab(_ delta: Int) {
        let boards = [""] + store.preferences.pinboards
        let current = activeBoard.flatMap { boards.firstIndex(of: $0) } ?? 0
        let next = (current + delta + boards.count) % boards.count
        activeBoard = next == 0 ? nil : boards[next]
        selectedID = nil
        selectedIDs.removeAll()
        reload()
        focusFirstCard()
    }

    private func visibleItems() -> [ClipboardRecord] {
        let filtered = store.search(search.stringValue)
        let boardItems = activeBoard.map { board in
            filtered.filter { ($0.pinboard ?? ($0.pinned ? "收藏" : "")) == board }
        } ?? filtered
        switch typeFilter?.selectedItem?.title ?? "全部" {
        case "文本": return boardItems.filter { $0.kind == "text" }
        case "链接": return boardItems.filter { $0.kind == "link" }
        case "图片": return boardItems.filter { $0.kind == "image" }
        case "文件": return boardItems.filter { $0.kind == "files" }
        default: return boardItems
        }
    }
    @objc private func typeFilterChanged() { selectedID = nil; selectedIDs.removeAll(); reload(); focusFirstCard() }
    @objc private func toggleShelfLayout() {
        store.setShelfLayout(isCompact ? .cards : .list)
        reload(keepingItems: true)
    }

    private func itemFrame(at index: Int) -> NSRect {
        if isCompact {
            return NSRect(x: 2, y: CGFloat(index) * rowHeight, width: max(0, cards.bounds.width - 4), height: rowHeight)
        }
        return NSRect(x: CGFloat(index) * cardStep + 4, y: cards.bounds.height - cardHeight - 1, width: cardWidth, height: cardHeight)
    }

    private func reload(keepingItems: Bool = false) {
        guard panel != nil else { return }
        let restoreCardFocus = panel?.firstResponder is ClipCard
        reloading = true
        if !keepingItems { rebuildTabs() }
        for card in visibleCards.values {
            card.removeFromSuperview()
            card.prepareForReuse()
            if reusableCards.count < 24 { reusableCards.append(card) }
        }
        visibleCards.removeAll()
        cards.viewWithTag(7341)?.removeFromSuperview()
        if !keepingItems {
            displayedItems = visibleItems()
            selectedIDs.formIntersection(Set(displayedItems.map(\.id)))
            if !displayedItems.contains(where: { $0.id == selectedID }) {
                selectedID = displayedItems.first(where: { selectedIDs.contains($0.id) })?.id ?? displayedItems.first?.id
            }
            if selectedIDs.isEmpty, let selectedID { selectedIDs.insert(selectedID) }
        }
        let compact = isCompact
        let changedLayout = compact != (cards is ShelfListDocument)
        if changedLayout {
            scroll.hasHorizontalScroller = !compact
            scroll.hasVerticalScroller = compact
            scroll.horizontalScrollElasticity = compact ? .none : .allowed
            scroll.verticalScrollElasticity = compact ? .allowed : .none
            let documentFrame = NSRect(origin: .zero, size: scroll.contentSize)
            cards = compact ? ShelfListDocument(frame: documentFrame) : NSView(frame: documentFrame)
            scroll.documentView = cards
            scroll.contentView.scroll(to: .zero)
        }
        if compact {
            cards.frame.size = NSSize(width: scroll.contentSize.width, height: max(scroll.contentSize.height, CGFloat(displayedItems.count) * rowHeight))
        } else {
            cards.frame.size = NSSize(width: max(scroll.contentSize.width, CGFloat(displayedItems.count) * cardStep + 8), height: max(cardHeight + 1, scroll.contentSize.height))
        }
        if changedLayout || layoutButton.toolTip == nil {
            let nextLayout = compact ? "大卡片" : "紧凑列表"
            layoutButton.image = NSImage(systemSymbolName: compact ? "square.grid.2x2" : "list.bullet", accessibilityDescription: nil)
            layoutButton.toolTip = "切换为\(nextLayout)"
            layoutButton.setAccessibilityLabel("切换为\(nextLayout)")
            layoutButton.setAccessibilityValue(compact ? "紧凑列表" : "大卡片")
            previewButton.title = compact ? "预览记录" : "预览卡片"
        }
        if displayedItems.isEmpty {
            let emptyText: String
            if hasSearchFilter { emptyText = "没有匹配的记录" }
            else if activeBoard != nil { emptyText = "这个标签还没有记录" }
            else { emptyText = "复制内容后会出现在这里" }
            let empty = NSTextField(labelWithString: emptyText)
            empty.tag = 7341
            empty.font = .systemFont(ofSize: 14)
            empty.textColor = OpenAllTheme.muted
            empty.alignment = .center
            empty.frame = NSRect(x: 16, y: 78, width: scroll.contentSize.width - 32, height: 24)
            cards.addSubview(empty)
        }
        if changedLayout, let index = displayedItems.firstIndex(where: { $0.id == selectedID }) {
            cards.scrollToVisible(itemFrame(at: index))
        }
        updateSelectionStatus()
        previewButton.isEnabled = !displayedItems.isEmpty
        reloading = false
        updateVisibleCards()
        if restoreCardFocus, let card = visibleCards.values.first(where: { $0.item.id == selectedID }) {
            panel?.makeFirstResponder(card)
        }
    }

    private func updateVisibleCards() {
        guard !reloading, scroll != nil, !displayedItems.isEmpty else { return }
        let compact = isCompact
        let step = compact ? rowHeight : cardStep
        let viewport = scroll.contentView.bounds
        let start = compact ? viewport.minY : viewport.minX
        let end = compact ? viewport.maxY : viewport.maxX
        let first = min(displayedItems.count - 1, max(0, Int(floor(start / step)) - 2))
        let last = min(displayedItems.count - 1, Int(ceil(end / step)) + 2)
        var needed = Set(first...max(first, last))
        if let selectedIndex = displayedItems.firstIndex(where: { $0.id == selectedID }) {
            needed.insert(selectedIndex)
        }
        for index in Array(visibleCards.keys) where !needed.contains(index) {
            guard let card = visibleCards.removeValue(forKey: index) else { continue }
            card.removeFromSuperview()
            card.prepareForReuse()
            if reusableCards.count < 24 { reusableCards.append(card) }
        }
        for index in needed.sorted() where visibleCards[index] == nil {
            let item = displayedItems[index]
            let card = reusableCards.popLast() ?? ClipCard(frame: .zero)
            card.compact = compact
            card.cardTextSize = store.preferences.cardTextSize
            card.frame = itemFrame(at: index)
            card.item = item
            card.searchTerm = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            card.title = item.title
            card.toolTip = "来源：\(item.sourceName)\n\(item.kind == "files" ? item.filePaths.joined(separator: "\n") : item.text.prefix(500).description)"
            card.imageURL = store.imageURL(for: item)
            let board = item.pinboard ?? (item.pinned ? store.preferences.pinboards.first : nil)
            card.boardColor = board.map { BoardPalette.color(store.preferences.pinboardColors[$0] ?? "blue") }
            card.sourceIcon = sourceIcon(for: item)
            card.selected = selectedIDs.contains(item.id)
            card.onChoose = { [weak self] selected, double, modifiers in
                self?.select(selected, paste: double, modifiers: modifiers)
            }
            card.onPreview = { [weak self] in
                self?.select(item, paste: false)
                self?.previewSelected()
            }
            card.onContext = { [weak self, weak card] selected, event in
                guard let self, let card else { return }
                self.selectForContext(selected)
                self.presentingDialog = true
                NSMenu.popUpContextMenu(self.menuForCard(selected), with: event, for: card)
                self.presentingDialog = false
            }
            card.onKey = { [weak self, weak card] event in
                guard let card else { return }
                self?.handleCardKey(event, from: card)
            }
            card.onStartDrag = { [weak self] selected, event, card in self?.startDragging(selected, from: card, event: event) }
            card.onDragEnd = { [weak self] completed in
                self?.presentingDialog = false
                if completed { self?.hide() }
            }
            cards.addSubview(card)
            visibleCards[index] = card
        }
        updateVisibleFilePreviews()
    }

    private func sourceIcon(for item: ClipboardRecord) -> NSImage? {
        let key = item.sourceBundleID ?? item.sourceName
        if let cached = cachedSourceIcons[key] { return cached }
        if let bundleID = item.sourceBundleID,
           let url = NSWorkspace.shared.urlForApplication(withBundleIdentifier: bundleID) {
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            cachedSourceIcons[key] = icon
            return icon
        }
        if let application = NSWorkspace.shared.runningApplications.first(where: { $0.localizedName == item.sourceName }),
           let url = application.bundleURL {
            let icon = NSWorkspace.shared.icon(forFile: url.path)
            cachedSourceIcons[key] = icon
            return icon
        }
        let fallback = NSImage(systemSymbolName: "app.fill", accessibilityDescription: item.sourceName)
        if let fallback { cachedSourceIcons[key] = fallback }
        return fallback
    }

    private func focusFirstCard() {
        updateVisibleCards()
        if let card = visibleCards.values.first(where: { $0.item.id == selectedID }) {
            panel?.makeFirstResponder(card)
        } else { panel?.makeFirstResponder(search) }
    }

    private func handleCardKey(_ event: NSEvent, from focusedCard: ClipCard) {
        // 只有真实获得焦点的卡片处理卡片快捷键，搜索、标签编辑和预览窗口各走自己的响应链。
        guard let panel, panel.firstResponder === focusedCard, focusedCard.window === panel,
              event.windowNumber == panel.windowNumber else { return }
        if event.modifierFlags.contains(.command), event.charactersIgnoringModifiers?.lowercased() == "k",
           let item = selectedRecord(), let card = visibleCards.values.first(where: { $0.item.id == item.id }) {
            presentingDialog = true
            menuForCard(item).popUp(positioning: nil, at: NSPoint(x: 16, y: card.bounds.maxY - 16), in: card)
            presentingDialog = false
            return
        }
        switch event.keyCode {
        case 48: switchTab(event.modifierFlags.contains(.shift) ? -1 : 1)
        case 123, 124:
            moveCard(direction: event.keyCode == 124 ? 1 : -1,
                     modifiers: event.modifierFlags, focusCard: true)
        case 125, 126:
            if isCompact { moveCard(direction: event.keyCode == 125 ? 1 : -1, modifiers: event.modifierFlags, focusCard: true) }
        case 36, 76: pasteSelected()
        case 49: previewSelected()
        case 51, 117:
            guard event.modifierFlags.intersection([.command, .control, .option, .shift]).isEmpty else { return }
            deleteFocusedCard(focusedCard.item)
        case 53: hide()
        default:
            guard event.modifierFlags.intersection([.command, .control, .option]).isEmpty,
                  let typed = event.characters, !typed.isEmpty,
                  typed.unicodeScalars.allSatisfy({ $0.value >= 32 }) else { return }
            search.stringValue = typed
            selectedID = nil
            selectedIDs.removeAll()
            scroll.contentView.scroll(to: .zero)
            reload()
            panel.makeFirstResponder(search)
            search.currentEditor()?.selectedRange = NSRange(location: (typed as NSString).length, length: 0)
        }
    }

    private func deleteFocusedCard(_ item: ClipboardRecord) {
        guard selectedID == item.id, selectedIDs.contains(item.id) else { return }
        guard !item.pinned else {
            message("固定卡片不能直接删除，请先取消固定")
            return
        }
        guard let index = displayedItems.firstIndex(where: { $0.id == item.id }) else { return }
        let nextID = displayedItems.dropFirst(index + 1).first?.id ?? displayedItems.prefix(index).last?.id
        selectedIDs.remove(item.id)
        selectedID = nextID
        if let nextID { selectedIDs.insert(nextID) }
        // Backspace 只删除焦点所在的一条；批量删除仍由现有右键操作明确触发。
        store.delete(item.id)
        reload()
        focusFirstCard()
    }

    private func moveCard(direction: Int, modifiers: NSEvent.ModifierFlags, focusCard: Bool) {
        guard !displayedItems.isEmpty else { return }
        let index = displayedItems.firstIndex(where: { $0.id == selectedID }) ?? 0
        let next = modifiers.contains(.command)
            ? (direction > 0 ? displayedItems.count - 1 : 0)
            : min(displayedItems.count - 1, max(0, index + direction))
        selectedID = displayedItems[next].id
        if modifiers.contains(.shift) { selectedIDs.insert(displayedItems[next].id) }
        else { selectedIDs = [displayedItems[next].id] }
        visibleCards.values.forEach { $0.selected = selectedIDs.contains($0.item.id) }
        updateSelectionStatus()
        cards.scrollToVisible(itemFrame(at: next))
        updateVisibleCards()
        if focusCard, let card = visibleCards[next] { panel?.makeFirstResponder(card) }
    }

    @objc private func previewSelected() {
        guard let item = selectedRecord() else { return }
        previewWindow?.close()
        previewRecord = item
        let window = ShelfPreviewWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 460),
                              styleMask: [.titled, .closable, .miniaturizable, .resizable],
                              backing: .buffered, defer: false)
        window.onClose = { [weak self, weak window] in
            guard let self, self.previewWindow === window else { return }
            self.previewWindow = nil
            self.previewRecord = nil
            self.previewHint = nil
        }
        window.isReleasedWhenClosed = false
        WindowChrome.apply(window, title: "剪贴板卡片预览")
        window.minSize = NSSize(width: 480, height: 200)
        window.center()
        let root = NSView(frame: window.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.appearance = OpenAllTheme.appearance
        window.contentView = root
        let format = ClipboardFormat.label(for: item)
        let heading = NSTextField(labelWithString: ["Markdown", "HTML"].contains(format) ? format + " 原文" : format + "预览")
        heading.font = .systemFont(ofSize: 17, weight: .semibold)
        heading.textColor = OpenAllTheme.ink
        heading.frame = NSRect(x: 24, y: 386, width: 202, height: 28)
        heading.autoresizingMask = [.minYMargin]
        root.addSubview(heading)
        let copiedAt = DateFormatter.localizedString(from: item.date, dateStyle: .short, timeStyle: .short)
        let provenance = [item.sourceName, copiedAt].filter { !$0.isEmpty }.joined(separator: " · ")
        let source = NSTextField(labelWithString: provenance)
        source.toolTip = provenance
        source.alignment = .right
        source.lineBreakMode = .byTruncatingMiddle
        source.font = .systemFont(ofSize: 12)
        source.textColor = OpenAllTheme.muted
        source.frame = NSRect(x: 234, y: 389, width: 502, height: 20)
        source.autoresizingMask = [.width, .minYMargin]
        root.addSubview(source)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 55, width: 712, height: 321))
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        let text = NSTextView(frame: scroll.bounds)
        text.string = item.kind == "files" ? item.filePaths.joined(separator: "\n") :
            (item.text.isEmpty ? item.title : item.text)
        text.isEditable = false
        text.isSelectable = true
        text.isVerticallyResizable = true
        text.autoresizingMask = [.width]
        text.textContainer?.widthTracksTextView = true
        text.font = ["JSON", "HTML"].contains(format) ?
            .monospacedSystemFont(ofSize: 14, weight: .regular) : .systemFont(ofSize: 14)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 22
        paragraph.maximumLineHeight = 22
        text.defaultParagraphStyle = paragraph
        text.textStorage?.addAttributes([.font: text.font!, .paragraphStyle: paragraph], range: NSRange(location: 0, length: text.string.utf16.count))
        text.textContainerInset = NSSize(width: 16, height: 14)
        WindowChrome.styleEditor(scroll, text: text)
        scroll.documentView = text
        root.addSubview(scroll)
        let hint = NSTextField(labelWithString: "Esc 关闭预览")
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = OpenAllTheme.muted
        hint.frame = NSRect(x: 24, y: 14, width: 356, height: 20)
        hint.lineBreakMode = .byTruncatingTail
        hint.allowsExpansionToolTips = true
        hint.autoresizingMask = [.width]
        root.addSubview(hint)
        previewHint = hint
        let pasteButton = NSButton(title: "粘贴此项", target: self, action: #selector(pastePreviewed))
        pasteButton.frame = NSRect(x: 616, y: 10, width: 120, height: 28)
        pasteButton.autoresizingMask = [.minXMargin]
        ClipboardShelfStyle.action(pasteButton, primary: true)
        root.addSubview(pasteButton)
        let copy = NSButton(title: "复制内容", target: self, action: #selector(copyPreviewed))
        copy.frame = NSRect(x: 498, y: 10, width: 108, height: 28)
        copy.autoresizingMask = [.minXMargin]
        ClipboardShelfStyle.action(copy)
        root.addSubview(copy)
        let actions = NSButton(title: "对内容操作", target: self, action: #selector(openPreviewedActions))
        actions.frame = NSRect(x: 390, y: 10, width: 98, height: 28)
        actions.autoresizingMask = [.minXMargin]
        ClipboardShelfStyle.action(actions)
        root.addSubview(actions)
        WindowChrome.installControls(on: window)
        let fileImageURL: URL?
        if item.kind == "files", item.filePaths.count == 1, let path = item.filePaths.first,
           ClipboardFilePreview.isImageCandidate(path) {
            fileImageURL = URL(fileURLWithPath: path, isDirectory: false)
        } else { fileImageURL = nil }
        let imageURL = item.kind == "image" ? store.imageURL(for: item) : fileImageURL
        if item.kind == "image" {
            text.string = imageURL == nil ? "无法载入这张图片" : "正在载入图片…"
        }
        let estimatedLines = String(text.string.prefix(12_000)).components(separatedBy: "\n").reduce(0) { $0 + max(1, Int(ceil(Double($1.count) / 65))) }
        let textHeight = min(690, max(208, 166 + estimatedLines * 22))
        window.setContentSize(NSSize(width: 760, height: item.kind == "image" || fileImageURL != nil ? 500 : textHeight))
        previewWindow = window
        WindowChrome.present(window)
        WindowChrome.activate()
        guard let imageURL else { return }
        DispatchQueue.global(qos: .userInitiated).async { [weak self, weak window] in
            let thumbnail = ClipboardFilePreview.thumbnail(at: imageURL, maxPixels: 2048)
            DispatchQueue.main.async {
                guard let window, self?.previewWindow === window else { return }
                guard let thumbnail else {
                    if fileImageURL == nil { text.string = "无法载入这张图片" }
                    return
                }
                var frame = scroll.frame
                if let fileImageURL {
                    // 文件路径仍可选中、复制和滚动；缩略图只占用其上方的空间。
                    scroll.autoresizingMask = [.width]
                    scroll.frame.size.height = 44
                    text.textContainerInset = NSSize(width: 14, height: 4)
                    text.scrollRangeToVisible(NSRange(location: text.string.utf16.count, length: 0))
                    frame.origin.y += 50
                    frame.size.height = max(0, frame.height - 50)
                    scroll.toolTip = fileImageURL.path
                } else { text.string = "" }
                let imageView = NSImageView(frame: frame)
                imageView.autoresizingMask = [.width, .height]
                imageView.imageScaling = .scaleProportionallyUpOrDown
                imageView.setAccessibilityLabel(fileImageURL?.lastPathComponent ?? "剪贴板图片")
                imageView.image = NSImage(cgImage: thumbnail, size: .zero)
                root.addSubview(imageView)
            }
        }
    }
    @objc private func copyPreviewed() {
        guard let record = previewRecord else { return }
        let copied = store.copy(record, plainText: store.preferences.plainTextByDefault)
        previewHint?.stringValue = copied ? "已复制 · Esc 关闭预览" : "复制失败，请重试"
    }

    private func select(_ item: ClipboardRecord, paste: Bool, modifiers: NSEvent.ModifierFlags = []) {
        if modifiers.contains(.command) && !paste {
            if selectedIDs.contains(item.id) { selectedIDs.remove(item.id) }
            else { selectedIDs.insert(item.id) }
            if selectedIDs.isEmpty { selectedIDs.insert(item.id) }
        } else if modifiers.contains(.shift) && !paste,
                  let anchor = displayedItems.firstIndex(where: { $0.id == selectedID }),
                  let destination = displayedItems.firstIndex(where: { $0.id == item.id }) {
            selectedIDs = Set(displayedItems[min(anchor, destination)...max(anchor, destination)].map(\.id))
        } else { selectedIDs = [item.id] }
        // 取消焦点卡的多选后，将键盘焦点移回仍有选中边框的卡片。
        let retainsCurrentSelection = selectedID.map { selectedIDs.contains($0) } ?? false
        if selectedIDs.contains(item.id) { selectedID = item.id }
        else if !retainsCurrentSelection {
            selectedID = displayedItems.first(where: { selectedIDs.contains($0.id) })?.id
        }
        updateVisibleCards()
        visibleCards.values.forEach { $0.selected = selectedIDs.contains($0.item.id) }
        updateSelectionStatus()
        if let card = visibleCards.values.first(where: { $0.item.id == selectedID }) {
            cards.scrollToVisible(card.frame)
            panel?.makeFirstResponder(card)
        }
        if paste { pasteSelected() }
    }
    private func selectForContext(_ item: ClipboardRecord) {
        if !selectedIDs.contains(item.id) { selectedIDs = [item.id] }
        selectedID = item.id
        visibleCards.values.forEach { $0.selected = selectedIDs.contains($0.item.id) }
        updateSelectionStatus()
        // 右键选择与键盘焦点保持一致，关闭菜单后按删除键只作用于这张卡片。
        focusFirstCard()
    }
    private func selectedRecord() -> ClipboardRecord? {
        return displayedItems.first { $0.id == selectedID } ?? displayedItems.first
    }
    private func selectedRecords() -> [ClipboardRecord] {
        displayedItems.filter { selectedIDs.contains($0.id) }
    }
    private func selectedText() -> String? {
        let items = selectedRecords()
        guard !items.isEmpty, items.allSatisfy({ $0.kind == "text" || $0.kind == "link" }) else { return nil }
        return items.map(\.text).joined(separator: "\n")
    }
    private func startDragging(_ item: ClipboardRecord, from card: ClipCard, event: NSEvent) {
        if !selectedIDs.contains(item.id) { select(item, paste: false) }
        let items = selectedRecords()
        let writers = items.prefix(20).flatMap { store.dragWriters(for: $0) }
        guard !writers.isEmpty else { message("无法拖放这条记录"); return }
        presentingDialog = true
        card.startDrag(writers: Array(writers.prefix(30)), event: event)
    }
    private var hasSearchFilter: Bool {
        !search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty || typeFilter.indexOfSelectedItem > 0
    }

    private func updateSelectionStatus() {
        guard let panel, let root = panel.contentView else { return }
        let count = "\(displayedItems.count) 条" + (hasSearchFilter ? "匹配" : "记录")
        status.stringValue = selectedIDs.isEmpty ? count : "\(count) · \(selectedIDs.count) 项已选"
        let statusX = previewButton.frame.maxX + 14
        // 单行 NSTextField 的固有尺寸可能取到上一次已截断的标题；按完整文本和实际字体留出边距。
        let textWidth = (status.stringValue as NSString).size(withAttributes: [.font: status.font!]).width
        let statusWidth = min(max(144, ceil(textWidth) + 16), max(0, root.bounds.width - statusX - 18))
        status.frame = NSRect(x: statusX, y: 16, width: statusWidth, height: 18)
        let hintX = status.frame.maxX + 20
        keyboardHint.frame = NSRect(x: hintX, y: 16, width: max(0, root.bounds.width - hintX - 18), height: 18)

        var hints: [String]
        if displayedItems.isEmpty { hints = [] }
        else if let editor = search.currentEditor(), panel.firstResponder === editor {
            hints = [isCompact ? "↓ 选择记录，再按空格预览" : "↓ 选择卡片，再按空格预览"]
        } else if let card = panel.firstResponder as? ClipCard {
            hints = [selectedIDs.count > 1 ? "↵ 粘贴所选" : "↵ 粘贴"]
            if !card.item.pinned { hints.append(isCompact ? "⌫ 删除此条" : "⌫ 删除此卡") }
            hints += [isCompact ? "↑ ↓ 浏览" : "← → 浏览", "空格 预览", "⌘ 点击多选"]
        } else { hints = [] }
        keyboardHint.toolTip = hints.joined(separator: "　")
        var visible = hints
        while !visible.isEmpty {
            keyboardHint.stringValue = visible.joined(separator: "　")
            if keyboardHint.intrinsicContentSize.width <= keyboardHint.frame.width { return }
            visible.removeLast()
        }
        keyboardHint.stringValue = ""
    }

    private func message(_ text: String) {
        keyboardHint?.stringValue = text
        keyboardHint?.toolTip = text
    }
    @objc private func hide() {
        guard let panel, panel.isVisible, !closing else { return }
        closing = true
        var frame = shelfFrame
        frame.origin.y -= frame.height
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            panel.orderOut(nil)
            closing = false
            return
        }
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.24
            context.timingFunction = CAMediaTimingFunction(name: .easeIn)
            panel.animator().setFrame(frame, display: false)
        } completionHandler: { [weak self, weak panel] in
            guard let self, self.closing else { return }
            panel?.orderOut(nil)
            self.closing = false
        }
    }

    @objc private func copySelected() {
        if selectedIDs.count > 1 {
            _ = copyBatch()
            return
        }
        guard let item = selectedRecord() else { return }
        message(store.copy(item, plainText: store.preferences.plainTextByDefault) ? "已复制" : "复制失败")
    }
    private func copyBatch() -> Bool {
        guard selectedIDs.count > 1 else { return false }
            if let text = selectedText() {
                let board = store.deliveryPasteboard
                store.suspendRecording(for: 1)
                board.clearContents()
                guard board.setString(text, forType: .string) else { message("复制失败"); return false }
                store.poll(force: true)
                message("已复制 \(selectedIDs.count) 条文本")
                return true
            } else {
                let items = selectedRecords()
                guard items.allSatisfy({ $0.kind == "files" }) else {
                    message("批量复制支持同类型文本或文件；不同类型可拖放到目标应用")
                    return false
                }
                let urls = items.flatMap(\.filePaths).map { URL(fileURLWithPath: $0) as NSURL }
                let board = store.deliveryPasteboard
                store.suspendRecording(for: 1)
                board.clearContents()
                guard board.writeObjects(urls) else { message("复制失败"); return false }
                store.poll(force: true)
                message("已复制 \(urls.count) 个文件")
                return true
            }
    }
    @objc private func pasteSelected() {
        if selectedIDs.count > 1 {
            if copyBatch() { deliverPaste() }
        } else { paste(plainText: store.preferences.plainTextByDefault) }
    }
    @objc private func pastePlainText() {
        if selectedIDs.count > 1 { if copyBatch() { deliverPaste() } }
        else { paste(plainText: true) }
    }
    private func menuForCard(_ item: ClipboardRecord) -> NSMenu {
        let menu = NSMenu()
        menu.addItem(withTitle: "对内容操作…", action: #selector(openSelectedActions), keyEquivalent: "").target = self
        menu.addItem(.separator())
        for (title, action) in [("粘贴", #selector(pasteSelected)), ("粘贴为纯文本", #selector(pastePlainText)),
                                ("复制内容", #selector(copySelected))] {
            menu.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        if selectedIDs.count > 1 {
            let compare = menu.addItem(withTitle: "对比两条文本", action: #selector(compareSelectedText), keyEquivalent: "")
            compare.target = self
            compare.isEnabled = selectedRecords().count == 2 && selectedText() != nil
            let merge = menu.addItem(withTitle: "合并为新文本卡片", action: #selector(mergeSelectedText), keyEquivalent: "")
            merge.target = self
            merge.isEnabled = selectedText() != nil
            menu.addItem(withTitle: "删除所选未固定记录", action: #selector(deleteSelectedBatch), keyEquivalent: "").target = self
        }
        if item.kind == "link" {
            menu.addItem(withTitle: "打开链接", action: #selector(openSelectedLink), keyEquivalent: "").target = self
        }
        if item.kind == "files" {
            menu.addItem(withTitle: "在访达中显示", action: #selector(revealSelectedFile), keyEquivalent: "").target = self
            menu.addItem(withTitle: "快速预览", action: #selector(previewSelectedFile), keyEquivalent: "").target = self
        }
        menu.addItem(NSMenuItem.separator())
        let pinMenu = NSMenu()
        let unpin = NSMenuItem(title: "取消固定", action: #selector(setSelectedPinboard(_:)), keyEquivalent: "")
        unpin.target = self
        unpin.representedObject = NSNull()
        pinMenu.addItem(unpin)
        for board in store.preferences.pinboards {
            let entry = NSMenuItem(title: board, action: #selector(setSelectedPinboard(_:)), keyEquivalent: "")
            entry.target = self
            entry.representedObject = board
            pinMenu.addItem(entry)
        }
        let pin = NSMenuItem(title: "固定到标签", action: nil, keyEquivalent: "")
        pin.submenu = pinMenu
        menu.addItem(pin)
        if item.kind == "text" || item.kind == "link" {
            let snippet = menu.addItem(withTitle: "存为常用片段", action: #selector(saveSelectedSnippet), keyEquivalent: "")
            snippet.target = self
            let edit = menu.addItem(withTitle: "编辑后粘贴…", action: #selector(editSelectedBeforePaste), keyEquivalent: "")
            edit.target = self
            let toolMenu = NSMenu(title: "发送到工具")
            for (title, tag) in [("翻译", 1), ("文本对比", 2), ("JSON", 3), ("Markdown", 4)] {
                let action = NSMenuItem(title: title, action: #selector(sendSelectedToTool(_:)), keyEquivalent: "")
                action.tag = tag
                action.target = self
                toolMenu.addItem(action)
            }
            let tool = NSMenuItem(title: "发送到工具", action: nil, keyEquivalent: "")
            tool.submenu = toolMenu
            menu.addItem(tool)
        }
        menu.addItem(NSMenuItem.separator())
        let delete = menu.addItem(withTitle: "删除记录", action: #selector(deleteSelected), keyEquivalent: "")
        delete.target = self
        delete.isEnabled = !item.pinned
        return menu
    }
    @objc private func openSelectedActions() {
        guard let item = selectedRecord() else { return }
        openContentActions(for: item)
    }
    @objc private func openPreviewedActions() {
        guard let item = previewRecord else { return }
        openContentActions(for: item)
    }
    func openContentActions(for item: ClipboardRecord) {
        guard let onOpenActions else { return }
        let content: SelectedContent
        switch item.kind {
        case "image":
            guard let url = store.imageURL(for: item), let image = NSImage(contentsOf: url) else {
                if previewRecord?.id == item.id { previewHint?.stringValue = "无法载入这张图片" }
                else { message("无法载入这张图片") }
                return
            }
            content = .image(image)
        case "files": content = .files(item.filePaths.map { URL(fileURLWithPath: $0) })
        default: content = .text(item.text)
        }
        // 直接将焦点交给操作面板，不触发抽屉收起动画或唤醒原粘贴目标。
        closing = true
        panel?.orderOut(nil)
        previewWindow?.close()
        closing = false
        onOpenActions(content)
    }
    private func paste(plainText: Bool) {
        guard let item = selectedRecord(), store.copy(item, plainText: plainText) else { return }
        deliverPaste()
    }
    @objc private func pastePreviewed() {
        guard let item = previewRecord else { return }
        guard store.copy(item, plainText: store.preferences.plainTextByDefault) else {
            previewHint?.stringValue = "复制失败，请重试"
            return
        }
        guard localDestination != nil || (targetApplication != nil && AXIsProcessTrusted()) else {
            previewHint?.stringValue = "已复制；直接粘贴需启用辅助功能权限"
            return
        }
        previewWindow?.close()
        deliverPaste()
    }
    private func deliverPaste() {
        if let localDestination {
            closing = false
            panel?.orderOut(nil)
            previewWindow?.orderOut(nil)
            if !localDestination.deliver(from: store.deliveryPasteboard) {
                if !DesignPreview.enabled { panel?.makeKeyAndOrderFront(nil) }
                message("已复制；原输入位置已关闭或不支持此内容，请重新选择目标")
            }
            return
        }
        guard let targetApplication, AXIsProcessTrusted() else {
            message("已复制到剪贴板；直接粘贴需启用辅助功能权限")
            return
        }
        // 投递前立即让出焦点，避免收起动画尚未结束时截走 ⌘V。
        closing = false
        panel?.orderOut(nil)
        previewWindow?.orderOut(nil)
        targetApplication.activate(options: [])
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.2) {
            let source = CGEventSource(stateID: .hidSystemState)
            let down = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: true)
            let up = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: false)
            down?.flags = .maskCommand
            up?.flags = .maskCommand
            down?.setIntegerValueField(.eventSourceUserData, value: 0x4F414C4C)
            up?.setIntegerValueField(.eventSourceUserData, value: 0x4F414C4C)
            down?.post(tap: .cghidEventTap)
            up?.post(tap: .cghidEventTap)
        }
    }

    static func verifyLocalTargetsForDesign() -> Bool {
        guard DesignPreview.enabled else { return false }
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 500, height: 300), styleMask: [.titled], backing: .buffered, defer: false)
        let text = NSTextView(frame: NSRect(x: 0, y: 50, width: 500, height: 250))
        window.contentView?.addSubview(text)
        text.string = "前旧后"
        window.makeFirstResponder(text)
        text.setSelectedRange(NSRange(location: 1, length: 1))
        guard pasteForDesign(into: window, text: "新内容"), text.string == "前新内容后" else { return false }
        let field = NSTextField(frame: NSRect(x: 10, y: 10, width: 200, height: 24))
        window.contentView?.addSubview(field)
        field.stringValue = "查询词"
        window.makeFirstResponder(field)
        (field.currentEditor() as? NSTextView)?.setSelectedRange(NSRange(location: 0, length: 2))
        guard pasteForDesign(into: window, text: "搜索"), field.currentEditor()?.string == "搜索词" else { return false }
        text.isEditable = false
        window.makeFirstResponder(text)
        guard pasteForDesign(into: window, text: "禁止写入"), text.string == "前新内容后" else { return false }
        print("内部剪贴板：文本区、输入框与只读保护通过")
        return true
    }

    static func pasteForDesign(into window: NSWindow, text: String, preview: Bool = false) -> Bool {
        guard DesignPreview.enabled else { return false }
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let store = ClipboardStore(pasteboard: board, directory: DesignPreview.home.appendingPathComponent("paste-check-" + UUID().uuidString))
        board.setString(text, forType: .string)
        store.poll(force: true, allowOwnApp: true)
        let shelf = ClipboardShelfWindow(store: store)
        shelf.show(target: nil, localWindow: window)
        guard !shelf.displayedItems.isEmpty, shelf.targetApplication == nil else { return false }
        shelf.panel?.makeFirstResponder(shelf.search)
        if preview { shelf.previewRecord = shelf.displayedItems.first; shelf.pastePreviewed() }
        else { shelf.pasteSelected() }
        return true
    }
    @objc private func mergeSelectedText() {
        let ids = selectedRecords().map(\.id)
        guard let merged = store.mergeText(ids: ids) else { message("只能合并两条以上文本或链接，且不能超过单条大小上限"); return }
        selectedID = merged.id
        selectedIDs = [merged.id]
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        reload()
        message("已合并为新卡片并复制到剪贴板")
    }
    @objc private func compareSelectedText() {
        let items = selectedRecords()
        guard items.count == 2, items.allSatisfy({ $0.kind == "text" || $0.kind == "link" }) else { return }
        hide()
        onCompareText?(items[0].text, items[1].text)
    }
    @objc private func deleteSelectedBatch() {
        let ids = selectedRecords().filter { !$0.pinned }.map(\.id)
        for id in ids { store.delete(id) }
        selectedIDs.removeAll()
        selectedID = nil
        reload()
        message("已删除 \(ids.count) 条未固定记录")
    }
    @objc private func saveSelectedSnippet() {
        guard let item = selectedRecord(), let saved = snippets?.add(from: item) else { return }
        message("已保存片段 ;\(saved.keyword) · 可在设置中改名和编辑")
    }

    @objc private func openSelectedLink() {
        guard let item = selectedRecord(), let url = URL(string: item.text),
              ["http", "https"].contains(url.scheme?.lowercased() ?? "") else { return }
        NSWorkspace.shared.open(url)
        hide()
    }
    @objc private func revealSelectedFile() {
        guard let path = selectedRecord()?.filePaths.first else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: path)])
        hide()
    }
    @objc private func previewSelectedFile() {
        guard let path = selectedRecord()?.filePaths.first else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
        process.arguments = ["-p", path]
        try? process.run()
        hide()
    }
    @objc private func sendSelectedToTool(_ sender: NSMenuItem) {
        guard let text = selectedRecord()?.text else { return }
        let name = [1: "translate", 2: "comparison", 3: "json", 4: "markdown"][sender.tag] ?? ""
        hide()
        onSendToTool?(name, text)
    }

    @objc private func editSelectedBeforePaste() {
        guard let item = selectedRecord(), let card = visibleCards.values.first(where: { $0.item.id == item.id }) else { return }
        let popover = NSPopover()
        popover.behavior = .transient
        let controller = NSViewController()
        let root = NSView(frame: NSRect(x: 0, y: 0, width: 420, height: 290))
        root.appearance = OpenAllTheme.appearance
        let title = NSTextField(labelWithString: "编辑卡片后粘贴")
        title.font = .systemFont(ofSize: 16, weight: .semibold)
        title.textColor = OpenAllTheme.ink
        title.frame = NSRect(x: 14, y: 250, width: 392, height: 25)
        root.addSubview(title)
        let editor = NSScrollView(frame: NSRect(x: 14, y: 52, width: 392, height: 190))
        editor.hasVerticalScroller = true
        editor.scrollerStyle = .overlay
        editor.autohidesScrollers = true
        editor.scrollerKnobStyle = OpenAllTheme.isLight ? .dark : .light
        editor.drawsBackground = false
        editor.borderType = .noBorder
        editor.wantsLayer = true
        editor.layer?.cornerRadius = 6
        editor.layer?.masksToBounds = true
        let textView = NSTextView(frame: editor.bounds)
        textView.string = item.text
        let paragraph = NSMutableParagraphStyle()
        paragraph.lineSpacing = 3
        textView.defaultParagraphStyle = paragraph
        textView.textStorage?.addAttribute(.paragraphStyle, value: paragraph, range: NSRange(location: 0, length: textView.string.utf16.count))
        textView.font = .systemFont(ofSize: 14)
        textView.textContainerInset = NSSize(width: 8, height: 8)
        textView.textColor = OpenAllTheme.ink
        textView.backgroundColor = OpenAllTheme.editorCanvas
        textView.isRichText = false
        editor.documentView = textView
        root.addSubview(editor)
        let confirm = NSButton(title: "保存并粘贴", target: nil, action: nil)
        WindowChrome.styleAction(confirm, primary: true)
        confirm.frame = NSRect(x: 286, y: 12, width: 120, height: 30)
        let cancel = NSButton(title: "取消", target: popover, action: #selector(NSPopover.performClose(_:)))
        WindowChrome.styleAction(cancel)
        cancel.keyEquivalent = "\u{1b}"
        cancel.frame = NSRect(x: 202, y: 12, width: 76, height: 30)
        root.addSubview(cancel)
        let action = ClipboardEditAction { [weak self, weak popover] in
            guard let self, self.store.editText(item.id, text: textView.string) else { return }
            popover?.close()
            self.paste(plainText: true)
        }
        confirm.target = action
        confirm.action = #selector(ClipboardEditAction.run)
        editAction = action
        editPopover = popover
        root.addSubview(confirm)
        controller.view = root
        popover.contentViewController = controller
        if DesignPreview.enabled {
            let preview = NSWindow(contentRect: root.bounds, styleMask: [.borderless], backing: .buffered, defer: false)
            root.wantsLayer = true
            root.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
            preview.contentView = root
            DesignPreview.lastWindow = preview
            return
        }
        presentingDialog = true
        popover.show(relativeTo: card.bounds, of: card, preferredEdge: .maxY)
        popover.contentViewController?.view.window?.makeFirstResponder(textView)
        NotificationCenter.default.addObserver(forName: NSPopover.didCloseNotification, object: popover, queue: .main) { [weak self] _ in
            self?.presentingDialog = false
            self?.editAction = nil
            self?.editPopover = nil
        }
    }
    @objc private func pinSelected(_ sender: NSButton) {
        guard selectedRecord() != nil else { return }
        let menu = NSMenu()
        let clear = NSMenuItem(title: "取消固定", action: #selector(setSelectedPinboard(_:)), keyEquivalent: "")
        clear.target = self
        clear.representedObject = NSNull()
        menu.addItem(clear)
        menu.addItem(NSMenuItem.separator())
        for board in store.preferences.pinboards {
            let item = NSMenuItem(title: board, action: #selector(setSelectedPinboard(_:)), keyEquivalent: "")
            item.target = self
            item.representedObject = board
            menu.addItem(item)
        }
        presentingDialog = true
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.maxY), in: sender)
        presentingDialog = false
    }

    @objc private func setSelectedPinboard(_ sender: NSMenuItem) {
        guard let item = selectedRecord() else { return }
        let board = sender.representedObject as? String
        store.setPinboard(item.id, name: board)
        message(board.map { "已固定到“\($0)”" } ?? "已取消固定")
    }
    @objc private func deleteSelected() {
        guard let item = selectedRecord() else { return }
        store.delete(item.id)
        selectedID = nil
        reload()
    }
}

// 剪贴板恢复原版按钮外观，独立于其他工具窗口的后续样式调整。
private enum ClipboardShelfStyle {
    static func action(_ button: NSButton, primary: Bool = false) {
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 9
        button.layer?.backgroundColor = (primary ? OpenAllTheme.accent : OpenAllTheme.raised.withAlphaComponent(0.42)).cgColor
        button.layer?.borderWidth = primary ? 0 : 0.5
        button.layer?.borderColor = OpenAllTheme.rule.cgColor
        button.contentTintColor = primary ? OpenAllTheme.onAccent : OpenAllTheme.ink
        button.font = .systemFont(ofSize: 11, weight: primary ? .medium : .regular)
        button.focusRingType = .none
    }
}
