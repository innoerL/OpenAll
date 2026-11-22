import AppKit
import QuartzCore
import WebKit

/// 颜色角色明确的控件在通用递归刷新结束后重新绑定主题，避免共享编辑器被二次映射。
protocol WindowThemeRefreshing: AnyObject {
    func refreshWindowTheme()
}

private final class InsetTextFieldCell: NSTextFieldCell {
    override func drawingRect(forBounds rect: NSRect) -> NSRect {
        super.drawingRect(forBounds: rect).insetBy(dx: 9, dy: 4)
    }

    override func select(withFrame rect: NSRect, in controlView: NSView, editor textObj: NSText,
                         delegate anObject: Any?, start selStart: Int, length selLength: Int) {
        super.select(withFrame: rect.insetBy(dx: 9, dy: 4), in: controlView,
                     editor: textObj, delegate: anObject, start: selStart, length: selLength)
    }
}

private final class WindowControl: NSButton {
    var fillColor = NSColor.systemRed
    var mark = ""
    private var hovering = false

    override func updateTrackingAreas() {
        super.updateTrackingAreas()
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
                                       owner: self, userInfo: nil))
    }

    override func mouseEntered(with event: NSEvent) { hovering = true; needsDisplay = true }
    override func mouseExited(with event: NSEvent) { hovering = false; needsDisplay = true }

    override func draw(_ dirtyRect: NSRect) {
        let circle = bounds.insetBy(dx: 2, dy: 2)
        fillColor.setFill()
        NSBezierPath(ovalIn: circle).fill()
        if hovering {
            (mark as NSString).draw(in: NSRect(x: 2, y: 1, width: 12, height: 12),
                                    withAttributes: [.font: NSFont.systemFont(ofSize: 9, weight: .bold),
                                                     .foregroundColor: NSColor.black.withAlphaComponent(0.54),
                                                     .paragraphStyle: centeredStyle()])
        }
    }

    private func centeredStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        return style
    }
}

final class QuietCheckbox: NSButton {
    init(title: String, target: AnyObject?, action: Selector?) {
        super.init(frame: .zero)
        self.title = title
        self.target = target
        self.action = action
        setButtonType(.switch)
        font = .systemFont(ofSize: 13, weight: .regular)
        isBordered = false
        focusRingType = .none
    }

    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    override func draw(_ dirtyRect: NSRect) {
        let box = NSRect(x: 1, y: (bounds.height - 16) / 2, width: 16, height: 16)
        (state == .on ? OpenAllTheme.accent : OpenAllTheme.raised).setFill()
        NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4).fill()
        if state == .off {
            OpenAllTheme.muted.withAlphaComponent(0.62).setStroke()
            let outline = NSBezierPath(roundedRect: box, xRadius: 4, yRadius: 4)
            outline.lineWidth = 1.1
            outline.stroke()
        } else {
            ("✓" as NSString).draw(in: box.offsetBy(dx: 0, dy: -1),
                                    withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .bold),
                                                     .foregroundColor: OpenAllTheme.canvas,
                                                     .paragraphStyle: centeredStyle()])
        }
        (title as NSString).draw(in: NSRect(x: 25, y: (bounds.height - 19) / 2,
                                            width: max(0, bounds.width - 26), height: 19),
                                 withAttributes: [.font: font ?? NSFont.systemFont(ofSize: 12, weight: .regular),
                                                  .foregroundColor: isEnabled ? OpenAllTheme.ink : OpenAllTheme.muted])
    }

    private func centeredStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .center
        return style
    }
}

class OpenAllTextView: NSTextView {
    var placeholderText = "" { didSet { needsDisplay = true } }
    var showsLineNumbers = false { didSet { needsDisplay = true } }
    var changedLineNumbers: Set<Int> = [] { didSet { needsDisplay = true } }
    var highlightsJSON = false { didSet { refreshSyntax() } }
    var usesFocusedJSONPalette = false { didSet { refreshSyntax() } }
    var highlightsMarkdown = false { didSet { refreshSyntax() } }
    var highlightsSQL = false { didSet { refreshSyntax() } }
    var highlightsConfig = false { didSet { refreshSyntax() } }
    var usesViewportSyntax = false
    private var isHighlighting = false
    private var viewportSyntaxRange = NSRange(location: NSNotFound, length: 0)
    private var largeSyntax = false
    private static var syntaxExpressions: [String: NSRegularExpression] = [:]

    override var string: String {
        get { super.string }
        set { super.string = newValue; refreshSyntax(); needsDisplay = true }
    }

    override func didChangeText() {
        if usesViewportSyntax, (textStorage?.length ?? 0) > 200000 {
            // 在原生排版前完成样式更新，避免长单行刚排完又因属性变化重排。
            refreshSyntax()
            super.didChangeText()
        } else {
            super.didChangeText()
            refreshSyntax()
        }
        needsDisplay = true
    }

    func refreshCurrentTheme() {
        selectedTextAttributes = [.backgroundColor: OpenAllTheme.accent.withAlphaComponent(0.32),
                                  .foregroundColor: OpenAllTheme.ink]
        refreshSyntax()
    }

