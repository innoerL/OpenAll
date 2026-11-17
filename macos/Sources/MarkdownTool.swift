import AppKit
import WebKit

final class MarkdownHelpRow: NSButton {
    var syntax = ""
    var explanation = ""
    var isDiagram = false
    private var hovering = false { didSet { needsDisplay = true } }
    override func updateTrackingAreas() {
        trackingAreas.forEach(removeTrackingArea)
        addTrackingArea(NSTrackingArea(rect: bounds, options: [.mouseEnteredAndExited, .activeInActiveApp], owner: self))
        super.updateTrackingAreas()
    }
    override func mouseEntered(with event: NSEvent) { hovering = true }
    override func mouseExited(with event: NSEvent) { hovering = false }
    override func draw(_ dirtyRect: NSRect) {
        let bounds = self.bounds.insetBy(dx: 2, dy: 2)
        (hovering ? OpenAllTheme.raised : NSColor.clear).setFill()
        NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).fill()
        if hovering || isHighlighted {
            OpenAllTheme.accent.withAlphaComponent(0.5).setStroke()
            NSBezierPath(roundedRect: bounds, xRadius: 5, yRadius: 5).stroke()
        }
        let title = isDiagram ? syntax : explanation
        let detail = isDiagram ? explanation : syntax
        (title as NSString).draw(in: NSRect(x: 12, y: 6, width: 105, height: 20),
                                 withAttributes: [.font: NSFont.systemFont(ofSize: 13, weight: .regular), .foregroundColor: OpenAllTheme.ink])
        (detail as NSString).draw(in: NSRect(x: 124, y: 6, width: bounds.width - 194, height: 20),
                                  withAttributes: [.font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular), .foregroundColor: OpenAllTheme.muted])
        ("↵" as NSString).draw(in: NSRect(x: bounds.maxX - 46, y: 6, width: 36, height: 20),
                                withAttributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: hovering ? OpenAllTheme.accentText : OpenAllTheme.muted])
    }
}

final class MarkdownHelpList: NSView {
    override var isFlipped: Bool { true }
}

final class MarkdownToolWindow: NSObject, NSTextViewDelegate, WKNavigationDelegate, NSWindowDelegate {
    private var window: NSWindow?
    private var editor: NSTextView!
    private var preview: WKWebView!
    private var copyButton: NSButton?
    private var previewLoaded = false
    private var previewJob: DispatchWorkItem?
    private var helpView: NSView?
    private var helpShade: NSView?
    private var helpButton: NSButton?
    private var helpClickMonitor: Any?
    private let examples: [(String, String, String)] = [
        ("流程图", "节点与分支", "```mermaid\nflowchart LR\nA[开始] --> B{检查}\nB -->|通过| C[完成]\nB -->|重试| A\n```"),
        ("时序图", "角色与消息", "```mermaid\nsequenceDiagram\nparticipant U as 用户\nparticipant A as OpenAll\nU->>A: 输入 Markdown\nA-->>U: 显示预览\n```"),
        ("甘特图", "任务与日期", "```mermaid\ngantt\n  title 工作计划\n  dateFormat YYYY-MM-DD\n  axisFormat %m/%d\n  tickInterval 1day\n  todayMarker off\n  section 开发\n  实现功能 :a1, 2026-11-02, 2d\n  验证效果 :after a1, 1d\n```"),
        ("状态图", "状态与转换", "```mermaid\nstateDiagram-v2\n[*] --> Draft\nDraft --> Done : 完成\nDone --> [*]\n```"),
        ("# 标题", "一级标题", "# 一级标题"), ("## 标题", "二级标题", "## 二级标题"),
        ("### 标题", "三级标题", "### 三级标题"), ("**粗体**", "强调", "**加粗文字**"),
        ("*斜体*", "斜体", "*斜体文字*"), ("~~删除~~", "删除线", "~~已删除文字~~"),
        ("[链接](网址)", "超链接", "[链接](http://baidu.com)"),
        ("![图片](网址)", "插入图片", "![图片](https://example.com/image.png)"),
        ("- 项目", "无序列表", "- 第一项\n- 第二项"), ("1. 项目", "有序列表", "1. 第一项\n2. 第二项"),
        ("- [ ] 任务", "任务清单", "- [ ] 待办\n- [x] 完成"),
        ("> 引用", "引用块", "> 引用内容"), ("`代码`", "行内代码", "`print(1)`"),
        ("```语言", "代码块", "```java\nSystem.out.println(1);\n```"),
        ("---", "分隔线", "---"), ("| 表格 |", "表格", "| 名称 | 值 |\n| --- | --- |\n| 示例 | 1 |"),
        ("空行", "段落分隔", "第一段\n\n第二段")
    ]

