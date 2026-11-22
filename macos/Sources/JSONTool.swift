import AppKit

enum JSONPrettyPrinter {
    static func compact(_ text: String) -> String? {
        guard (try? JSONValidator(text).validate()) != nil else { return nil }
        var output = ""
        var insideString = false
        var escaped = false
        for scalar in text.unicodeScalars {
            if insideString {
                output.unicodeScalars.append(scalar)
                if escaped { escaped = false }
                else if scalar == "\\" { escaped = true }
                else if scalar == "\"" { insideString = false }
            } else if scalar == "\"" {
                insideString = true
                output.unicodeScalars.append(scalar)
            } else if !CharacterSet.whitespacesAndNewlines.contains(scalar) {
                output.unicodeScalars.append(scalar)
            }
        }
        return output
    }

    static func format(_ text: String) -> String? {
        guard (try? JSONValidator(text).validate()) != nil else { return nil }
        let scalars = Array(text.unicodeScalars)
        var output = ""
        output.reserveCapacity(min(text.utf8.count * 2, 20000000))
        var depth = 0
        var outputUnits = 0, outputLines = 1
        var insideString = false
        var escaped = false
        for (index, scalar) in scalars.enumerated() {
            outputUnits += scalar.utf16.count
            if outputUnits > 10000000 || outputLines > 200000 { return nil }
            if insideString {
                output.unicodeScalars.append(scalar)
                if escaped { escaped = false }
                else if scalar == "\\" { escaped = true }
                else if scalar == "\"" { insideString = false }
                continue
            }
            switch scalar {
            case "\"":
                insideString = true
                output.unicodeScalars.append(scalar)
            case "{", "[":
                output.unicodeScalars.append(scalar)
                let closing: Unicode.Scalar = scalar == "{" ? "}" : "]"
                if scalars[(index + 1)...].first(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }) != closing {
                    depth += 1
                    output += "\n" + String(repeating: "  ", count: depth)
                    outputUnits += 1 + depth * 2; outputLines += 1
                }
            case "}", "]":
                let opening: Unicode.Scalar = scalar == "}" ? "{" : "["
                if scalars[..<index].last(where: { !CharacterSet.whitespacesAndNewlines.contains($0) }) != opening {
                    depth -= 1
                    output += "\n" + String(repeating: "  ", count: depth)
                    outputUnits += 1 + depth * 2; outputLines += 1
                }
                output.unicodeScalars.append(scalar)
            case ",":
                output += ",\n" + String(repeating: "  ", count: depth)
                outputUnits += 1 + depth * 2; outputLines += 1
            case ":": output += ": "; outputUnits += 1
            default:
                if !CharacterSet.whitespacesAndNewlines.contains(scalar) { output.unicodeScalars.append(scalar) }
            }
        }
        return output
    }
}

enum NaturalJSONFormatter {
    private enum OutputLimit: Error { case exceeded }
    private struct Writer {
        var text = ""
        var units = 0
        var lines = 1
        mutating func append(_ part: String) throws {
            units += part.utf16.count
            lines += part.utf16.reduce(0, { $0 + ($1 == 10 ? 1 : 0) })
            guard units <= 10000000, lines <= 200000 else { throw OutputLimit.exceeded }
            text += part
        }
    }

    static func format(_ text: String) -> String? {
        guard (try? JSONValidator(text).validate()) != nil,
              let value = try? JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed]) else { return nil }
        var writer = Writer()
        do { try render(value, depth: 0, into: &writer); return writer.text }
        catch { return nil }
    }

    // 逐段写入同一缓冲区并检查预算，避免多层容器反复复制整棵子树。
    private static func render(_ value: Any, depth: Int, into writer: inout Writer) throws {
        guard depth <= 128 else { throw OutputLimit.exceeded }
        let indent = String(repeating: "  ", count: depth)
        let childIndent = indent + "  "
        if let object = value as? [String: Any] {
            if object.isEmpty { try writer.append("{}"); return }
            let keys = object.keys.sorted {
                let order = $0.localizedStandardCompare($1)
                return order == .orderedSame ? $0 < $1 : order == .orderedAscending
            }
            try writer.append("{\n")
            for (index, key) in keys.enumerated() {
                if index > 0 { try writer.append(",\n") }
                try writer.append(childIndent + scalar(key) + ": ")
                try render(object[key]!, depth: depth + 1, into: &writer)
            }
            try writer.append("\n" + indent + "}")
        } else if let array = value as? [Any] {
            if array.isEmpty { try writer.append("[]"); return }
            try writer.append("[\n")
            for (index, item) in array.enumerated() {
                if index > 0 { try writer.append(",\n") }
                try writer.append(childIndent)
                try render(item, depth: depth + 1, into: &writer)
            }
            try writer.append("\n" + indent + "]")
        } else { try writer.append(scalar(value)) }
    }

    private static func scalar(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed, .withoutEscapingSlashes]) else { return "null" }
        return String(decoding: data, as: UTF8.self)
    }
}

struct JSONIssue: Error {
    let offset: Int
    let line: Int
    let column: Int
    let message: String
}

final class JSONValidator {
    private let scalars: [Unicode.Scalar]
    private var position = 0
    private var depth = 0
    init(_ text: String) { scalars = Array(text.unicodeScalars) }

    func validate() throws {
        skipSpaces()
        try value()
        skipSpaces()
        if position != scalars.count { throw issue("JSON 值之后存在多余内容") }
    }

    private func issue(_ message: String) -> JSONIssue {
        let before = scalars.prefix(position)
        let line = before.filter { $0 == "\n" }.count + 1
        let column = (before.reversed().prefix { $0 != "\n" }.count) + 1
        let offset = before.reduce(0) { $0 + $1.utf16.count }
        return JSONIssue(offset: offset, line: line, column: column, message: message)
    }
    private func skipSpaces() { while position < scalars.count && " \t\r\n".unicodeScalars.contains(scalars[position]) { position += 1 } }
    private func take(_ token: Unicode.Scalar) -> Bool {
        guard position < scalars.count, scalars[position] == token else { return false }
        position += 1
        return true
    }
    private func value() throws {
        if position < scalars.count, scalars[position] == "{" || scalars[position] == "[", depth >= 128 {
            throw issue("JSON 嵌套超过 128 层，已停止处理并保留原文")
        }
        depth += 1
        defer { depth -= 1 }
        guard position < scalars.count else { throw issue("缺少 JSON 值") }
        switch scalars[position] {
        case "{": try object()
        case "[": try array()
        case "\"": try string()
        case "t": try literal("true")
        case "f": try literal("false")
        case "n": try literal("null")
        case "-", "0"..."9": try number()
        default: throw issue("此处不是有效的 JSON 值")
        }
    }
    private func object() throws {
        position += 1
        skipSpaces()
        if take("}") { return }
        while true {
            guard position < scalars.count, scalars[position] == "\"" else { throw issue("对象键必须使用双引号") }
            try string()
            skipSpaces()
            guard take(":") else { throw issue("对象键后缺少冒号") }
            skipSpaces()
            try value()
            skipSpaces()
            if take("}") { return }
            guard take(",") else { throw issue("对象属性之间缺少逗号或右花括号") }
            skipSpaces()
            if position < scalars.count, scalars[position] == "}" { throw issue("对象最后一项后不能有逗号") }
        }
    }
    private func array() throws {
        position += 1
        skipSpaces()
        if take("]") { return }
        while true {
            try value()
            skipSpaces()
            if take("]") { return }
            guard take(",") else { throw issue("数组元素之间缺少逗号或右方括号") }
            skipSpaces()
            if position < scalars.count, scalars[position] == "]" { throw issue("数组最后一项后不能有逗号") }
        }
    }
    private func string() throws {
        position += 1
        while position < scalars.count {
            let scalar = scalars[position]
            if scalar == "\"" { position += 1; return }
            if scalar.value < 32 { throw issue("字符串包含未转义的控制字符") }
            if scalar == "\\" {
                position += 1
                guard position < scalars.count else { throw issue("转义符后缺少字符") }
                let escaped = scalars[position]
                if escaped == "u" {
                    for _ in 0..<4 {
                        position += 1
                        guard position < scalars.count,
                              (("0"..."9").contains(scalars[position]) ||
                               ("a"..."f").contains(scalars[position]) || ("A"..."F").contains(scalars[position])) else {
                            throw issue("Unicode 转义需要四位十六进制数字")
                        }
                    }
                } else if !"\"\\/bfnrt".unicodeScalars.contains(escaped) { throw issue("无效的字符串转义") }
            }
            position += 1
        }
        throw issue("字符串缺少结束引号")
    }
    private func literal(_ text: String) throws {
        for expected in text.unicodeScalars {
            guard position < scalars.count, scalars[position] == expected else { throw issue("无效的关键字，预期 \(text)") }
            position += 1
        }
    }
    private func number() throws {
        _ = take("-")
        guard position < scalars.count else { throw issue("数字不完整") }
        if !take("0") {
            guard ("1"..."9").contains(scalars[position]) else { throw issue("数字首位无效") }
            while position < scalars.count, ("0"..."9").contains(scalars[position]) { position += 1 }
        }
        if take(".") {
            guard position < scalars.count, ("0"..."9").contains(scalars[position]) else { throw issue("小数点后需要数字") }
            while position < scalars.count, ("0"..."9").contains(scalars[position]) { position += 1 }
        }
        if take("e") || take("E") {
            if !take("+") { _ = take("-") }
            guard position < scalars.count, ("0"..."9").contains(scalars[position]) else { throw issue("指数后需要数字") }
            while position < scalars.count, ("0"..."9").contains(scalars[position]) { position += 1 }
        }
    }
}

private final class JSONEditorTextView: OpenAllTextView {
    private(set) var fastScrollCount = 0

    override func scrollRangeToVisible(_ range: NSRange) {
        let source = string as NSString
        guard source.length > 200000, range.location != NSNotFound,
              source.lineRange(for: NSRange(location: min(range.location, source.length), length: 0)).length > 32768,
              let manager = layoutManager, let container = textContainer else {
            super.scrollRangeToVisible(range); return
        }
        // 超长单行直接定位目标字形，避免系统为整行计算所有插入点。
        let offset = min(NSMaxRange(range), source.length)
        let glyph = manager.glyphIndexForCharacter(at: min(offset, source.length - 1))
        let line = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
        let position = manager.location(forGlyphAt: glyph)
        let advance = offset == source.length ? (font?.advancement(forGlyph: manager.glyph(at: glyph)).width ?? 8) : 0
        let rect = NSRect(x: textContainerOrigin.x + line.minX + position.x + advance,
                          y: textContainerOrigin.y + line.minY, width: 12, height: max(22, line.height))
        scrollToVisible(rect.insetBy(dx: -12, dy: -8))
        fastScrollCount += 1
        _ = container
    }
    var selectedSource: (() -> String?)?
    var refreshFoldAppearance: (() -> Void)?
    var onExpandFold: ((Int) -> Void)?
    var prepareMarkedInput: ((NSRange) -> NSRange)?
    var finishMarkedInput: (() -> Void)?
    private var updatingMarkedInput = false
    var foldLabels: [(range: NSRange, start: Int)] = [] { didSet { needsDisplay = true } }

    override func setMarkedText(_ string: Any, selectedRange: NSRange, replacementRange: NSRange) {
        let range = prepareMarkedInput?(replacementRange) ?? replacementRange
        updatingMarkedInput = true
        super.setMarkedText(string, selectedRange: selectedRange, replacementRange: range)
        updatingMarkedInput = false
    }