    private func refreshSyntax() {
        guard !isHighlighting, let storage = textStorage else { return }
        if usesViewportSyntax, storage.length > 200000 {
            if !largeSyntax {
                storage.addAttribute(.foregroundColor, value: OpenAllTheme.ink, range: NSRange(location: 0, length: storage.length))
            }
            largeSyntax = true
            viewportSyntaxRange = NSRange(location: NSNotFound, length: 0)
            needsDisplay = true
            return
        }
        if largeSyntax {
            layoutManager?.removeTemporaryAttribute(.foregroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
            largeSyntax = false
        }
        colorSyntax(in: NSRange(location: 0, length: storage.length), temporary: false)
    }

    private func colorSyntax(in full: NSRange, temporary: Bool) {
        guard !isHighlighting, let storage = textStorage else { return }
        isHighlighting = true
        defer { isHighlighting = false }
        if !temporary {
            storage.beginEditing()
            storage.addAttribute(.foregroundColor, value: OpenAllTheme.ink, range: full)
        } else { layoutManager?.addTemporaryAttribute(.foregroundColor, value: OpenAllTheme.ink, forCharacterRange: full) }
        let jsonKey = usesFocusedJSONPalette ? (OpenAllTheme.isLight ? NSColor(calibratedRed: 0.12, green: 0.34, blue: 0.46, alpha: 1) : NSColor(calibratedRed: 0.62, green: 0.76, blue: 0.84, alpha: 1)) : OpenAllTheme.accentText
        let jsonValue = usesFocusedJSONPalette ? (OpenAllTheme.isLight ? NSColor(calibratedRed: 0.27, green: 0.38, blue: 0.25, alpha: 1) : NSColor(calibratedRed: 0.78, green: 0.83, blue: 0.71, alpha: 1)) :
            (OpenAllTheme.isLight ? NSColor(calibratedRed: 0.34, green: 0.39, blue: 0.19, alpha: 1) : NSColor(calibratedRed: 0.77, green: 0.82, blue: 0.71, alpha: 1))
        let jsonLiteral = usesFocusedJSONPalette ? (OpenAllTheme.isLight ? NSColor(calibratedRed: 0.44, green: 0.30, blue: 0.57, alpha: 1) : NSColor(calibratedRed: 0.77, green: 0.70, blue: 0.85, alpha: 1)) :
            (OpenAllTheme.isLight ? NSColor(calibratedRed: 0.16, green: 0.44, blue: 0.25, alpha: 1) : NSColor(calibratedRed: 0.66, green: 0.77, blue: 0.67, alpha: 1))
        let jsonRules: [(String, NSColor)] = [
            ("[{}\\[\\]:,]", OpenAllTheme.muted),
            ("(?<![\\w.])-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?", OpenAllTheme.accentText),
            ("\\b(?:true|false|null)\\b", jsonLiteral),
            ("\"(?:[^\"\\\\]|\\\\.)*\"", jsonValue),
            ("\"(?:[^\"\\\\]|\\\\.)*\"(?=\\s*:)", jsonKey)
        ]
        let markdownRules: [(String, NSColor)] = [
            ("(?m)^```.*$", OpenAllTheme.muted),
            ("(?m)^#{1,6}[ \\t]+[^\\n]*$", OpenAllTheme.accentText),
            ("(?m)^[ \\t]*[-*+][ \\t]+", OpenAllTheme.accentText),
            ("\\*\\*[^\\n*]+\\*\\*", OpenAllTheme.isLight ? NSColor(calibratedRed: 0.20, green: 0.37, blue: 0.25, alpha: 1) : NSColor(calibratedRed: 0.84, green: 0.87, blue: 0.75, alpha: 1)),
            ("(?m)^(?:flowchart|sequenceDiagram|gantt|stateDiagram-v2)\\b.*$", OpenAllTheme.accentText),
            ("\\[[^\\]]+\\]\\([^\\)]+\\)", OpenAllTheme.accentText)
        ]
        let sqlRules: [(String, NSColor)] = [
            (#"(?i)\b(?:SELECT|FROM|WHERE|JOIN|LEFT|RIGHT|INNER|GROUP|ORDER|BY|HAVING|LIMIT|VALUES|SET|UNION|INSERT|UPDATE|DELETE|AS|AND|OR|NULL|TRUE|FALSE)\b"#, OpenAllTheme.isLight ? NSColor.systemBlue : NSColor(calibratedRed: 0.60, green: 0.74, blue: 0.84, alpha: 1)),
            (#"\b\d+(?:\.\d+)?\b"#, OpenAllTheme.muted),
            (#"'(?:[^']|'')*'"#, OpenAllTheme.isLight ? .systemGreen : NSColor(calibratedRed: 0.65, green: 0.78, blue: 0.66, alpha: 1)),
            (#"(?m)--[^\n]*|/\*[\s\S]*?\*/"#, OpenAllTheme.muted)
        ]
        let configRules: [(String, NSColor)] = [
            (#"(?m)^\s*[A-Za-z0-9_.-]+(?=\s*[:=])"#, OpenAllTheme.accentText),
            (#"\b(?:true|false|null)\b"#, OpenAllTheme.isLight ? .systemGreen : NSColor(calibratedRed: 0.65, green: 0.78, blue: 0.66, alpha: 1)),
            (#"(?m)^\s*[#!][^\n]*"#, OpenAllTheme.muted)
        ]
        let rules = highlightsJSON ? jsonRules : highlightsMarkdown ? markdownRules :
            highlightsSQL ? sqlRules : highlightsConfig ? configRules : []
        let source = storage.string
        for (pattern, color) in rules {
            if Self.syntaxExpressions[pattern] == nil { Self.syntaxExpressions[pattern] = try? NSRegularExpression(pattern: pattern) }
            guard let regex = Self.syntaxExpressions[pattern] else { continue }
            regex.enumerateMatches(in: source, range: full) { match, _, _ in
                guard let match else { return }
                if temporary { self.layoutManager?.addTemporaryAttribute(.foregroundColor, value: color, forCharacterRange: match.range) }
                else { storage.addAttribute(.foregroundColor, value: color, range: match.range) }
            }
        }
        if !temporary { storage.endEditing() }
    }

    override func draw(_ dirtyRect: NSRect) {
        if largeSyntax, let manager = layoutManager, let container = textContainer, let storage = textStorage {
            let glyphs = manager.glyphRange(forBoundingRect: visibleRect.offsetBy(dx: -textContainerOrigin.x, dy: -textContainerOrigin.y), in: container)
            let visible = manager.characterRange(forGlyphRange: glyphs, actualGlyphRange: nil)
            // 超长单行也只给可见附近的有限字符着色，避免正则扫描全文。
            let start = max(0, visible.location - 256)
            let range = NSRange(location: start, length: min(storage.length - start, min(visible.length + 512, 20000)))
            if viewportSyntaxRange != range {
                manager.removeTemporaryAttribute(.foregroundColor, forCharacterRange: NSRange(location: 0, length: storage.length))
                viewportSyntaxRange = range
                colorSyntax(in: range, temporary: true)
            }
        }
        super.draw(dirtyRect)
        if showsLineNumbers, let manager = layoutManager {
            let text = string as NSString
            var index = 0
            var number = 1
            while index < text.length {
                let glyph = manager.glyphIndexForCharacter(at: index)
                let fragment = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
                let point = NSPoint(x: 7, y: fragment.minY + textContainerOrigin.y + 1)
                if point.y > dirtyRect.maxY { break }
                if point.y + 17 >= dirtyRect.minY {
                    if changedLineNumbers.contains(number) {
                        OpenAllTheme.accent.setFill()
                        NSBezierPath(roundedRect: NSRect(x: 1, y: point.y + 2, width: 2, height: 12),
                                     xRadius: 1, yRadius: 1).fill()
                    }
                    (String(number) as NSString).draw(in: NSRect(x: 4, y: point.y, width: 27, height: 17),
                        withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                                         .foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.65),
                                         .paragraphStyle: rightAlignedStyle()])
                }
                let next = NSMaxRange(text.lineRange(for: NSRange(location: index, length: 0)))
                guard next > index else { break }
                index = next
                number += 1
            }
            if text.length == 0 {
                ("1" as NSString).draw(in: NSRect(x: 4, y: textContainerOrigin.y + 1, width: 27, height: 17),
                    withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .regular),
                                     .foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.65),
                                     .paragraphStyle: rightAlignedStyle()])
            }
        }
        guard string.isEmpty, !placeholderText.isEmpty else { return }
        (placeholderText as NSString).draw(at: NSPoint(x: textContainerInset.width + 5,
                                                       y: textContainerInset.height + 2),
                                           withAttributes: [.font: NSFont.systemFont(ofSize: 13),
                                                            .foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.72)])
    }

    private func rightAlignedStyle() -> NSParagraphStyle {
        let style = NSMutableParagraphStyle()
        style.alignment = .right
        return style
    }
}

final class QuietSplitView: NSSplitView {
    override var dividerColor: NSColor { OpenAllTheme.rule }
}

final class ToolPane: NSView {
    private let heading: NSTextField
    func setTitle(_ title: String) { heading.stringValue = title }
    private let content: NSView
    private let actions: [NSButton]
    private let headerBand = NSView()
    private var contentFocused = false
    private let rule = NSView()

    init(title: String, content: NSView, actions: [NSButton] = [], size: NSSize) {
        heading = NSTextField(labelWithString: title)
        self.content = content
        self.actions = actions
        super.init(frame: NSRect(origin: .zero, size: size))
        wantsLayer = true
        layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        heading.font = .systemFont(ofSize: 12, weight: .medium)
        heading.textColor = OpenAllTheme.ink.withAlphaComponent(0.86)
        addSubview(content)
        headerBand.wantsLayer = true
        headerBand.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        addSubview(headerBand)
        addSubview(heading)
        rule.wantsLayer = true
        rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        addSubview(rule)
        for action in actions { addSubview(action) }
        needsLayout = true
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    override func viewDidMoveToWindow() {
        super.viewDidMoveToWindow()
        NotificationCenter.default.removeObserver(self, name: NSWindow.didUpdateNotification, object: nil)
        if let window {
            NotificationCenter.default.addObserver(self, selector: #selector(updateFocus),
                name: NSWindow.didUpdateNotification, object: window)
        }
        updateFocus()
    }

    @objc private func updateFocus() {
        let focused = window?.isKeyWindow == true && (window?.firstResponder as? NSView)?.isDescendant(of: content) == true
        guard focused != contentFocused else { return }
        contentFocused = focused
        heading.textColor = focused ? OpenAllTheme.accentText : OpenAllTheme.ink.withAlphaComponent(0.86)
        rule.layer?.backgroundColor = focused ? OpenAllTheme.accent.withAlphaComponent(0.65).cgColor : OpenAllTheme.rule.cgColor
    }

    override func layout() {
        super.layout()
        let header: CGFloat = 32
        content.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - header))
        headerBand.frame = NSRect(x: 0, y: bounds.height - header, width: bounds.width, height: header)
        heading.frame = NSRect(x: 14, y: bounds.height - 24, width: 150, height: 18)
        rule.frame = NSRect(x: 0, y: bounds.height - header, width: bounds.width, height: 1)
        var x = bounds.width - 10
        for action in actions.reversed() {
            let width = action.frame.width
            x -= width
            action.frame = NSRect(x: x, y: bounds.height - 28, width: width, height: 24)
            x -= 6
        }
    }
}

private struct AppearanceSettings: Codable {
    var backgroundHex: String?
    var accentHex: String?
    var followsSystem: Bool?
}

enum OpenAllTheme {
    private static let defaultCanvas = NSColor(calibratedRed: 0.105, green: 0.111, blue: 0.113, alpha: 1)
    private static let systemLightCanvas = NSColor(srgbRed: 0.949, green: 0.949, blue: 0.937, alpha: 1)
    private static let defaultAccent = NSColor(calibratedRed: 0.808, green: 0.710, blue: 0.553, alpha: 1)
    static var defaultBackgroundHex: String { hex(defaultCanvas) }
    static var defaultAccentHex: String { hex(defaultAccent) }
    private static let file = DesignPreview.home
        .appendingPathComponent("Library/Application Support/OpenAll/appearance.json")
    private static var settings: AppearanceSettings = {
        guard let data = try? Data(contentsOf: file),
              let saved = try? JSONDecoder().decode(AppearanceSettings.self, from: data) else {
            return AppearanceSettings()
        }
        return saved
    }()