    deinit {
        if let helpClickMonitor { NSEvent.removeMonitor(helpClickMonitor) }
    }

    func show(_ initial: String) {
        if window == nil { build() }
        if !initial.isEmpty { editor.string = initial }
        refresh()
        WindowChrome.present(window)
        WindowChrome.activate()
        window?.makeFirstResponder(editor)
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 540),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable],
                         backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.delegate = self
        WindowChrome.apply(w, title: "Markdown 编辑与预览")
        w.minSize = NSSize(width: 760, height: 480)
        w.center()
        let root = NSView(frame: w.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.appearance = OpenAllTheme.appearance
        w.contentView = root
        let help = NSButton(title: "语法示例", target: self, action: #selector(toggleHelp))
        help.frame = NSRect(x: 0, y: 0, width: 86, height: 24)
        help.toolTip = "语法速查（⌘/）"
        helpButton = help
        help.keyEquivalent = "/"
        help.keyEquivalentModifierMask = [.command]
        WindowChrome.styleAction(help)
        help.autoresizingMask = [.minYMargin]
        let copy = NSButton(title: "复制 Markdown", target: self, action: #selector(copyAll))
        copy.frame = NSRect(x: 0, y: 0, width: 116, height: 24)
        copy.autoresizingMask = [.minXMargin, .minYMargin]
        WindowChrome.styleOutputAction(copy)
        copyButton = copy
        let split = QuietSplitView(frame: NSRect(x: 20, y: 20, width: 940, height: 454))
        split.isVertical = true
        split.dividerStyle = .thin
        split.wantsLayer = true
        split.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        split.layer?.cornerRadius = 10
        split.layer?.borderWidth = 0.5
        split.layer?.borderColor = OpenAllTheme.rule.cgColor
        split.layer?.masksToBounds = true
        split.autoresizingMask = [.width, .height]
        root.addSubview(split)
        let left = NSScrollView(frame: NSRect(x: 0, y: 0, width: 468, height: 454))
        for scroll in [left] {
            scroll.hasVerticalScroller = true
            scroll.borderType = .noBorder
            scroll.drawsBackground = false
        }
        let markdownEditor = OpenAllTextView(frame: left.bounds)
        markdownEditor.placeholderText = "输入 Markdown，右侧实时预览 · ⌘/ 查看语法"
        editor = markdownEditor
        editor.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        markdownEditor.highlightsMarkdown = true
        editor.textContainerInset = NSSize(width: 16, height: 18)
        WindowChrome.styleEditor(left, text: editor)
        left.layer?.cornerRadius = 0
        left.layer?.borderWidth = 0
        editor.isRichText = false
        editor.isAutomaticQuoteSubstitutionEnabled = false
        editor.isAutomaticDashSubstitutionEnabled = false
        editor.delegate = self
        left.documentView = editor
        preview = WKWebView(frame: NSRect(x: 0, y: 0, width: 468, height: 454))
        preview.navigationDelegate = self
        preview.wantsLayer = true
        preview.layer?.cornerRadius = 0
        preview.layer?.masksToBounds = true
        preview.layer?.borderWidth = 0
        preview.layer?.borderColor = OpenAllTheme.rule.cgColor
        split.addSubview(ToolPane(title: "Markdown", content: left, actions: [help, copy], size: NSSize(width: 468, height: 454)))
        split.addSubview(ToolPane(title: "实时预览", content: preview, size: NSSize(width: 468, height: 454)))
        split.adjustSubviews()
        WindowChrome.installControls(on: w)
        editor.string = ""
        window = w
        if let file = Bundle.main.url(forResource: "markdown-preview", withExtension: "html") {
            preview.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        }
    }

    @MainActor func waitForPreviewForDesign() async throws {
        guard DesignPreview.enabled else { return }
        for _ in 0..<100 {
            if previewLoaded, let text = try? await preview.evaluateJavaScript("document.body.innerText"),
               (text as? String)?.contains("项目记录") == true {
                let rendered = try? await preview.evaluateJavaScript("document.querySelectorAll('table').length === 1 && document.querySelectorAll('.task input:checked').length === 2")
                if rendered as? Bool == true { return }
            }
            try await Task.sleep(nanoseconds: 100_000_000)
        }
        throw NSError(domain: "MarkdownPreviewNotReady", code: 1)
    }

    @objc private func toggleHelp() {
        guard let root = window?.contentView else { return }
        if helpView != nil { dismissHelp(); return }
        let width = root.bounds.width / 2 - 20
        let card = NSView(frame: NSRect(x: root.bounds.width / 2, y: 20,
                                        width: width, height: root.bounds.height - 118))
        card.autoresizingMask = [.minXMargin, .height]
        card.wantsLayer = true
        card.layer?.cornerRadius = 10
        card.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        card.layer?.borderWidth = 0.5
        card.layer?.borderColor = OpenAllTheme.rule.cgColor
        card.shadow = NSShadow()
        card.shadow?.shadowBlurRadius = 0
        card.shadow?.shadowColor = NSColor.clear
        let heading = NSTextField(labelWithString: "语法速查")
        heading.font = .systemFont(ofSize: 16, weight: .medium)
        heading.textColor = OpenAllTheme.ink
        heading.frame = NSRect(x: 22, y: card.bounds.height - 43, width: width - 74, height: 26)
        heading.autoresizingMask = [.minYMargin]
        card.addSubview(heading)
        let subtitle = NSTextField(labelWithString: "点击语法，在左侧光标处插入")
        subtitle.font = .systemFont(ofSize: 12)
        subtitle.textColor = OpenAllTheme.muted
        subtitle.frame = NSRect(x: 22, y: card.bounds.height - 64, width: width - 44, height: 17)
        subtitle.autoresizingMask = [.minYMargin]
        card.addSubview(subtitle)
        let close = NSButton(title: "×", target: self, action: #selector(toggleHelp))
        close.isBordered = false
        close.font = .systemFont(ofSize: 19, weight: .light)
        close.contentTintColor = OpenAllTheme.muted
        close.frame = NSRect(x: width - 48, y: card.bounds.height - 47, width: 30, height: 30)
        close.autoresizingMask = [.minYMargin]
        card.addSubview(close)
        let visibleHeight = floor((card.bounds.height - 131) / 34) * 34 + 24
        let scroll = NSScrollView(frame: NSRect(x: 14, y: card.bounds.height - 76 - visibleHeight, width: width - 28, height: visibleHeight))
        scroll.autoresizingMask = [.height]
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        let rowHeight: CGFloat = 34
        let basicCount = examples.count - 4
        let basicRows = basicCount
        let diagramHeadingY = 34 + CGFloat(basicRows) * rowHeight
        let rowWidth = width - 50
        let list = MarkdownHelpList(frame: NSRect(x: 0, y: 0, width: width - 44,
                                                   height: diagramHeadingY + 164))
        for (title, y) in [("基础语法", CGFloat(2)), ("图形绘制", diagramHeadingY)] {
            let heading = NSTextField(labelWithString: title)
            heading.frame = NSRect(x: 10, y: y, width: 220, height: 20)
            heading.font = .systemFont(ofSize: 11, weight: .semibold)
            heading.textColor = OpenAllTheme.muted
            list.addSubview(heading)
        }
        let order = Array(4..<examples.count) + Array(0..<4)
        for (position, index) in order.enumerated() {
            let item = examples[index]
            let inDiagram = position >= basicCount
            let sectionIndex = inDiagram ? position - basicCount : position
            let row = MarkdownHelpRow(frame: NSRect(x: CGFloat(0),
                                                     y: (inDiagram ? diagramHeadingY + 24 : 24) + CGFloat(sectionIndex) * rowHeight,
                                                     width: rowWidth - 4, height: 32))
            row.syntax = item.0
            row.explanation = item.1
            row.isDiagram = index < 4
            row.tag = index
            row.target = self
            row.action = #selector(insertExample(_:))
            row.isBordered = false
            row.focusRingType = .none
            row.toolTip = "插入：\(item.2)"
            row.setAccessibilityLabel("插入\(item.1)")
            list.addSubview(row)
        }
        scroll.documentView = list
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        card.addSubview(scroll)
        let scrollHint = NSTextField(labelWithString: "包含基础语法与 Mermaid 图形")
        scrollHint.font = .systemFont(ofSize: 10, weight: .medium)
        scrollHint.textColor = OpenAllTheme.muted
        scrollHint.frame = NSRect(x: 24, y: 9, width: width - 48, height: 17)
        card.addSubview(scrollHint)
        let shade = NSView(frame: NSRect(x: 0, y: 0, width: root.bounds.width, height: root.bounds.height - WindowChrome.height))
        shade.autoresizingMask = [.width, .height]
        shade.wantsLayer = true
        shade.layer?.backgroundColor = NSColor.clear.cgColor
        root.addSubview(shade)
        helpShade = shade
        root.addSubview(card)
        helpView = card
        if !DesignPreview.enabled {
            helpClickMonitor = NSEvent.addLocalMonitorForEvents(matching: [.leftMouseDown, .rightMouseDown]) { [weak self] event in
                guard let self, let card = self.helpView, let root = self.window?.contentView,
                      event.window === self.window else { return event }
                let point = root.convert(event.locationInWindow, from: nil)
                let onButton = self.helpButton.map { $0.bounds.contains($0.convert(event.locationInWindow, from: nil)) } ?? false
                if !card.frame.contains(point) && !onButton { self.dismissHelp() }
                return event
            }
        }
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
            card.alphaValue = 0
            NSAnimationContext.runAnimationGroup { context in
                context.duration = 0.16
                context.timingFunction = CAMediaTimingFunction(name: .easeOut)
                card.animator().alphaValue = 1
            }
        }
    }

    private func dismissHelp() {
        guard let helpView else { return }
        self.helpView = nil
        helpShade?.removeFromSuperview()
        helpShade = nil
        if let helpClickMonitor { NSEvent.removeMonitor(helpClickMonitor); self.helpClickMonitor = nil }
        if NSWorkspace.shared.accessibilityDisplayShouldReduceMotion { helpView.removeFromSuperview() }
        else {
            NSAnimationContext.runAnimationGroup({ context in
                context.duration = 0.14
                helpView.animator().alphaValue = 0
            }, completionHandler: { helpView.removeFromSuperview() })
        }
    }

    func windowDidResignKey(_ notification: Notification) { dismissHelp() }
    func windowDidResize(_ notification: Notification) { dismissHelp() }

    func showHelpForDesign() {
        guard DesignPreview.enabled, helpView == nil else { return }
        toggleHelp()
    }

    @objc private func insertExample(_ sender: NSButton) {
        guard examples.indices.contains(sender.tag) else { return }
        let sample = examples[sender.tag].2
        let range = editor.selectedRange()
        let source = editor.string as NSString
        let prefix = sample.hasPrefix("```") && range.location > 0 &&
            !source.substring(to: range.location).hasSuffix("\n\n") ? "\n\n" : ""
        let suffix = sample.hasPrefix("```") && range.location + range.length < source.length &&
            !source.substring(from: range.location + range.length).hasPrefix("\n") ? "\n\n" : ""
        editor.insertText(prefix + sample + suffix, replacementRange: range)
        refresh()
        dismissHelp()
        window?.makeFirstResponder(editor)
    }

    @objc private func copyAll() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(editor.string, forType: .string)
        copyButton?.title = "已复制 Markdown"
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.4) { [weak self] in
            self?.copyButton?.title = "复制 Markdown"
        }
    }

    func textDidChange(_ notification: Notification) {
        previewJob?.cancel()
        let job = DispatchWorkItem { [weak self] in self?.refresh() }
        previewJob = job
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.08, execute: job)
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        previewLoaded = true
        WindowChrome.applyWebTheme(webView, kind: "markdown") { [weak self] in self?.refresh() }
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
            NSWorkspace.shared.open(url)
            decisionHandler(.cancel)
        } else { decisionHandler(.allow) }
    }

    private func refresh() {
        guard editor != nil, preview != nil else { return }
        copyButton?.isEnabled = !editor.string.isEmpty
        if previewLoaded {
            let body = MarkdownRenderer.body(editor.string)
            if let data = try? JSONSerialization.data(withJSONObject: [body]),
               let json = String(data: data, encoding: .utf8) {
                preview.evaluateJavaScript("window.renderMarkdown(\(json)[0])") { _, _ in }
            }
        }
    }
}

