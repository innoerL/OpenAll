import AppKit

final class SnippetEditorView: NSView, NSTableViewDataSource, NSTableViewDelegate {
    private let store: SnippetStore
    private let table = NSTableView()
    private let chooser = NSPopUpButton()
    private let creationHeading = NSTextField(labelWithString: "新建片段")
    private let nameField = NSTextField()
    private let keywordField = NSTextField()
    private let bodyView = OpenAllTextView(usingTextLayoutManager: false)
    private let status = NSTextField(labelWithString: "")
    private let emptyHint = NSTextField(wrappingLabelWithString: "暂无片段\n点击下方新建")
    private var emptyForm: NSView?
    private var detailCard: NSView?
    private var selectedID: UUID?
    private var regularFrames: [(NSView, NSRect)] = []
    private weak var listScroll: NSScrollView?
    private weak var newButton: NSButton?
    private weak var removeButton: NSButton?
    private weak var saveButton: NSButton?

    init(frame: NSRect, store: SnippetStore) {
        self.store = store
        super.init(frame: frame)
        build()
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    private func label(_ value: String, frame: NSRect) -> NSTextField {
        let label = NSTextField(labelWithString: value)
        label.frame = frame
        label.font = .systemFont(ofSize: 13, weight: .medium)
        label.textColor = OpenAllTheme.muted
        return label
    }

    private func build() {
        let heading = label("常用片段", frame: NSRect(x: 28, y: 474, width: 300, height: 30))
        heading.font = .systemFont(ofSize: 18, weight: .medium)
        heading.textColor = OpenAllTheme.ink
        addSubview(heading)
        let hint = label("在搜索中输入 ;关键词 后回车即可展开并粘贴。",
                         frame: NSRect(x: 28, y: 441, width: 650, height: 22))
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .secondaryLabelColor
        addSubview(hint)
        chooser.frame = NSRect(x: 28, y: 405, width: 360, height: 28)
        WindowChrome.stylePopUp(chooser)
        chooser.target = self
        chooser.action = #selector(chooseSnippet)
        addSubview(chooser)
        creationHeading.frame = NSRect(x: 28, y: 405, width: 360, height: 28)
        creationHeading.font = .systemFont(ofSize: 13, weight: .medium)
        creationHeading.textColor = OpenAllTheme.ink
        addSubview(creationHeading)
        let listCard = NSView(frame: NSRect(x: 18, y: 82, width: 215, height: 340))
        let detailCard = NSView(frame: NSRect(x: 246, y: 82, width: 444, height: 340))
        WindowChrome.styleSettingsSection(listCard)
        WindowChrome.styleSettingsSection(detailCard)
        listCard.layer?.backgroundColor = NSColor.clear.cgColor
        detailCard.layer?.backgroundColor = NSColor.clear.cgColor
        addSubview(listCard)
        addSubview(detailCard)
        self.detailCard = detailCard
        detailCard.isHidden = false
        let list = NSScrollView(frame: NSRect(x: 29, y: 151, width: 193, height: 228))
        list.hasVerticalScroller = true
        list.scrollerStyle = .overlay
        list.autohidesScrollers = true
        list.borderType = .noBorder
        list.drawsBackground = false
        table.headerView = nil
        table.rowHeight = 48
        table.style = .plain
        table.selectionHighlightStyle = .regular
        table.backgroundColor = .clear
        table.delegate = self
        table.dataSource = self
        table.columnAutoresizingStyle = .lastColumnOnlyAutoresizingStyle
        table.autoresizingMask = [.width]
        table.frame = NSRect(x: 0, y: 0, width: list.contentSize.width, height: 0)
        let column = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("snippet"))
        column.width = 193
        table.addTableColumn(column)
        list.documentView = table
        addSubview(list)
        listScroll = list
        emptyHint.font = .systemFont(ofSize: 12)
        emptyHint.textColor = OpenAllTheme.muted
        emptyHint.alignment = .center
        emptyHint.frame = NSRect(x: 35, y: 320, width: 180, height: 52)
        emptyHint.stringValue = "在右侧创建\n第一个片段"
        newButton?.isHidden = store.items.isEmpty
        layoutCreationForm()
        addSubview(emptyHint)
        addSubview(label("名称", frame: NSRect(x: 260, y: 387, width: 180, height: 20)))
        nameField.placeholderString = "例如 客户回复"
        nameField.frame = NSRect(x: 260, y: 349, width: 188, height: 32)
        WindowChrome.styleInput(nameField)
        addSubview(nameField)
        addSubview(label("关键词 · 用 ; 调用", frame: NSRect(x: 464, y: 387, width: 190, height: 20)))
        keywordField.frame = NSRect(x: 464, y: 349, width: 187, height: 32)
        WindowChrome.styleInput(keywordField)
        keywordField.placeholderString = "例如 reply"
        addSubview(keywordField)
        addSubview(label("内容", frame: NSRect(x: 260, y: 311, width: 80, height: 20)))
        let bodyScroll = NSScrollView(frame: NSRect(x: 260, y: 145, width: 391, height: 160))
        bodyScroll.hasVerticalScroller = true
        bodyScroll.borderType = .noBorder
        bodyView.frame = bodyScroll.bounds
        bodyView.isVerticallyResizable = true
        bodyView.autoresizingMask = [.width]
        bodyView.textContainer?.widthTracksTextView = true
        bodyView.placeholderText = "输入需要重复使用的文字。\n支持 {{date}}、{{time}}、{{clipboard}} 变量。"
        bodyView.isRichText = false
        bodyView.font = .systemFont(ofSize: 13)
        bodyView.textContainerInset = NSSize(width: 12, height: 10)
        WindowChrome.styleEditor(bodyScroll, text: bodyView)
        bodyScroll.documentView = bodyView
        addSubview(bodyScroll)
        let add = NSButton(title: "新建", target: self, action: #selector(newSnippet))
        add.frame = NSRect(x: 404, y: 405, width: 132, height: 28)
        add.title = "＋  新建片段"
        WindowChrome.styleAction(add)
        self.addSubview(add)
        newButton = add
        add.isHidden = store.items.isEmpty
        let remove = NSButton(title: "删除", target: self, action: #selector(removeSnippet))
        remove.frame = NSRect(x: 398, y: 102, width: 74, height: 30)
        WindowChrome.styleAction(remove)
        addSubview(remove)
        removeButton = remove
        remove.isHidden = store.items.isEmpty
        let save = NSButton(title: "保存片段", target: self, action: #selector(saveSnippet))
        save.frame = NSRect(x: 260, y: 102, width: 130, height: 30)
        WindowChrome.styleAction(save, primary: true)
        addSubview(save)
        saveButton = save
        save.title = store.items.isEmpty ? "创建片段" : "保存更改"
        status.frame = NSRect(x: 28, y: 43, width: 630, height: 25)
        status.font = .systemFont(ofSize: 12)
        status.textColor = .secondaryLabelColor
        addSubview(status)
        regularFrames = subviews.filter { $0.frame.minX >= 260 && $0 !== newButton }.map { ($0, $0.frame) }
        let empty = NSView(frame: NSRect(x: 28, y: 82, width: 640, height: 340))
        empty.wantsLayer = true
        empty.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        let title = NSTextField(labelWithString: "创建第一个常用片段")
        title.font = .systemFont(ofSize: 18, weight: .medium)
        title.textColor = OpenAllTheme.ink
        title.frame = NSRect(x: 0, y: 240, width: 600, height: 30)
        empty.addSubview(title)
        let explanation = NSTextField(wrappingLabelWithString: ";greeting → 你好，今天也请多关照。")
        explanation.font = .systemFont(ofSize: 12)
        explanation.textColor = OpenAllTheme.muted
        explanation.frame = NSRect(x: 0, y: 200, width: 600, height: 28)
        empty.addSubview(explanation)
        let syntax = NSTextField(labelWithString: "内容支持 {{date}}、{{time}}、{{clipboard}} 变量")
        syntax.font = .systemFont(ofSize: 12)
        syntax.textColor = OpenAllTheme.muted
        syntax.frame = NSRect(x: 0, y: 169, width: 600, height: 22)
        empty.addSubview(syntax)
        let create = NSButton(title: "创建第一个片段", target: self, action: #selector(newSnippet))
        create.frame = NSRect(x: 0, y: 110, width: 154, height: 34)
        WindowChrome.styleAction(create, primary: true)
        create.isHidden = false
        empty.addSubview(create)
        empty.isHidden = true
        addSubview(empty)
        emptyForm = empty
        table.reloadData()
        emptyHint.stringValue = "在右侧创建\n第一个片段"
        newButton?.isHidden = store.items.isEmpty
        layoutCreationForm()
        if !store.items.isEmpty { table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false) }
    }

    /// 固定表单位置；片段切换仅更新内容，不移动编辑焦点所在的区域。
    private func layoutCreationForm() {
        emptyHint.isHidden = true
        listScroll?.isHidden = true
        refreshChooser()
        for (view, original) in regularFrames {
            var frame = original
            frame.origin.x -= 232
            frame.origin.y -= 22
            if view === nameField || (view is NSTextField && original.minX == 260 && original.minY == 387) { frame.size.width = 240 }
            if view === keywordField || original.minX == 464 { frame.origin.x += 64; frame.size.width = 240 }
            if view is NSScrollView { frame.size.width = 508 }
            view.frame = frame
        }
    }

    private func refreshChooser() {
        chooser.removeAllItems()
        if selectedID == nil { chooser.addItem(withTitle: store.items.isEmpty ? "创建第一个片段" : "新建片段") }
        for item in store.items {
            chooser.addItem(withTitle: item.name + "  ·  ;" + item.keyword)
            chooser.lastItem?.representedObject = item.id
        }
        chooser.isEnabled = !store.items.isEmpty
        chooser.isHidden = store.items.isEmpty
        creationHeading.isHidden = !store.items.isEmpty
        if let id = selectedID, let index = chooser.itemArray.firstIndex(where: { $0.representedObject as? UUID == id }) { chooser.selectItem(at: index) }
    }

    @objc private func chooseSnippet() {
        guard let id = chooser.selectedItem?.representedObject as? UUID,
              let index = store.items.firstIndex(where: { $0.id == id }) else { newSnippet(); return }
        table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false)
    }

    func numberOfRows(in tableView: NSTableView) -> Int { store.items.count }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? { ResultRowView() }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let cell = NSTableCellView()
        let title = NSTextField(labelWithString: store.items[row].name)
        title.font = .systemFont(ofSize: 13, weight: .medium)
        title.lineBreakMode = .byTruncatingTail
        title.frame = NSRect(x: 10, y: 23, width: 172, height: 19)
        cell.addSubview(title)
        let keyword = NSTextField(labelWithString: ";" + store.items[row].keyword)
        keyword.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
        keyword.textColor = OpenAllTheme.muted
        keyword.frame = NSRect(x: 10, y: 4, width: 172, height: 18)
        cell.addSubview(keyword)
        return cell
    }
    func tableViewSelectionDidChange(_ notification: Notification) {
        guard store.items.indices.contains(table.selectedRow) else { return }
        let item = store.items[table.selectedRow]
        selectedID = item.id
        refreshChooser()
        removeButton?.isHidden = false
        saveButton?.title = "保存更改"
        nameField.stringValue = item.name
        keywordField.stringValue = item.keyword
        bodyView.string = item.body
    }
    @objc private func newSnippet() {
        emptyForm?.isHidden = true
        detailCard?.isHidden = false
        selectedID = nil
        removeButton?.isHidden = true
        saveButton?.title = "创建片段"
        table.deselectAll(nil)
        nameField.stringValue = ""
        keywordField.stringValue = ""
        bodyView.string = ""
        refreshChooser()
        window?.makeFirstResponder(nameField)
    }
    @objc private func removeSnippet() {
        guard let selectedID else { return }
        store.remove(id: selectedID)
        newSnippet()
        table.reloadData()
        emptyHint.stringValue = "在右侧创建\n第一个片段"
        newButton?.isHidden = store.items.isEmpty
        layoutCreationForm()
        emptyForm?.isHidden = true
        detailCard?.isHidden = false
        status.stringValue = "已删除片段"
    }
    @objc private func saveSnippet() {
        let saved: Bool
        if let selectedID {
            saved = store.update(id: selectedID, name: nameField.stringValue,
                                 keyword: keywordField.stringValue, body: bodyView.string)
        } else {
            saved = store.add(name: nameField.stringValue, keyword: keywordField.stringValue, body: bodyView.string)
            if saved { selectedID = store.items.last?.id }
        }
        status.stringValue = saved ? "已保存；在搜索中输入 ;\(keywordField.stringValue)" : "请填写唯一关键词和内容；关键词不能包含空格"
        status.textColor = saved ? .systemGreen : .systemOrange
        table.reloadData()
        emptyHint.stringValue = "在右侧创建\n第一个片段"
        newButton?.isHidden = store.items.isEmpty
        layoutCreationForm()
        if saved {
            emptyForm?.isHidden = true
            detailCard?.isHidden = false
            if let index = store.items.firstIndex(where: { $0.id == selectedID }) { table.selectRowIndexes(IndexSet(integer: index), byExtendingSelection: false) }
            removeButton?.isHidden = false
            saveButton?.title = "保存更改"
        }
    }
    func verifyCreationForDesign() -> Bool {
        guard DesignPreview.enabled else { return false }
        let count = store.items.count
        newSnippet()
        nameField.stringValue = "编辑流程检查"
        keywordField.stringValue = "check-" + UUID().uuidString.lowercased()
        bodyView.string = "首次保存"
        saveSnippet()
        guard let id = selectedID, store.items.count == count + 1, removeButton?.isHidden == false else { return false }
        newSnippet()
        guard chooser.titleOfSelectedItem == "新建片段", let index = chooser.itemArray.firstIndex(where: { $0.representedObject as? UUID == id }) else { return false }
        chooser.selectItem(at: index)
        chooseSnippet()
        guard selectedID == id, bodyView.string == "首次保存" else { return false }
        bodyView.string = "继续编辑"
        saveSnippet()
        guard store.items.count == count + 1, store.item(id: id)?.body == "继续编辑" else { return false }
        removeSnippet()
        return store.items.count == count && selectedID == nil && removeButton?.isHidden == true
    }

}