    static func color(_ hex: String?) -> NSColor? {
        guard let hex, hex.count == 7, hex.first == "#",
              let value = UInt32(hex.dropFirst(), radix: 16) else { return nil }
        return NSColor(srgbRed: CGFloat((value >> 16) & 255) / 255,
                       green: CGFloat((value >> 8) & 255) / 255,
                       blue: CGFloat(value & 255) / 255, alpha: 1)
    }

    static func hex(_ color: NSColor) -> String {
        let rgb = color.usingColorSpace(.sRGB) ?? color
        let red = min(255, max(0, Int((rgb.redComponent * 255).rounded())))
        let green = min(255, max(0, Int((rgb.greenComponent * 255).rounded())))
        let blue = min(255, max(0, Int((rgb.blueComponent * 255).rounded())))
        return String(format: "#%02X%02X%02X", red, green, blue)
    }

    private static func luminance(_ color: NSColor) -> CGFloat {
        let rgb = color.usingColorSpace(.deviceRGB) ?? color
        return rgb.redComponent * 0.2126 + rgb.greenComponent * 0.7152 + rgb.blueComponent * 0.0722
    }

    static var followsSystem: Bool { settings.followsSystem == true }
    static var systemIsLight: Bool { NSApp.effectiveAppearance.bestMatch(from: [.aqua, .darkAqua]) == .aqua }
    static var systemCanvas: NSColor { systemIsLight ? systemLightCanvas : defaultCanvas }
    static var canvas: NSColor { followsSystem ? systemCanvas : (color(settings.backgroundHex) ?? defaultCanvas) }
    static var accent: NSColor { color(settings.accentHex) ?? defaultAccent }
    static var hasCustomization: Bool { followsSystem || settings.backgroundHex != nil || settings.accentHex != nil }
    static var isLight: Bool { luminance(canvas) > 0.55 }
    static var appearance: NSAppearance? { followsSystem ? nil : NSAppearance(named: isLight ? .aqua : .darkAqua) }
    private static func relativeLuminance(_ color: NSColor) -> CGFloat {
        let rgb = color.usingColorSpace(.sRGB) ?? color
        func linear(_ value: CGFloat) -> CGFloat {
            value <= 0.04045 ? value / 12.92 : pow((value + 0.055) / 1.055, 2.4)
        }
        return linear(rgb.redComponent) * 0.2126 + linear(rgb.greenComponent) * 0.7152 + linear(rgb.blueComponent) * 0.0722
    }

