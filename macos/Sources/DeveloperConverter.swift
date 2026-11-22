import AppKit

struct ConversionRow {
    let title: String
    let value: String
}

enum ConversionMode: Int, CaseIterable {
    case duration, cron, ascii

    var title: String {
        switch self {
        case .duration: return "时间单位"
        case .cron: return "Cron 表达式"
        case .ascii: return "ASCII 码表"
        }
    }
}

enum DeveloperConversion {
    static let durationUnits: [(name: String, symbol: String, seconds: Double)] = [
        ("年 · 365 天", "yr", 31_536_000), ("月 · 30 天", "mo", 2_592_000),
        ("周", "week", 604_800), ("天", "d", 86_400),
        ("小时", "h", 3_600), ("分钟", "min", 60),
        ("秒", "s", 1), ("毫秒", "ms", 0.001),
        ("微秒", "μs", 0.000_001), ("纳秒", "ns", 0.000_000_001)]

    static func durationRows(value: Double, source: Int) -> [ConversionRow] {
        guard value.isFinite, durationUnits.indices.contains(source) else { return [] }
        let seconds = value * durationUnits[source].seconds
        return durationUnits.map { unit in
            let result = seconds / unit.seconds
            let display: String
            if !result.isFinite { display = "超出范围" }
            else if abs(result) >= 1, abs(result) < 1_000_000_000_000_000,
                    abs(result - result.rounded()) <= abs(result) * 1e-12 {
                display = String(format: "%.0f", result)
            } else { display = String(format: "%.9g", result) }
            return ConversionRow(title: "\(unit.name) (\(unit.symbol))", value: display)
        }
    }

    static let controlNames = ["NUL", "SOH", "STX", "ETX", "EOT", "ENQ", "ACK", "BEL",
                               "BS", "TAB", "LF", "VT", "FF", "CR", "SO", "SI",
                               "DLE", "DC1", "DC2", "DC3", "DC4", "NAK", "SYN", "ETB",
                               "CAN", "EM", "SUB", "ESC", "FS", "GS", "RS", "US"]

    static func asciiRows(query: String) -> [(number: Int, hex: String, character: String, name: String)] {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        return (0...127).compactMap { number in
            let character = number < 32 ? controlNames[number] : number == 32 ? "空格" :
                number == 127 ? "DEL" : String(UnicodeScalar(number)!)
            let name = number < 32 || number == 127 ? "控制字符" :
                number == 32 ? "空格" : "可打印字符"
            let hex = String(format: "0x%02X", number)
            guard term.isEmpty || character.lowercased().contains(term) ||
                    String(number).contains(term) || hex.lowercased().contains(term) ||
                    name.contains(term) else { return nil }
            return (number, hex, character, name)
        }
    }
}

final class DeveloperConverterWindow: NSObject, NSTextFieldDelegate {
    private var window: NSWindow?
    private var root: NSView!
    private var content: NSView!
    private var selectedMode: ConversionMode = .duration
    private var tabs: [NSButton] = []
    private var durationInput: NSTextField?
    private var durationUnit: NSPopUpButton?
    private var durationResults: NSView?
    private weak var durationSummary: NSTextField?
    private var durationRows: [ConversionRow] = []
    private var cronInput: NSTextField?
    private var cronResults: NSView?
    private var asciiSearch: NSTextField?
    private var asciiScroll: NSScrollView?
    private var cronDescription: NSTextField?
    private var modeHint: NSTextField?
    private var asciiCategory = 0
    private var asciiStatus: NSTextField?
    private let cronSamples = ["*/15 9-18 * * 1-5", "0 9 * * 1-5", "30 8 1 * *"]

    func show(_ initial: String = "") {
        if window == nil { build() }
        if !initial.isEmpty {
            if CronExpression.parse(initial) != nil { selectedMode = .cron }
            else if Double(initial) != nil { selectedMode = .duration }
            rebuildContent()
            if selectedMode == .cron { cronInput?.stringValue = initial; refreshCron() }
            else if selectedMode == .duration { durationInput?.stringValue = initial; refreshDuration() }
        }
        if DesignPreview.enabled { DesignPreview.lastWindow = window; return }
        window?.makeKeyAndOrderFront(nil)
        WindowChrome.activate()
        window?.makeFirstResponder(selectedMode == .cron ? cronInput : selectedMode == .ascii ? asciiSearch : durationInput)
    }

