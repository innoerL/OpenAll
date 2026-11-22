import AppKit

enum SearchFuzzy {
    static func matches(_ candidate: String, query: String) -> Bool {
        let target = Array(candidate.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased())
        let input = Array(query.folding(options: [.diacriticInsensitive, .caseInsensitive], locale: .current).lowercased())
        guard input.count >= 3, input.count <= 32, abs(target.count - input.count) <= 2 else { return false }
        var previous = Array(0...input.count)
        for (row, character) in target.enumerated() {
            var current = [row + 1] + Array(repeating: 0, count: input.count)
            for column in input.indices {
                current[column + 1] = min(previous[column + 1] + 1, current[column] + 1,
                                          previous[column] + (character == input[column] ? 0 : 1))
            }
            previous = current
        }
        return previous[input.count] <= (input.count >= 6 ? 2 : 1)
    }
}

enum LocalTextTools {
    static func formatConfiguration(_ input: String) -> (String, String)? {
        let lines = input.replacingOccurrences(of: "\r\n", with: "\n")
            .replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        let significant = lines.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("!") }
        guard !significant.isEmpty else { return nil }
        func separator(in line: String) -> String.Index? {
            var escaped = false
            for index in line.indices {
                let character = line[index]
                if escaped { escaped = false; continue }
                if character == "\\" { escaped = true; continue }
                if character == "=" || character == ":" { return index }
            }
            return nil
        }
        let properties = significant.allSatisfy { line in
            separator(in: line).map { line[$0] == "=" } ?? false
        }
        if properties {
            var formatted: [String] = []
            for raw in lines {
                let line = String(raw.drop(while: { $0 == " " || $0 == "\t" || $0 == "\u{000C}" }))
                if line.isEmpty || line.hasPrefix("#") || line.hasPrefix("!") { formatted.append(raw); continue }
                // 续行会改变下一行的解释方式，未完整解析时不输出结果。
                guard line.reversed().prefix(while: { $0 == "\\" }).count.isMultiple(of: 2),
                      let delimiter = separator(in: line), line[delimiter] == "=" else { return nil }
                let keyPart = String(line[..<delimiter])
                var escaped = false
                var sawWhitespace = false
                var key = ""
                for character in keyPart {
                    if escaped {
                        guard !sawWhitespace else { return nil }
                        key.append(character); escaped = false; continue
                    }
                    if character == " " || character == "\t" || character == "\u{000C}" {
                        sawWhitespace = true; continue
                    }
                    guard !sawWhitespace else { return nil }
                    key.append(character)
                    if character == "\\" { escaped = true }
                }
                guard !key.isEmpty, !escaped else { return nil }
                // Properties 忽略分隔符后的前导空白，但值尾部的空格属于实际数据。
                let value = line[line.index(after: delimiter)...].drop(while: { $0 == " " || $0 == "\t" || $0 == "\u{000C}" })
                formatted.append(key + "=" + value)
            }
            return (formatted.joined(separator: "\n"), "Properties · 保留值、原顺序与注释")
        }
        // 简化校验器不能证明这些 YAML 结构的等价性，因此明确拒绝处理。
        for line in significant {
            if line.hasPrefix("-") && line != "---" { return nil }
            guard let colon = line.firstIndex(of: ":") else {
                if line == "---" { continue }
                return nil
            }
            let value = line[line.index(after: colon)...].trimmingCharacters(in: .whitespaces)
            if let first = value.first, "#&*!|>[{".contains(first) { return nil }
        }
        guard let original = try? ConfigDiff.parse(input) else { return nil }
        var levels: [Int] = []
        let output = lines.map { raw -> String in
            let clean = raw.trimmingCharacters(in: .whitespaces)
            guard !clean.isEmpty, !clean.hasPrefix("#"), clean != "---" else { return raw }
            let indent = raw.prefix(while: { $0 == " " }).count
            while let last = levels.last, last >= indent { levels.removeLast() }
            let depth = levels.count
            if clean.hasSuffix(":") { levels.append(indent) }
            return String(repeating: "  ", count: depth) + clean
        }.joined(separator: "\n")
        guard (try? ConfigDiff.parse(output)) == original else { return nil }
        return (output, "YAML · 仅整理受支持的键值结构")
    }

    static func formatSQL(_ input: String) -> String? {
        guard !input.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var tokens: [String] = []
        var current = ""
        var quote: Character?
        var spacedOpenParens = Set<Int>()
        var index = input.startIndex
        func flush() { if !current.isEmpty { tokens.append(current); current = "" } }
        while index < input.endIndex {
            let char = input[index]
            let next = input.index(after: index)
            if let active = quote {
                // 反斜杠转义取决于数据库方言，不能在未选择方言时猜测字符串边界。
                if char == "\\" { return nil }
                current.append(char)
                if char == active {
                    if next < input.endIndex && input[next] == active { current.append(input[next]); index = input.index(after: next) }
                    else { quote = nil; index = next; flush() }
                } else { index = next }
                continue
            }
            if char == "'" || char == "\"" || char == "`" {
                let prefix = current.lowercased()
                // 字符集及 Unicode 转义前缀依赖数据库方言，不能拆开后继续输出。
                if char == "'" || char == "\"" {
                    if prefix == "u&" || prefix.range(of: #"^_[A-Za-z0-9_]+$"#, options: .regularExpression) != nil { return nil }
                }
                if char == "'", ["n", "e", "b", "x"].contains(prefix) {
                    // 前缀与引号必须保持相邻，例如 SQL Server 的 N'文字'。
                } else {
                    if char == "'", ["q", "nq", "u&"].contains(prefix) { return nil }
                    flush()
                }
                quote = char; current.append(char); index = next; continue
            }
            if char == "[" || char == "]" || char == "#" { return nil }
            if char == "$", input[index...].range(of: #"^\$(?:[A-Za-z_][A-Za-z_0-9]*)?\$"#, options: .regularExpression) != nil { return nil }
            if char == "-", next < input.endIndex, input[next] == "-" {
                let following = input.index(after: next)
                if following < input.endIndex && !input[following].isWhitespace { return nil }
                flush(); let end = input[next...].firstIndex(of: "\n") ?? input.endIndex
                tokens.append(String(input[index..<end])); index = end; continue
            }
            if char == "/", next < input.endIndex, input[next] == "*" {
                guard let ending = input[next...].range(of: "*/") else { return nil }
                flush(); let end = ending.upperBound
                if input[next..<ending.lowerBound].contains("/*") { return nil }
                tokens.append(String(input[index..<end])); index = end; continue
            }
            if char.isWhitespace { flush(); index = next; continue }
            if ",();".contains(char) {
                flush()
                if char == "(", index > input.startIndex, input[input.index(before: index)].isWhitespace {
                    spacedOpenParens.insert(tokens.count)
                }
                tokens.append(String(char)); index = next; continue
            }
            current.append(char); index = next
        }
        guard quote == nil else { return nil }
        flush()
        func isStringLiteral(_ token: String) -> Bool {
            token.hasPrefix("'") || ["n'", "e'", "b'", "x'"].contains(where: { token.lowercased().hasPrefix($0) })
        }
        for index in tokens.indices.dropFirst() where isStringLiteral(tokens[index - 1]) && isStringLiteral(tokens[index]) { return nil }
        var lines: [String] = []
        var selectList = false
        var depth = 0
        var position = 0
        func finish() {
            let line = current.trimmingCharacters(in: .whitespacesAndNewlines)
            if !line.isEmpty { lines.append(current.hasPrefix("  ") ? "  " + line : line) }
            current = ""
        }
        func trimRight() {
            while current.last?.isWhitespace == true { current.removeLast() }
        }
        while position < tokens.count {
            let token = tokens[position]
            let upper = token.uppercased()
            let next = position + 1 < tokens.count ? tokens[position + 1].uppercased() : ""
            if depth == 0 {
                if upper == "SELECT" {
                    finish(); lines.append("SELECT"); current = "  "; selectList = true
                    position += 1; continue
                }
                var clause: String?
                var consumed = 1
                if ["LEFT", "RIGHT", "INNER", "FULL", "CROSS"].contains(upper), next == "JOIN" {
                    clause = upper + " JOIN"; consumed = 2
                } else if ["GROUP", "ORDER"].contains(upper), next == "BY" {
                    clause = upper + " BY"; consumed = 2
                } else if ["FROM", "WHERE", "JOIN", "HAVING", "LIMIT", "VALUES", "SET", "UNION"].contains(upper) {
                    clause = upper
                }
                if let clause {
                    finish(); current = clause; selectList = false
                    position += consumed; continue
                }
            }
            if token.hasPrefix("--") || token.hasPrefix("/*") {
                finish(); lines.append(token)
            } else if token == "," {
                trimRight(); current += ","
                if selectList && depth == 0 { finish(); current = "  " }
            } else if token == "(" {
                trimRight()
                if spacedOpenParens.contains(position), !current.isEmpty { current += " " }
                current += "("
                depth += 1
            } else if token == ")" {
                guard depth > 0 else { return nil }
                trimRight(); current += ")"
                depth = max(0, depth - 1)
            } else if token == ";" {
                trimRight(); current += ";"
                finish(); selectList = false
            } else {
                if !current.isEmpty && current != "  " && !current.hasSuffix("(") { current += " " }
                current += token
            }
            position += 1
        }
        guard depth == 0 else { return nil }
        finish()
        return lines.joined(separator: "\n")
    }
}

private final class TextLineRuler: NSRulerView {
    weak var textView: OpenAllTextView?
    override var isFlipped: Bool { true }

    init(scroll: NSScrollView, text: OpenAllTextView) {
        textView = text
        super.init(scrollView: scroll, orientation: .verticalRuler)
        clientView = text
        ruleThickness = 32
        scroll.contentView.postsBoundsChangedNotifications = true
        NotificationCenter.default.addObserver(self, selector: #selector(refresh),
            name: NSView.boundsDidChangeNotification, object: scroll.contentView)
    }
    required init(coder: NSCoder) { fatalError("不支持从归档创建") }
    deinit { NotificationCenter.default.removeObserver(self) }
    @objc private func refresh() { needsDisplay = true }

    override func drawHashMarksAndLabels(in rect: NSRect) {
        guard let textView, let manager = textView.layoutManager else { return }
        textView.backgroundColor.setFill()
        bounds.fill()
        let source = textView.string as NSString
        let paragraph = NSMutableParagraphStyle()
        paragraph.alignment = .right
        var index = 0
        var number = 1
        while index < source.length {
            let glyph = manager.glyphIndexForCharacter(at: index)
            let fragment = manager.lineFragmentRect(forGlyphAt: glyph, effectiveRange: nil)
            let point = convert(NSPoint(x: 0, y: fragment.minY + textView.textContainerOrigin.y), from: textView)
            if point.y > bounds.maxY { break }
            if point.y + fragment.height >= 0 {
                if textView.changedLineNumbers.contains(number) {
                    OpenAllTheme.accent.setFill()
                    NSBezierPath(roundedRect: NSRect(x: 29, y: point.y, width: 2, height: fragment.height),
                                 xRadius: 1, yRadius: 1).fill()
                }
                (String(number) as NSString).draw(in: NSRect(x: 3, y: point.y + 1, width: 22, height: 18),
                    withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 10, weight: .regular),
                                     .foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.65),
                                     .paragraphStyle: paragraph])
            }
            index = NSMaxRange(source.lineRange(for: NSRange(location: index, length: 0)))
            number += 1
        }
    }
}