    private static func contrast(_ a: CGFloat, _ b: CGFloat) -> CGFloat {
        (max(a, b) + 0.05) / (min(a, b) + 0.05)
    }

    // 同一强调色会叠在面板、编辑区或按钮上，保留能在这些背景上读清的最接近原色的文字。
    static func readableText(_ preferred: NSColor, on backgrounds: [NSColor]) -> NSColor {
        let levels = backgrounds.map(relativeLuminance)
        func score(_ color: NSColor) -> CGFloat {
            let value = relativeLuminance(color)
            return levels.map { contrast(value, $0) }.min() ?? 1
        }
        guard score(preferred) < 4.5 else { return preferred }
        let toward: NSColor = score(.black) >= score(.white) ? .black : .white
        for step in 1..<10 {
            if let candidate = preferred.blended(withFraction: CGFloat(step) / 10, of: toward), score(candidate) >= 4.5 {
                return candidate
            }
        }
        return toward
    }

    private static var cachedColors: (canvas: NSColor, accent: NSColor, raised: NSColor, text: NSColor, onAccent: NSColor)?
    private static func accentColors() -> (text: NSColor, onAccent: NSColor) {
        let base = canvas, fill = accent, raisedColor = raised
        if let cachedColors, cachedColors.canvas == base, cachedColors.accent == fill, cachedColors.raised == raisedColor {
            return (cachedColors.text, cachedColors.onAccent)
        }
        let preferred = isLight && luminance(fill) > 0.42 ? fill.blended(withFraction: 0.46, of: .black) ?? fill : fill
        let text = readableText(preferred, on: [base, raisedColor, editorCanvas])
        let dark = NSColor(srgbRed: 0.102, green: 0.102, blue: 0.102, alpha: 1)
        let level = relativeLuminance(fill)
        let buttonText = readableText(contrast(level, 1) >= contrast(level, relativeLuminance(dark)) ? .white : dark, on: [fill])
        cachedColors = (base, fill, raisedColor, text, buttonText)
        return (text, buttonText)
    }
    static var onAccent: NSColor { accentColors().onAccent }
    static var accentText: NSColor { accentColors().text }
    static var sidebar: NSColor {
        guard followsSystem || settings.backgroundHex != nil else { return NSColor(calibratedRed: 0.125, green: 0.132, blue: 0.132, alpha: 1) }
        return canvas.blended(withFraction: 0.025, of: isLight ? .black : .white) ?? canvas
    }
    static var surface: NSColor {
        guard followsSystem || settings.backgroundHex != nil else { return NSColor(calibratedRed: 0.151, green: 0.158, blue: 0.156, alpha: 1) }
        return canvas.blended(withFraction: 0.052, of: isLight ? .black : .white) ?? canvas
    }
    static var editorCanvas: NSColor {
        canvas.blended(withFraction: isLight ? 0.45 : 0.16, of: isLight ? .white : .black) ?? canvas
    }
    static var raised: NSColor {
        guard followsSystem || settings.backgroundHex != nil else { return NSColor(calibratedRed: 0.190, green: 0.198, blue: 0.193, alpha: 1) }
        return canvas.blended(withFraction: 0.095, of: isLight ? .black : .white) ?? canvas
    }
    static var ink: NSColor { isLight ? NSColor(calibratedWhite: 0.09, alpha: 1) : NSColor(calibratedRed: 0.940, green: 0.933, blue: 0.902, alpha: 1) }
    static var muted: NSColor { isLight ? NSColor(calibratedWhite: 0.38, alpha: 1) : NSColor(calibratedRed: 0.61, green: 0.63, blue: 0.61, alpha: 1) }
    static var rule: NSColor { (isLight ? NSColor.black : NSColor.white).withAlphaComponent(isLight ? 0.12 : 0.085) }