    override func insertText(_ string: Any, replacementRange: NSRange) {
        updatingMarkedInput = true
        let plain = (string as? String) ?? (string as? NSAttributedString)?.string
        if let plain, plain.utf16.count > 200000, !hasMarkedText() {
            let target = replacementRange.location == NSNotFound ? selectedRange() : replacementRange
            // 大段纯文本沿原生编辑协议登记撤销，跳过逐项输入替换处理。
            if shouldChangeText(in: target, replacementString: plain) {
                textStorage?.replaceCharacters(in: target, with: plain)
                didChangeText()
                setSelectedRange(NSRange(location: target.location + plain.utf16.count, length: 0))
                scrollRangeToVisible(selectedRange())
            }
        } else {
            super.insertText(string, replacementRange: replacementRange)
        }
        updatingMarkedInput = false
        if !hasMarkedText() { finishMarkedInput?() }
    }

    override func unmarkText() {
        super.unmarkText()
        if !updatingMarkedInput { finishMarkedInput?() }
    }

    override func refreshCurrentTheme() {
        super.refreshCurrentTheme()
        backgroundColor = OpenAllTheme.editorCanvas
        enclosingScrollView?.backgroundColor = backgroundColor
        enclosingScrollView?.layer?.borderColor = OpenAllTheme.rule.withAlphaComponent(OpenAllTheme.isLight ? 0.09 : 0.06).cgColor
        refreshFoldAppearance?()
    }

    override func draw(_ dirtyRect: NSRect) {
        super.draw(dirtyRect)
        guard let manager = layoutManager, let container = textContainer, let font else { return }
        let source = string as NSString
        let glyphs = manager.glyphRange(forBoundingRect: dirtyRect.offsetBy(dx: -textContainerOrigin.x, dy: -textContainerOrigin.y), in: container)
        guard glyphs.location < manager.numberOfGlyphs else { return }
        var offset = source.lineRange(for: NSRange(location: manager.characterIndexForGlyph(at: glyphs.location), length: 0)).location
        let advance = (" " as NSString).size(withAttributes: [.font: font]).width
        (OpenAllTheme.isLight ? NSColor.black : NSColor.white).withAlphaComponent(0.07).setStroke()
        // 导线仅落在缩进空白中，帮助阅读层级，不参与文本存储或复制。
        while offset < source.length {
            let line = source.lineRange(for: NSRange(location: offset, length: 0))
            let fragment = manager.lineFragmentRect(forGlyphAt: manager.glyphIndexForCharacter(at: offset), effectiveRange: nil)
            let y = fragment.minY + textContainerOrigin.y
            if y > dirtyRect.maxY { break }
            var spaces = 0
            while spaces < 256, offset + spaces < NSMaxRange(line), source.character(at: offset + spaces) == 32 { spaces += 1 }
            if spaces >= 4 {
                for level in 1..<min(64, spaces / 2) {
                    let x = textContainerOrigin.x + container.lineFragmentPadding + CGFloat(level * 2) * advance
                    let path = NSBezierPath()
                    path.move(to: NSPoint(x: x, y: y))
                    path.line(to: NSPoint(x: x, y: y + fragment.height))
                    path.lineWidth = 0.5
                    path.stroke()
                }
            }
            offset = NSMaxRange(line)
        }
    }

    private func foldLabelRect(_ range: NSRange) -> NSRect {
        guard let manager = layoutManager, let container = textContainer else { return .zero }
        let glyphs = manager.glyphRange(forCharacterRange: range, actualCharacterRange: nil)
        return manager.boundingRect(forGlyphRange: glyphs, in: container)
            .offsetBy(dx: textContainerOrigin.x, dy: textContainerOrigin.y)
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let label = visibleFoldLabels().first(where: { foldLabelRect($0.range).contains(point) }) {
            onExpandFold?(label.start)
        } else { super.mouseDown(with: event) }
    }

    override func resetCursorRects() {
        super.resetCursorRects()
        for label in visibleFoldLabels() { addCursorRect(foldLabelRect(label.range), cursor: .pointingHand) }
    }

    private func visibleFoldLabels() -> [(range: NSRange, start: Int)] {
        guard !foldLabels.isEmpty, let manager = layoutManager, let container = textContainer else { return [] }
        let glyphs = manager.glyphRange(forBoundingRect: visibleRect.offsetBy(dx: -textContainerOrigin.x, dy: -textContainerOrigin.y), in: container)
        let range = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        return foldLabels.filter { NSIntersectionRange($0.range, range).length > 0 }
    }

    func clickFoldLabelForDesign(start: Int) -> Bool {
        guard DesignPreview.enabled, let window, let label = foldLabels.first(where: { $0.start == start }) else { return false }
        let rect = foldLabelRect(label.range)
        guard let event = NSEvent.mouseEvent(with: .leftMouseDown,
            location: convert(NSPoint(x: rect.midX, y: rect.midY), to: nil), modifierFlags: [], timestamp: 0,
            windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1) else { return false }
        mouseDown(with: event)
        return true
    }

    // 折叠只影响显示；复制、拖出和系统服务始终读取完整的原文选区。
    override var writablePasteboardTypes: [NSPasteboard.PasteboardType] { [.string] }
    override func writeSelection(to pboard: NSPasteboard, type: NSPasteboard.PasteboardType) -> Bool {
        guard type == .string, let value = selectedSource?() else { return false }
        return pboard.setString(value, forType: .string)
    }
}

private final class JSONLineRuler: NSRulerView {
    private weak var editor: NSTextView?
    var projection = JSONFoldDocument(source: "").projection() { didSet {
        regionsByLine = Dictionary(projection.visibleRegions.map { ($0.lineIndex, $0) }, uniquingKeysWith: { first, _ in first })
        refreshWidth(); needsDisplay = true
    } }
    private var regionsByLine: [Int: JSONFoldVisibleRegion] = [:]
    var onToggle: ((Int) -> Void)?
    private var foldTargets: [(rect: NSRect, start: Int)] = []
    override var isFlipped: Bool { true }

    init(scroll: NSScrollView, editor: NSTextView) {
        self.editor = editor
        super.init(scrollView: scroll, orientation: .verticalRuler)
        clientView = editor
        ruleThickness = 52
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(refresh),
            name: NSView.boundsDidChangeNotification, object: scroll.contentView)
        setAccessibilityLabel("JSON 行号；点击三角形折叠或展开对象与数组")
        toolTip = "点击有箭头的行号，折叠或展开对象与数组"
    }
    required init(coder: NSCoder) { fatalError("不支持从归档创建") }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func refresh() { needsDisplay = true }

    private func refreshWidth() {
        let digits = String(projection.lineNumbers.last ?? 1).count
        let width = max(52, CGFloat(digits) * 7 + 29)
        if ruleThickness != width { ruleThickness = width }
    }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let editor, let manager = editor.layoutManager, let container = editor.textContainer else { return }
        editor.backgroundColor.setFill()
        bounds.fill()
        foldTargets.removeAll(keepingCapacity: true)
        OpenAllTheme.rule.withAlphaComponent(OpenAllTheme.isLight ? 0.08 : 0.05).setFill()
        NSRect(x: bounds.width - 0.5, y: 0, width: 0.5, height: bounds.height).fill()
        manager.ensureLayout(forBoundingRect: editor.visibleRect.offsetBy(dx: -editor.textContainerOrigin.x, dy: -editor.textContainerOrigin.y), in: container)
        let source = editor.string as NSString
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .right
        let numberFont = NSFont.monospacedDigitSystemFont(ofSize: 12.5, weight: .regular)
        // 只遍历当前视口附近的逻辑行；软换行不重复编号。
        let visibleGlyphs = manager.glyphRange(forBoundingRect: editor.visibleRect.offsetBy(dx: -editor.textContainerOrigin.x,
            dy: -editor.textContainerOrigin.y), in: container)
        let firstCharacter = visibleGlyphs.location < manager.numberOfGlyphs ? manager.characterIndexForGlyph(at: visibleGlyphs.location) : 0
        var lower = 0
        var upper = projection.lineStarts.count
        while lower < upper {
            let middle = (lower + upper) / 2
            if projection.lineStarts[middle] <= firstCharacter { lower = middle + 1 } else { upper = middle }
        }
        for index in max(0, lower - 1)..<projection.lineStarts.count {
            let offset = projection.lineStarts[index]
            let fragment: NSRect
            let baseline: CGFloat
            if offset < source.length {
                let glyph = manager.glyphIndexForCharacter(at: offset)
                fragment = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
                baseline = manager.location(forGlyphAt: glyph).y
            } else {
                fragment = manager.extraLineFragmentRect
                baseline = editor.font?.ascender ?? 14
            }
            let point = convert(NSPoint(x: 0, y: fragment.minY + editor.textContainerOrigin.y), from: editor)
            let height = max(fragment.height, 17)
            if point.y > bounds.maxY { break }
            if point.y + height < bounds.minY { continue }
            (String(projection.lineNumbers[index]) as NSString).draw(in: NSRect(x: 4, y: point.y + baseline - numberFont.ascender,
                width: bounds.width - 25, height: height), withAttributes: [
                    .font: numberFont,
                    .foregroundColor: OpenAllTheme.ink.withAlphaComponent(0.74), .paragraphStyle: paragraph])
            if let region = regionsByLine[index], onToggle != nil {
                let target = NSRect(x: 0, y: point.y, width: bounds.width - 1, height: height)
                foldTargets.append((target, region.region.start))
                let center = NSPoint(x: bounds.width - 12, y: point.y + baseline - (editor.font?.capHeight ?? 10) / 2)
                let path = NSBezierPath()
                if region.isCollapsed {
                    path.move(to: NSPoint(x: center.x - 2, y: center.y - 3.5))
                    path.line(to: NSPoint(x: center.x + 2, y: center.y))
                    path.line(to: NSPoint(x: center.x - 2, y: center.y + 3.5))
                } else {
                    path.move(to: NSPoint(x: center.x - 3.5, y: center.y - 2))
                    path.line(to: NSPoint(x: center.x, y: center.y + 2))
                    path.line(to: NSPoint(x: center.x + 3.5, y: center.y - 2))
                }
                (region.isCollapsed ? OpenAllTheme.accentText : OpenAllTheme.muted).setStroke()
                path.lineWidth = 1.4
                path.lineCapStyle = .round
                path.lineJoinStyle = .round
                path.stroke()
            }
        }
    }

    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        if let target = foldTargets.first(where: { $0.rect.contains(point) }) { onToggle?(target.start) }
    }

    func clickFoldForDesign(start: Int) -> Bool {
        guard DesignPreview.enabled, let window else { return false }
        display()
        guard let target = foldTargets.first(where: { $0.start == start }),
              let event = NSEvent.mouseEvent(with: .leftMouseDown,
                  location: convert(NSPoint(x: target.rect.midX, y: target.rect.midY), to: nil),
                  modifierFlags: [], timestamp: 0, windowNumber: window.windowNumber, context: nil,
                  eventNumber: 0, clickCount: 1, pressure: 1) else { return false }
        mouseDown(with: event)
        return true
    }
}

private final class JSONSearchWindow: NSWindow {
    var handleSearchKey: ((NSEvent) -> Bool)?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if handleSearchKey?(event) == true { return true }
        return super.performKeyEquivalent(with: event)
    }
    override func sendEvent(_ event: NSEvent) {
        if event.type == .keyDown, handleSearchKey?(event) == true { return }
        super.sendEvent(event)
    }
}

