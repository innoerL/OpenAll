import AppKit
import ApplicationServices

/// 侧栏只在键盘遍历时显示焦点提示，鼠标点击与页面选中分别处理。
final class SettingsWindow: NSWindow {
    private(set) var showsNavigationFocus = false

    func setNavigationFocusVisible(_ visible: Bool) {
        guard showsNavigationFocus != visible else { return }
        showsNavigationFocus = visible
        (firstResponder as? SettingsNavItem)?.needsDisplay = true
    }

    override func sendEvent(_ event: NSEvent) {
        switch event.type {
        case .leftMouseDown, .rightMouseDown, .otherMouseDown:
            setNavigationFocusVisible(false)
        case .keyDown where event.keyCode == 48 && event.modifierFlags.intersection([.command, .control, .option]).isEmpty:
            setNavigationFocusVisible(true)
        default: break
        }
        super.sendEvent(event)
    }

    @discardableResult
    override func makeFirstResponder(_ responder: NSResponder?) -> Bool {
        let previous = firstResponder as? SettingsNavItem
        let accepted = super.makeFirstResponder(responder)
        if previous !== firstResponder {
            previous?.needsDisplay = true
            (firstResponder as? SettingsNavItem)?.needsDisplay = true
        }
        return accepted
    }

    override func resignKey() {
        super.resignKey()
        setNavigationFocusVisible(false)
    }
}

final class SettingsNavItem: NSButton, WindowThemeRefreshing {
    let titleText: String
    private let iconView = NSImageView()
    var selected = false {
        didSet {
            setAccessibilityValue(selected ? 1 : 0)
            refreshWindowTheme()
        }
    }
    var onChoose: (() -> Void)?

    init(frame: NSRect, title: String, symbol: String) {
        titleText = title
        super.init(frame: frame)
        isBordered = false
        focusRingType = .none
        setAccessibilityRole(.radioButton)
        setAccessibilityLabel(title)
        self.title = title
        target = self
        action = #selector(choose)
        iconView.frame = NSRect(x: 18, y: 11, width: 18, height: 18)
        iconView.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
        iconView.image?.isTemplate = true
        iconView.setAccessibilityElement(false)
        iconView.contentTintColor = OpenAllTheme.muted
        addSubview(iconView)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    @objc private func choose() {
        window?.makeFirstResponder(self)
        onChoose?()
    }
    private var rowShape: NSBezierPath {
        NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 3), xRadius: 7, yRadius: 7)
    }

    var showsKeyboardFocus: Bool {
        guard let window = window as? SettingsWindow else { return false }
        return window.isKeyWindow && window.showsNavigationFocus && window.firstResponder === self && canBecomeKeyView
    }

    func refreshWindowTheme() {
        iconView.contentTintColor = selected ? OpenAllTheme.accentText : OpenAllTheme.muted
        needsDisplay = true
    }

    override func draw(_ dirtyRect: NSRect) {
        if selected {
            OpenAllTheme.raised.setFill()
            rowShape.fill()
            OpenAllTheme.accentText.setFill()
            NSBezierPath(roundedRect: NSRect(x: 4, y: bounds.midY - 8, width: 3, height: 16),
                         xRadius: 1.5, yRadius: 1.5).fill()
        }
        if showsKeyboardFocus {
            OpenAllTheme.accentText.setStroke()
            let outline = rowShape
            outline.lineWidth = 1.5
            outline.stroke()
        }
        let name = titleText as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 13, weight: selected ? .semibold : .regular),
            .foregroundColor: selected ? OpenAllTheme.ink : OpenAllTheme.muted
        ]
        let height = name.size(withAttributes: attributes).height
        name.draw(at: NSPoint(x: 46, y: floor((bounds.height - height) / 2)), withAttributes: attributes)
    }
}