    private static func save() {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(settings) { try? data.write(to: file, options: .atomic) }
    }
    static func setBackground(_ color: NSColor) { settings.backgroundHex = hex(color); settings.followsSystem = false; save() }
    static func followSystem() { settings.backgroundHex = nil; settings.followsSystem = true; save() }
    static func setAccent(_ color: NSColor) { settings.accentHex = hex(color); save() }
    static func reset() { settings = AppearanceSettings(); save() }

    static func withTemporaryBackgroundForDesign(_ color: NSColor?, perform check: () -> Bool) -> Bool {
        guard DesignPreview.enabled else { return false }
        let original = settings
        defer { settings = original; WindowChrome.refreshAllWindows() }
        // 预览验收只修改内存，退出后还原，不写入外观偏好文件。
        settings.backgroundHex = color.map(hex)
        settings.followsSystem = false
        WindowChrome.refreshAllWindows()
        return check()
    }

    @MainActor static func withTemporaryAppearanceForDesign<T>(background: NSColor?, accent: NSColor?,
                                                                perform check: () async throws -> T) async rethrows -> T {
        let original = settings
        defer { settings = original; WindowChrome.refreshAllWindows() }
        // 原生窗口专项仅在内存中往返外观，不写入用户偏好。
        if DesignPreview.enabled {
            settings.backgroundHex = background.map(hex)
            settings.accentHex = accent.map(hex)
            settings.followsSystem = false
            WindowChrome.refreshAllWindows()
        }
        return try await check()
    }
}

enum WindowChrome {
    static let height: CGFloat = 46

    private struct Palette {
        let canvas = OpenAllTheme.canvas
        let sidebar = OpenAllTheme.sidebar
        let surface = OpenAllTheme.surface
        let raised = OpenAllTheme.raised
        let ink = OpenAllTheme.ink
        let muted = OpenAllTheme.muted
        let rule = OpenAllTheme.rule
        let accent = OpenAllTheme.accent
        let accentText = OpenAllTheme.accentText
        let onAccent = OpenAllTheme.onAccent
    }

    private static var appliedPalette = Palette()

    static func rememberCurrentTheme() { appliedPalette = Palette() }

    private static func mappedColor(_ color: NSColor, previous: Palette, current: Palette,
                                    foreground: Bool = false) -> NSColor? {
        let source = color.usingColorSpace(.sRGB) ?? color
        var pairs = [(previous.canvas, current.canvas), (previous.sidebar, current.sidebar),
                     (previous.surface, current.surface), (previous.raised, current.raised),
                     (previous.ink, current.ink), (previous.muted, current.muted),
                     (previous.accent, foreground ? current.accentText : current.accent),
                     (previous.onAccent, current.onAccent),
                     (previous.rule, current.rule)]
        if foreground && previous.accentText != previous.accent {
            pairs.insert((previous.accentText, current.accentText), at: 0)
        }
        for (old, new) in pairs {
            let original = old.usingColorSpace(.sRGB) ?? old
            if abs(source.redComponent - original.redComponent) < 0.012,
               abs(source.greenComponent - original.greenComponent) < 0.012,
               abs(source.blueComponent - original.blueComponent) < 0.012 {
                if old == previous.rule && abs(source.alphaComponent - original.alphaComponent) > 0.015 { continue }
                return new.withAlphaComponent(source.alphaComponent)
            }
        }
        return nil
    }

    private static func refreshView(_ view: NSView, previous: Palette, current: Palette) {
        if let visual = view as? NSVisualEffectView { visual.appearance = OpenAllTheme.appearance }
        if let layer = view.layer {
            if let background = layer.backgroundColor,
               let color = NSColor(cgColor: background),
               let mapped = mappedColor(color, previous: previous, current: current) {
                layer.backgroundColor = mapped.cgColor
            }
            if let border = layer.borderColor,
               let color = NSColor(cgColor: border),
               let mapped = mappedColor(color, previous: previous, current: current) {
                layer.borderColor = mapped.cgColor
            }
        }
        if let field = view as? NSTextField, let color = field.textColor,
           let mapped = mappedColor(color, previous: previous, current: current, foreground: true) {
            field.textColor = mapped
        }
        if let button = view as? NSButton, let tint = button.contentTintColor,
           let mapped = mappedColor(tint, previous: previous, current: current, foreground: true) {
            button.contentTintColor = mapped
        }
        if let image = view as? NSImageView, let tint = image.contentTintColor,
           let mapped = mappedColor(tint, previous: previous, current: current, foreground: true) {
            image.contentTintColor = mapped
        }
        if let scroll = view as? NSScrollView,
           let mapped = mappedColor(scroll.backgroundColor, previous: previous, current: current) {
            scroll.backgroundColor = mapped
        }
        if let text = view as? NSTextView {
            if let mapped = mappedColor(text.backgroundColor, previous: previous, current: current) { text.backgroundColor = mapped }
            if let color = text.textColor,
               let mapped = mappedColor(color, previous: previous, current: current, foreground: true) { text.textColor = mapped }
            if let mapped = mappedColor(text.insertionPointColor, previous: previous, current: current, foreground: true) { text.insertionPointColor = mapped }
            if let editor = text as? OpenAllTextView { editor.refreshCurrentTheme() }
        }
        if let web = view as? WKWebView, web.url?.lastPathComponent == "diff-v2.html" {
            TextCompareV2Window.applyTheme(web)
            return
        }
        if let web = view as? WKWebView, let name = web.url?.lastPathComponent,
           name == "markdown-preview.html" || name == "diff.html" {
            let isMarkdown = name == "markdown-preview.html"
            applyWebTheme(web, kind: isMarkdown ? "markdown" : "comparison") {
                if isMarkdown { web.evaluateJavaScript("window.refreshOpenAllDiagramTheme?.()") { _, _ in } }
            }
            return
        }
        view.needsDisplay = true
        view.subviews.forEach { refreshView($0, previous: previous, current: current) }
    }