final class JSONToolWindow: NSObject, NSTextViewDelegate, NSSearchFieldDelegate {
    private struct DocumentSnapshot {
        let document: JSONFoldDocument
        let projection: JSONFoldProjection
        let supportsFolding: Bool
        let selection: NSRange
    }
    private static let clearDocumentAction = "清空全文"
    private var window: NSWindow?
    private var editor: JSONEditorTextView!
    private var status: NSTextField!
    private var documentSummary: NSTextField!
    private var copyButton: NSButton!
    private var foldButton: NSButton!
    private var ruler: JSONLineRuler!
    private var result = JSONFoldDocument(source: "")
    private var projection = JSONFoldDocument(source: "").projection()
    private var renderingEditor = false
    private var supportsFolding = false
    private var operationButtons: [NSButton] = []
    private let history = UndoManager()
    private var searchBar: NSView!
    private var overflowFold: NSMenuItem!
    private var overflowCopy: NSMenuItem!
    private var searchButton: NSButton!
    private var searchField: NSSearchField!
    private var searchCount: NSTextField!
    private var searchCase: NSButton!
    private var searchPrevious: NSButton!
    private var searchNext: NSButton!
    private var searchMatches: [NSRange] = []
    private var searchIndex = -1
    private var searchVisible = false
    private var searchLimited = false
    private var applyingFoldedEdit = false
    private var compositionFolds: JSONFoldDocument?
    private var historyFolds: JSONFoldDocument?
    private var applyingDocumentHistory = false
    private var fullExpansionCount = 0
    private var largeDocument = false
    private var hasLargeHistory = false
    private var historyDocumentLength = 0
    private var revision = 0
    private var operationVersion = 0
    private var operationWork: DispatchWorkItem?
    private var metadataWork: DispatchWorkItem?
    private var searchWork: DispatchWorkItem?
    private var searchNeedsRefresh = false
    private let processingQueue = DispatchQueue(label: "OpenAll.JSON.processing", qos: .userInitiated)
    private let metadataQueue = DispatchQueue(label: "OpenAll.JSON.metadata", qos: .userInitiated)

    deinit { NotificationCenter.default.removeObserver(self) }

    func undoManager(for view: NSTextView) -> UndoManager? { history }

    func show(_ initial: String, initialOperation: Int? = nil) {
        if window == nil { build() }
        if !initial.isEmpty, !loadContent(initial) { WindowChrome.present(window); return }
        if initialOperation == 0 { formatJSON() }
        if initialOperation == 1 { compactJSON() }
        WindowChrome.present(window)
        WindowChrome.activate()
        window?.makeFirstResponder(editor)
    }