enum MarkdownRenderer {
    private static func escaped(_ text: String) -> String {
        text.replacingOccurrences(of: "&", with: "&amp;")
            .replacingOccurrences(of: "<", with: "&lt;")
            .replacingOccurrences(of: ">", with: "&gt;")
            .replacingOccurrences(of: "\"", with: "&quot;")
    }

    private static func replaced(_ source: String, pattern: String, template: String) -> String {
        guard let regex = try? NSRegularExpression(pattern: pattern) else { return source }
        return regex.stringByReplacingMatches(in: source,
                                              range: NSRange(source.startIndex..., in: source),
                                              withTemplate: template)
    }

    private static func inline(_ source: String) -> String {
        var text = escaped(source)
        text = replaced(text, pattern: "`([^`]+)`", template: "<code>$1</code>")
        text = replaced(text, pattern: "~~(.+?)~~", template: "<del>$1</del>")
        text = replaced(text, pattern: "!\\[([^\\]]*)\\]\\((https?://[^ )]+)\\)", template: "<img alt=\"$1\" src=\"$2\">")
        text = replaced(text, pattern: "\\*\\*([^*]+)\\*\\*", template: "<strong>$1</strong>")
        text = replaced(text, pattern: "\\*([^*]+)\\*", template: "<em>$1</em>")
        text = replaced(text, pattern: "\\[([^\\]]+)\\]\\((https?://[^ )]+)\\)",
                        template: "<a href=\"$2\">$1</a>")
        return text
    }