final class LocalTextToolWindow: NSObject, NSTextViewDelegate {
    enum Mode { case configuration, sql }
    private var window: NSWindow?
    private var input: NSTextView!
    private var output: NSTextView!
    private var status: NSTextField!
    private var actionButton: NSButton!
    private var copyButton: NSButton!
    private var inputSummary: NSTextField!
    private var outputSummary: NSTextField!
    private var changeLegend: NSView!
    private var mode: Mode = .configuration

    func show(_ selected: Mode, text: String = "") {
        if window == nil { build() }
        mode = selected
        WindowChrome.updateTitle(on: window, to: selected == .configuration ? "配置格式化" : "SQL 格式化")
        actionButton.title = "格式化  ⌘↵"
        for text in [input, output].compactMap({ $0 as? OpenAllTextView }) {
            text.highlightsSQL = selected == .sql
            text.highlightsConfig = selected == .configuration
        }
        let inputParagraph = NSMutableParagraphStyle()
        inputParagraph.lineSpacing = 4
        inputParagraph.headIndent = selected == .sql ? 24 : 0
        input.defaultParagraphStyle = inputParagraph
        input.typingAttributes[.paragraphStyle] = inputParagraph
        (input as? OpenAllTextView)?.placeholderText = selected == .sql ? "粘贴 SQL 语句" : "粘贴 YAML 或 Properties 内容"
        if !text.isEmpty { input.string = text }
        input.textStorage?.addAttribute(.paragraphStyle, value: inputParagraph, range: NSRange(location: 0, length: input.string.utf16.count))
        run()
        if DesignPreview.enabled { DesignPreview.lastWindow = window; return }
        WindowChrome.present(window)
        WindowChrome.activate()
        window?.makeFirstResponder(input)
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 960, height: 420),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        WindowChrome.apply(panel, title: "本地文本工具")
        panel.center()
        let root = NSView(frame: panel.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        panel.contentView = root
        let resultSurface = NSView(frame: NSRect(x: 480, y: 60, width: 480, height: 326))
        resultSurface.wantsLayer = true
        resultSurface.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        root.addSubview(resultSurface)
        func label(_ title: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 11,
                   color: NSColor = OpenAllTheme.muted) -> NSTextField {
            let label = NSTextField(labelWithString: title)
            label.frame = NSRect(x: x, y: y, width: width, height: 20)
            label.font = .systemFont(ofSize: size)
            label.textColor = color
            root.addSubview(label)
            return label
        }
        for (title, x) in [("原文", 24), ("结果", 504)] {
            label(title, x: CGFloat(x), y: 352, width: 48, size: 13, color: OpenAllTheme.ink).font = .systemFont(ofSize: 13, weight: .semibold)
        }
        inputSummary = label("", x: 70, y: 352, width: 245)
        outputSummary = label("", x: 550, y: 352, width: 269)
        for summary in [inputSummary, outputSummary] {
            summary?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
            summary?.lineBreakMode = .byTruncatingTail
        }
        func editor(_ x: CGFloat, _ placeholder: String, editable: Bool) -> NSTextView {
            let scroll = NSScrollView(frame: NSRect(x: x, y: 64, width: 456, height: 282))
            scroll.hasVerticalScroller = true
            scroll.scrollerStyle = .overlay
            let text = OpenAllTextView(usingTextLayoutManager: false)
            text.frame = scroll.bounds
            text.placeholderText = placeholder
            text.isEditable = editable
            text.isSelectable = true
            text.isVerticallyResizable = true
            text.isHorizontallyResizable = false
            text.autoresizingMask = [.width]
            text.textContainer?.widthTracksTextView = true
            text.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
            text.textContainerInset = NSSize(width: 7, height: 12)
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineSpacing = 4
            text.defaultParagraphStyle = paragraph
            text.typingAttributes[.paragraphStyle] = paragraph
            WindowChrome.styleEditor(scroll, text: text)
            scroll.layer?.cornerRadius = 0
            scroll.layer?.borderWidth = 0
            scroll.backgroundColor = editable ? OpenAllTheme.canvas : OpenAllTheme.sidebar
            text.backgroundColor = scroll.backgroundColor
            scroll.documentView = text
            scroll.hasVerticalRuler = true
            scroll.verticalRulerView = TextLineRuler(scroll: scroll, text: text)
            scroll.rulersVisible = true
            root.addSubview(scroll)
            return text
        }
        input = editor(12, "粘贴原文", editable: true)
        output = editor(492, "格式化后可在这里选择或复制结果", editable: false)
        input.delegate = self
        for rect in [NSRect(x: 480, y: 60, width: 0.5, height: 326),
                     NSRect(x: 0, y: 60, width: 960, height: 0.5)] {
            let rule = NSView(frame: rect)
            rule.wantsLayer = true
            rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
            root.addSubview(rule)
        }
        let action = NSButton(title: "格式化  ⌘↵", target: self, action: #selector(run))
        action.frame = NSRect(x: 24, y: 16, width: 100, height: 30)
        WindowChrome.styleAction(action, primary: true)
        action.keyEquivalent = "\r"
        action.keyEquivalentModifierMask = [.command]
        root.addSubview(action)
        actionButton = action
        let copy = NSButton(title: "复制结果", target: self, action: #selector(copyResult))
        copy.frame = NSRect(x: 844, y: 348, width: 92, height: 27)
        WindowChrome.styleOutputAction(copy)
        copy.keyEquivalent = "c"
        copy.keyEquivalentModifierMask = [.command, .shift]
        copy.toolTip = "复制结果（⇧⌘C）"
        root.addSubview(copy)
        copyButton = copy
        status = label("", x: 150, y: 7, width: 758)
        status.alignment = .left
        status.frame.size.height = 32
        status.cell?.usesSingleLineMode = false
        status.cell?.wraps = true
        status.cell?.isScrollable = false
        status.maximumNumberOfLines = 2
        changeLegend = NSView(frame: NSRect(x: 140, y: 24, width: 2, height: 11))
        changeLegend.wantsLayer = true
        changeLegend.layer?.backgroundColor = OpenAllTheme.accent.cgColor
        changeLegend.isHidden = true
        root.addSubview(changeLegend)
        WindowChrome.installControls(on: panel, compact: true)
        window = panel
    }

    func textDidChange(_ notification: Notification) {
        guard notification.object as AnyObject? === input else { return }
        inputSummary.stringValue = "\(input.string.components(separatedBy: "\n").count) 行"
        outputSummary.stringValue = "等待重新处理"
        changeLegend.isHidden = true
        status.stringValue = "原文已更改"
        copyButton.isEnabled = false
        (output as? OpenAllTextView)?.changedLineNumbers = []
        output.enclosingScrollView?.verticalRulerView?.needsDisplay = true
    }

    func showDesignSample(_ selected: Mode) {
        guard DesignPreview.enabled else { return }
        let sample = selected == .configuration ? "server:\n    host: localhost\n    port: 8080\n    enabled: true\nlogging:\n    level: info\n    path: /tmp/openall.log\nservice:\n    endpoint: https://example.com\n    timeout: 30\n    retries: 3" :
            "select u.id, u.name, count(o.id) as orders from users u left join orders o on o.user_id = u.id where u.active = true and o.total > 100 group by u.id, u.name order by orders desc limit 50;"
        show(selected, text: sample)
        input.needsDisplay = true
        output.needsDisplay = true
    }

    @objc private func run() {
        guard input != nil else { return }
        (output as? OpenAllTextView)?.changedLineNumbers = []
        inputSummary.stringValue = "\(input.string.components(separatedBy: "\n").count) 行"
        outputSummary.stringValue = ""
        changeLegend.isHidden = true
        if input.string.isEmpty {
            inputSummary.stringValue = "0 行"
            output.string = ""
            status.stringValue = ""
            copyButton.isEnabled = false
            return
        }
        switch mode {
        case .configuration:
            if let result = LocalTextTools.formatConfiguration(input.string) {
                output.string = result.0
                let before = input.string.components(separatedBy: "\n")
                let after = result.0.components(separatedBy: "\n")
                let changed = max(before.count, after.count) - zip(before, after).filter { $0.0 == $0.1 }.count
                let changedLines = Set(after.indices.filter { $0 >= before.count || before[$0] != after[$0] }.map { $0 + 1 })
                (output as? OpenAllTextView)?.changedLineNumbers = changedLines
                outputSummary.stringValue = result.1.hasPrefix("YAML") ? "YAML · 2 空格缩进" : "Properties"
                status.stringValue = changed == 0 ? "格式已规范" : "行侧标记：格式调整"
                outputSummary.stringValue += changed > 0 ? " · \(changed) 行已调整" : " · 无改动"
                changeLegend.isHidden = changed == 0
            }
            else { output.string = ""; status.stringValue = "配置格式无法识别；请检查 YAML 或 Properties 语法" }
        case .sql:
            if let formatted = LocalTextTools.formatSQL(input.string) {
                output.string = formatted
                outputSummary.stringValue = "通用 SQL · \(formatted.components(separatedBy: "\n").count) 行"
                status.stringValue = "分句换行 · 关键字大写"
            } else {
                output.string = ""
                status.stringValue = "不支持此 SQL 语法或输入不完整，未生成结果"
            }
        }
        copyButton.isEnabled = !output.string.isEmpty
        input.enclosingScrollView?.verticalRulerView?.needsDisplay = true
        output.enclosingScrollView?.verticalRulerView?.needsDisplay = true
    }

    @objc private func copyResult() {
        guard copyButton.isEnabled, !output.string.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(output.string, forType: .string)
        changeLegend.isHidden = true
        status.stringValue = "已复制结果"
    }
}