    private func build() {
        let w = JSONSearchWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 600),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        WindowChrome.apply(w, title: "JSON 工具")
        w.minSize = NSSize(width: 760, height: 440)
        w.center()
        let root = NSView(frame: w.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.appearance = OpenAllTheme.appearance
        root.autoresizingMask = [.width, .height]
        w.contentView = root
        let divider = NSView(frame: NSRect(x: 301, y: 520, width: 1, height: 18))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        divider.autoresizingMask = [.minYMargin]
        root.addSubview(divider)
        let operations: [(Int, String, CGFloat)] = [(0, "格式化  ⌘↵", 108), (2, "压缩", 58)]
        var actionX: CGFloat = 20
        for (index, name, width) in operations {
            let action = NSButton(title: name, target: self, action: #selector(performOperationButton(_:)))
            action.tag = index
            action.frame = NSRect(x: actionX, y: 515, width: width, height: 28)
            action.autoresizingMask = [.minYMargin]
            styleToolbarButton(action, primary: index == 0)
            if index == 0 {
                action.keyEquivalent = "\r"
                action.keyEquivalentModifierMask = [.command]
                let title = NSMutableAttributedString(string: "格式化", attributes: [
                    .font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: OpenAllTheme.onAccent])
                title.append(NSAttributedString(string: "  ⌘↵", attributes: [
                    .font: NSFont.systemFont(ofSize: 11), .foregroundColor: OpenAllTheme.onAccent.withAlphaComponent(0.7)]))
                action.attributedTitle = title
            }
            root.addSubview(action)
            operationButtons.append(action)
            actionX += width + 8
        }
        let more = NSPopUpButton(frame: NSRect(x: actionX, y: 515, width: 88, height: 28), pullsDown: true)
        more.autoresizingMask = [.minYMargin]
        more.isBordered = false
        more.font = .systemFont(ofSize: 13)
        more.contentTintColor = OpenAllTheme.ink.withAlphaComponent(0.74)
        more.addItem(withTitle: "更多操作")
        for (tag, title) in [(1, "自然排序"), (3, "添加转义"), (4, "去除转义")] {
            let item = NSMenuItem(title: title, action: #selector(performMenuOperation(_:)), keyEquivalent: "")
            item.tag = tag
            item.target = self
            more.menu?.addItem(item)
        }
        overflowFold = NSMenuItem(title: "全部折叠", action: #selector(toggleAllFolds), keyEquivalent: "")
        overflowCopy = NSMenuItem(title: "复制全文", action: #selector(copyContent), keyEquivalent: "")
        for item in [overflowFold!, overflowCopy!] {
            item.target = self
            item.isHidden = true
            more.menu?.addItem(item)
        }
        root.addSubview(more)
        let copy = NSButton(title: "复制全文", target: self, action: #selector(copyContent))
        copy.frame = NSRect(x: 389, y: 515, width: 76, height: 28)
        copy.autoresizingMask = [.minYMargin]
        styleToolbarButton(copy)
        copy.isEnabled = false
        copyButton = copy
        root.addSubview(copy)
        foldButton = NSButton(title: "全部折叠", target: self, action: #selector(toggleAllFolds))
        foldButton.frame = NSRect(x: 311, y: 515, width: 76, height: 28)
        foldButton.autoresizingMask = [.minYMargin]
        foldButton.toolTip = "折叠或展开所有对象与数组；复制始终保留完整内容"
        styleToolbarButton(foldButton)
        foldButton.isEnabled = false
        root.addSubview(foldButton)
        editor = makeEditor(root: root)
        buildSearch(root: root)
        w.handleSearchKey = { [weak self] in self?.handleSearchKey($0) ?? false }
        status = NSTextField(labelWithString: "就绪")
        status.font = .systemFont(ofSize: 13)
        status.textColor = OpenAllTheme.muted
        status.lineBreakMode = .byTruncatingTail
        status.frame = NSRect(x: 20, y: 7, width: 700, height: 18)
        status.autoresizingMask = [.width]
        root.addSubview(status)
        documentSummary = NSTextField(labelWithString: "0 行")
        documentSummary.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        documentSummary.textColor = OpenAllTheme.muted
        documentSummary.alignment = .right
        documentSummary.frame = NSRect(x: 730, y: 7, width: 210, height: 18)
        documentSummary.autoresizingMask = [.minXMargin]
        root.addSubview(documentSummary)
        WindowChrome.installControls(on: w, editorStyle: true)
        window = w
        for name in [Notification.Name.NSUndoManagerWillUndoChange, Notification.Name.NSUndoManagerWillRedoChange] {
            NotificationCenter.default.addObserver(self, selector: #selector(prepareHistoryChange), name: name, object: history)
        }
        for name in [Notification.Name.NSUndoManagerDidUndoChange, Notification.Name.NSUndoManagerDidRedoChange] {
            NotificationCenter.default.addObserver(self, selector: #selector(historyDidChange), name: name, object: history)
        }
    }

    private func styleToolbarButton(_ button: NSButton, primary: Bool = false) {
        WindowChrome.styleAction(button, primary: primary)
        button.font = .systemFont(ofSize: 13, weight: primary ? .medium : .regular)
        button.layer?.borderWidth = 0
        button.contentTintColor = primary ? OpenAllTheme.onAccent : OpenAllTheme.ink.withAlphaComponent(0.74)
        button.layer?.backgroundColor = (primary ? OpenAllTheme.accent : .clear).cgColor
    }

    private func makeEditor(root: NSView) -> JSONEditorTextView {
        let scroll = NSScrollView(frame: NSRect(x: 20, y: 34, width: 920, height: 470))
        scroll.autoresizingMask = [.width, .height]
        scroll.hasVerticalScroller = true
        let editor = JSONEditorTextView(frame: scroll.bounds)
        editor.placeholderText = "在这里粘贴或输入 JSON，格式化后继续编辑"
        editor.highlightsJSON = true
        editor.usesViewportSyntax = true
        editor.usesFocusedJSONPalette = true
        editor.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 22
        paragraph.maximumLineHeight = 22
        editor.defaultParagraphStyle = paragraph
        editor.typingAttributes[.paragraphStyle] = paragraph
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.textContainerInset = NSSize(width: 10, height: 12)
        editor.isRichText = false
        editor.isAutomaticTextReplacementEnabled = false
        editor.isAutomaticSpellingCorrectionEnabled = false
        editor.isVerticallyResizable = true
        editor.isHorizontallyResizable = false
        editor.autoresizingMask = [.width]
        editor.minSize = .zero
        editor.maxSize = NSSize(width: CGFloat.greatestFiniteMagnitude, height: CGFloat.greatestFiniteMagnitude)
        editor.textContainer?.widthTracksTextView = true
        editor.textContainer?.containerSize = NSSize(width: scroll.contentSize.width, height: CGFloat.greatestFiniteMagnitude)
        editor.delegate = self
        editor.allowsUndo = true
        WindowChrome.styleEditor(scroll, text: editor)
        editor.backgroundColor = OpenAllTheme.editorCanvas
        scroll.backgroundColor = OpenAllTheme.editorCanvas
        scroll.layer?.cornerRadius = 6
        scroll.layer?.borderWidth = 0.5
        scroll.layer?.borderColor = OpenAllTheme.rule.withAlphaComponent(0.06).cgColor
        scroll.documentView = editor
        let ruler = JSONLineRuler(scroll: scroll, editor: editor)
        scroll.verticalRulerView = ruler
        scroll.hasVerticalRuler = true
        scroll.rulersVisible = true
        self.ruler = ruler
        ruler.onToggle = { [weak self] start in self?.toggleFold(start: start) }
        editor.selectedSource = { [weak self] in self?.selectedSource() }
        editor.refreshFoldAppearance = { [weak self] in
            self?.styleFoldPlaceholders()
            self?.updateSearchHighlights()
        }
        editor.onExpandFold = { [weak self] start in
            guard let self else { return }
            self.toggleFold(start: start)
            self.window?.makeFirstResponder(self.editor)
        }
        editor.prepareMarkedInput = { [weak self] range in self?.prepareMarkedInput(range) ?? range }
        editor.finishMarkedInput = { [weak self] in self?.finishMarkedInput() }
        root.addSubview(scroll)
        return editor
    }

    private func buildSearch(root: NSView) {
        let open = NSButton(title: "搜索  ⌘F", target: self, action: #selector(openSearch))
        open.frame = NSRect(x: 844, y: 515, width: 96, height: 28)
        open.autoresizingMask = [.minXMargin, .minYMargin]
        styleToolbarButton(open)
        open.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)?
            .withSymbolConfiguration(.init(pointSize: 11, weight: .medium))
        open.imagePosition = .imageLeading
        open.imageHugsTitle = true
        open.layer?.borderWidth = 0.5
        open.setAccessibilityLabel("搜索 JSON 内容")
        root.addSubview(open)
        searchButton = open
        searchBar = NSView(frame: NSRect(x: 426, y: 472, width: 514, height: 32))
        searchBar.autoresizingMask = []
        searchBar.wantsLayer = true
        searchBar.layer?.cornerRadius = 6
        searchBar.layer?.backgroundColor = OpenAllTheme.surface.cgColor
        searchBar.layer?.borderColor = OpenAllTheme.rule.cgColor
        searchBar.layer?.borderWidth = 0.5
        searchBar.isHidden = true
        root.addSubview(searchBar)
        searchField = NSSearchField(frame: NSRect(x: 3, y: 3, width: 231, height: 26))
        searchField.autoresizingMask = [.width]
        searchField.placeholderString = "搜索 JSON 内容"
        searchField.font = .systemFont(ofSize: 14)
        searchField.focusRingType = .none
        searchField.isBezeled = false
        (searchField.cell as? NSSearchFieldCell)?.searchButtonCell = nil
        searchField.drawsBackground = false
        searchField.sendsSearchStringImmediately = true
        searchField.sendsWholeSearchString = false
        searchField.delegate = self
        searchField.setAccessibilityLabel("搜索 JSON 内容")
        let searchBorder = NSView(frame: searchField.frame)
        searchBorder.autoresizingMask = [.width]
        searchBorder.wantsLayer = true
        searchBorder.layer?.cornerRadius = 4
        searchBorder.layer?.borderWidth = 0.5
        searchBorder.layer?.borderColor = OpenAllTheme.rule.cgColor
        searchBorder.layer?.backgroundColor = OpenAllTheme.editorCanvas.cgColor
        searchField.frame = searchBorder.bounds.insetBy(dx: 8, dy: 2)
        searchBorder.addSubview(searchField)
        searchBar.addSubview(searchBorder)
        searchCount = NSTextField(labelWithString: "")
        searchCount.frame = NSRect(x: 238, y: 7, width: 110, height: 18)
        searchCount.autoresizingMask = [.minXMargin]
        searchCount.font = .monospacedDigitSystemFont(ofSize: 13, weight: .medium)
        searchCount.textColor = OpenAllTheme.ink
        searchCount.alignment = .center
        searchBar.addSubview(searchCount)
        searchCase = WindowChrome.checkbox("Aa", target: self, action: #selector(searchOptionsChanged))
        searchCase.frame = NSRect(x: 352, y: 2, width: 49, height: 28)
        searchCase.autoresizingMask = [.minXMargin]
        searchCase.font = .systemFont(ofSize: 12)
        searchCase.toolTip = "区分大小写"
        searchCase.setAccessibilityLabel("区分大小写")
        searchBar.addSubview(searchCase)
        for (x, title, action, help) in [
            (CGFloat(407), "↑", #selector(previousSearchMatch), "上一处（⇧↵ / ⇧⌘G）"),
            (CGFloat(440), "↓", #selector(nextSearchMatch), "下一处（↵ / ⌘G）"),
            (CGFloat(481), "×", #selector(closeSearch), "关闭搜索（Esc）")
        ] {
            let button = NSButton(title: title, target: self, action: action)
            button.frame = NSRect(x: x, y: 3, width: 30, height: 26)
            button.autoresizingMask = [.minXMargin]
            if title == "×" { WindowChrome.styleOutputAction(button) }
            else { WindowChrome.styleAction(button) }
            button.toolTip = help
            button.setAccessibilityLabel(help)
            searchBar.addSubview(button)
            if title == "↑" { searchPrevious = button }
            if title == "↓" { searchNext = button }
        }
        root.postsFrameChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(layoutSearchBar), name: NSView.frameDidChangeNotification, object: root)
        NotificationCenter.default.addObserver(self, selector: #selector(searchViewportChanged),
            name: NSView.boundsDidChangeNotification, object: editor.enclosingScrollView?.contentView)
    }

    private func handleSearchKey(_ event: NSEvent) -> Bool {
        if let input = window?.firstResponder as? NSTextView, input.hasMarkedText() { return false }
        let modifiers = event.modifierFlags.intersection([.command, .control, .option, .shift])
        let key = event.charactersIgnoringModifiers?.lowercased()
        if modifiers == .command, key == "f" { openSearch(); return true }
        if searchVisible, modifiers == .command || modifiers == [.command, .shift], key == "g" {
            moveSearch(by: modifiers.contains(.shift) ? -1 : 1); return true
        }
        if searchVisible, event.keyCode == 53, modifiers.isEmpty { closeSearch(); return true }
        return false
    }

    @objc private func layoutSearchBar() {
        guard let root = searchBar?.superview else { return }
        let compact = root.bounds.width < 888
        let start: CGFloat = compact ? 314 : 476
        let width = min(386, root.bounds.width - 20 - start)
        let top = editor.enclosingScrollView?.frame.maxY ?? searchButton.frame.minY
        searchBar.frame = NSRect(x: root.bounds.width - 20 - width, y: top - 1, width: width, height: 32)
        let overflow = searchVisible && compact
        foldButton.isHidden = overflow
        copyButton.isHidden = overflow
        overflowFold.isHidden = !overflow
        overflowCopy.isHidden = !overflow
        overflowFold.title = foldButton.title
    }

    @objc private func openSearch() {
        if !searchVisible {
            searchVisible = true
            searchBar.isHidden = false
            searchButton.isHidden = true
            layoutSearchBar()
        }
        if searchField.stringValue.isEmpty, let selected = selectedSource(),
           !selected.isEmpty, selected.utf16.count <= 256, !selected.contains("\n") {
            searchField.stringValue = selected
        }
        refreshSearch(navigate: true)
        window?.makeFirstResponder(searchField)
        searchField.selectText(nil)
    }

    @objc private func closeSearch() {
        guard searchVisible, !editor.hasMarkedText() else { return }
        searchWork?.cancel()
        searchNeedsRefresh = false
        searchVisible = false
        searchBar.isHidden = true
        searchButton.isHidden = false
        layoutSearchBar()
        searchMatches = []
        searchLimited = false
        searchIndex = -1
        updateSearchHighlights()
        window?.makeFirstResponder(editor)
    }

    func controlTextDidChange(_ notification: Notification) {
        guard notification.object as? NSSearchField === searchField,
              (searchField.currentEditor() as? NSTextView)?.hasMarkedText() != true else { return }
        searchWork?.cancel()
        if largeDocument {
            searchNeedsRefresh = true
            let work = DispatchWorkItem { [weak self] in self?.refreshSearch(navigate: true) }
            searchWork = work
            DispatchQueue.main.asyncAfter(deadline: .now() + 0.15, execute: work)
        } else { refreshSearch(navigate: true) }
    }

    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        guard control === searchField, !textView.hasMarkedText() else { return false }
        if selector == #selector(NSResponder.insertNewline(_:)) {
            moveSearch(by: NSApp.currentEvent?.modifierFlags.contains(.shift) == true ? -1 : 1)
            return true
        }
        if selector == #selector(NSResponder.cancelOperation(_:)) { closeSearch(); return true }
        return false
    }

    @objc private func searchOptionsChanged() { refreshSearch(navigate: true) }
    @objc private func previousSearchMatch() { moveSearch(by: -1) }
    @objc private func nextSearchMatch() { moveSearch(by: 1) }
    @objc private func searchViewportChanged() { updateSearchHighlights() }

    private func refreshSearch(navigate: Bool) {
        guard searchVisible, !editor.hasMarkedText() else { return }
        searchWork?.cancel()
        searchNeedsRefresh = false
        let previous = searchMatches.indices.contains(searchIndex) ? searchMatches[searchIndex].location : 0
        let source = result.source as NSString
        let query = searchField.stringValue
        searchMatches = []
        searchLimited = false
        if !query.isEmpty {
            var offset = 0
            while offset < source.length {
                let range = source.range(of: query, options: searchCase.state == .on ? [] : [.caseInsensitive],
                    range: NSRange(location: offset, length: source.length - offset))
                if range.location == NSNotFound || range.length == 0 { break }
                if searchMatches.count == 10000 { searchLimited = true; break }
                searchMatches.append(range)
                offset = NSMaxRange(range)
            }
        }
        searchIndex = searchMatches.isEmpty ? -1 : (navigate ? 0 : (searchMatches.firstIndex { $0.location >= previous } ?? searchMatches.count - 1))
        updateSearchCount()
        if navigate { revealSearchMatch() } else { updateSearchHighlights() }
    }

    private func updateSearchCount() {
        searchCount.stringValue = searchField.stringValue.isEmpty ? "" :
            searchMatches.isEmpty ? "无匹配结果" : "\(searchIndex + 1) / \(searchMatches.count)\(searchLimited ? "+" : "")"
        searchCount.toolTip = searchLimited ? "显示前 10,000 处匹配，请增加搜索词以缩小范围" : searchCount.stringValue
        searchCount.setAccessibilityLabel("搜索结果：\(searchCount.stringValue)")
        searchPrevious.isEnabled = !searchMatches.isEmpty
        searchNext.isEnabled = !searchMatches.isEmpty
    }

    private func moveSearch(by direction: Int) {
        if searchNeedsRefresh { refreshSearch(navigate: true); return }
        guard searchVisible, !searchMatches.isEmpty, !editor.hasMarkedText(),
              (searchField.currentEditor() as? NSTextView)?.hasMarkedText() != true else { return }
        searchIndex = (searchIndex + direction + searchMatches.count) % searchMatches.count
        updateSearchCount()
        revealSearchMatch()
    }

    private func revealSearchMatch() {
        guard searchMatches.indices.contains(searchIndex) else { updateSearchHighlights(); return }
        let match = searchMatches[searchIndex]
        // 只展开覆盖当前匹配的节点；搜索统计始终来自完整正文。
        let hidden = result.regions.filter { result.collapsed.contains($0.start) && NSIntersectionRange($0.contentRange, match).length > 0 }
        if !hidden.isEmpty {
            result.expand(starts: Set(hidden.map(\.start)))
            renderEditor(preservingPosition: true)
        }
        let range = NSRange(location: projection.projectedOffset(forSourceOffset: match.location), length: match.length)
        editor.setSelectedRange(range)
        editor.scrollRangeToVisible(range)
        updateSearchHighlights()
    }

    private func updateSearchHighlights() {
        guard let editor, let manager = editor.layoutManager, let container = editor.textContainer else { return }
        let full = NSRange(location: 0, length: (editor.string as NSString).length)
        manager.removeTemporaryAttribute(.backgroundColor, forCharacterRange: full)
        manager.removeTemporaryAttribute(.underlineStyle, forCharacterRange: full)
        manager.removeTemporaryAttribute(.underlineColor, forCharacterRange: full)
        guard searchVisible, !searchMatches.isEmpty, full.length > 0 else { return }
        let glyphs = manager.glyphRange(forBoundingRect: editor.visibleRect.offsetBy(dx: -editor.textContainerOrigin.x,
            dy: -editor.textContainerOrigin.y), in: container)
        guard glyphs.location != NSNotFound, NSMaxRange(glyphs) <= manager.numberOfGlyphs else { return }
        let visible = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
        let sourceStart = projection.sourceRange(for: NSRange(location: visible.location, length: 0)).location
        let sourceEnd = NSMaxRange(projection.sourceRange(for: visible))
        var low = 0, high = searchMatches.count
        while low < high {
            let middle = (low + high) / 2
            if NSMaxRange(searchMatches[middle]) <= sourceStart { low = middle + 1 } else { high = middle }
        }
        for index in low..<searchMatches.count {
            let match = searchMatches[index]
            if match.location > sourceEnd { break }
            let range = NSRange(location: projection.projectedOffset(forSourceOffset: match.location), length: match.length)
            guard NSMaxRange(range) <= full.length, projection.sourceRange(for: range) == match else { continue }
            manager.addTemporaryAttribute(.backgroundColor,
                value: OpenAllTheme.accentText.withAlphaComponent(index == searchIndex ? 0.34 : 0.15), forCharacterRange: range)
            if index == searchIndex {
                manager.addTemporaryAttributes([.underlineStyle: NSUnderlineStyle.single.rawValue, .underlineColor: OpenAllTheme.accentText], forCharacterRange: range)
            }
        }
    }

    private func parsedInput() -> Any? {
        let text = result.source
        do {
            try JSONValidator(text).validate()
            return text
        } catch let issue as JSONIssue {
            expandForEditing()
            status.stringValue = "第 \(issue.line) 行、第 \(issue.column) 列：\(issue.message)"
            status.textColor = .systemRed
            editor.setSelectedRange(NSRange(location: min(issue.offset, (text as NSString).length), length: 0))
            editor.scrollRangeToVisible(editor.selectedRange())
            window?.makeFirstResponder(editor)
        } catch {
            status.stringValue = "JSON 解析失败：\(error.localizedDescription)"
            status.textColor = .systemRed
        }
        return nil
    }
    @objc private func performOperationButton(_ sender: NSButton) {
        performOperation(sender.tag)
    }
    @objc private func performMenuOperation(_ sender: NSMenuItem) { performOperation(sender.tag) }
    private func performOperation(_ tag: Int) {
        switch tag {
        case 0: formatJSON()
        case 1: sortJSON()
        case 2: compactJSON()
        case 3: escapeJSON()
        case 4: unescapeJSON()
        default: break
        }
    }
    private func success(_ description: String) {
        status.stringValue = description
        status.textColor = OpenAllTheme.ink.withAlphaComponent(0.74)
        copyButton.isEnabled = !result.source.isEmpty
    }
    @objc private func formatJSON() {
        if largeDocument { processLargeJSON(action: "格式化", transform: JSONPrettyPrinter.format); return }
        guard parsedInput() != nil else { return }
        guard let formatted = JSONPrettyPrinter.format(result.source) else { status.stringValue = "处理结果过大，已保留原文"; return }
        if replaceContent(formatted, action: "格式化") { success("格式化完成") }
    }
    @objc private func sortJSON() {
        if largeDocument { processLargeJSON(action: "自然排序", transform: NaturalJSONFormatter.format); return }
        guard parsedInput() != nil else { return }
        guard let sorted = NaturalJSONFormatter.format(result.source) else { status.stringValue = "无法生成排序结果或结果过大，已保留原文"; return }
        if replaceContent(sorted, action: "自然排序") { success("自然排序完成") }
    }
    @objc private func compactJSON() {
        if largeDocument { processLargeJSON(action: "压缩", transform: JSONPrettyPrinter.compact); return }
        guard parsedInput() != nil, let compact = JSONPrettyPrinter.compact(result.source) else { return }
        if replaceContent(compact, action: "压缩") { success("压缩完成") }
    }
    @objc private func escapeJSON() {
        guard let data = try? JSONSerialization.data(withJSONObject: result.source, options: [.fragmentsAllowed]) else { return }
        if replaceContent(String(decoding: data, as: UTF8.self), action: "添加转义") { success("已转换为带引号的 JSON 字符串") }
    }
    @objc private func unescapeJSON() {
        let raw = result.source.trimmingCharacters(in: .whitespacesAndNewlines)
        let candidate = raw.hasPrefix("\"") ? raw : "\"\(raw)\""
        do {
            guard let value = try JSONSerialization.jsonObject(with: Data(candidate.utf8), options: [.fragmentsAllowed]) as? String else {
                status.stringValue = "输入不是 JSON 转义字符串"; status.textColor = .systemRed; return
            }
            if replaceContent(value, action: "去除转义") { success("已去除 JSON 字符串转义") }
        } catch {
            status.stringValue = "转义内容无效：\(error.localizedDescription)"
            status.textColor = .systemRed
        }
    }
    @objc private func copyContent() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(result.source, forType: .string)
        success("全文已复制")
    }

    @discardableResult private func loadContent(_ source: String) -> Bool {
        guard acceptsDocument(source) else { return false }
        revision += 1
        operationVersion += 1
        operationWork?.cancel()
        historyDocumentLength = 0
        hasLargeHistory = source.utf16.count > 200000
        configureDocumentSize(source)
        compositionFolds = nil
        historyFolds = nil
        applyingDocumentHistory = false
        editor.breakUndoCoalescing()
        history.removeAllActions()
        result = JSONFoldDocument(source: source, scanRegions: !largeDocument)
        supportsFolding = !largeDocument && !source.isEmpty && (try? JSONValidator(source).validate()) != nil
        renderEditor(preservingPosition: false)
        refreshSearch(navigate: false)
        success("就绪")
        scheduleMetadata()
        return true
    }

    @discardableResult private func replaceContent(_ source: String, action: String) -> Bool {
        guard acceptsDocument(source) else { return false }
        configureDocumentSize(source)
        expandForEditing()
        guard source != result.source else { return true }
        // 通过原生文本编辑协议登记整次替换，使格式化与普通输入可以分别撤销。
        editor.breakUndoCoalescing()
        history.beginUndoGrouping()
        let range = NSRange(location: 0, length: (editor.string as NSString).length)
        if editor.shouldChangeText(in: range, replacementString: source) {
            editor.textStorage?.replaceCharacters(in: range, with: source)
            editor.didChangeText()
            editor.setSelectedRange(NSRange(location: 0, length: 0))
            editor.scrollRangeToVisible(editor.selectedRange())
            history.setActionName(action)
        }
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        window?.makeFirstResponder(editor)
        return result.source == source
    }

    private func expandForEditing() {
        guard !result.collapsed.isEmpty else { return }
        fullExpansionCount += 1
        result.expandAll()
        renderEditor(preservingPosition: true)
    }

    @objc private func prepareHistoryChange(_ notification: Notification) {
        let action = notification.name == Notification.Name.NSUndoManagerWillRedoChange ? history.redoActionName : history.undoActionName
        applyingDocumentHistory = action == Self.clearDocumentAction
        // 全文快照同时保存正文与投影，不经过普通字符撤销的展开流程。
        if applyingDocumentHistory { historyFolds = nil; return }
        // 撤销记录使用完整文档的字符范围，不能直接应用到含省略标记的投影上。
        if hasLargeHistory { configureDocumentLength(200001) }
        if !result.collapsed.isEmpty { historyFolds = result }
        expandForEditing()
    }

    @objc private func historyDidChange(_ notification: Notification) {
        if applyingDocumentHistory {
            applyingDocumentHistory = false
        } else if let previous = historyFolds {
            historyFolds = nil
            restoreFolds(from: previous)
        } else { syncDocument() }
        editor.refreshCurrentTheme()
        success(notification.name == Notification.Name.NSUndoManagerDidUndoChange ? "已撤销" : "已重做")
    }

    private func selectedSource() -> String? {
        guard editor.selectedRange().length > 0 else { return nil }
        return (result.source as NSString).substring(with: projection.sourceRange(for: editor.selectedRange()))
    }

    func textView(_ textView: NSTextView, shouldChangeTextIn affectedCharRange: NSRange, replacementString: String?) -> Bool {
        if textView === editor, !renderingEditor, !applyingFoldedEdit,
           replacementString == "", projection.coversEntireDocument(affectedCharRange) {
            // 删除不可能超限：必须先走此分支，避免复制全文计行或逐个展开隐藏节点。
            guard !result.collapsed.isEmpty else { return true }
            clearWholeDocument()
            return false
        }
        if textView === editor, !renderingEditor, let replacementString {
            let sourceRange = projection.sourceRange(for: affectedCharRange)
            let length = (result.source as NSString).length - sourceRange.length + (replacementString as NSString).length
            let removedLines = sourceRange.length == 0 ? 0 : (result.source as NSString).substring(with: sourceRange).utf16.reduce(0, { $0 + ($1 == 10 ? 1 : 0) })
            if length > 10000000 || replacementString.utf8.count > 20000000 ||
                result.lineCount - removedLines + replacementString.utf16.reduce(0, { $0 + ($1 == 10 ? 1 : 0) }) > 200000 {
                status.stringValue = "内容过大（超过 20 MB、1000 万字符或 20 万行），已保留原文"
                return false
            }
            // 粘贴前就启用大文本排版，避免先为超长单行生成成千上万条软换行。
            if length > 200000 { configureDocumentLength(length) }
        }
        guard textView === editor, !renderingEditor, !applyingFoldedEdit,
              !result.collapsed.isEmpty, let replacementString else { return true }
        let selection = projection.sourceRange(for: editor.selectedRange())
        let changed = projection.sourceRange(for: affectedCharRange)
        let touched = projection.visibleRegions.filter { visible in
            guard visible.isCollapsed else { return false }
            let displayed = NSRange(location: visible.openingOffset, length: (visible.region.placeholder as NSString).length + 2)
            return affectedCharRange.length > 0 && NSIntersectionRange(displayed, affectedCharRange).length > 0
        }
        if replacementString.isEmpty && !touched.isEmpty {
            // 第一次删除只展开涉及的整个区域（含子折叠），原文与历史都不改变。
            let first = touched.first!.region.start, last = touched.last!.region.end
            let expand = result.regions.filter { result.collapsed.contains($0.start) && $0.start >= first && $0.end <= last }
            editor.breakUndoCoalescing()
            result.expand(starts: Set(expand.map(\.start)))
            renderEditor(preservingPosition: true)
            let start = projection.projectedOffset(forSourceOffset: selection.location)
            let end = projection.projectedOffset(forSourceOffset: NSMaxRange(selection))
            editor.setSelectedRange(NSRange(location: start, length: max(0, end - start)))
            editor.scrollRangeToVisible(editor.selectedRange())
            success("已展开，再按删除键删除")
            return false
        }
        let previous = result
        applyingFoldedEdit = true
        // 原生撤销只登记完整正文坐标；显示投影不会进入正文或撤销记录。
        expandForEditing()
        editor.breakUndoCoalescing()
        history.beginUndoGrouping()
        editor.insertText(replacementString, replacementRange: changed)
        history.setActionName(replacementString.isEmpty ? "删除" : "输入")
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        applyingFoldedEdit = false
        restoreFolds(from: previous)
        return false
    }

    private func documentSnapshot() -> DocumentSnapshot {
        DocumentSnapshot(document: result, projection: projection, supportsFolding: supportsFolding,
            selection: editor.selectedRange())
    }

    private func clearWholeDocument() {
        var empty = result
        empty.clear()
        let cleared = DocumentSnapshot(document: empty, projection: empty.projection(), supportsFolding: false,
            selection: NSRange(location: 0, length: 0))
        editor.breakUndoCoalescing()
        history.beginUndoGrouping()
        restoreDocumentSnapshot(cleared)
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        success("已清空")
    }

    private func restoreDocumentSnapshot(_ snapshot: DocumentSnapshot) {
        let previous = documentSnapshot()
        history.registerUndo(withTarget: self) { target in target.restoreDocumentSnapshot(previous) }
        history.setActionName(Self.clearDocumentAction)
        revision += 1
        operationVersion += 1
        operationWork?.cancel()
        metadataWork?.cancel()
        searchWork?.cancel()
        searchNeedsRefresh = false
        compositionFolds = nil
        historyFolds = nil
        result = snapshot.document
        supportsFolding = snapshot.supportsFolding
        // 直接恢复已保存的投影；清空只渲染空串，撤销也无需重新解析隐藏的大文本。
        renderEditor(preservingPosition: false, cachedProjection: snapshot.projection,
            documentLength: snapshot.projection.originalLength)
        editor.setSelectedRange(snapshot.selection)
        refreshSearch(navigate: false)
        scheduleMetadata()
    }

    private func restoreFolds(from previous: JSONFoldDocument) {
        var restored = previous
        restored.replaceSourcePreservingFolds(editor.string)
        // 此刻编辑器是完整正文，先用恒等投影保存选区，再恢复折叠显示。
        projection = JSONFoldDocument(source: editor.string, scanRegions: false).projection()
        result = restored
        supportsFolding = !result.collapsed.isEmpty || (!result.source.isEmpty && (try? JSONValidator(result.source).validate()) != nil)
        renderEditor(preservingPosition: true)
        refreshSearch(navigate: false)
    }

    private func prepareMarkedInput(_ range: NSRange) -> NSRange {
        guard !result.collapsed.isEmpty else { return range }
        let target = range.location == NSNotFound ? editor.selectedRange() : range
        let sourceRange = projection.sourceRange(for: target)
        compositionFolds = result
        // 输入法组合期间使用原生完整文本；提交后恢复未被改动的折叠节点。
        expandForEditing()
        return sourceRange
    }

    private func finishMarkedInput() {
        guard !editor.hasMarkedText(), let previous = compositionFolds else { return }
        compositionFolds = nil
        restoreFolds(from: previous)
    }

    func textDidChange(_ notification: Notification) {
        guard let changed = notification.object as? NSTextView, changed === editor, !renderingEditor else { return }
        syncDocument()
        success("已修改")
    }

    private func syncDocument() {
        revision += 1
        configureDocumentSize(editor.string)
        result = JSONFoldDocument(source: editor.string, scanRegions: !largeDocument)
        supportsFolding = !largeDocument && !result.source.isEmpty && (try? JSONValidator(result.source).validate()) != nil
        projection = result.projection()
        updateEditorControls()
        refreshSearch(navigate: false)
        scheduleMetadata()
    }

    private func acceptsDocument(_ source: String) -> Bool {
        var lines = 1
        for unit in source.utf16 where unit == 10 { lines += 1; if lines > 200000 { break } }
        guard source.utf8.count <= 20000000, source.utf16.count <= 10000000, lines <= 200000 else {
            status.stringValue = "内容过大（超过 20 MB、1000 万字符或 20 万行），已保留原文"
            return false
        }
        return true
    }

    private func configureDocumentSize(_ source: String) {
        configureDocumentLength(source.utf16.count)
    }

    private func configureDocumentLength(_ length: Int) {
        historyDocumentLength = max(historyDocumentLength, length)
        // 按本次文档的峰值大小限制历史步数，避免反复处理大文本积累大量全文副本。
        history.levelsOfUndo = max(3, min(60, 30000000 / max(1, historyDocumentLength)))
        let next = length > 200000
        if next { hasLargeHistory = true }
        guard next != largeDocument else { return }
        largeDocument = next
        editor.layoutManager?.allowsNonContiguousLayout = next
        editor.isHorizontallyResizable = next
        if !next, let scroll = editor.enclosingScrollView { editor.setFrameSize(NSSize(width: scroll.contentSize.width, height: editor.frame.height)) }
        editor.enclosingScrollView?.hasHorizontalScroller = next
        editor.textContainer?.widthTracksTextView = !next
        editor.textContainer?.containerSize = NSSize(width: next ? CGFloat.greatestFiniteMagnitude : (editor.enclosingScrollView?.contentSize.width ?? 900),
                                                    height: CGFloat.greatestFiniteMagnitude)
    }

    private func scheduleMetadata() {
        metadataWork?.cancel()
        guard largeDocument, result.collapsed.isEmpty else { return }
        let source = result.source, version = revision
        let work = DispatchWorkItem { [weak self] in
            let document = JSONFoldDocument(source: source)
            let valid = (try? JSONValidator(source).validate()) != nil
            DispatchQueue.main.async { [weak self] in
                guard let self, self.revision == version, self.result.collapsed.isEmpty, !self.editor.hasMarkedText() else { return }
                self.result = document
                self.projection = document.projection()
                self.supportsFolding = valid
                self.updateEditorControls()
            }
        }
        metadataWork = work
        metadataQueue.asyncAfter(deadline: .now() + 0.25, execute: work)
    }

    private func processLargeJSON(action: String, transform: @escaping (String) -> String?) {
        operationVersion += 1
        operationWork?.cancel()
        let version = operationVersion, sourceVersion = revision, source = result.source
        status.stringValue = "正在后台\(action)…可继续编辑"
        let work = DispatchWorkItem { [weak self] in
            let response: Result<String, Error> = Result {
                try JSONValidator(source).validate()
                guard let output = transform(source) else { throw NSError(domain: "JSONOutputLimit", code: 1,
                    userInfo: [NSLocalizedDescriptionKey: "处理结果过大，已保留原文"]) }
                return output
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.operationVersion == version else { return }
                guard self.revision == sourceVersion else { self.success("内容已修改，请重新\(action)"); return }
                switch response {
                case .success(let value):
                    if self.replaceContent(value, action: action) { self.success("\(action)完成") }
                case .failure(let issue as JSONIssue):
                    self.status.stringValue = "第 \(issue.line) 行、第 \(issue.column) 列：\(issue.message)"
                    self.status.textColor = .systemRed
                case .failure(let error): self.status.stringValue = error.localizedDescription
                }
            }
        }
        operationWork = work
        processingQueue.async(execute: work)
    }

    private func updateEditorControls() {
        let folded = result.collapsed.count
        documentSummary?.stringValue = folded == 0 ? "\(result.lineCount) 行" : "\(result.lineCount) 行 · 折叠 \(folded) 处"
        ruler.projection = projection
        ruler.onToggle = supportsFolding ? { [weak self] start in self?.toggleFold(start: start) } : nil
        foldButton.isEnabled = supportsFolding && !result.regions.isEmpty
        foldButton.title = result.collapsed.isEmpty ? "全部折叠" : "全部展开"
        overflowFold.title = foldButton.title
        copyButton.isEnabled = !result.source.isEmpty
        editor.isEditable = true
        editor.toolTip = result.collapsed.isEmpty ? nil : "全选删除直接清空；局部删除折叠区域时，第一次只展开，第二次才删除"
    }

    private func renderEditor(preservingPosition: Bool, cachedProjection: JSONFoldProjection? = nil, documentLength: Int? = nil) {
        let selection = projection.sourceRange(for: editor.selectedRange())
        let scroll = editor.enclosingScrollView
        var anchor = 0
        var lineOffset: CGFloat = 0
        if preservingPosition, let manager = editor.layoutManager, let container = editor.textContainer,
           manager.numberOfGlyphs > 0, let clip = scroll?.contentView {
            let glyph = manager.glyphIndex(for: NSPoint(x: 0, y: max(0, clip.bounds.minY - editor.textContainerOrigin.y)), in: container)
            let character = manager.characterIndexForGlyph(at: min(glyph, manager.numberOfGlyphs - 1))
            anchor = projection.sourceRange(for: NSRange(location: character, length: 0)).location
            lineOffset = clip.bounds.minY - manager.lineFragmentRect(forGlyphAt: min(glyph, manager.numberOfGlyphs - 1),
                effectiveRange: nil).minY - editor.textContainerOrigin.y
        }
        projection = cachedProjection ?? result.projection()
        renderingEditor = true
        if let documentLength, documentLength > 200000 { configureDocumentLength(documentLength) }
        let storage = editor.textStorage
        // NSTextView.string 会同步请求布局，不能置于 NSTextStorage 尚未完成的编辑事务中。
        editor.string = projection.text
        // 基础字体与全部折叠标签一次提交，避免每个节点都触发布局和字形更新。
        storage?.beginEditing()
        let full = NSRange(location: 0, length: (projection.text as NSString).length)
        storage?.removeAttribute(.backgroundColor, range: full)
        storage?.addAttribute(.font, value: NSFont.monospacedSystemFont(ofSize: 14, weight: .regular), range: full)
        let labels = storage.map { applyFoldPlaceholderAttributes(to: $0) } ?? []
        storage?.endEditing()
        editor.foldLabels = labels
        if let documentLength, documentLength <= 200000 { configureDocumentLength(documentLength) }
        editor.window?.invalidateCursorRects(for: editor)
        renderingEditor = false
        updateEditorControls()
        let start = preservingPosition ? projection.projectedOffset(forSourceOffset: selection.location) : 0
        let end = preservingPosition ? projection.projectedOffset(forSourceOffset: NSMaxRange(selection)) : 0
        editor.setSelectedRange(NSRange(location: start, length: max(0, end - start)))
        if let manager = editor.layoutManager, let container = editor.textContainer, let scroll {
            manager.ensureLayout(forBoundingRect: editor.visibleRect.offsetBy(dx: -editor.textContainerOrigin.x, dy: -editor.textContainerOrigin.y), in: container)
            var y: CGFloat = 0
            let character = projection.projectedOffset(forSourceOffset: anchor)
            if preservingPosition, character < (editor.string as NSString).length {
                let glyph = manager.glyphIndexForCharacter(at: character)
                y = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil).minY + editor.textContainerOrigin.y + lineOffset
            }
            // 标尺占用的水平内容偏移由 AppKit 管理，重置为零会把文字移到行号栏下面。
            scroll.contentView.scroll(to: NSPoint(x: scroll.contentView.bounds.minX,
                y: max(0, min(y, editor.bounds.height - scroll.contentView.bounds.height))))
            scroll.reflectScrolledClipView(scroll.contentView)
        }
        updateSearchHighlights()
    }

    private func styleFoldPlaceholders() {
        guard let storage = editor.textStorage else { return }
        storage.beginEditing()
        let labels = applyFoldPlaceholderAttributes(to: storage)
        storage.endEditing()
        editor.foldLabels = labels
        editor.window?.invalidateCursorRects(for: editor)
    }

    private func applyFoldPlaceholderAttributes(to storage: NSTextStorage) -> [(range: NSRange, start: Int)] {
        var labels: [(range: NSRange, start: Int)] = []
        labels.reserveCapacity(projection.visibleRegions.count)
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.monospacedSystemFont(ofSize: 13, weight: .semibold), .foregroundColor: OpenAllTheme.ink,
            .backgroundColor: OpenAllTheme.raised
        ]
        for visible in projection.visibleRegions where visible.isCollapsed {
            let range = NSRange(location: visible.openingOffset + 1, length: (visible.region.placeholder as NSString).length)
            guard NSMaxRange(range) <= storage.length else { continue }
            storage.addAttributes(attributes, range: range)
            labels.append((range, visible.region.start))
        }
        return labels
    }

    private func toggleFold(start: Int) {
        guard supportsFolding else { return }
        result.toggle(start: start)
        renderEditor(preservingPosition: true)
        reportFolding()
    }

    @objc private func toggleAllFolds() {
        guard supportsFolding else { return }
        if result.collapsed.isEmpty { result.collapseAll() } else { result.expandAll() }
        renderEditor(preservingPosition: true)
        reportFolding()
    }

    private func reportFolding() {
        success(result.collapsed.isEmpty ? "已全部展开" : "已折叠，可继续编辑")
    }

    @MainActor func verifyFoldingForDesign() throws -> Bool {
        guard DesignPreview.enabled else { return false }
        if window == nil { build() }
        while history.groupingLevel > 0 { history.endUndoGrouping() }
        history.groupsByEvent = false
        defer { history.groupsByEvent = true }
        let sample = #"{"project":"OpenAll","data":{"items":[{"name":"剪贴板 😀","enabled":true},{"name":"JSON 工具","features":["行号","折叠"]}],"note":"字符串中的 {} [] 不折叠"},"count":2}"#
        show(sample)
        guard let window, let formatted = JSONPrettyPrinter.format(sample) else { return false }
        func textEditors(_ view: NSView) -> [NSTextView] {
            if let text = view as? NSTextView { return [text] }
            return view.subviews.flatMap(textEditors)
        }
        guard textEditors(window.contentView!).count == 1, editor.string == sample, editor.isEditable else { return false }
        operationButtons[0].performClick(nil)
        guard editor.string == formatted, result.source == formatted, history.canUndo else { return false }
        history.undo()
        guard editor.string == sample, result.source == sample, history.canRedo else { return false }
        history.redo()
        guard editor.string == formatted, result.source == formatted else { return false }
        // 验证格式化后直接修改，以及普通编辑与格式化分别撤销、重做。
        history.beginUndoGrouping()
        editor.insertText("OpenAll 编辑", replacementRange: (formatted as NSString).range(of: "OpenAll"))
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        let edited = formatted.replacingOccurrences(of: "OpenAll", with: "OpenAll 编辑")
        guard editor.string == edited, result.source == edited else { return false }
        history.undo()
        guard result.source == formatted else { return false }
        history.undo()
        guard result.source == sample else { return false }
        history.redo()
        history.redo()
        guard result.source == edited else { return false }
        compactJSON()
        guard result.source == JSONPrettyPrinter.compact(edited), !result.source.contains("\n") else { return false }
        history.undo()
        guard editor.string == edited else { return false }
        history.redo()
        let compact = result.source
        formatJSON()
        guard result.source == edited, let root = result.regions.first,
              let items = result.regions.first(where: { $0.startLine == 4 }) else { return false }
        try DesignPreview.capture(window, name: "03-json-single-editor")
        guard ruler.clickFoldForDesign(start: items.start), result.collapsed.contains(items.start),
              projection.lineNumbers.contains(items.endLine + 1), projection.text.contains("[ … 12 行 ]") else { return false }
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        guard editor.writeSelection(to: board, types: [.string]), board.string(forType: .string) == edited else { return false }
        let marker = (editor.string as NSString).range(of: " … ")
        editor.setSelectedRange(NSRange(location: marker.location + 1, length: 1))
        board.clearContents()
        guard editor.writeSelection(to: board, types: [.string]),
              board.string(forType: .string) == (edited as NSString).substring(with: items.contentRange),
              editor.visibleRect.minX <= editor.textContainerOrigin.x else { return false }
        editor.setSelectedRange(NSRange(location: 0, length: 0))
        try DesignPreview.capture(window, name: "03-json-single-folded")
        guard editor.clickFoldLabelForDesign(start: items.start), result.collapsed.isEmpty, editor.isEditable,
              ruler.clickFoldForDesign(start: items.start), result.collapsed.contains(items.start) else { return false }
        guard ruler.clickFoldForDesign(start: root.start), projection.text == "{ … 19 行 }",
              ruler.clickFoldForDesign(start: root.start), result.collapsed == [items.start] else { return false }
        // 折叠时撤销仍按完整文档执行，省略号不能进入正文或撤销记录。
        guard editor.tryToPerform(NSSelectorFromString("undo:"), with: nil) else { return false }
        guard result.source == compact, editor.string == compact, result.collapsed.isEmpty else { return false }
        history.redo()
        guard result.source == edited, editor.isEditable else { return false }
        foldButton.performClick(nil)
        guard projection.text == "{ … 19 行 }" else { return false }
        compactJSON()
        guard result.source == compact, editor.string == compact else { return false }
        history.undo()
        guard result.source == edited else { return false }
        escapeJSON()
        let escaped = result.source
        unescapeJSON()
        guard result.source == edited else { return false }
        history.undo()
        guard result.source == escaped else { return false }
        history.undo()
        guard result.source == edited else { return false }
        // 校验失败保留原文和撤销记录，重新载入文档则清除旧记录。
        show("{\"ok\":true}")
        guard !history.canUndo else { return false }
        history.beginUndoGrouping()
        editor.insertText("?", replacementRange: NSRange(location: (editor.string as NSString).length, length: 0))
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        formatJSON()
        guard editor.string == "{\"ok\":true}?", result.source == editor.string, history.canUndo else { return false }
        history.undo()
        guard result.source == "{\"ok\":true}" else { return false }
        show("{\"item10\":10,\"item2\":2}")
        sortJSON()
        guard result.source == NaturalJSONFormatter.format("{\"item10\":10,\"item2\":2}") else { return false }
        history.undo()
        guard result.source == "{\"item10\":10,\"item2\":2}" else { return false }
        show(sample, initialOperation: 0)
        let originalFrame = window.frame
        window.setContentSize(NSSize(width: 760, height: 440))
        try DesignPreview.capture(window, name: "03-json-single-small-window")
        window.setFrame(originalFrame, display: false)
        guard try verifyFoldedEditingForDesign() else { return false }
        guard try verifySearchForDesign() else { return false }
        show("{\"value\":\"旧值\"}")
        editor.setSelectedRange((editor.string as NSString).range(of: "旧值"))
        history.beginUndoGrouping()
        let pasted = ClipboardShelfWindow.pasteForDesign(into: window, text: "新值", preview: true)
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        guard pasted, result.source == "{\"value\":\"新值\"}" else { return false }
        history.undo()
        guard result.source == "{\"value\":\"旧值\"}" else { return false }
        print("内部剪贴板：JSON 选区替换、预览粘贴与撤销通过")
        return true
    }

    @MainActor private func verifyFoldedEditingForDesign() throws -> Bool {
        guard let window else { return false }
        let sample = "{\n  \"title\": \"OpenAll 😀\",\n  \"items\": [\n    {\n      \"name\": \"隐藏中文\"\n    }\n  ],\n  \"tail\": \"结束\"\n}"
        func check(_ condition: Bool, _ message: String) -> Bool {
            if !condition { print("JSON 折叠编辑检查失败：\(message)，正文=\(result.source)，显示=\(editor.string)") }
            return condition
        }
        func resetFolded() {
            show(sample)
            for region in result.regions.dropFirst() { result.toggle(start: region.start) }
            renderEditor(preservingPosition: false)
            window.makeFirstResponder(editor)
        }
        resetFolded()
        let folds = result.collapsed
        editor.insertText("工具😎", replacementRange: (editor.string as NSString).range(of: "OpenAll 😀"))
        let first = sample.replacingOccurrences(of: "OpenAll 😀", with: "工具😎")
        guard check(result.source == first && editor.isEditable && result.collapsed.count == folds.count,
                    "折叠前编辑且保留子节点状态") else { return false }
        editor.insertText("修改完成", replacementRange: (editor.string as NSString).range(of: "结束"))
        let second = first.replacingOccurrences(of: "结束", with: "修改完成")
        guard check(result.source == second && result.collapsed.count == folds.count, "折叠后编辑") else { return false }
        history.undo()
        guard check(result.source == first && result.collapsed.count == folds.count, "撤销折叠后编辑") else { return false }
        history.undo()
        guard check(result.source == sample && result.collapsed == folds, "撤销折叠前编辑") else { return false }
        history.redo()
        history.redo()
        guard check(result.source == second && result.collapsed.count == folds.count, "重做保留隐藏正文与折叠") else { return false }
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        editor.setSelectedRange(NSRange(location: 0, length: (editor.string as NSString).length))
        guard check(editor.writeSelection(to: board, types: [.string]) && board.string(forType: .string) == second,
                    "折叠编辑后复制完整正文") else { return false }
        editor.setSelectedRange(NSRange(location: 0, length: 0))
        try DesignPreview.capture(window, name: "03-json-folded-editable")

        // 首次删除只展开，包括折叠节点中的子节点；第二次按键才执行原选区删除。
        resetFolded()
        let visible = projection.visibleRegions.first(where: { $0.isCollapsed })!
        let whole = NSRange(location: visible.openingOffset, length: (visible.region.placeholder as NSString).length + 2)
        editor.setSelectedRange(whole)
        editor.deleteBackward(nil)
        guard check(result.source == sample && result.collapsed.isEmpty && !history.canUndo &&
                    editor.selectedRange() == visible.region.range, "第一次删除仅展开且保留选区") else { return false }
        history.beginUndoGrouping()
        editor.deleteBackward(nil)
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        let deleted = (sample as NSString).replacingCharacters(in: visible.region.range, with: "")
        guard check(result.source == deleted, "第二次删除执行完整选区") else { return false }
        history.undo()
        guard check(result.source == sample, "撤销删除恢复隐藏全文") else { return false }

        resetFolded()
        let closing = projection.visibleRegions.first(where: { $0.isCollapsed })!
        editor.setSelectedRange(NSRange(location: closing.openingOffset + (closing.region.placeholder as NSString).length + 2, length: 0))
        editor.deleteBackward(nil)
        guard check(result.source == sample && !history.canUndo && result.collapsed.isEmpty &&
                    editor.selectedRange().location == closing.region.end, "闭括号后退格首次只展开") else { return false }
        history.beginUndoGrouping()
        editor.deleteBackward(nil)
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        guard check(result.source == (sample as NSString).replacingCharacters(in: NSRange(location: closing.region.end - 1, length: 1), with: ""),
                    "第二次退格只删除闭括号") else { return false }
        history.undo()
        guard check(result.source == sample, "退格撤销") else { return false }

        resetFolded()
        let opening = projection.visibleRegions.first(where: { $0.isCollapsed })!
        editor.setSelectedRange(NSRange(location: opening.openingOffset, length: 0))
        editor.deleteForward(nil)
        guard check(result.source == sample && !history.canUndo && result.collapsed.isEmpty &&
                    editor.selectedRange().location == opening.region.start, "向前删除首次只展开") else { return false }

        // 临时不完整 JSON 也不能让未触及的隐藏内容消失。
        resetFolded()
        editor.insertText("\"", replacementRange: (editor.string as NSString).range(of: "OpenAll"))
        guard check(result.source == sample.replacingOccurrences(of: "OpenAll", with: "\"") && result.collapsed.count == folds.count,
                    "未闭合字符串仍保留折叠正文") else { return false }
        history.undo()
        guard check(result.source == sample && result.collapsed == folds, "无效 JSON 编辑撤销") else { return false }

        // 通过真实 NSTextInputClient 协议走中文组合与提交，省略标记不参与输入法正文。
        resetFolded()
        editor.setSelectedRange((editor.string as NSString).range(of: "结束"))
        history.beginUndoGrouping()
        editor.setMarkedText("zhong", selectedRange: NSRange(location: 5, length: 0), replacementRange: NSRange(location: NSNotFound, length: 0))
        guard check(editor.hasMarkedText() && editor.string.contains("隐藏中文"), "中文组合使用完整正文") else { return false }
        editor.insertText("中文", replacementRange: NSRange(location: NSNotFound, length: 0))
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        guard check(!editor.hasMarkedText() && result.source == sample.replacingOccurrences(of: "结束", with: "中文") &&
                    result.collapsed == folds, "中文提交恢复折叠") else { return false }
        history.undo()
        guard check(result.source == sample && result.collapsed == folds, "中文输入撤销") else { return false }

        // 选区跨多个折叠节点时只展开涉及的节点，其余节点保持折叠并参与后续撤销映射。
        let siblings = "[\n  {\n    \"id\": 1\n  },\n  {\n    \"id\": 2\n  },\n  {\n    \"id\": 3\n  }\n]"
        show(siblings)
        let nodes = Array(result.regions.dropFirst())
        for node in nodes { result.toggle(start: node.start) }
        renderEditor(preservingPosition: false)
        let selectedStart = projection.projectedOffset(forSourceOffset: nodes[0].start)
        let selectedEnd = projection.projectedOffset(forSourceOffset: nodes[1].end)
        editor.setSelectedRange(NSRange(location: selectedStart, length: selectedEnd - selectedStart))
        editor.deleteBackward(nil)
        let selectedSource = NSRange(location: nodes[0].start, length: nodes[1].end - nodes[0].start)
        guard check(result.source == siblings && result.collapsed == [nodes[2].start] &&
                    editor.selectedRange() == selectedSource && !history.canUndo, "跨节点首次删除只展开选中区域") else { return false }
        editor.deleteBackward(nil)
        guard check(result.source == (siblings as NSString).replacingCharacters(in: selectedSource, with: "") &&
                    result.collapsed.count == 1, "其他节点折叠时第二次删除正常执行") else { return false }
        history.undo()
        guard check(result.source == siblings && result.collapsed == [nodes[2].start], "跨节点删除撤销") else { return false }
        let digit = (editor.string as NSString).range(of: "1")
        editor.setSelectedRange(NSRange(location: NSMaxRange(digit), length: 0))
        editor.deleteBackward(nil)
        guard check(result.source == siblings.replacingOccurrences(of: "1", with: "") && result.collapsed.count == 1,
                    "可见文字退格直接删除，不展开其他节点") else { return false }
        history.undo()
        guard check(result.source == siblings && result.collapsed == [nodes[2].start], "可见文字退格撤销") else { return false }

        // 全选删除是独立的一次清空操作；普通输入的撤销、重做仍使用原生正文坐标。
        resetFolded()
        editor.insertText("工具😎", replacementRange: (editor.string as NSString).range(of: "OpenAll 😀"))
        let editedFolds = result.collapsed
        let editedProjection = editor.string
        let expansionBeforeClear = fullExpansionCount
        let revisionBeforeClear = revision
        editor.selectAll(nil)
        editor.deleteBackward(nil)
        guard check(result.source.isEmpty && editor.string.isEmpty && result.collapsed.isEmpty && history.canUndo &&
                    revision > revisionBeforeClear && fullExpansionCount == expansionBeforeClear, "全选退格一次清空且不展开正文") else { return false }
        history.undo()
        guard check(result.source == first && result.collapsed == editedFolds && editor.string == editedProjection &&
                    fullExpansionCount == expansionBeforeClear, "撤销清空直接恢复完整正文与原折叠投影") else { return false }
        history.undo()
        guard check(result.source == sample && result.collapsed == folds, "清空撤销后仍可撤销此前普通编辑") else { return false }
        history.redo()
        guard check(result.source == first && result.collapsed == editedFolds, "清空撤销后仍可重做此前普通编辑") else { return false }
        let expansionBeforeRedo = fullExpansionCount
        history.redo()
        guard check(result.source.isEmpty && editor.string.isEmpty && fullExpansionCount == expansionBeforeRedo,
                    "重做清空不会展开或重建隐藏正文") else { return false }

        resetFolded()
        result.collapseAll()
        renderEditor(preservingPosition: false)
        let rootFolds = result.collapsed
        editor.selectAll(nil)
        editor.deleteForward(nil)
        guard check(result.source.isEmpty && editor.string.isEmpty, "根节点折叠时全选向前删除一次清空") else { return false }
        history.undo()
        guard check(result.source == sample && result.collapsed == rootFolds, "向前删除的撤销恢复根节点及子折叠") else { return false }
        print("JSON 折叠编辑检查通过")
        return true
    }

    @MainActor private func verifySearchForDesign() throws -> Bool {
        guard let window else { return false }
        let sample = "{\n  \"items\": [\n    \"OpenAll 😀\",\n    \"openall 中文\",\n    \".*\"\n  ]\n}"
        show(sample)
        result.collapseAll()
        renderEditor(preservingPosition: false)
        guard let commandF = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
            timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "f",
            charactersIgnoringModifiers: "f", isARepeat: false, keyCode: 3),
              window.performKeyEquivalent(with: commandF), searchVisible else { return false }
        searchField.stringValue = "openall"
        refreshSearch(navigate: true)
        guard searchMatches.count == 2, result.collapsed.isEmpty, result.source == sample,
              editor.selectedRange() == (sample as NSString).range(of: "OpenAll") else { return false }
        nextSearchMatch()
        guard editor.selectedRange() == (sample as NSString).range(of: "openall") else { return false }
        nextSearchMatch()
        guard searchIndex == 0 else { return false }
        previousSearchMatch()
        guard searchIndex == 1 else { return false }
        searchCase.state = .on
        searchOptionsChanged()
        guard searchMatches.count == 1 else { return false }
        searchCase.state = .off
        searchField.stringValue = "😀"
        refreshSearch(navigate: true)
        guard searchMatches.count == 1, editor.selectedRange().length == 2 else { return false }
        searchField.stringValue = ".*"
        refreshSearch(navigate: true)
        guard searchMatches.count == 1, editor.selectedRange().length == 2 else { return false }
        searchField.stringValue = "不存在"
        refreshSearch(navigate: true)
        guard searchMatches.isEmpty, !searchNext.isEnabled, searchCount.stringValue == "无匹配结果" else { return false }
        searchField.stringValue = "openall"
        refreshSearch(navigate: true)
        let selected = editor.selectedRange()
        history.beginUndoGrouping()
        editor.insertText("工具", replacementRange: selected)
        history.endUndoGrouping()
        guard searchMatches.count == 1 else { return false }
        history.undo()
        guard result.source == sample, searchMatches.count == 2, !history.canUndo else { return false }
        try DesignPreview.capture(window, name: "03-json-search")
        let originalFrame = window.frame
        window.setContentSize(NSSize(width: 760, height: 440))
        guard let bounds = window.contentView?.bounds, bounds.contains(searchBar.frame) else { return false }
        try DesignPreview.capture(window, name: "03-json-search-small")
        window.setFrame(originalFrame, display: false)
        if let cell = searchField.cell as? NSSearchFieldCell, let cancel = cell.cancelButtonCell {
            cancel.performClick(searchField)
        }
        guard searchField.stringValue.isEmpty, searchMatches.isEmpty else {
            print("JSON 搜索原生清空按钮检查失败")
            return false
        }
        let oldHeight = editor.enclosingScrollView!.frame.height
        closeSearch()
        guard editor.enclosingScrollView!.frame.height == oldHeight, result.source == sample,
              !searchVisible, searchMatches.isEmpty else { return false }
        show(String(repeating: "x", count: 10005))
        openSearch()
        searchField.stringValue = "x"
        refreshSearch(navigate: true)
        guard searchMatches.count == 10000, searchLimited, searchCount.stringValue.hasSuffix("+") else { return false }
        previousSearchMatch()
        guard searchIndex == 9999, searchCount.intrinsicContentSize.width <= searchCount.frame.width else { return false }
        closeSearch()
        show(sample)
        print("JSON 内容搜索检查通过")
        return true
    }

    @MainActor func verifyPerformanceForDesign() async throws -> Bool {
        guard DesignPreview.enabled else { return false }
        if window == nil { build() }
        let row = "{\"payload\":\"" + String(repeating: "x", count: 980) + "\",\"id\":1}"
        let source = "[\n" + Array(repeating: row, count: 5000).joined(separator: ",\n") + "\n]"
        let start = Date()
        show(source)
        print("大 JSON 载入：\(source.utf8.count) 字节，\(Date().timeIntervalSince(start)) 秒")
        guard result.source == source, largeDocument, history.levelsOfUndo <= 6 else { return false }
        // 使用原生粘贴入口模拟长单行输入，不触碰用户剪贴板。
        let compact = "[" + Array(repeating: row, count: 1000).joined(separator: ",") + "]"
        let compactStart = Date()
        show("{}")
        while history.groupingLevel > 0 { history.endUndoGrouping() }
        history.groupsByEvent = false
        defer { history.groupsByEvent = true }
        history.beginUndoGrouping()
        editor.insertText(compact, replacementRange: NSRange(location: 0, length: 2))
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        guard result.source == compact else { return false }
        let pasted = Date()
        history.undo()
        guard result.source == "{}" else { return false }
        let undone = Date()
        history.redo()
        guard result.source == compact else { return false }
        print("长单行 JSON 载入：\(compact.utf8.count) 字节，\(Date().timeIntervalSince(compactStart)) 秒")
        print("粘贴 \(pasted.timeIntervalSince(compactStart)) 秒；撤销 \(undone.timeIntervalSince(pasted)) 秒；重做 \(Date().timeIntervalSince(undone)) 秒")
        print("长行直接定位：\(editor.fastScrollCount) 次")
        let before = revision
        formatJSON()
        guard revision == before, result.source == compact else { return false }
        var ticks = 0
        while revision == before, ticks < 300 {
            try await Task.sleep(nanoseconds: 50_000_000)
            ticks += 1
        }
        guard revision > before, JSONPrettyPrinter.compact(result.source) == compact, ticks > 0 else { return false }
        print("大 JSON 后台格式化通过，界面心跳 \(ticks) 次")
        openSearch()
        searchField.stringValue = "payload"
        refreshSearch(navigate: true)
        searchField.stringValue = "id"
        controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: searchField))
        nextSearchMatch()
        guard searchMatches.count == 1000, selectedSource() == "id" else { return false }
        closeSearch()
        let original = result.source
        formatJSON()
        history.beginUndoGrouping()
        editor.insertText(" ", replacementRange: NSRange(location: 0, length: 0))
        history.endUndoGrouping()
        editor.breakUndoCoalescing()
        let changed = " " + original
        try await Task.sleep(nanoseconds: 1_000_000_000)
        guard result.source == changed else { return false }
        show("{\"保留\":true}")
        let retained = result.source
        show(String(repeating: "x", count: 10000001))
        guard result.source == retained else { return false }
        // 真实多节点折叠大文档走原生全选与删除入口，测量范围不包含测试数据构造或折叠准备。
        let foldedRow = "  {\n    \"payload\": \"" + String(repeating: "x", count: 980) + "\",\n    \"id\": 1\n  }"
        let foldedSource = "[\n" + Array(repeating: foldedRow, count: 5000).joined(separator: ",\n") + "\n]"
        show(foldedSource)
        var metadataTicks = 0
        while !supportsFolding && metadataTicks < 300 {
            try await Task.sleep(nanoseconds: 50_000_000)
            metadataTicks += 1
        }
        guard supportsFolding, result.regions.count == 5001 else { return false }
        result.collapseAll()
        result.toggle(start: result.regions[0].start)
        renderEditor(preservingPosition: false)
        let foldedProjection = editor.string
        let originalFolds = result.collapsed
        let expansionCount = fullExpansionCount
        let sourceVersion = revision
        formatJSON()
        editor.selectAll(nil)
        let clearStart = Date()
        editor.deleteBackward(nil)
        let clearDuration = Date().timeIntervalSince(clearStart)
        guard result.source.isEmpty, editor.string.isEmpty, result.collapsed.isEmpty,
              !copyButton.isEnabled, !foldButton.isEnabled, revision > sourceVersion,
              fullExpansionCount == expansionCount else { return false }
        let restoreStart = Date()
        history.undo()
        let restoreDuration = Date().timeIntervalSince(restoreStart)
        guard result.source == foldedSource, result.collapsed == originalFolds,
              editor.string == foldedProjection, fullExpansionCount == expansionCount else { return false }
        let clearAgainStart = Date()
        history.redo()
        let clearAgainDuration = Date().timeIntervalSince(clearAgainStart)
        guard result.source.isEmpty, editor.string.isEmpty, fullExpansionCount == expansionCount else { return false }
        try await Task.sleep(nanoseconds: 1_000_000_000)
        guard result.source.isEmpty, editor.string.isEmpty else { return false }
        print("折叠大 JSON 全选清空：\(foldedSource.utf8.count) 字节，\(originalFolds.count) 个折叠节点；删除 \(clearDuration) 秒，撤销 \(restoreDuration) 秒，重做 \(clearAgainDuration) 秒；未展开正文，过期后台结果已丢弃")
        // 仅折叠一个小节点时投影仍很大；撤销必须先恢复大文本布局，再注入缓存投影。
        history.undo()
        guard result.source == foldedSource else { return false }
        result.expandAll()
        result.toggle(start: result.regions[1].start)
        renderEditor(preservingPosition: false)
        let mostlyVisibleProjection = editor.string
        guard result.collapsed.count == 1, mostlyVisibleProjection.utf16.count > 200000 else { return false }
        editor.selectAll(nil)
        editor.deleteBackward(nil)
        guard result.source.isEmpty, !largeDocument else { return false }
        let largeProjectionRestoreStart = Date()
        history.undo()
        let largeProjectionRestoreDuration = Date().timeIntervalSince(largeProjectionRestoreStart)
        guard result.source == foldedSource, result.collapsed.count == 1, editor.string == mostlyVisibleProjection,
              largeDocument, editor.isHorizontallyResizable, editor.textContainer?.widthTracksTextView == false,
              fullExpansionCount == expansionCount else { return false }
        history.redo()
        guard result.source.isEmpty, editor.string.isEmpty else { return false }
        print("单节点折叠的大投影撤销：\(mostlyVisibleProjection.utf8.count) 字节，\(largeProjectionRestoreDuration) 秒；已提前恢复大文本布局")
        do {
            try JSONValidator(String(repeating: "[", count: 10000) + "0" + String(repeating: "]", count: 10000)).validate()
            return false
        } catch is JSONIssue { }
        print("JSON 大文本、过期结果及深度保护检查通过")
        return true
    }

}