    func showDesignSample(_ mode: ConversionMode) {
        guard DesignPreview.enabled else { return }
        if window == nil { build() }
        selectedMode = mode
        rebuildContent()
        if mode == .duration {
            precondition(durationSummary?.stringValue == "1 秒 = 1000 毫秒")
            durationUnit?.selectItem(at: 7)
            refreshDuration()
            precondition(durationSummary?.stringValue == "1 毫秒 = 0.001 秒")
            durationInput?.stringValue = "无效"
            refreshDuration()
            precondition(durationRows.isEmpty && durationSummary?.stringValue == "换算结果")
            durationInput?.stringValue = "1"
            durationUnit?.selectItem(at: 6)
            refreshDuration()
        } else if mode == .ascii {
            asciiSearch?.stringValue = "a"
            refreshASCII()
            precondition(asciiStatus?.stringValue == "a  ·  十进制 97  ·  0x61")
            asciiSearch?.stringValue = "没有这个字符"
            refreshASCII()
            precondition(asciiStatus?.stringValue == "0 个字符")
            asciiSearch?.stringValue = ""
            refreshASCII()
        }
        DesignPreview.lastWindow = window
    }

    private func label(_ value: String, frame: NSRect, size: CGFloat = 12,
                       color: NSColor? = nil, weight: NSFont.Weight = .regular) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.frame = frame
        field.font = .systemFont(ofSize: max(12, size), weight: weight)
        field.textColor = color ?? OpenAllTheme.ink
        return field
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 980, height: 610),
                             styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
        WindowChrome.apply(panel, title: "开发者转换")
        panel.isReleasedWhenClosed = false
        panel.center()
        let surface = NSView(frame: panel.contentView!.bounds)
        surface.wantsLayer = true
        surface.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        panel.contentView = surface
        root = surface
        
        
        for mode in ConversionMode.allCases {
            let button = NSButton(title: mode.title, target: self, action: #selector(changeMode(_:)))
            button.tag = mode.rawValue
            button.frame = NSRect(x: 26 + mode.rawValue * 122, y: 518, width: 118, height: 32)
            surface.addSubview(button)
            tabs.append(button)
        }
        content = NSView(frame: NSRect(x: 26, y: 84, width: 928, height: 420))
        surface.addSubview(content)
        let hint = label("", frame: NSRect(x: 28, y: 23, width: 700, height: 20), size: 12, color: OpenAllTheme.muted)
        surface.addSubview(hint)
        modeHint = hint
        WindowChrome.installControls(on: panel)
        window = panel
        rebuildContent()
    }

    @objc private func changeMode(_ sender: NSButton) {
        selectedMode = ConversionMode(rawValue: sender.tag) ?? .duration
        rebuildContent()
        window?.makeFirstResponder(selectedMode == .cron ? cronInput : selectedMode == .ascii ? asciiSearch : durationInput)
    }

    private func rebuildContent() {
        guard content != nil else { return }
        for button in tabs {
            let selected = button.tag == selectedMode.rawValue
            WindowChrome.styleToolMode(button, active: selected)
            button.setAccessibilityValue(selected ? "已选中" : "未选中")
        }
        content.subviews.forEach { $0.removeFromSuperview() }
        durationInput = nil
        durationUnit = nil
        durationResults = nil
        cronInput = nil
        cronResults = nil
        asciiSearch = nil
        asciiScroll = nil
        asciiStatus = nil
        switch selectedMode {
        case .duration:
            modeHint?.stringValue = "点击行末图标可复制完整精度的数值"
            buildDuration()
        case .cron:
            modeHint?.stringValue = "执行时间按北京时间（UTC+8）排列"
            buildCron()
        case .ascii:
            modeHint?.stringValue = "搜索支持字符、十进制数和 0x 开头的十六进制数"
            buildASCII()
        }
    }

    private func buildDuration() {
        content.addSubview(label("输入时长", frame: NSRect(x: 12, y: 380, width: 280, height: 22), size: 14, weight: .medium))
        let input = NSTextField(frame: NSRect(x: 12, y: 335, width: 290, height: 36))
        input.stringValue = "1"
        input.placeholderString = "例如 1.5"
        WindowChrome.styleInput(input)
        input.delegate = self
        content.addSubview(input)
        durationInput = input
        content.addSubview(label("单位", frame: NSRect(x: 12, y: 296, width: 280, height: 22), size: 13, color: OpenAllTheme.muted))
        let units = NSPopUpButton(frame: NSRect(x: 12, y: 255, width: 290, height: 35))
        for unit in DeveloperConversion.durationUnits { units.addItem(withTitle: "\(unit.name) (\(unit.symbol))") }
        units.selectItem(at: 6)
        units.target = self
        units.action = #selector(refreshDuration)
        WindowChrome.stylePopUp(units)
        content.addSubview(units)
        durationUnit = units
        let note = label("数值或单位改变后自动换算。\n年按 365 天、月按 30 天计算。", frame: NSRect(x: 12, y: 180, width: 290, height: 54), size: 13, color: OpenAllTheme.muted)
        note.cell?.wraps = true
        note.maximumNumberOfLines = 2
        content.addSubview(note)
        let summary = label("换算结果", frame: NSRect(x: 328, y: 380, width: 562, height: 24), size: 16, weight: .semibold)
        summary.lineBreakMode = .byTruncatingTail
        content.addSubview(summary)
        durationSummary = summary
        let results = NSView(frame: NSRect(x: 316, y: 0, width: 580, height: 372))
        content.addSubview(results)
        durationResults = results
        refreshDuration()
    }

    @objc private func refreshDuration() {
        guard let input = durationInput, let units = durationUnit, let holder = durationResults else { return }
        holder.subviews.forEach { $0.removeFromSuperview() }
        durationRows = []
        durationSummary?.stringValue = "换算结果"
        let raw = input.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard let number = Double(raw), number.isFinite else {
            holder.addSubview(label("请输入有效数字，结果会实时更新。", frame: NSRect(x: 12, y: 236, width: 600, height: 25),
                                    size: 12, color: OpenAllTheme.muted))
            return
        }
        durationRows = DeveloperConversion.durationRows(value: number, source: units.indexOfSelectedItem)
        let source = units.indexOfSelectedItem
        let target = source == 6 ? 7 : 6
        let sourceUnit = DeveloperConversion.durationUnits[source]
        let targetUnit = DeveloperConversion.durationUnits[target]
        let targetValue = durationRows[target].value
        if let converted = Double(targetValue) {
            let calculated = number * sourceUnit.seconds / targetUnit.seconds
            let rounding = max(abs(calculated), abs(converted)) * (Double.ulpOfOne * 4)
            let operation = abs(calculated - converted) <= rounding && (converted != 0 || number == 0) ? "=" : "≈"
            let name = sourceUnit.name.components(separatedBy: " · ")[0]
            durationSummary?.stringValue = "\(raw) \(name) \(operation) \(targetValue) \(targetUnit.name)"
        } else { durationSummary?.stringValue = "换算超出范围" }
        let order = Array(0..<10)
        for (position, index) in order.enumerated() {
            let row = durationRows[index]
            let card = NSView(frame: NSRect(x: 0, y: CGFloat(333 - position * 37), width: holder.bounds.width, height: 35))
            card.wantsLayer = true
            card.layer?.backgroundColor = (index == units.indexOfSelectedItem ? OpenAllTheme.accent.withAlphaComponent(0.10) : NSColor.clear).cgColor
            let rule = NSView(frame: NSRect(x: 12, y: 0, width: card.bounds.width - 24, height: 0.5))
            rule.wantsLayer = true
            rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
            card.addSubview(rule)
            // 屏幕显示保留六位有效数字；复制仍使用完整换算值。
            var display = Double(row.value).map { String(format: "%.6g", $0) } ?? row.value
            let parts = display.lowercased().components(separatedBy: "e")
            if parts.count == 2, let exponent = Int(parts[1]) {
                let superscript: [Character: String] = ["-":"⁻","0":"⁰","1":"¹","2":"²","3":"³","4":"⁴","5":"⁵","6":"⁶","7":"⁷","8":"⁸","9":"⁹"]
                display = parts[0] + " × 10" + String(exponent).map { superscript[$0] ?? String($0) }.joined()
            }
            let number = label(display, frame: NSRect(x: 146, y: 6, width: card.bounds.width - 214, height: 24), size: 15)
            number.toolTip = row.value
            number.alignment = .right
            number.font = .monospacedDigitSystemFont(ofSize: 15, weight: index == units.indexOfSelectedItem ? .semibold : .regular)
            card.addSubview(number)
            card.addSubview(label(row.title, frame: NSRect(x: 14, y: 8, width: 132, height: 20),
                                  size: 11, color: OpenAllTheme.muted))
            let copy = NSButton(title: "复制", target: self, action: #selector(copyDuration(_:)))
            copy.tag = index
            copy.frame = NSRect(x: card.bounds.width - 52, y: 4, width: 40, height: 27)
            WindowChrome.styleOutputAction(copy)
            copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "复制完整数值")
            copy.imagePosition = .imageOnly
            copy.contentTintColor = OpenAllTheme.muted
            copy.toolTip = "复制完整数值"
            card.addSubview(copy)
            holder.addSubview(card)
        }
    }

    @objc private func copyDuration(_ sender: NSButton) {
        guard durationRows.indices.contains(sender.tag) else { return }
        copy(durationRows[sender.tag].value)
    }

    private func buildCron() {
        content.addSubview(label("标准五字段表达式", frame: NSRect(x: 12, y: 380, width: 300, height: 22),
                                 size: 14, weight: .medium))

        let input = NSTextField(frame: NSRect(x: 12, y: 337, width: 630, height: 35))
        input.stringValue = cronSamples[0]
        input.placeholderString = "例如 */15 9-18 * * 1-5"
        WindowChrome.styleInput(input)
        input.delegate = self
        content.addSubview(input)
        cronInput = input
        content.addSubview(label("按中国时间 UTC+8 预览", frame: NSRect(x: 660, y: 344, width: 258, height: 20),
                                 size: 11, color: OpenAllTheme.muted))
        for index in cronSamples.indices {
            let button = NSButton(title: ["工作日 · 每 15 分钟", "工作日 · 09:00", "每天 · 08:30"][index], target: self, action: #selector(useCronSample(_:)))
            button.tag = index
            button.frame = NSRect(x: 12 + index * 180, y: 297, width: 168, height: 26)
            WindowChrome.styleOutputAction(button)
            button.alignment = .left
            content.addSubview(button)
        }
        let description = label("", frame: NSRect(x: 12, y: 256, width: 910, height: 26), size: 14, color: OpenAllTheme.accentText)
        description.lineBreakMode = .byTruncatingTail
        content.addSubview(description)
        cronDescription = description
        let results = NSView(frame: NSRect(x: 0, y: 0, width: 928, height: 248))
        content.addSubview(results)
        cronResults = results
        refreshCron()
    }

    @objc private func useCronSample(_ sender: NSButton) {
        guard cronSamples.indices.contains(sender.tag) else { return }
        cronInput?.stringValue = cronSamples[sender.tag]
        refreshCron()
    }

    private func refreshCron() {
        guard let holder = cronResults, let input = cronInput else { return }
        holder.subviews.forEach { $0.removeFromSuperview() }
        cronDescription?.stringValue = ""
        guard let expression = CronExpression.parse(input.stringValue) else {
            holder.addSubview(label("表达式应为 5 个字段：分 时 日 月 周，例如 */15 9-18 * * 1-5。",
                                    frame: NSRect(x: 12, y: 202, width: 900, height: 25),
                                    size: 12, color: .systemOrange))
            return
        }
        cronDescription?.stringValue = expression.summary
        cronDescription?.toolTip = expression.summary
        let times = expression.nextOccurrences(after: Date())
        holder.addSubview(label("未来执行时间", frame: NSRect(x: 12, y: 214, width: 300, height: 24),
                                size: 14, weight: .medium))
        guard !times.isEmpty else {
            holder.addSubview(label("未来五年内没有匹配的时间。", frame: NSRect(x: 12, y: 176, width: 500, height: 24),
                                    size: 12, color: OpenAllTheme.muted))
            return
        }
        let parts = input.stringValue.split(whereSeparator: \.isWhitespace).map(String.init)
        holder.addSubview(label("字段解析", frame: NSRect(x: 574, y: 214, width: 220, height: 24), size: 13, color: OpenAllTheme.muted, weight: .medium))
        for (index, name) in ["分钟", "小时", "日期", "月份", "星期"].enumerated() where index < parts.count {
            holder.addSubview(label(name, frame: NSRect(x: 574, y: CGFloat(174 - index * 39), width: 76, height: 22), size: 13, color: OpenAllTheme.muted))
            let value = label(parts[index] == "*" ? "任意" : parts[index], frame: NSRect(x: 668, y: CGFloat(174 - index * 39), width: 122, height: 22), size: 14)
            value.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
            holder.addSubview(value)
        }
        let zone = TimeZone(identifier: "Asia/Shanghai")!
        for (index, date) in times.enumerated() {
            let row = NSView(frame: NSRect(x: 12, y: CGFloat(166 - index * 39), width: 530, height: 34))
            row.wantsLayer = true
            row.layer?.backgroundColor = index == 0 ? OpenAllTheme.accent.withAlphaComponent(0.08).cgColor : NSColor.clear.cgColor
            row.addSubview(label(index == 0 ? "下一次" : "\(index + 1)", frame: NSRect(x: 14, y: 8, width: 64, height: 19),
                                 size: 12, color: index == 0 ? OpenAllTheme.accentText : OpenAllTheme.muted))
            var calendar = Calendar(identifier: .gregorian)
            calendar.timeZone = zone
            let weekdays = ["", "星期日", "星期一", "星期二", "星期三", "星期四", "星期五", "星期六"]
            let weekday = weekdays[calendar.component(.weekday, from: date)]
            let timestamp = label("\(TimeResults.format(date, "yyyy-MM-dd HH:mm:ss", zone)) \(weekday)",
                                  frame: NSRect(x: 100, y: 6, width: 414, height: 23), size: 13)
            timestamp.font = .monospacedDigitSystemFont(ofSize: 13, weight: index == 0 ? .semibold : .regular)
            timestamp.isSelectable = true
            row.addSubview(timestamp)
            holder.addSubview(row)
        }
    }

    private func buildASCII() {
        content.addSubview(label("ASCII 码表 · 0–127", frame: NSRect(x: 12, y: 380, width: 340, height: 22),
                                 size: 14, weight: .medium))
        let search = NSTextField(frame: NSRect(x: 12, y: 339, width: 380, height: 34))
        search.placeholderString = "搜索字符、十进制码或十六进制码"
        WindowChrome.styleInput(search)
        search.delegate = self
        content.addSubview(search)
        asciiSearch = search
        let filter = NSPopUpButton(frame: NSRect(x: 420, y: 339, width: 170, height: 34))
        filter.addItems(withTitles: ["可打印字符", "控制字符", "全部字符"])
        filter.selectItem(at: asciiCategory)
        WindowChrome.stylePopUp(filter)
        filter.target = self
        filter.action = #selector(changeASCIICategory(_:))
        content.addSubview(filter)
        let status = label("", frame: NSRect(x: 614, y: 346, width: 300, height: 20),
                           size: 11, color: OpenAllTheme.muted)
        content.addSubview(status)
        status.alignment = .right
        status.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        asciiStatus = status
        let header = NSView(frame: NSRect(x: 12, y: 301, width: 904, height: 30))
        WindowChrome.styleCard(header, radius: 6)
        for (title, x, width) in [("十进制", 15, 100), ("十六进制", 125, 120),
                                  ("字符", 265, 120), ("说明", 425, 300)] {
            header.addSubview(label(title, frame: NSRect(x: x, y: 5, width: width, height: 20),
                                    size: 11, color: OpenAllTheme.muted, weight: .medium))
        }
        content.addSubview(header)
        let scroll = NSScrollView(frame: NSRect(x: 12, y: 8, width: 904, height: 283))
        scroll.hasVerticalScroller = true
        scroll.drawsBackground = false
        content.addSubview(scroll)
        asciiScroll = scroll
        refreshASCII()
    }

    @objc private func changeASCIICategory(_ sender: NSPopUpButton) {
        asciiCategory = sender.indexOfSelectedItem
        refreshASCII()
    }

    private func refreshASCII() {
        guard let search = asciiSearch, let scroll = asciiScroll else { return }
        let rows = DeveloperConversion.asciiRows(query: search.stringValue).filter {
            !search.stringValue.isEmpty || asciiCategory == 2 || (asciiCategory == 0 ? (32..<127).contains($0.number) : $0.number < 32 || $0.number == 127)
        }
        let term = search.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let match = rows.first(where: { String($0.number) == term || $0.hex.lowercased() == term.lowercased() })
            ?? rows.first(where: { $0.character == term || (term.count > 1 && $0.character.lowercased() == term.lowercased()) })
        if let match {
            asciiStatus?.stringValue = "\(match.character)  ·  十进制 \(match.number)  ·  \(match.hex)"
            asciiStatus?.textColor = OpenAllTheme.ink
            asciiStatus?.font = .monospacedDigitSystemFont(ofSize: 14, weight: .semibold)
        } else {
            asciiStatus?.stringValue = "\(rows.count) 个字符"
            asciiStatus?.textColor = OpenAllTheme.muted
            asciiStatus?.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        }
        let height = max(CGFloat(283), CGFloat(rows.count * 29 + 4))
        let document = NSView(frame: NSRect(x: 0, y: 0, width: 886, height: height))
        if rows.isEmpty {
            let empty = label("没有匹配的字符，可试试 A、65 或 0x41",
                              frame: NSRect(x: 12, y: height / 2, width: 862, height: 24), size: 13, color: OpenAllTheme.muted)
            empty.alignment = .center
            document.addSubview(empty)
        }
        for (index, item) in rows.enumerated() {
            let y = height - CGFloat((index + 1) * 29)
            let row = NSView(frame: NSRect(x: 0, y: y, width: 886, height: 28))
            if index.isMultiple(of: 2) {
                row.wantsLayer = true
                row.layer?.backgroundColor = OpenAllTheme.surface.withAlphaComponent(0.35).cgColor
            }
            for (value, x, width) in [(String(item.number), 16, 100), (item.hex, 126, 120),
                                      (item.character, 266, 120), (asciiDescription(item.number), 426, 300)] {
                let field = label(value, frame: NSRect(x: x, y: 4, width: width, height: 20), size: 12)
                if x < 426 { field.font = .monospacedSystemFont(ofSize: 12, weight: .regular) }
                field.isSelectable = true
                row.addSubview(field)
            }
            let copy = NSButton(title: "复制", target: self, action: #selector(copyASCII(_:)))
            copy.tag = item.number
            copy.toolTip = "复制字符：\(item.character)"
            copy.frame = NSRect(x: 800, y: 2, width: 84, height: 25)
            WindowChrome.styleOutputAction(copy)
            copy.image = NSImage(systemSymbolName: "doc.on.doc", accessibilityDescription: "复制字符")
            copy.imagePosition = .imageOnly
            copy.contentTintColor = OpenAllTheme.muted
            row.addSubview(copy)
            document.addSubview(row)
        }
        scroll.documentView = document
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, height - scroll.contentSize.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func asciiDescription(_ number: Int) -> String {
        let punctuation: [Int: String] = [32: "空格", 33: "感叹号", 34: "双引号", 35: "井号", 36: "美元符号", 37: "百分号", 38: "与号", 39: "单引号", 40: "左圆括号", 41: "右圆括号", 42: "星号", 43: "加号", 44: "逗号", 45: "连字符", 46: "句点", 47: "斜杠", 58: "冒号", 59: "分号", 60: "小于号", 61: "等号", 62: "大于号", 63: "问号", 64: "At 符号", 91: "左方括号", 92: "反斜杠", 93: "右方括号", 94: "脱字符", 95: "下划线", 96: "反引号", 123: "左花括号", 124: "竖线", 125: "右花括号", 126: "波浪号"]
        if let name = punctuation[number] { return name }
        if (48...57).contains(number) { return "数字" }
        if (65...90).contains(number) { return "大写字母" }
        if (97...122).contains(number) { return "小写字母" }
        return "控制字符"
    }

    @objc private func copyASCII(_ sender: NSButton) {
        guard let scalar = UnicodeScalar(sender.tag) else { return }
        copy(String(scalar))
        sender.title = "已复制"
        sender.imagePosition = .noImage
        DispatchQueue.main.asyncAfter(deadline: .now() + 1.2) { [weak sender] in sender?.title = "复制"; sender?.imagePosition = .imageOnly }
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let sender = notification.object as? NSTextField else { return }
        if sender === durationInput { refreshDuration() }
        else if sender === cronInput { refreshCron() }
        else if sender === asciiSearch { refreshASCII() }
    }

    private func copy(_ value: String) {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
    }
}
