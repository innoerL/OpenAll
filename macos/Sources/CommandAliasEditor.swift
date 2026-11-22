import AppKit

final class CommandAliasEditorView: NSView, NSSearchFieldDelegate {
    private let store: CommandAliasStore
    private let commands: [OpenAllCommand]
    private let onChange: () -> Void
    private var selectedIndex = 0
    private var aliasDrafts: [String: String] = [:]
    private var buttons: [NSButton] = []
    private let commandSearch = NSSearchField()
    private let commandScroll = NSScrollView()
    private let commandList = NSView()
    private let detail = NSView()
    private let noMatches = NSTextField(labelWithString: "没有匹配的功能")
    private var commandTitle: NSTextField!
    private var builtInNames: NSTextField!
    private var aliasField: NSTextField!
    private var notice: NSTextField!

    init(frame: NSRect, store: CommandAliasStore, settings: LaunchSettings, onChange: @escaping () -> Void) {
        self.store = store
        commands = CommandCatalog.all(settings: settings)
        self.onChange = onChange
        super.init(frame: frame)
        build()
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    private func label(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 12) -> NSTextField {
        let field = NSTextField(labelWithString: value)
        field.font = .systemFont(ofSize: size)
        field.textColor = OpenAllTheme.ink
        field.frame = NSRect(x: x, y: y, width: width, height: 23)
        return field
    }

    private func build() {
        let heading = label("功能别名", x: 28, y: 455, width: 300, size: 18)
        heading.font = .systemFont(ofSize: 18, weight: .medium)
        addSubview(heading)
        let hint = label("为内置功能添加搜索词；输入别名即可直接找到功能。", x: 28, y: 424, width: 650, size: 11)
        hint.textColor = OpenAllTheme.muted
        addSubview(hint)

        let listCard = NSView(frame: NSRect(x: 28, y: 89, width: 244, height: 316))
        WindowChrome.styleSettingsSection(listCard)
        addSubview(listCard)
        commandSearch.frame = NSRect(x: 6, y: 282, width: 232, height: 30)
        commandSearch.placeholderString = "查找功能或别名"
        commandSearch.font = .systemFont(ofSize: 13)
        commandSearch.isBezeled = false
        commandSearch.drawsBackground = false
        commandSearch.focusRingType = .none
        (commandSearch.cell as? NSSearchFieldCell)?.searchButtonCell = nil
        commandSearch.delegate = self
        let searchBorder = NSView(frame: commandSearch.frame)
        searchBorder.wantsLayer = true
        searchBorder.layer?.backgroundColor = OpenAllTheme.editorCanvas.cgColor
        searchBorder.layer?.borderColor = OpenAllTheme.rule.cgColor
        searchBorder.layer?.borderWidth = 0.5
        searchBorder.layer?.cornerRadius = 6
        commandSearch.frame = searchBorder.bounds.insetBy(dx: 10, dy: 5)
        searchBorder.addSubview(commandSearch)
        listCard.addSubview(searchBorder)
        let scroll = commandScroll
        scroll.frame = NSRect(x: 0, y: 0, width: 244, height: 270)
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        let listHeight = max(scroll.bounds.height, CGFloat(commands.count) * 49)
        let list = commandList
        list.frame = NSRect(x: 0, y: 0, width: scroll.bounds.width - 8, height: listHeight)
        for (index, command) in commands.enumerated() {
            let button = NSButton(frame: NSRect(x: 2, y: listHeight - CGFloat(index + 1) * 49,
                                                width: list.bounds.width - 4, height: 46))
            button.isBordered = false
            button.alignment = .left
            button.wantsLayer = true
            button.layer?.cornerRadius = 8
            button.tag = index
            button.target = self
            button.action = #selector(selectCommand(_:))
            button.setAccessibilityLabel(command.title)
            list.addSubview(button)
            buttons.append(button)
        }
        noMatches.font = .systemFont(ofSize: 13)
        noMatches.textColor = OpenAllTheme.muted
        noMatches.frame = NSRect(x: 8, y: 187, width: 228, height: 30)
        noMatches.alignment = .center
        noMatches.isHidden = true
        listCard.addSubview(noMatches)
        scroll.documentView = list
        scroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, listHeight - scroll.contentSize.height)))
        scroll.reflectScrolledClipView(scroll.contentView)
        listCard.addSubview(scroll)

        detail.frame = NSRect(x: 288, y: 47, width: 392, height: 358)
        WindowChrome.styleSettingsSection(detail)
        addSubview(detail)
        commandTitle = label("", x: 20, y: 324, width: 350, size: 16)
        commandTitle.font = .systemFont(ofSize: 16, weight: .medium)
        detail.addSubview(commandTitle)
        let builtInLabel = label("系统匹配词", x: 20, y: 276, width: 88, size: 12)
        builtInLabel.textColor = OpenAllTheme.ink
        detail.addSubview(builtInLabel)
        builtInNames = NSTextField(wrappingLabelWithString: "")
        builtInNames.font = .systemFont(ofSize: 12)
        builtInNames.textColor = OpenAllTheme.ink
        builtInNames.frame = NSRect(x: 110, y: 251, width: 261, height: 48)
        detail.addSubview(builtInNames)
        let customLabel = label("自定义别名", x: 20, y: 213, width: 88, size: 12)
        customLabel.textColor = OpenAllTheme.ink
        detail.addSubview(customLabel)
        aliasField = NSTextField(frame: NSRect(x: 110, y: 210, width: 261, height: 32))
        aliasField.placeholderString = "输入此功能的其他叫法"
        aliasField.delegate = self
        aliasField.target = self
        aliasField.action = #selector(saveAliases)
        WindowChrome.styleInput(aliasField)
        detail.addSubview(aliasField)
        let format = label("多个别名用逗号分隔。", x: 110, y: 183, width: 260, size: 11)
        format.textColor = OpenAllTheme.muted
        detail.addSubview(format)
        let save = NSButton(title: "保存别名", target: self, action: #selector(saveAliases))
        save.frame = NSRect(x: 110, y: 145, width: 90, height: 32)
        WindowChrome.styleAction(save, primary: true)
        detail.addSubview(save)
        notice = label("", x: 209, y: 149, width: 165, size: 11)
        notice.textColor = OpenAllTheme.muted
        detail.addSubview(notice)
        refreshSelection()
        filterCommands()
    }

    private func refreshSelection() {
        for (index, button) in buttons.enumerated() {
            let command = commands[index]
            let extra = store.names(for: command.id)
            let subtitle = extra.isEmpty ? distinct(command.keywords.filter { $0 != command.title }).prefix(2).joined(separator: " · ") : (extra.first ?? "")
            let selected = index == selectedIndex
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            paragraph.lineSpacing = 3
            let title = NSMutableAttributedString(string: "  \(command.title)\n  \(subtitle)", attributes: [
                .font: NSFont.systemFont(ofSize: 12), .foregroundColor: OpenAllTheme.muted,
                .paragraphStyle: paragraph
            ])
            title.addAttributes([.font: NSFont.systemFont(ofSize: 13, weight: .medium),
                                 .foregroundColor: OpenAllTheme.ink],
                                range: NSRange(location: 0, length: ("  " + command.title).utf16.count))
            button.attributedTitle = title
            button.toolTip = ([command.title] + command.keywords + extra).joined(separator: " · ")
            button.layer?.backgroundColor = selected ? OpenAllTheme.accent.withAlphaComponent(0.13).cgColor : NSColor.clear.cgColor

        }
        let command = commands[selectedIndex]
        commandTitle.stringValue = command.title
        let systemWords = distinct(command.keywords.filter { $0 != command.title })
        builtInNames.stringValue = systemWords.prefix(4).joined(separator: "  ·  ") + (systemWords.count > 4 ? "  …" : "")
        builtInNames.toolTip = systemWords.joined(separator: " · ")
        aliasField.stringValue = aliasDrafts[command.id] ?? store.names(for: command.id).joined(separator: "、")
        if aliasDrafts[command.id] != nil { notice.stringValue = "尚未保存" }
    }

    func controlTextDidChange(_ notification: Notification) {
        if notification.object as? NSTextField === aliasField {
            let id = commands[selectedIndex].id
            let value = aliasField.stringValue
            aliasDrafts[id] = value == store.names(for: id).joined(separator: "、") ? nil : value
            notice.stringValue = aliasDrafts[id] == nil ? "" : "尚未保存"
        } else if notification.object as? NSSearchField === commandSearch {
            filterCommands()
        }
    }

    private func filterCommands() {
        let query = commandSearch.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let matches = commands.indices.filter { index in
            query.isEmpty || ([commands[index].title] + commands[index].keywords + store.names(for: commands[index].id))
                .contains { $0.localizedCaseInsensitiveContains(query) }
        }
        let height = max(commandScroll.contentSize.height, CGFloat(matches.count) * 54)
        commandList.frame.size.height = height
        buttons.forEach { $0.isHidden = true }
        for (position, index) in matches.enumerated() {
            buttons[index].isHidden = false
            buttons[index].frame = NSRect(x: 2, y: height - CGFloat(position + 1) * 54, width: 232, height: 50)
        }
        noMatches.isHidden = !matches.isEmpty
        commandScroll.isHidden = matches.isEmpty
        detail.isHidden = matches.isEmpty
        if let first = matches.first, !matches.contains(selectedIndex) {
            selectedIndex = first
            notice.stringValue = ""
            refreshSelection()
        }
        commandScroll.contentView.scroll(to: NSPoint(x: 0, y: max(0, height - commandScroll.contentSize.height)))
        commandScroll.reflectScrolledClipView(commandScroll.contentView)
    }

    func verifyFilterForDesign() -> Bool {
        guard DesignPreview.enabled else { return false }
        let originalIndex = selectedIndex
        let original = aliasField.stringValue
        let sample = "测试草稿-仅在当前页"
        aliasField.stringValue = sample
        let change = Notification(name: NSControl.textDidChangeNotification, object: aliasField)
        controlTextDidChange(change)
        commandSearch.stringValue = "JSON"
        filterCommands()
        let filtered = buttons.filter { !$0.isHidden }
        let matched = !filtered.isEmpty && filtered.allSatisfy { commands[$0.tag].title.contains("JSON") || commands[$0.tag].keywords.contains { $0.localizedCaseInsensitiveContains("JSON") } }
        commandSearch.stringValue = "无此功能-zero-match"
        filterCommands()
        let empty = buttons.allSatisfy(\.isHidden) && !noMatches.isHidden
        commandSearch.stringValue = ""
        filterCommands()
        selectCommand(buttons[originalIndex])
        let restored = aliasField.stringValue == sample && notice.stringValue == "尚未保存"
        aliasField.stringValue = original
        controlTextDidChange(change)
        return matched && empty && restored && notice.stringValue.isEmpty && buttons.allSatisfy { !$0.isHidden }
    }

    private func distinct(_ names: [String]) -> [String] {
        var seen = Set<String>()
        return names.filter { seen.insert($0.localizedLowercase).inserted }
    }

    @objc private func selectCommand(_ sender: NSButton) {
        selectedIndex = sender.tag
        notice.stringValue = ""
        refreshSelection()
    }

    @objc private func saveAliases() {
        let command = commands[selectedIndex]
        let separators = CharacterSet(charactersIn: ",，、;；\n")
        var unique = Set<String>()
        let aliases = aliasField.stringValue.components(separatedBy: separators)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }
            .filter { !$0.isEmpty && unique.insert($0.localizedLowercase).inserted }
        guard aliases.count <= 12 else { notice.stringValue = "最多添加 12 个别名"; return }
        for name in aliases {
            if let conflict = store.conflict(for: name, excluding: command.id, commands: commands) {
                notice.stringValue = "“\(name)”已用于\(conflict)"
                return
            }
        }
        store.update(id: command.id, names: aliases)
        aliasDrafts.removeValue(forKey: command.id)
        notice.stringValue = "已保存，搜索立即生效"
        refreshSelection()
        onChange()
    }
}
