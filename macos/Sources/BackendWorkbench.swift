import AppKit

enum BackendMode: Int, CaseIterable {
    case config, explain, logs, sql

    var title: String {
        switch self {
        case .config: return "结构化配置对比"
        case .explain: return "SQL 执行计划"
        case .logs: return "日志时间线"
        case .sql: return "SQL 参数还原"
        }
    }
}

/// 将分析结果排成可扫描的列，原始结果仍用于复制。
private final class AnalysisReportView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    struct Row {
        var values: [String]
        var tone: String = "normal"
    }
    private let table = NSTableView()
    private let header = NSView()
    private let scroll = NSScrollView()
    private var rows: [Row] = []
    private let numericColumns: Set<Int>
    private let empty = NSTextField(labelWithString: "粘贴内容并运行分析，结果会显示在这里")
    init(frame: NSRect, columns: [(String, CGFloat)], numericColumns: Set<Int> = []) {
        self.numericColumns = numericColumns
        super.init(frame: frame)
        wantsLayer = true
        layer?.backgroundColor = OpenAllTheme.surface.cgColor
        layer?.cornerRadius = 6
        layer?.borderWidth = 0.5
        layer?.borderColor = OpenAllTheme.rule.cgColor
        layer?.masksToBounds = true
        header.wantsLayer = true
        header.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        addSubview(header)
        table.headerView = nil
        table.style = .plain
        table.backgroundColor = .clear
        table.rowHeight = 34
        table.intercellSpacing = NSSize(width: 0, height: 1)
        table.selectionHighlightStyle = .regular
        table.delegate = self
        table.dataSource = self
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        var x: CGFloat = 0
        for (index, column) in columns.enumerated() {
            let cell = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("\(index)"))
            cell.width = column.1
            table.addTableColumn(cell)
            let label = NSTextField(labelWithString: column.0)
            label.font = .systemFont(ofSize: 12, weight: .medium)
            label.textColor = OpenAllTheme.muted
            label.frame = NSRect(x: x + 12, y: 6, width: column.1 - 24, height: 18)
            label.alignment = numericColumns.contains(index) ? .right : .left
            header.addSubview(label)
            x += column.1
        }
        scroll.borderType = .noBorder
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.autohidesScrollers = true
        scroll.documentView = table
        addSubview(scroll)
        empty.font = .systemFont(ofSize: 13)
        empty.textColor = OpenAllTheme.muted
        empty.alignment = .center
        addSubview(empty)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }
    override func layout() {
        super.layout()
        header.frame = NSRect(x: 0, y: bounds.height - 30, width: bounds.width, height: 30)
        scroll.frame = NSRect(x: 0, y: 0, width: bounds.width, height: max(0, bounds.height - 30))
        table.sizeLastColumnToFit()
        empty.frame = NSRect(x: 24, y: max(12, (bounds.height - 60) / 2), width: bounds.width - 48, height: 24)
    }
    func display(_ rows: [Row], emptyText: String = "粘贴内容并运行分析，结果会显示在这里") {
        self.rows = rows
        empty.stringValue = emptyText
        empty.isHidden = !rows.isEmpty
        table.reloadData()
        needsLayout = true
    }
    func numberOfRows(in tableView: NSTableView) -> Int { rows.count }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        guard let column = tableColumn, let index = Int(column.identifier.rawValue), rows.indices.contains(row) else { return nil }
        let item = rows[row]
        let view = NSTableCellView()
        if item.tone == "group" {
            view.wantsLayer = true
            view.layer?.backgroundColor = OpenAllTheme.surface.withAlphaComponent(0.3).cgColor
        }
        let text = NSTextField(labelWithString: index < item.values.count ? item.values[index] : "")
        text.frame = NSRect(x: 12, y: 7, width: column.width - 24, height: 22)
        text.autoresizingMask = [.width]
        text.font = .systemFont(ofSize: 13, weight: item.tone == "group" ? .semibold : .regular)
        if numericColumns.contains(index) {
            text.font = .monospacedDigitSystemFont(ofSize: 13, weight: .regular)
            text.alignment = .right
        }
        text.textColor = item.tone == "group" ? OpenAllTheme.muted : OpenAllTheme.ink
        if (item.tone == "warning" && index == 1) || (item.tone == "risk" && index == 5) { text.textColor = .systemOrange }
        if item.tone == "added", index > 0 { text.textColor = .systemGreen }
        if item.tone == "removed", index > 0 { text.textColor = .systemRed }
        if item.tone == "changed", index == 2 { text.textColor = OpenAllTheme.muted }
        if item.tone == "changed", index == 3 { text.textColor = OpenAllTheme.accentText }
        if item.tone == "changed" || item.tone == "added" || item.tone == "removed", index >= 2,
           let split = text.stringValue.range(of: " · ", options: .backwards) {
            let styled = NSMutableAttributedString(string: text.stringValue, attributes: [.font: text.font!, .foregroundColor: text.textColor!])
            styled.addAttributes([.font: NSFont.systemFont(ofSize: 11), .foregroundColor: OpenAllTheme.muted], range: NSRange(split.lowerBound..<text.stringValue.endIndex, in: text.stringValue))
            text.attributedStringValue = styled
        }
        text.lineBreakMode = .byTruncatingTail
        text.toolTip = text.stringValue
        view.addSubview(text)
        view.textField = text
        return view
    }
}