    /// 表格分列时保留代码跨度及转义的竖线，避免把内容误识别为列边界。
    private static func tableCells(_ line: String) -> [String] {
        var value = line.trimmingCharacters(in: .whitespaces)
        if value.hasPrefix("|") { value.removeFirst() }
        if value.hasSuffix("|"), !value.hasSuffix("\\|") { value.removeLast() }
        var cells: [String] = [], cell = ""
        var escapedPipe = false, inCode = false
        for character in value {
            if escapedPipe {
                if character != "|" { cell.append("\\") }
                cell.append(character)
                escapedPipe = false
            } else if character == "\\" {
                escapedPipe = true
            } else if character == "`" {
                inCode.toggle()
                cell.append(character)
            } else if character == "|", !inCode {
                cells.append(cell.trimmingCharacters(in: .whitespaces))
                cell = ""
            } else { cell.append(character) }
        }
        if escapedPipe { cell.append("\\") }
        cells.append(cell.trimmingCharacters(in: .whitespaces))
        return cells
    }

    static func body(_ source: String) -> String {
        if source.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty {
            return "<p class=\"empty\">预览会在这里呈现</p>"
        }
        var blocks: [String] = []
        var codeLanguage: String?
        var codeLines: [String] = []
        var list: String?
        let lines = source.replacingOccurrences(of: "\r\n", with: "\n").replacingOccurrences(of: "\r", with: "\n").components(separatedBy: "\n")
        var index = 0
        func closeList() {
            if let current = list { blocks.append("</\(current)>"); list = nil }
        }
        while index < lines.count {
            let line = lines[index]
            index += 1
            if line.hasPrefix("```") {
                closeList()
                if let language = codeLanguage {
                    let content = escaped(codeLines.joined(separator: "\n"))
                    blocks.append(language == "mermaid" ? "<div class=\"diagram\">\(content)</div>" : "<pre><code>\(content)</code></pre>")
                    codeLanguage = nil
                    codeLines.removeAll()
                } else { codeLanguage = String(line.dropFirst(3)).trimmingCharacters(in: .whitespaces).lowercased() }
                continue
            }
            if codeLanguage != nil { codeLines.append(line); continue }
            if line.contains("|"), index < lines.count {
                let headings = tableCells(line), separators = tableCells(lines[index])
                if headings.count == separators.count, separators.allSatisfy({ $0.range(of: #"^:?-{3,}:?$"#, options: .regularExpression) != nil }) {
                    closeList()
                    index += 1
                    let alignments = separators.map { $0.hasSuffix(":") ? ($0.hasPrefix(":") ? "center" : "right") : "left" }
                    func cells(_ values: [String], tag: String) -> String {
                        headings.indices.map { column in
                            "<\(tag) style=\"text-align:\(alignments[column])\">\(inline(column < values.count ? values[column] : ""))</\(tag)>"
                        }.joined()
                    }
                    blocks.append("<div class=\"table-wrap\"><table><thead><tr>" + cells(headings, tag: "th") + "</tr></thead><tbody>")
                    while index < lines.count, lines[index].contains("|"), !lines[index].trimmingCharacters(in: .whitespaces).isEmpty {
                        blocks.append("<tr>" + cells(tableCells(lines[index]), tag: "td") + "</tr>")
                        index += 1
                    }
                    blocks.append("</tbody></table></div>")
                    continue
                }
            }
            let unordered = line.hasPrefix("- ") || line.hasPrefix("* ") || line.hasPrefix("+ ")
            let ordered = line.range(of: #"^\d+[.)]\s+"#, options: .regularExpression)
            if unordered || ordered != nil {
                let kind = unordered ? "ul" : "ol"
                if list != kind { closeList(); blocks.append("<\(kind)>"); list = kind }
                let value = unordered ? String(line.dropFirst(2)) : String(line[ordered!.upperBound...])
                if unordered, value.range(of: #"^\[[ xX]\]\s"#, options: .regularExpression) != nil {
                    let checked = value.lowercased().hasPrefix("[x]")
                    blocks.append("<li class=\"task\"><input type=\"checkbox\" disabled\(checked ? " checked" : "")>\(inline(String(value.dropFirst(4))))</li>")
                } else { blocks.append("<li>\(inline(value))</li>") }
                continue
            }
            closeList()
            if line.isEmpty { blocks.append("<div class=\"gap\"></div>"); continue }
            if line == "---" || line == "***" { blocks.append("<hr>"); continue }
            let hashes = line.prefix { $0 == "#" }.count
            if (1...6).contains(hashes), line.dropFirst(hashes).first == " " {
                blocks.append("<h\(hashes)>\(inline(String(line.dropFirst(hashes + 1))))</h\(hashes)>")
            } else if line.hasPrefix("> ") {
                blocks.append("<blockquote>\(inline(String(line.dropFirst(2))))</blockquote>")
            } else { blocks.append("<p>\(inline(line))</p>") }
        }
        closeList()
        if let language = codeLanguage {
            let content = escaped(codeLines.joined(separator: "\n"))
            blocks.append(language == "mermaid" ? "<div class=\"diagram\">\(content)</div>" : "<pre><code>\(content)</code></pre>")
        }
        return blocks.joined()
    }

    static func verifyRenderingForDesign() -> Bool {
        let source = "| 列 A | 列 B |\n| :--- | ---: |\n| a\\|b | `<x>` |\n\n- [x] 完成\n- [ ] 待办\n1. 第一项\n2. 第二项\n\n```\n| 原样 |\n- [x] 原样\n```"
        let rendered = body(source)
        return body(source.replacingOccurrences(of: "\n", with: "\r\n")) == rendered && rendered.contains("<table>") && rendered.contains("a|b</td>") &&
            rendered.contains("<code>&lt;x&gt;</code>") && rendered.contains("text-align:right") &&
            rendered.contains("disabled checked") && rendered.contains("<ol><li>第一项</li><li>第二项</li></ol>") &&
            rendered.contains("<pre><code>| 原样 |\n- [x] 原样</code></pre>") && !rendered.contains("<x>")
    }

    static func html(_ source: String) -> String {
        let theme = OpenAllTheme.hasCustomization ? """
        body{background:\(OpenAllTheme.hex(OpenAllTheme.canvas));color:\(OpenAllTheme.hex(OpenAllTheme.ink))}
        a{color:\(OpenAllTheme.hex(OpenAllTheme.accentText))}
        code,pre{background:\(OpenAllTheme.hex(OpenAllTheme.surface))}
        blockquote{border-left-color:\(OpenAllTheme.hex(OpenAllTheme.accent));color:\(OpenAllTheme.hex(OpenAllTheme.muted))}
        .empty{color:\(OpenAllTheme.hex(OpenAllTheme.muted))}
        """ : ""
        return """
        <!doctype html><meta charset="utf-8"><style>
        :root{color-scheme:dark}body{font:14px -apple-system,BlinkMacSystemFont,sans-serif;
        line-height:1.58;color:#e9e7df;background:#222625;margin:0;padding:22px 24px}
        h1,h2,h3,h4,h5,h6{line-height:1.3;margin:.95em 0 .4em;font-weight:600}main>:first-child{margin-top:0}h1{font-size:1.55em;border-bottom:1px solid #454b47;padding-bottom:.34em}
        h2{font-size:1.3em}p{margin:12px 0}ul{padding-left:1.5em}li{margin:.2em 0}
        code,pre{font:14px SFMono-Regular,Menlo,monospace;background:#343a36;border-radius:5px}
        code{padding:2px 5px}pre{padding:16px;overflow:auto}pre code{padding:0}
        blockquote{border-left:3px solid #cfb58d;color:#c6c9bf;margin:1em 0;padding:.15em 1em}
        .gap{height:0}.table-wrap{overflow-x:auto;margin:16px 0}table{width:100%;border-collapse:collapse;font-size:13px}th,td{padding:9px 12px;border-bottom:1px solid #454b47;vertical-align:top}li.task{list-style:none;margin-left:-1.5em;display:flex;gap:9px}li.task input{accent-color:#d5bf99}
        .empty{color:#9da49c;font-size:13px;margin:2px 0}
        a{color:#d5bf99;text-decoration:none}img{max-width:100%;height:auto;border-radius:8px}
        \(theme)
        </style><main>\(body(source))</main>
        """
    }
}