    private static func refreshThemeBindings(in view: NSView) {
        (view as? WindowThemeRefreshing)?.refreshWindowTheme()
        view.subviews.forEach { refreshThemeBindings(in: $0) }
    }

    static func refreshAllWindows() {
        let previous = appliedPalette
        let current = Palette()
        appliedPalette = current
        for window in NSApp.windows where !(window is NSColorPanel) {
            window.appearance = OpenAllTheme.appearance
            if window.backgroundColor.alphaComponent > 0.01 { window.backgroundColor = current.canvas }
            if let root = window.contentView {
                refreshView(root, previous: previous, current: current)
                refreshThemeBindings(in: root)
            }
            window.invalidateShadow()
        }
    }

    static func applyWebTheme(_ webView: WKWebView, kind: String, completion: @escaping () -> Void) {
        guard OpenAllTheme.hasCustomization else {
            webView.evaluateJavaScript("document.getElementById('openall-custom-theme')?.remove()") { _, _ in
                if kind == "markdown" {
                    webView.evaluateJavaScript("mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'dark',suppressErrorRendering:true})") { _, _ in completion() }
                } else { completion() }
            }
            return
        }
        let background = OpenAllTheme.hex(OpenAllTheme.canvas)
        let sidebar = OpenAllTheme.hex(OpenAllTheme.sidebar)
        let surface = OpenAllTheme.hex(OpenAllTheme.surface)
        let raised = OpenAllTheme.hex(OpenAllTheme.raised)
        let ink = OpenAllTheme.hex(OpenAllTheme.ink)
        let muted = OpenAllTheme.hex(OpenAllTheme.muted)
        let accent = OpenAllTheme.hex(OpenAllTheme.accent)
        let accentText = OpenAllTheme.hex(OpenAllTheme.accentText)
        let scheme = OpenAllTheme.isLight ? "light" : "dark"
        let css: String
        if kind == "markdown" {
            css = """
            :root{color-scheme:\(scheme)} body{background:\(background);color:\(ink)}
            a{color:\(accentText)} blockquote{border-left-color:\(accent);color:\(muted)}
            code,pre,.diagram,.zoom-controls{background:\(surface);border-color:\(muted)}
            .diagram .edgeLabel rect{fill:\(surface)!important}.diagram .edgeLabel span{background:\(surface)!important}
            .zoom-controls button{color:\(ink)}.zoom-controls button:hover{background:\(raised)}
            .zoom-controls output,.empty,.diagram-error{color:\(muted)}
            """
        } else {
            css = """
            :root{color-scheme:\(scheme)} body,header{background:\(background);color:\(ink)}
            button,.pane-heading,.result-heading,.review-columns{background:\(surface);color:\(ink)}
            button:hover{background:\(raised)} textarea,#diff-scroll{background:\(sidebar);color:\(ink)}
            .inputs,.input-pane:first-child,.result-heading,.review-columns,#diff-scroll{border-color:\(muted)}
            button.plain,button.mode.active{color:\(accentText)} button.mode.active{border-bottom-color:\(accent)}
            input[type=checkbox]{accent-color:\(accent)}.resize-bar:hover::after,.resize-bar.dragging::after{background:\(accent)}
            .row.current{outline-color:\(accent)} #summary,.legend,.empty,.line-no{color:\(muted)}
            """
        }
        guard let data = try? JSONSerialization.data(withJSONObject: [css]),
              let encoded = String(data: data, encoding: .utf8) else { completion(); return }
        let script = "var style=document.getElementById('openall-custom-theme');if(!style){style=document.createElement('style');style.id='openall-custom-theme';document.head.appendChild(style)}style.textContent=\(encoded)[0];"
        webView.evaluateJavaScript(script) { _, _ in
            if kind == "markdown" {
                let mode = OpenAllTheme.isLight ? "default" : "dark"
                webView.evaluateJavaScript("mermaid.initialize({startOnLoad:false,securityLevel:'strict',theme:'\(mode)',suppressErrorRendering:true})") { _, _ in completion() }
            } else { completion() }
        }
    }

    static func styleAction(_ button: NSButton, primary: Bool = false) {
        button.bezelStyle = .regularSquare
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 6
        button.layer?.masksToBounds = true
        button.layer?.backgroundColor = (primary ? OpenAllTheme.accent : OpenAllTheme.raised.withAlphaComponent(0.42)).cgColor
        button.layer?.borderWidth = primary ? 0 : 0.5
        button.layer?.borderColor = OpenAllTheme.rule.cgColor
        button.contentTintColor = primary ? OpenAllTheme.onAccent : OpenAllTheme.ink
        button.font = .systemFont(ofSize: 12, weight: primary ? .medium : .regular)
        button.focusRingType = .none
    }

    static func styleOutputAction(_ button: NSButton) {
        styleAction(button)
        button.layer?.backgroundColor = NSColor.clear.cgColor
        button.layer?.borderWidth = 0
        button.contentTintColor = OpenAllTheme.muted
        button.font = .systemFont(ofSize: 12, weight: .regular)
    }

    static func styleToolMode(_ button: NSButton, active: Bool) {
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.backgroundColor = NSColor.clear.cgColor
        button.layer?.sublayers?.filter { $0.name == "modeUnderline" }.forEach { $0.removeFromSuperlayer() }
        button.contentTintColor = active ? OpenAllTheme.accentText : OpenAllTheme.muted
        button.font = .systemFont(ofSize: 13, weight: active ? .medium : .regular)
        button.focusRingType = .none
        if active {
            let underline = CALayer()
            underline.name = "modeUnderline"
            let width = min(button.bounds.width - 16, (button.title as NSString).size(withAttributes: [.font: button.font!]).width + 24)
            underline.frame = NSRect(x: (button.bounds.width - width) / 2, y: button.bounds.height - 2, width: width, height: 2)
            underline.backgroundColor = OpenAllTheme.accent.cgColor
            underline.cornerRadius = 1
            button.layer?.addSublayer(underline)
        }
    }

