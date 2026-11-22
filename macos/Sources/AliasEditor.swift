import AppKit

final class AliasEditorView: NSView, NSTextFieldDelegate {
    private let store: AliasStore
    private let onChange: () -> Void
    private let list = NSView()
    private let scroll = NSScrollView()
    private let notice = NSTextField(labelWithString: "")
    private let example = NSTextField(labelWithString: "")
    private let countLabel = NSTextField(labelWithString: "")
    private var fields: [NSTextField] = []
    private var saveButton: NSButton!
    private var deleteButton: NSButton!
    private var selection: Int?

    init(frame: NSRect, store: AliasStore, onChange: @escaping () -> Void) {
        self.store = store
        self.onChange = onChange
        selection = store.items.isEmpty ? nil : 0
        super.init(frame: frame)
        build()
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    func verifyScrollRetentionForDesign() -> Bool {
        guard DesignPreview.enabled else { return false }
        guard list.bounds.height > scroll.contentSize.height + 1,
              let last = list.subviews.compactMap({ $0 as? NSButton }).last else { return false }
        scroll.contentView.scroll(to: .zero)
        scroll.reflectScrolledClipView(scroll.contentView)
        last.performClick(nil)
        return scroll.contentView.bounds.origin.y < 1 && selection == last.tag
    }

    private func label(_ title: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 13) {
        let text = NSTextField(labelWithString: title)
        text.font = .systemFont(ofSize: size, weight: size == 12 ? .regular : .medium)
        text.textColor = size == 12 ? OpenAllTheme.muted : OpenAllTheme.ink
        text.frame = NSRect(x: x, y: y, width: width, height: 20)
        addSubview(text)
    }

    private func input(_ placeholder: String, y: CGFloat, multiline: Bool = false) {
        let field = NSTextField(frame: NSRect(x: 236, y: y, width: 442, height: multiline ? 70 : 34))
        field.placeholderString = placeholder
        field.font = .systemFont(ofSize: 12)
        WindowChrome.styleInput(field)
        if multiline {
            field.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
            field.toolTip = "只接受 http 或 https；{query} 代表搜索词"
            field.cell?.usesSingleLineMode = false
            field.cell?.wraps = true
            field.cell?.isScrollable = false
        }
        field.delegate = self
        addSubview(field)
        fields.append(field)
    }

    private func build() {
        label("网址别名", x: 28, y: 472, width: 220, size: 20)
        label("输入别名和关键词，直接打开对应网站。", x: 28, y: 440, width: 600, size: 12)
        let left = NSView(frame: NSRect(x: 18, y: 82, width: 191, height: 340))
        let right = NSView(frame: NSRect(x: 222, y: 82, width: 468, height: 340))
        WindowChrome.styleSettingsSection(left)
        WindowChrome.styleSettingsSection(right)
        left.layer?.backgroundColor = NSColor.clear.cgColor
        right.layer?.backgroundColor = NSColor.clear.cgColor
        let separator = NSView(frame: NSRect(x: 215, y: 90, width: 1, height: 326))
        separator.wantsLayer = true
        separator.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        addSubview(separator)
        addSubview(left)
        addSubview(right)
        label("网站", x: 36, y: 393, width: 150)
        countLabel.font = .monospacedDigitSystemFont(ofSize: 12, weight: .regular)
        countLabel.textColor = OpenAllTheme.muted
        countLabel.frame = NSRect(x: 111, y: 393, width: 80, height: 20)
        countLabel.alignment = .right
        addSubview(countLabel)
        scroll.frame = NSRect(x: 29, y: 140, width: 169, height: 240)
        scroll.hasVerticalScroller = true
        scroll.scrollerStyle = .overlay
        scroll.autohidesScrollers = true
        scroll.drawsBackground = false
        scroll.borderType = .noBorder
        scroll.documentView = list
        addSubview(scroll)
        let add = NSButton(title: "＋  新增网址", target: self, action: #selector(newAlias))
        add.frame = NSRect(x: 35, y: 101, width: 156, height: 32)
        WindowChrome.styleAction(add)
        addSubview(add)
        label("显示名称", x: 236, y: 393, width: 180)
        input("例如 Google", y: 354)
        label("别名 · 最多三个，用逗号分隔", x: 236, y: 310, width: 350)
        input("例如 google, gg", y: 270)
        label("网址模板 · {query} 代表搜索词", x: 236, y: 229, width: 350)
        input("https://example.com/search?q={query}", y: 155, multiline: true)
        example.frame = NSRect(x: 236, y: 132, width: 442, height: 20)
        example.font = .systemFont(ofSize: 12)
        example.textColor = OpenAllTheme.muted
        example.lineBreakMode = .byTruncatingTail
        addSubview(example)
        saveButton = NSButton(title: "保存更改", target: self, action: #selector(saveAlias))
        saveButton.frame = NSRect(x: 236, y: 86, width: 104, height: 30)
        WindowChrome.styleAction(saveButton, primary: true)
        addSubview(saveButton)
        deleteButton = NSButton(title: "删除", target: self, action: #selector(deleteAlias))
        deleteButton.frame = NSRect(x: 608, y: 86, width: 70, height: 30)
        WindowChrome.styleOutputAction(deleteButton)
        addSubview(deleteButton)
        notice.font = .systemFont(ofSize: 12)
        notice.textColor = OpenAllTheme.muted
        notice.frame = NSRect(x: 351, y: 89, width: 245, height: 20)
        addSubview(notice)
        rebuildList(resetScroll: true)
        fillSelection()
    }

    private func rebuildList(resetScroll: Bool = false) {
        let previousOrigin = scroll.contentView.bounds.origin
        countLabel.stringValue = "\(store.items.count) 个网站"
        list.subviews.forEach { $0.removeFromSuperview() }
        let height = max(CGFloat(store.items.count) * 40, scroll.contentSize.height)
        list.frame = NSRect(x: 0, y: 0, width: scroll.contentSize.width, height: height)
        for (index, alias) in store.items.enumerated() {
            let button = NSButton(title: alias.title, target: self, action: #selector(selectAlias(_:)))
            button.frame = NSRect(x: 2, y: height - CGFloat(index + 1) * 40, width: list.bounds.width - 4, height: 38)
            button.tag = index
            button.alignment = .left
            button.toolTip = alias.allNames.joined(separator: " · ")
            button.isBordered = false
            button.wantsLayer = true
            button.layer?.cornerRadius = 8
            button.layer?.backgroundColor = selection == index ? OpenAllTheme.raised.cgColor : NSColor.clear.cgColor
            let paragraph = NSMutableParagraphStyle()
            paragraph.lineBreakMode = .byTruncatingTail
            paragraph.lineSpacing = 0
            let text = NSMutableAttributedString(string: "  " + alias.title + "\n  " + (alias.allNames.first ?? alias.title),
                attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: OpenAllTheme.muted, .paragraphStyle: paragraph])
            text.addAttributes([.font: NSFont.systemFont(ofSize: 13, weight: .medium), .foregroundColor: OpenAllTheme.ink],
                               range: NSRange(location: 0, length: ("  " + alias.title).utf16.count))
            button.attributedTitle = text
            button.layer?.backgroundColor = selection == index ? OpenAllTheme.accent.withAlphaComponent(0.13).cgColor : NSColor.clear.cgColor

            list.addSubview(button)
        }
        let maximumOffset = max(0, height - scroll.contentSize.height)
        let offset = resetScroll ? maximumOffset : min(max(0, previousOrigin.y), maximumOffset)
        scroll.contentView.scroll(to: NSPoint(x: 0, y: offset))
        scroll.reflectScrolledClipView(scroll.contentView)
    }

    private func fillSelection() {
        if let selection, store.items.indices.contains(selection) {
            let item = store.items[selection]
            fields[0].stringValue = item.title
            fields[1].stringValue = item.allNames.joined(separator: ", ")
            fields[2].stringValue = item.template
            saveButton.title = "保存更改"
            deleteButton.isHidden = false
        } else {
            fields.forEach { $0.stringValue = "" }
            saveButton.title = "添加网址"
            deleteButton.isHidden = true
        }
        updateExample()
        rebuildList()
    }

    func controlTextDidChange(_ notification: Notification) {
        showNotice("尚未保存")
        updateExample()
    }

    private func updateExample() {
        let keyword = fields[1].stringValue.components(separatedBy: CharacterSet(charactersIn: ",，"))
            .first?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
        let name = fields[0].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let template = fields[2].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !keyword.isEmpty, !name.isEmpty, !template.isEmpty else {
            example.stringValue = ""
            example.toolTip = nil
            return
        }
        let query = template.contains("{query}")
        example.stringValue = query ? "输入 “\(keyword) 咖啡” → 在\(name)搜索“咖啡”"
                                    : "输入 “\(keyword)” → 打开\(name)"
        example.toolTip = example.stringValue
    }

    private func showNotice(_ text: String, error: Bool = false) {
        notice.stringValue = text
        notice.toolTip = text
        notice.frame = error ? NSRect(x: 236, y: 54, width: 442, height: 22) : NSRect(x: 351, y: 89, width: 245, height: 20)
        notice.textColor = error ? .systemOrange : OpenAllTheme.muted
    }

    private func validated() -> LinkAlias? {
        let names = fields[1].stringValue.replacingOccurrences(of: "，", with: ",")
            .split(separator: ",", omittingEmptySubsequences: false)
            .map { $0.trimmingCharacters(in: .whitespacesAndNewlines) }.filter { !$0.isEmpty }
        let title = fields[0].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let template = fields[2].stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            .replacingOccurrences(of: "\n", with: "")
        let check = template.replacingOccurrences(of: "{query}", with: "test")
        guard !names.isEmpty, names.count <= 3, names.allSatisfy({ !$0.contains(where: \.isWhitespace) }),
              Set(names.map { $0.lowercased() }).count == names.count, !title.isEmpty,
              let url = URL(string: check), ["http", "https"].contains(url.scheme?.lowercased() ?? "") else {
            showNotice("请填写 1–3 个不重复的别名、名称和有效的 http(s) 网址。", error: true)
            return nil
        }
        if store.items.enumerated().contains(where: { old in
            old.offset != selection && old.element.allNames.contains(where: { existing in
                names.contains(where: { $0.caseInsensitiveCompare(existing) == .orderedSame })
            })
        }) {
            showNotice("这个别名已存在，请换一个名称。", error: true)
            return nil
        }
        return LinkAlias(name: names[0], title: title, template: template, alternateNames: Array(names.dropFirst()))
    }

    @objc private func selectAlias(_ sender: NSButton) { selection = sender.tag; showNotice(""); fillSelection() }
    @objc private func newAlias() { selection = nil; showNotice(""); fillSelection(); window?.makeFirstResponder(fields[0]) }
    @objc private func saveAlias() {
        guard let alias = validated() else { return }
        if let selection {
            store.replace(at: selection, with: alias)
            showNotice("已保存“\(alias.title)”")
        } else {
            store.add(alias)
            selection = store.items.count - 1
            showNotice("已添加“\(alias.title)”")
        }
        fillSelection()
        onChange()
    }
    @objc private func deleteAlias() {
        guard let selection, store.items.indices.contains(selection) else { return }
        let title = store.items[selection].title
        store.remove(at: selection)
        self.selection = store.items.isEmpty ? nil : min(selection, store.items.count - 1)
        fillSelection()
        showNotice("已删除“\(title)”。")
        onChange()
    }
}