/// 色样、名称与对勾同时表达当前选择。
final class AppearancePresetButton: NSButton {
    var swatchColor: NSColor = .clear
    var swatchTitle = ""
    var chosen = false {
        didSet {
            setAccessibilityValue(chosen ? 1 : 0)
            needsDisplay = true
        }
    }
    override func draw(_ dirtyRect: NSRect) {
        let box = NSRect(x: 5, y: 5, width: 24, height: 24)
        let swatch = NSBezierPath(roundedRect: box, xRadius: 6, yRadius: 6)
        swatchColor.setFill()
        swatch.fill()
        OpenAllTheme.rule.setStroke()
        swatch.lineWidth = 1
        swatch.stroke()
        if chosen {
            OpenAllTheme.accentText.setStroke()
            let outline = NSBezierPath(roundedRect: box.insetBy(dx: -2.5, dy: -2.5), xRadius: 8.5, yRadius: 8.5)
            outline.lineWidth = 1.5
            outline.stroke()
            let rgb = swatchColor.usingColorSpace(.sRGB) ?? swatchColor
            func linear(_ channel: CGFloat) -> CGFloat {
                channel <= 0.04045 ? channel / 12.92 : pow((channel + 0.055) / 1.055, 2.4)
            }
            let luminance = 0.2126 * linear(rgb.redComponent) + 0.7152 * linear(rgb.greenComponent) + 0.0722 * linear(rgb.blueComponent)
            (luminance > 0.179 ? NSColor.black : NSColor.white).setStroke()
            let tick = NSBezierPath()
            tick.move(to: NSPoint(x: box.midX - 4.5, y: box.midY))
            tick.line(to: NSPoint(x: box.midX - 1.3, y: box.midY + (isFlipped ? 3 : -3)))
            tick.line(to: NSPoint(x: box.midX + 5, y: box.midY + (isFlipped ? -4 : 4)))
            tick.lineWidth = 1.8
            tick.lineJoinStyle = .round
            tick.lineCapStyle = .round
            tick.stroke()
        }
        let name = swatchTitle as NSString
        let attributes: [NSAttributedString.Key: Any] = [
            .font: NSFont.systemFont(ofSize: 12, weight: chosen ? .semibold : .regular),
            .foregroundColor: chosen ? OpenAllTheme.ink : OpenAllTheme.muted
        ]
        let height = name.size(withAttributes: attributes).height
        name.draw(at: NSPoint(x: 38, y: floor((bounds.height - height) / 2)), withAttributes: attributes)
    }
}

final class PermissionsView: NSView {
    private var accessibilityStatus: NSTextField!
    private var fileStatus: NSTextField!
    private var fileHelp: NSTextField!
    private var downloadsButton: NSButton!
    private var filesPermissionButton: NSButton!
    var fileSearch: FileSearchIndex?
    var fileSearchEnabled = false
    var onRetryFiles: (() -> Void)?
    var onEnableFiles: (() -> Void)?
    var onOpenSearchSettings: (() -> Void)?