    static func checkbox(_ title: String, target: AnyObject, action: Selector) -> NSButton {
        QuietCheckbox(title: title, target: target, action: action)
    }

    static func styleCard(_ view: NSView, radius: CGFloat = 13) {
        view.wantsLayer = true
        view.layer?.cornerRadius = radius
        view.layer?.backgroundColor = OpenAllTheme.surface.cgColor
        view.layer?.borderWidth = 0.5
        view.layer?.borderColor = OpenAllTheme.rule.cgColor
    }

    static func styleSettingsSection(_ view: NSView) {
        view.wantsLayer = true
        view.layer?.cornerRadius = 8
        view.layer?.backgroundColor = NSColor.clear.cgColor
        view.layer?.borderWidth = 0
    }

    static func refineSettingsTypography(in view: NSView) {
        if abs(view.bounds.height - 536) < 1,
           let heading = view.subviews.compactMap({ $0 as? NSTextField }).filter({ ($0.font?.pointSize ?? 0) >= 18 }).max(by: { $0.frame.minY < $1.frame.minY }) {
            let delta = max(0, 474 - heading.frame.minY)
            if delta > 0 { view.subviews.forEach { $0.frame.origin.y += delta } }
            heading.frame.size.height = max(28, heading.frame.height)
        }
        if let field = view as? NSTextField, !field.isEditable, let font = field.font {
            let size: CGFloat = font.pointSize >= 18 ? 19 : font.pointSize <= 12 ? 12 : max(13, font.pointSize)
            field.font = NSFont(descriptor: font.fontDescriptor, size: size) ?? NSFont.systemFont(ofSize: size)
        }
        for child in view.subviews { refineSettingsTypography(in: child) }
    }

    static func styleInput(_ field: NSTextField) {
        let value = field.stringValue
        let placeholder = field.placeholderString
        field.cell = InsetTextFieldCell(textCell: value)
        field.placeholderString = placeholder
        if let placeholder {
            field.placeholderAttributedString = NSAttributedString(string: placeholder,
                attributes: [.foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.82),
                             .font: NSFont.systemFont(ofSize: 12)])
        }
        field.isEditable = true
        field.isSelectable = true
        field.isBezeled = false
        field.wantsLayer = true
        field.layer?.cornerRadius = 6
        field.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        field.layer?.borderWidth = 1
        field.layer?.borderColor = OpenAllTheme.rule.cgColor
        field.textColor = OpenAllTheme.ink
        field.font = .systemFont(ofSize: 13)
        field.focusRingType = .none
    }

    static func stylePopUp(_ button: NSPopUpButton) {
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 8
        button.layer?.backgroundColor = OpenAllTheme.surface.cgColor
        button.layer?.borderWidth = 0.5
        button.layer?.borderColor = OpenAllTheme.rule.cgColor
        button.contentTintColor = OpenAllTheme.ink
    }

    static func styleEditor(_ scroll: NSScrollView, text: NSTextView) {
        scroll.borderType = .noBorder
        scroll.drawsBackground = true
        scroll.backgroundColor = OpenAllTheme.sidebar
        scroll.wantsLayer = true
        scroll.layer?.cornerRadius = 6
        scroll.layer?.masksToBounds = true
        scroll.layer?.borderWidth = 0.5
        scroll.layer?.borderColor = OpenAllTheme.rule.cgColor
        text.backgroundColor = OpenAllTheme.sidebar
        text.textColor = OpenAllTheme.ink
        text.insertionPointColor = OpenAllTheme.accentText
        text.selectedTextAttributes = [.backgroundColor: OpenAllTheme.accent.withAlphaComponent(0.32),
                                       .foregroundColor: OpenAllTheme.ink]
    }

    static func apply(_ window: NSWindow, title: String) {
        window.title = title
        window.titleVisibility = .hidden
        window.titlebarAppearsTransparent = true
        window.styleMask.insert(.fullSizeContentView)
        window.tabbingMode = .disallowed
        window.backgroundColor = OpenAllTheme.canvas
        window.appearance = OpenAllTheme.appearance
        window.isMovableByWindowBackground = true
        window.animationBehavior = .documentWindow
        for type in [NSWindow.ButtonType.closeButton, .miniaturizeButton, .zoomButton] {
            window.standardWindowButton(type)?.isHidden = true
        }
    }