final class BackendWorkbenchWindow: NSObject {
    private var window: NSWindow?
    private var root: NSView!
    private var body: NSView!
    private var tabs: [NSButton] = []
    private var mode: BackendMode = .config
    private var left: NSTextView?
    private var right: NSTextView?
    private var reportView: AnalysisReportView?
    private var manualRuleExpanded = false
    private var reportSummary: NSTextField?
    private weak var copyResultButton: NSButton?
    private var result: NSTextView?
    private var status: NSTextField!
    private var reveal: NSButton?
    private var groupField: NSPopUpButton?
    private var timeField: NSPopUpButton?
    private var manualRule: NSTextField?
    private var logFields: [String] = []
    private var logs: [ParsedLog] = []
    private var savedInputs: [BackendMode: (left: String, right: String, rule: String)] = [:]

    func show(_ selected: BackendMode, initial: String = "") {
        if window == nil { build() }
        if selected != mode || left == nil { switchMode(selected) }
        if !initial.isEmpty { left?.string = initial; analyze() }
        if DesignPreview.enabled { DesignPreview.lastWindow = window; return }
        WindowChrome.present(window)
        WindowChrome.activate()
        window?.makeFirstResponder(left)
    }

    func showDesignSample(_ selected: BackendMode) {
        guard DesignPreview.enabled else { return }
        let sample: String
        switch selected {
        case .config: sample = "server:\n  port: 8080\n  apiKey: demo-secret\nfeature:\n  enabled: true"
        case .explain: sample = "[{\"Plan\":{\"Node Type\":\"Seq Scan\",\"Relation Name\":\"users\",\"Plan Rows\":12000,\"Actual Rows\":3,\"Actual Total Time\":18.4}}]"
        case .logs: sample = """
            {"time":"2026-11-03T13:00:00+08:00","requestId":"a1","level":"INFO","message":"开始请求"}
            {"time":"2026-11-03T13:00:01+08:00","requestId":"a1","level":"ERROR","message":"数据库超时"}
            {"time":"2026-11-03T13:01:00+08:00","requestId":"b2","level":"INFO","message":"开始请求"}
            """
        case .sql: sample = "SELECT * FROM users WHERE id = ? AND name = ?"
        }
        show(selected, initial: sample)
        if selected == .config {
            right?.string = "server:\n  port: 9090\n  apiKey: new-secret\nfeature:\n  enabled: false"
            analyze()
        } else if selected == .sql {
            right?.string = "Parameters: 42(Integer), Alice(String)"
            analyze()
        }
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1000, height: 680),
                             styleMask: [.titled, .closable, .miniaturizable],
                             backing: .buffered, defer: false)
        panel.isReleasedWhenClosed = false
        WindowChrome.apply(panel, title: "后端工具")
        panel.center()
        let surface = NSView(frame: panel.contentView!.bounds)
        surface.wantsLayer = true
        surface.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        surface.appearance = OpenAllTheme.appearance
        panel.contentView = surface
        root = surface
        
        
        for selected in BackendMode.allCases {
            let tab = NSButton(title: selected.title, target: self, action: #selector(selectTab(_:)))
            tab.tag = selected.rawValue
            tab.frame = NSRect(x: 28 + selected.rawValue * 124, y: 583, width: 120, height: 32)
            root.addSubview(tab)
            tabs.append(tab)
        }
        body = NSView(frame: NSRect(x: 24, y: 44, width: 952, height: 520))
        root.addSubview(body)
        status = label("", x: 31, y: 16, w: 930, h: 22, size: 11, color: OpenAllTheme.muted)
        root.addSubview(status)
        WindowChrome.installControls(on: panel)
        window = panel
    }

    private func label(_ text: String, x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
                       size: CGFloat = 12, color: NSColor? = nil,
                       weight: NSFont.Weight = .regular) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.frame = NSRect(x: x, y: y, width: w, height: h)
        field.font = .systemFont(ofSize: max(12, size), weight: weight)
        field.textColor = color ?? OpenAllTheme.ink
        return field
    }

    private func button(_ title: String, x: CGFloat, y: CGFloat, w: CGFloat,
                        action: Selector, primary: Bool = false) -> NSButton {
        let control = NSButton(title: title, target: self, action: action)
        control.frame = NSRect(x: x, y: y, width: w, height: 30)
        WindowChrome.styleAction(control, primary: primary)
        if primary {
            control.keyEquivalent = "\r"
            control.keyEquivalentModifierMask = [.command]
            control.toolTip = title + "（⌘↵）"
        }
        body.addSubview(control)
        return control
    }

    private func editor(x: CGFloat, y: CGFloat, w: CGFloat, h: CGFloat,
                        placeholder: String, editable: Bool = true) -> NSTextView {
        let scroll = NSScrollView(frame: NSRect(x: x, y: y, width: w, height: h))
        scroll.hasVerticalScroller = true
        let text = OpenAllTextView(frame: scroll.bounds)
        text.placeholderText = placeholder
        text.font = .monospacedSystemFont(ofSize: 13, weight: .regular)
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 21
        paragraph.maximumLineHeight = 21
        text.defaultParagraphStyle = paragraph
        text.isEditable = editable
        text.isSelectable = true
        text.isVerticallyResizable = true
        text.textContainer?.widthTracksTextView = true
        text.textContainerInset = NSSize(width: 12, height: 10)
        WindowChrome.styleEditor(scroll, text: text)
        scroll.documentView = text
        body.addSubview(scroll)
        return text
    }

    @objc private func selectTab(_ sender: NSButton) {
        guard let next = BackendMode(rawValue: sender.tag) else { return }
        switchMode(next)
        window?.makeFirstResponder(left)
    }

    private func switchMode(_ selected: BackendMode) {
        if left != nil {
            savedInputs[mode] = (left?.string ?? "", right?.string ?? "", manualRule?.stringValue ?? "")
        }
        mode = selected
        rebuild()
        if let saved = savedInputs[selected] {
            left?.string = saved.left
            right?.string = saved.right
            manualRule?.stringValue = saved.rule
            if !saved.left.isEmpty { analyze() }
        }
    }

    private func rebuild() {
        body.subviews.forEach { $0.removeFromSuperview() }
        reportView = nil
        reportSummary = nil
        left = nil; right = nil; result = nil; reveal = nil
        groupField = nil; timeField = nil; manualRule = nil; logs = []; logFields = []
        status.stringValue = ""
        for tab in tabs {
            let selected = tab.tag == mode.rawValue
            WindowChrome.styleToolMode(tab, active: selected)
            tab.setAccessibilityValue(selected ? "已选中" : "未选中")
        }
        switch mode {
        case .config:
            body.addSubview(label("左侧配置", x: 4, y: 438, w: 300, h: 24, size: 13, weight: .medium))
            body.addSubview(label("右侧配置", x: 486, y: 438, w: 300, h: 24, size: 13, weight: .medium))
            left = editor(x: 4, y: 226, w: 466, h: 205, placeholder: "粘贴 JSON、YAML 或 .properties")
            right = editor(x: 486, y: 226, w: 466, h: 205, placeholder: "粘贴另一份配置")
            _ = button("比较配置", x: 4, y: 185, w: 110, action: #selector(analyze), primary: true)
            let checkbox = WindowChrome.checkbox("结果显示敏感值", target: self, action: #selector(analyze))
            checkbox.frame = NSRect(x: 130, y: 189, width: 160, height: 24)
            body.addSubview(checkbox)
            reveal = checkbox
            result = editor(x: 4, y: 4, w: 948, h: 172, placeholder: "差异会显示在这里", editable: false)
        case .explain:
            body.addSubview(label("粘贴 PostgreSQL / MySQL 的 EXPLAIN 输出", x: 4, y: 438,
                                  w: 700, h: 24, size: 13, weight: .medium))
            left = editor(x: 4, y: 230, w: 948, h: 200, placeholder: "支持 PostgreSQL JSON、文本；MySQL JSON、TREE、表格")
            _ = button("分析计划", x: 4, y: 187, w: 110, action: #selector(analyze), primary: true)
            result = editor(x: 4, y: 4, w: 948, h: 175, placeholder: "计划节点会显示在这里", editable: false)
        case .logs:
            body.addSubview(label("粘贴 JSON Lines 或包含 key=value 的日志", x: 4, y: 438,
                                  w: 700, h: 24, size: 13, weight: .medium))
            left = editor(x: 4, y: 264, w: 948, h: 167, placeholder: "每行一条日志，最多解析 10000 行")
            _ = button("1 识别字段", x: 4, y: 220, w: 110, action: #selector(analyze), primary: true)
            body.addSubview(label("2 聚合字段", x: 130, y: 227, w: 92, h: 20, size: 11, color: OpenAllTheme.muted))
            let group = NSPopUpButton(frame: NSRect(x: 222, y: 217, width: 263, height: 32))
            WindowChrome.stylePopUp(group)
            group.target = self; group.action = #selector(renderLogs)
            body.addSubview(group); groupField = group
            body.addSubview(label("时间字段", x: 510, y: 227, w: 80, h: 20, size: 11, color: OpenAllTheme.muted))
            let time = NSPopUpButton(frame: NSRect(x: 586, y: 217, width: 226, height: 32))
            WindowChrome.stylePopUp(time)
            time.target = self; time.action = #selector(renderLogs)
            body.addSubview(time); timeField = time
            let rule = NSTextField(frame: NSRect(x: 4, y: 172, width: 704, height: 30))
            rule.placeholderString = "高级：字段名=正则表达式（可选，取第 1 个捕获组）"
            WindowChrome.styleInput(rule)
            body.addSubview(rule); manualRule = rule
            result = editor(x: 4, y: 4, w: 948, h: 160, placeholder: "先识别字段，再选择聚合字段", editable: false)
        case .sql:
            body.addSubview(label("带占位符的 SQL", x: 4, y: 438, w: 400, h: 24, size: 13, weight: .medium))
            body.addSubview(label("参数日志", x: 486, y: 438, w: 400, h: 24, size: 13, weight: .medium))
            left = editor(x: 4, y: 224, w: 466, h: 207, placeholder: "SELECT * FROM users WHERE id = ?")
            right = editor(x: 486, y: 224, w: 466, h: 207, placeholder: "Parameters: 42(Integer)")
            _ = button("还原 SQL", x: 4, y: 183, w: 110, action: #selector(analyze), primary: true)
            result = editor(x: 4, y: 4, w: 948, h: 170, placeholder: "还原后的语句会显示在这里", editable: false)
        }
        copyResultButton = button("复制结果", x: 844, y: mode == .logs ? 172 : 183, w: 108, action: #selector(copyResult))
        copyResultButton?.isEnabled = false
        for view in body.subviews where view !== result?.enclosingScrollView { view.frame.origin.y += 50 }
        if let output = result?.enclosingScrollView { output.frame.size.height += 40 }
        if let text = left as? OpenAllTextView { text.highlightsJSON = mode == .explain || mode == .logs; text.highlightsConfig = mode == .config; text.highlightsSQL = mode == .sql }
        if let text = right as? OpenAllTextView { text.highlightsConfig = mode == .config }
        if let text = result as? OpenAllTextView { text.highlightsSQL = mode == .sql; text.highlightsConfig = mode == .config }
        let extraResultHeight: CGFloat = mode == .config ? 35 : mode == .logs ? 50 : 47
        if let input = left?.enclosingScrollView { input.frame.origin.y += extraResultHeight; input.frame.size.height -= extraResultHeight }
        if let input = right?.enclosingScrollView { input.frame.origin.y += extraResultHeight; input.frame.size.height -= extraResultHeight }
        for view in body.subviews where view is NSButton || view is NSTextField {
            if view.frame.origin.y < 400 { view.frame.origin.y += extraResultHeight }
        }
        result?.enclosingScrollView?.frame.size.height += extraResultHeight
        if mode == .logs, let output = result?.enclosingScrollView {
            left?.enclosingScrollView?.frame = NSRect(x: 4, y: 356, width: 948, height: 124)
            for view in body.subviews {
                if let button = view as? NSButton, button.action == #selector(analyze) { button.frame.origin = NSPoint(x: 4, y: 312); button.title = "识别字段" }
                if let button = view as? NSButton, button.action == #selector(copyResult) { button.frame.origin = NSPoint(x: 834, y: 270) }
                if let label = view as? NSTextField, label.stringValue == "2 聚合字段" { label.stringValue = "聚合字段"; label.frame = NSRect(x: 4, y: 276, width: 68, height: 22) }
                if let label = view as? NSTextField, label.stringValue == "时间字段" { label.frame = NSRect(x: 410, y: 276, width: 70, height: 22) }
            }
            groupField?.frame = NSRect(x: 78, y: 270, width: 296, height: 32)
            timeField?.frame = NSRect(x: 486, y: 270, width: 226, height: 32)
            manualRule?.frame = NSRect(x: 250, y: 312, width: 702, height: 30)
            manualRule?.placeholderString = "字段名=正则表达式（取第 1 个捕获组，回车应用）"
            manualRule?.target = self
            manualRule?.action = #selector(analyze)
            manualRule?.isHidden = !manualRuleExpanded
            let advanced = button(manualRuleExpanded ? "⌄ 自定义字段" : "› 自定义字段", x: 130, y: 312, w: 110, action: #selector(toggleLogRule))
            WindowChrome.styleOutputAction(advanced)
            output.frame = NSRect(x: 4, y: 4, width: 948, height: 254)
        }
        if mode == .config {
            reveal?.frame.origin.x = 450
            let summary = label("差异结果", x: 136, y: 274, w: 280, h: 24, size: 13, weight: .medium)
            body.addSubview(summary)
            reportSummary = summary
        }
        if mode == .sql, let output = result?.enclosingScrollView {
            let summary = label("还原结果", x: 136, y: output.frame.maxY + 22, w: 400, h: 24, size: 13, weight: .medium)
            body.addSubview(summary)
            reportSummary = summary
        }
        if mode == .config || mode == .sql {
            left?.enclosingScrollView?.frame = NSRect(x: 4, y: 310, width: 466, height: 170)
            right?.enclosingScrollView?.frame = NSRect(x: 486, y: 310, width: 466, height: 170)
            for button in body.subviews.compactMap({ $0 as? NSButton }) {
                if button.action == #selector(analyze), button !== reveal { button.frame.origin.y = 268 }
                if button.action == #selector(copyResult) { button.frame.origin.y = 228; WindowChrome.styleOutputAction(button) }
            }
            reveal?.frame.origin = NSPoint(x: 130, y: 272)
            reportSummary?.frame = NSRect(x: 4, y: 232, width: 600, height: 24)
            result?.enclosingScrollView?.frame = NSRect(x: 4, y: 4, width: 948, height: 216)
        }
        if mode == .config {
            left?.enclosingScrollView?.frame = NSRect(x: 4, y: 340, width: 466, height: 140)
            right?.enclosingScrollView?.frame = NSRect(x: 486, y: 340, width: 466, height: 140)
            for button in body.subviews.compactMap({ $0 as? NSButton }) {
                if button.action == #selector(analyze), button !== reveal { button.frame.origin.y = 298 }
                if button.action == #selector(copyResult) { button.frame.origin.y = 258 }
            }
            reveal?.frame.origin.y = 302
            reportSummary?.frame.origin.y = 262
            result?.enclosingScrollView?.frame.size.height = 246
        }
        if mode == .sql {
            left?.enclosingScrollView?.frame = NSRect(x: 4, y: 370, width: 466, height: 110)
            right?.enclosingScrollView?.frame = NSRect(x: 486, y: 370, width: 466, height: 110)
            for button in body.subviews.compactMap({ $0 as? NSButton }) {
                if button.action == #selector(analyze) { button.frame.origin.y = 328 }
                if button.action == #selector(copyResult) { button.frame.origin.y = 288 }
            }
            reportSummary?.frame.origin.y = 292
            result?.enclosingScrollView?.frame.size.height = 276
        }
        if mode == .explain {
            left?.enclosingScrollView?.frame = NSRect(x: 4, y: 370, width: 948, height: 110)
            for button in body.subviews.compactMap({ $0 as? NSButton }) {
                if button.action == #selector(analyze) { button.frame.origin.y = 328 }
                if button.action == #selector(copyResult) { button.frame.origin.y = 288; WindowChrome.styleOutputAction(button) }
            }
            result?.enclosingScrollView?.frame.size.height = 276
            let summary = label("计划节点", x: 4, y: 292, w: 780, h: 24, size: 13, weight: .medium)
            body.addSubview(summary)
            reportSummary = summary
        }
        if mode == .logs, let output = result?.enclosingScrollView {
            output.frame.size.height = 222
            let summary = label("事件时间线", x: 4, y: 232, w: 720, h: 24, size: 13, weight: .semibold)
            body.addSubview(summary)
            reportSummary = summary
            if let copyResultButton {
                copyResultButton.frame.origin.y = 228
                WindowChrome.styleOutputAction(copyResultButton)
            }
        }
        if mode != .sql, let output = result?.enclosingScrollView {
            let columns: [(String, CGFloat)]
            switch mode {
            case .config: columns = [("变更", 78), ("字段路径", 330), ("原值", 270), ("新值", 270)]
            case .explain: columns = [("计划节点", 170), ("对象 / 索引", 170), ("估算行", 90), ("实际行", 90), ("耗时 ms", 90), ("风险信号", 338)]
            case .logs: columns = [("时间 / 聚合项", 320), ("级别", 96), ("消息", 532)]
            case .sql: columns = []
            }
            let report = AnalysisReportView(frame: output.frame, columns: columns, numericColumns: mode == .explain ? [2, 3, 4] : [])
            output.isHidden = true
            body.addSubview(report)
            reportView = report
        }
    }

    @objc private func toggleLogRule(_ sender: NSButton) {
        manualRuleExpanded.toggle()
        manualRule?.isHidden = !manualRuleExpanded
        sender.title = manualRuleExpanded ? "⌄ 自定义字段" : "› 自定义字段"
        if manualRuleExpanded { window?.makeFirstResponder(manualRule) }
    }

    @objc private func analyze() {
        guard let input = left?.string, let result else { return }
        reportView?.display([])
        reportSummary?.textColor = OpenAllTheme.ink
        reportSummary?.stringValue = mode == .config ? "差异结果" : mode == .explain ? "计划节点" : mode == .logs ? "事件时间线" : "还原结果"
        defer { copyResultButton?.isEnabled = !result.string.isEmpty }
        switch mode {
        case .config:
            guard let other = right?.string else { return }
            do {
                let a = try ConfigDiff.parse(input), b = try ConfigDiff.parse(other)
                let diff = ConfigDiff.compare(a, b, revealSecrets: reveal?.state == .on)
                result.string = diff.text
                let keys = Set(a.keys).union(b.keys).sorted { $0.localizedStandardCompare($1) == .orderedAscending }
                reportView?.display(keys.filter { a[$0] != b[$0] }.map { key in
                    let masked = reveal?.state != .on && key.range(of: #"password|passwd|secret|token|api.?key|credential|authorization|private.?key"#, options: [.regularExpression, .caseInsensitive]) != nil
                    return AnalysisReportView.Row(values: [a[key] == nil ? "＋ 新增" : b[key] == nil ? "− 删除" : "~ 修改", key, a[key].map { (masked ? "••••" : $0.value) + " · " + $0.type } ?? "—", b[key].map { (masked ? "••••" : $0.value) + " · " + $0.type } ?? "—"], tone: a[key] == nil ? "added" : b[key] == nil ? "removed" : "changed")
                }, emptyText: "两份配置相同")
                reportSummary?.stringValue = "差异结果 · \(diff.changed) 项变更"
                status.stringValue = "左侧 \(a.count) 项 · 右侧 \(b.count) 项"
            } catch let issue as BackendIssue {
                result.string = ""; status.stringValue = issue.message
            } catch { result.string = ""; status.stringValue = "配置解析失败" }
        case .explain:
            if let report = ExplainReader.parse(input) {
                result.string = "\(report.engine) · 执行计划\n\n" + report.lines.joined(separator: "\n\n")
                reportView?.display(report.lines.map { line in
                    let parts = line.components(separatedBy: " · ")
                    func metric(_ prefix: String, suffix: String = " 行") -> String {
                        guard let part = parts.first(where: { $0.hasPrefix(prefix) }) else { return "—" }
                        return part.replacingOccurrences(of: prefix, with: "").replacingOccurrences(of: suffix, with: "")
                    }
                    let estimated = metric("估算 ") == "—" ? metric("扫描 ") : metric("估算 ")
                    let actual = metric("实际 ") == "—" ? metric("输出 ") : metric("实际 ")
                    let time = parts.first(where: { $0.hasSuffix(" ms") })?.replacingOccurrences(of: " ms", with: "") ?? "—"
                    var signals: [String] = line.contains("⚠") ? ["全表扫描"] : []
                    if let estimate = Double(estimated), let count = Double(actual), estimate > 0, count > 0 {
                        let ratio = max(estimate, count) / min(estimate, count)
                        if ratio >= 10 { signals.append("估算偏\(estimate > count ? "高" : "低") \(String(format: "%.0f", ratio))×") }
                    }
                    let object = parts.dropFirst().filter { !$0.hasPrefix("估算 ") && !$0.hasPrefix("扫描 ") && !$0.hasPrefix("实际 ") && !$0.hasPrefix("输出 ") && !$0.hasSuffix(" ms") }.joined(separator: " · ")
                    let node = (parts.first ?? line).replacingOccurrences(of: "⚠ ", with: "").replacingOccurrences(of: "• ", with: "")
                    return AnalysisReportView.Row(values: [node, object.isEmpty ? "—" : object, estimated, actual, time,
                                                           signals.isEmpty ? "—" : signals.joined(separator: " · ")], tone: signals.isEmpty ? "normal" : "risk")
                })
                let scanCount = report.lines.filter { $0.contains("⚠") }.count
                reportSummary?.stringValue = scanCount == 0 ? "计划节点 · \(report.lines.count) 项" : "\(scanCount) 个全表扫描节点 · 请结合表规模评估"
                reportSummary?.textColor = scanCount == 0 ? OpenAllTheme.muted : OpenAllTheme.accentText
                status.stringValue = "\(report.engine) · \(report.lines.count) 个节点" +
                    (report.warning.map { " · \($0)" } ?? "")
            } else {
                result.string = ""; status.stringValue = "无法识别执行计划，请粘贴完整的 EXPLAIN 输出"
            }
        case .logs:
            do {
                logs = try LogTimeline.addingField(LogTimeline.parse(input), rule: manualRule?.stringValue ?? "")
            } catch let issue as BackendIssue {
                result.string = ""; status.stringValue = issue.message; return
            } catch {
                result.string = ""; status.stringValue = "手动规则解析失败"; return
            }
            let fields = LogTimeline.fieldCoverage(logs)
            logFields = fields.map(\.name)
            groupField?.removeAllItems(); timeField?.removeAllItems()
            for field in fields {
                let sample = String(field.sample.prefix(28))
                groupField?.addItem(withTitle: "\(field.name) · \(field.count)/\(logs.count) · \(sample)")
                timeField?.addItem(withTitle: field.name)
            }
            if let preferred = logFields.firstIndex(where: { ["requestid", "traceid", "trace.id"].contains($0.lowercased()) }) {
                groupField?.selectItem(at: preferred)
            }
            if let preferred = logFields.firstIndex(where: { ["time", "timestamp", "@timestamp", "时间"].contains($0.lowercased()) }) {
                timeField?.selectItem(at: preferred)
            }
            status.stringValue = "识别 \(logs.count) 行 · \(fields.count) 个字段 · 选择字段后按其值聚合"
            renderLogs()
        case .sql:
            let restored = SQLParameterRestorer.restore(sql: input, parameterText: right?.string ?? "")
            result.string = restored.sql
            status.stringValue = "已替换 \(restored.replaced) 个参数" +
                (restored.unresolved > 0 ? " · \(restored.unresolved) 个占位符未匹配" : "") +
                " · 仅生成调试文本"
        }
    }

    @objc private func renderLogs() {
        guard mode == .logs, let result else { return }
        guard !logFields.isEmpty else {
            result.string = logs.isEmpty ? "没有可解析的日志行" : "未识别出字段；请使用 JSON Lines 或 key=value 日志。"
            return
        }
        let group = logFields[max(0, groupField?.indexOfSelectedItem ?? 0)]
        let time = logFields[max(0, timeField?.indexOfSelectedItem ?? 0)]
        let groups = Dictionary(grouping: logs) { $0.fields[group] ?? "未分组" }
        var reportRows: [AnalysisReportView.Row] = []
        result.string = groups.keys.sorted().map { key in
            let rows = groups[key]!.sorted {
                let a = LogTimeline.timestamp($0.fields[time] ?? "")
                let b = LogTimeline.timestamp($1.fields[time] ?? "")
                if let a, let b, a != b { return a < b }
                return $0.position < $1.position
            }
            reportRows.append(.init(values: ["\(group) · \(key)", "\(rows.count) 条", ""], tone: "group"))
            var previousDate: String?
            for entry in rows {
                let level = entry.fields["level"] ?? entry.fields["severity"] ?? "—"
                let rawTime = entry.fields[time] ?? "—"
                var displayTime = rawTime
                if rawTime.count >= 19, rawTime.contains("T") {
                    let date = String(rawTime.prefix(10))
                    let clock = String(rawTime.dropFirst(11))
                    displayTime = previousDate == date ? "            " + clock : date + "  " + clock
                    previousDate = date
                }
                reportRows.append(.init(values: [displayTime, level, entry.fields["message"] ?? entry.fields["msg"] ?? entry.raw], tone: ["ERROR", "WARN", "FATAL"].contains(level.uppercased()) ? "warning" : "normal"))
            }
            return "\(group)  \(key)  ·  \(rows.count) 条\n" + rows.map { entry in
                let timestamp = entry.fields[time] ?? "—"
                let level = entry.fields["level"] ?? entry.fields["severity"] ?? "—"
                let message = entry.fields["message"] ?? entry.fields["msg"] ?? entry.raw
                return "\(timestamp)   \(level)\n  \(message)"
            }.joined(separator: "\n\n")
        }.joined(separator: "\n\n────────────────────────────────────────\n\n")
        reportView?.display(reportRows)
        reportSummary?.stringValue = "事件时间线 · \(logs.count) 条日志 · \(groups.count) 个分组"
        copyResultButton?.isEnabled = !result.string.isEmpty
    }

    @objc private func copyResult() {
        guard let text = result?.string, !text.isEmpty else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(text, forType: .string)
        status.stringValue = "结果已复制"
    }
}