    override init(frame: NSRect) {
        super.init(frame: frame)
        build()
        NotificationCenter.default.addObserver(self, selector: #selector(refresh), name: NSApplication.didBecomeActiveNotification, object: nil)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }
    deinit { NotificationCenter.default.removeObserver(self) }

    private func label(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, size: CGFloat = 12) -> NSTextField {
        let field = NSTextField(labelWithString: text)
        field.font = .systemFont(ofSize: size)
        field.frame = NSRect(x: x, y: y, width: width, height: 24)
        return field
    }

    private func build() {
        for y in [286.0, 166.0] {
            let rule = NSView(frame: NSRect(x: 28, y: y, width: 536, height: 1))
            rule.wantsLayer = true
            rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
            addSubview(rule)
        }
        let title = label("权限与隐私", x: 28, y: 449, width: 300, size: 20)
        title.font = .systemFont(ofSize: 18, weight: .medium)
        addSubview(title)
        let hint = label("按需授权，权限状态会在返回后自动更新。", x: 28, y: 420, width: 620)
        hint.textColor = .secondaryLabelColor
        addSubview(hint)

        let accessibility = label("辅助功能", x: 28, y: 339, width: 180, size: 13)
        accessibility.font = .systemFont(ofSize: 13, weight: .medium)
        addSubview(accessibility)
        accessibilityStatus = label("", x: 28, y: 312, width: 160)
        addSubview(accessibilityStatus)
        let accessibilityHelp = NSButton(title: "图标显示异常？查看处理方法 →", target: self, action: #selector(showIconHelp))
        accessibilityHelp.isBordered = false
        accessibilityHelp.alignment = .left
        accessibilityHelp.contentTintColor = OpenAllTheme.accentText
        accessibilityHelp.font = .systemFont(ofSize: 12)
        accessibilityHelp.frame = NSRect(x: 28, y: 20, width: 320, height: 22)
        addSubview(accessibilityHelp)
        let accessibilityButton = NSButton(title: "打开辅助功能设置 ↗", target: self, action: #selector(openAccessibility))
        accessibilityButton.frame = NSRect(x: 385, y: 334, width: 180, height: 30)
        WindowChrome.styleOutputAction(accessibilityButton)
        addSubview(accessibilityButton)

        let files = label("文件与文件夹", x: 28, y: 239, width: 180, size: 13)
        files.font = .systemFont(ofSize: 13, weight: .medium)
        addSubview(files)
        fileStatus = label("", x: 28, y: 212, width: 152)
        fileStatus.textColor = OpenAllTheme.muted
        addSubview(fileStatus)
        fileHelp = label("文件搜索使用 Spotlight 与本地扫描；受保护目录按提示授权。", x: 28, y: 178, width: 335)
        fileHelp.textColor = .secondaryLabelColor
        fileHelp.cell?.wraps = true
        fileHelp.cell?.usesSingleLineMode = false
        fileHelp.frame.size.height = 32
        addSubview(fileHelp)
        let retry = NSButton(title: "选择下载…", target: self, action: #selector(chooseDownloads))
        retry.frame = NSRect(x: 385, y: 234, width: 180, height: 30)
        WindowChrome.styleAction(retry)
        addSubview(retry)
        downloadsButton = retry
        let fileButton = NSButton(title: "打开文件权限设置 ↗", target: self, action: #selector(openFiles))
        fileButton.frame = NSRect(x: 385, y: 202, width: 180, height: 26)
        WindowChrome.styleOutputAction(fileButton)
        addSubview(fileButton)
        filesPermissionButton = fileButton

        let browser = label("Chrome 书签与历史", x: 28, y: 124, width: 220, size: 13)
        browser.font = .systemFont(ofSize: 13, weight: .medium)
        addSubview(browser)
        let browserStatus = label("无需额外授权", x: 28, y: 96, width: 160)
        browserStatus.textColor = OpenAllTheme.muted
        addSubview(browserStatus)
        let browserButton = NSButton(title: "打开搜索设置 →", target: self, action: #selector(openSearchSettings))
        browserButton.frame = NSRect(x: 385, y: 119, width: 180, height: 30)
        WindowChrome.styleOutputAction(browserButton)
        addSubview(browserButton)
        let browserHelp = label("书签与历史的搜索范围可在搜索设置中调整。", x: 28, y: 68, width: 630)
        browserHelp.textColor = .secondaryLabelColor
        addSubview(browserHelp)
        subviews.forEach { $0.frame.origin.y += 25 }
        refresh()
    }

    @objc private func refresh() {
        accessibilityStatus.stringValue = AXIsProcessTrusted() ? "● 已授权" : "● 未授权"
        accessibilityStatus.textColor = AXIsProcessTrusted() ? OpenAllTheme.muted : .systemOrange
        refreshFileStatus()
    }

    func refreshFileStatus() {
        filesPermissionButton.isHidden = !fileSearchEnabled
        guard fileSearchEnabled else {
            fileStatus.stringValue = "搜索已关闭"
            fileHelp.stringValue = "开启后检查桌面、文稿与下载文件夹的权限。"
            downloadsButton.title = "开启文件搜索"
            downloadsButton.target = self
            downloadsButton.action = #selector(enableFileSearch)
            return
        }
        downloadsButton.title = "选择下载…"
        downloadsButton.action = #selector(chooseDownloads)
        guard let fileSearch else { return }
        if !fileSearch.unreadableFolders.isEmpty {
            let names = fileSearch.unreadableFolders.map { ["Downloads": "下载", "Documents": "文稿", "Desktop": "桌面"][$0] ?? $0 }
            fileStatus.stringValue = "部分目录不可读"
            fileStatus.textColor = .systemOrange
            fileHelp.stringValue = "无法读取：\(names.joined(separator: "、"))。请在系统设置中开启对应权限，再到搜索页重新扫描。"
        } else if fileSearch.isIndexing {
            fileStatus.stringValue = "正在扫描…"
            fileStatus.textColor = OpenAllTheme.muted
            fileHelp.stringValue = "正在检查桌面、文稿、下载等目录；首次访问时请允许 macOS 授权提示。"
        } else {
            fileStatus.stringValue = "已扫描 \(fileSearch.indexedCount) 项"
            fileStatus.textColor = OpenAllTheme.muted
            fileHelp.stringValue = "覆盖桌面、文稿、下载等目录；未找到时可重新扫描并检查系统权限。"
        }
    }

    @objc private func chooseDownloads() {
        let panel = NSOpenPanel()
        panel.canChooseFiles = false
        panel.canChooseDirectories = true
        panel.allowsMultipleSelection = false
        panel.directoryURL = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads")
        panel.prompt = "选择下载文件夹"
        panel.message = "选择下载文件夹后，OpenAll 会重新扫描其中的文件名。"
        panel.begin { [weak self] response in
            guard response == .OK, let self else { return }
            let downloads = FileManager.default.homeDirectoryForCurrentUser.appendingPathComponent("Downloads").standardizedFileURL
            guard panel.url?.standardizedFileURL == downloads else {
                self.fileHelp.stringValue = "请选择当前账户的下载文件夹。"
                return
            }
            self.onRetryFiles?()
            self.refreshFileStatus()
        }
    }

    @objc private func enableFileSearch() { onEnableFiles?() }
    @objc private func openSearchSettings() { onOpenSearchSettings?() }

    @objc private func showIconHelp() {
        let alert = NSAlert()
        alert.messageText = "刷新系统设置中的 OpenAll 图标"
        alert.informativeText = "先确认已安装新版 /Applications/OpenAll.app。然后在“隐私与安全性 → 辅助功能”中移除旧 OpenAll 条目，重新添加该路径下的应用并开启授权。macOS 会更新权限列表中的图标。"
        alert.addButton(withTitle: "知道了")
        alert.runModal()
    }

    private func openSettings(_ section: String) {
        let url = URL(string: "x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?\(section)")!
        if !NSWorkspace.shared.open(url) {
            NSWorkspace.shared.open(URL(fileURLWithPath: "/System/Applications/System Settings.app"))
        }
    }
    @objc private func openAccessibility() { openSettings("Privacy_Accessibility") }
    @objc private func openFiles() { openSettings("Privacy_FilesAndFolders") }
}