    static func installControls(on window: NSWindow, compact: Bool = false, editorStyle: Bool = false) {
        guard let root = window.contentView else { return }
        ButtonPressFeedback.install(on: window)
        let headerHeight: CGFloat = compact ? 34 : height
        let header = NSView(frame: NSRect(x: 0, y: root.bounds.height - headerHeight,
                                          width: root.bounds.width, height: headerHeight))
        header.autoresizingMask = [.width, .minYMargin]
        header.wantsLayer = true
        header.layer?.backgroundColor = (editorStyle ? OpenAllTheme.canvas : OpenAllTheme.sidebar).cgColor
        root.addSubview(header)
        let rule = NSView(frame: NSRect(x: 0, y: 0, width: header.bounds.width, height: 1))
        rule.autoresizingMask = [.width]
        rule.wantsLayer = true
        rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        if !editorStyle { header.addSubview(rule) }
        let controls: [(NSColor, Selector, String, String)] = [
            (NSColor(calibratedRed: 0.92, green: 0.37, blue: 0.34, alpha: 1), #selector(NSWindow.performClose(_:)), "关闭", "×"),
            (NSColor(calibratedRed: 0.88, green: 0.68, blue: 0.30, alpha: 1), #selector(NSWindow.miniaturize(_:)), "最小化", "−"),
            (NSColor(calibratedRed: 0.40, green: 0.72, blue: 0.43, alpha: 1), #selector(NSWindow.zoom(_:)), "缩放", "+")
        ]
        for (index, item) in controls.enumerated() {
            let control = WindowControl(frame: NSRect(x: 17 + CGFloat(index) * 20, y: compact ? 9 : 15, width: 16, height: 16))
            control.fillColor = item.0
            control.mark = item.3
            control.target = window
            control.action = item.1
            control.toolTip = item.2
            control.isBordered = false
            control.focusRingType = .none
            control.setAccessibilityLabel(item.2)
            header.addSubview(control)
        }
        let label = NSTextField(labelWithString: window.title)
        label.identifier = NSUserInterfaceItemIdentifier("OpenAllWindowTitle")
        label.font = .systemFont(ofSize: editorStyle ? 13 : 12, weight: .medium)
        label.textColor = OpenAllTheme.ink
        label.lineBreakMode = .byTruncatingTail
        label.frame = NSRect(x: 91, y: compact ? 7 : 13, width: max(100, root.bounds.width - 109), height: 20)
        label.autoresizingMask = [.width]
        header.addSubview(label)
    }

    static func updateTitle(on window: NSWindow?, to title: String) {
        guard let window else { return }
        window.title = title
        for header in window.contentView?.subviews ?? [] {
            if let label = header.subviews.compactMap({ $0 as? NSTextField })
                .first(where: { $0.identifier?.rawValue == "OpenAllWindowTitle" }) { label.stringValue = title }
        }
    }

    static func activate() {
        if !DesignPreview.enabled { NSApp.activate(ignoringOtherApps: true) }
    }

    static func present(_ window: NSWindow?) {
        if DesignPreview.enabled { DesignPreview.lastWindow = window; return }
        guard let window else { return }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion || window.isVisible {
            window.makeKeyAndOrderFront(nil)
            return
        }
        let destination = window.frame
        var origin = destination
        origin.origin.y -= 10
        window.setFrame(origin, display: false)
        window.alphaValue = 0
        window.makeKeyAndOrderFront(nil)
        NSAnimationContext.runAnimationGroup { context in
            context.duration = 0.22
            context.timingFunction = CAMediaTimingFunction(name: .easeOut)
            window.animator().alphaValue = 1
            window.animator().setFrame(destination, display: false)
        }
    }
}

// 离屏预览使用独立数据目录，不创建菜单栏项、全局监听或剪贴板记录。
enum DesignPreview {
    static let enabled = ProcessInfo.processInfo.arguments.contains("--design-snapshot")
    static let home = enabled ? URL(fileURLWithPath: ProcessInfo.processInfo.environment["OPENALL_PREVIEW_ROOT"] ?? "/private/tmp/openall-preview-data") : FileManager.default.homeDirectoryForCurrentUser
    static let output = URL(fileURLWithPath: ProcessInfo.processInfo.environment["OPENALL_PREVIEW_OUTPUT"] ?? "/private/tmp/openall-offscreen")
    static var lastWindow: NSWindow?

    @MainActor static func capture(_ window: NSWindow, name: String) throws {
        guard let root = window.contentView else { return }
        root.layoutSubtreeIfNeeded()
        // 按真实屏幕的像素密度截图，保留 Retina 字体与细线细节。
        let scale = max(1, window.backingScaleFactor)
        guard let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(root.bounds.width * scale),
                                            pixelsHigh: Int(root.bounds.height * scale), bitsPerSample: 8,
                                            samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
                                            colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
            throw NSError(domain: "DesignPreview", code: 1)
        }
        bitmap.size = root.bounds.size
        root.cacheDisplay(in: root.bounds, to: bitmap)
        guard let png = bitmap.representation(using: .png, properties: [:]) else { throw NSError(domain: "DesignPreview", code: 2) }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try png.write(to: output.appendingPathComponent(name + ".png"))
    }

    @MainActor static func captureWeb(_ window: NSWindow, name: String) async throws {
        guard let root = window.contentView else { return }
        root.layoutSubtreeIfNeeded()
        guard let bitmap = root.bitmapImageRepForCachingDisplay(in: root.bounds) else { throw NSError(domain: "DesignPreview", code: 3) }
        root.cacheDisplay(in: root.bounds, to: bitmap)
        let composite = NSImage(size: root.bounds.size)
        composite.addRepresentation(bitmap)
        func webViews(_ view: NSView) -> [WKWebView] {
            if let web = view as? WKWebView { return [web] }
            return view.subviews.flatMap { webViews($0) }
        }
        for web in webViews(root) {
            let snapshot = try await web.takeSnapshot(configuration: nil)
            let frame = web.convert(web.bounds, to: root)
            composite.lockFocus()
            snapshot.draw(in: frame)
            composite.unlockFocus()
        }
        // 网页与原生窗口采用相同的屏幕像素密度。
        let scale = max(1, window.backingScaleFactor)
        guard let result = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(root.bounds.width * scale),
            pixelsHigh: Int(root.bounds.height * scale), bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
            isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0),
            let context = NSGraphicsContext(bitmapImageRep: result) else { throw NSError(domain: "DesignPreview", code: 4) }
        result.size = root.bounds.size
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        context.imageInterpolation = .high
        context.cgContext.scaleBy(x: scale, y: scale)
        composite.draw(in: NSRect(origin: .zero, size: root.bounds.size))
        NSGraphicsContext.restoreGraphicsState()
        guard (result.colorAt(x: result.pixelsWide - 8, y: result.pixelsHigh / 2)?.alphaComponent ?? 0) > 0.9 else {
            throw NSError(domain: "DesignPreviewIncompleteBitmap", code: 1)
        }
        guard let png = result.representation(using: .png, properties: [:]) else { throw NSError(domain: "DesignPreview", code: 4) }
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        try png.write(to: output.appendingPathComponent(name + ".png"))
    }
}
