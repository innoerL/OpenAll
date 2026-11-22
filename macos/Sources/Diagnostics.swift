import AppKit
import ApplicationServices
import UniformTypeIdentifiers

struct DiagnosticSnapshot: Codable {
    let version: String
    let build: String
    let macOS: String
    let architecture: String
    let accessibilityEffective: Bool
    let searchHotkeyActive: Bool
    let clipboardHotkeyActive: Bool
    let stackHotkeyActive: Bool
    let selectionHotkeyActive: Bool
    let doubleTapConfigured: Bool
    let doubleTapActive: Bool
    let chromeProfileCount: Int
    let chromeBookmarksEnabled: Bool
    let chromeHistoryEnabled: Bool
    let fileSearchEnabled: Bool
    let fileIndexCount: Int
    let fileIndexing: Bool
    let unreadableFolderCount: Int
    let clipboardRecordingEnabled: Bool
    let clipboardPaused: Bool
    let clipboardItemCount: Int
    let exportedAt: Date
}

final class DiagnosticsView: NSView {
    var snapshot: (() -> DiagnosticSnapshot)?
    var openHotkeys: (() -> Void)?
    var openPermissions: (() -> Void)?
    var retryDoubleTap: (() -> Void)?
    private let metrics = NSView()
    private let updated = NSTextField(labelWithString: "")

    override init(frame: NSRect) {
        super.init(frame: frame)
        wantsLayer = true
        let title = NSTextField(labelWithString: "状态与诊断")
        title.font = .systemFont(ofSize: 18, weight: .medium)
        title.frame = NSRect(x: 28, y: 474, width: 360, height: 30)
        addSubview(title)
        let hint = NSTextField(labelWithString: "导出内容仅包含状态和数量，不包含搜索词、剪贴板内容或文件路径。")
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .secondaryLabelColor
        hint.frame = NSRect(x: 28, y: 86, width: 650, height: 22)
        addSubview(hint)
        updated.font = .systemFont(ofSize: 13, weight: .medium)
        updated.textColor = OpenAllTheme.muted
        updated.frame = NSRect(x: 28, y: 443, width: 540, height: 18)
        addSubview(updated)
        metrics.frame = NSRect(x: 28, y: 116, width: 640, height: 330)
        WindowChrome.styleSettingsSection(metrics)
        metrics.layer?.backgroundColor = NSColor.clear.cgColor
        addSubview(metrics)
        let refresh = NSButton(title: "刷新状态", target: self, action: #selector(reload))
        refresh.frame = NSRect(x: 28, y: 34, width: 120, height: 32)
        WindowChrome.styleAction(refresh)
        addSubview(refresh)
        let export = NSButton(title: "导出诊断 JSON…", target: self, action: #selector(export))
        export.frame = NSRect(x: 158, y: 34, width: 165, height: 32)
        WindowChrome.styleAction(export)
        addSubview(export)
    }
    required init?(coder: NSCoder) { fatalError("不支持从归档创建") }

    @objc func reload() {
        guard let value = snapshot?() else { return }
        let checkedTime = DateFormatter.localizedString(from: value.exportedAt, dateStyle: .none, timeStyle: .medium)
        metrics.subviews.forEach { $0.removeFromSuperview() }
        let activeHotkeys = [value.searchHotkeyActive, value.clipboardHotkeyActive,
                             value.stackHotkeyActive, value.selectionHotkeyActive].filter { $0 }.count
        let rows: [(String, String, Bool?)] = [
            ("版本", "\(value.version) (\(value.build))", nil),
            ("辅助功能", value.accessibilityEffective ? "已授权" : "未授权", value.accessibilityEffective),
            ("全局快捷键", activeHotkeys == 4 ? "4 项快捷键均已启用" : "\(4 - activeHotkeys) 项快捷键未注册", activeHotkeys == 4),
            ("双击修饰键", value.doubleTapActive ? "已启用" : value.doubleTapConfigured ?
                (value.accessibilityEffective ? "监听未启动" : "需授权辅助功能") : "未设置",
             value.doubleTapConfigured && !value.doubleTapActive ? false : nil),
            ("Chrome 配置", "检测到 \(value.chromeProfileCount) 个配置 · 书签\(value.chromeBookmarksEnabled ? "开启" : "关闭") · 历史\(value.chromeHistoryEnabled ? "开启" : "关闭")", nil),
            ("文件索引", value.fileSearchEnabled ? "\(value.fileIndexCount) 项\(value.fileIndexing ? " · 扫描中" : "")" : "未启用", nil),
            ("无法读取的目录", "\(value.unreadableFolderCount) 个", value.unreadableFolderCount == 0),
            ("剪贴板记录", value.clipboardRecordingEnabled ? "\(value.clipboardItemCount) 项\(value.clipboardPaused ? " · 已暂停" : "")" : "已关闭", nil)
        ]
        let issues = rows.filter { $0.2 == false }.count
        updated.stringValue = "\(issues == 0 ? "各项状态正常" : "\(issues) 类问题需要处理") · 最近检查 \(checkedTime)"
        updated.textColor = issues == 0 ? OpenAllTheme.muted : OpenAllTheme.accentText
        var y: CGFloat = 300
        let ordered = rows.enumerated().sorted { ($0.element.2 == false ? 0 : 1) < ($1.element.2 == false ? 0 : 1) }
        for (position, entry) in ordered.enumerated() {
            let (index, row) = entry
            if row.2 == false {
                let stripe = NSView(frame: NSRect(x: 0, y: y - (index == 2 ? 27 : 3), width: 3, height: index == 2 ? 48 : 26))
                stripe.wantsLayer = true
                stripe.layer?.backgroundColor = NSColor.systemOrange.withAlphaComponent(0.65).cgColor
                metrics.addSubview(stripe)
            }
            let key = NSTextField(labelWithString: row.0)
            key.font = .systemFont(ofSize: 13, weight: .regular)
            key.textColor = OpenAllTheme.muted
            key.frame = NSRect(x: 18, y: y, width: 190, height: 20)
            metrics.addSubview(key)
            let detail = NSTextField(labelWithString: row.1)
            detail.font = .systemFont(ofSize: 13, weight: row.2 == false ? .medium : .regular)
            detail.textColor = row.2.map { $0 ? OpenAllTheme.ink : .systemOrange } ?? OpenAllTheme.ink
            detail.lineBreakMode = .byTruncatingMiddle
            detail.frame = NSRect(x: 218, y: y, width: index == 4 ? 390 : 275, height: 20)
            metrics.addSubview(detail)
            if index == 2 {
                let names = [("搜索", value.searchHotkeyActive), ("剪贴板", value.clipboardHotkeyActive),
                             ("复制堆栈", value.stackHotkeyActive), ("选中操作", value.selectionHotkeyActive)]
                let failed = names.filter { !$0.1 }.map { $0.0 }
                let detail = NSTextField(labelWithString: failed.isEmpty ? "搜索、剪贴板、复制堆栈、选中操作" : "未注册：" + failed.joined(separator: "、"))
                detail.font = .systemFont(ofSize: 12)
                detail.textColor = OpenAllTheme.muted
                detail.frame = NSRect(x: 218, y: y - 23, width: 400, height: 20)
                metrics.addSubview(detail)
            }
            if (index == 1 && !value.accessibilityEffective) || (index == 2 && activeHotkeys < 4) ||
                (index == 3 && value.doubleTapConfigured && !value.doubleTapActive) {
                let retry = index == 3 && value.accessibilityEffective
                let button = NSButton(title: index == 2 ? "修改快捷键 →" : retry ? "重新启动 →" : "检查权限 →",
                                      target: self, action: index == 2 ? #selector(showHotkeys) :
                                          retry ? #selector(retryMonitor) : #selector(showPermissions))
                button.frame = NSRect(x: 500, y: y - 1, width: 122, height: 22)
                WindowChrome.styleOutputAction(button)
                metrics.addSubview(button)
            }
            if position < rows.count - 1 {
                let line = NSView(frame: NSRect(x: 18, y: y - (index == 2 ? 30 : 9), width: 604, height: 1))
                line.wantsLayer = true
                line.layer?.backgroundColor = OpenAllTheme.rule.cgColor
                metrics.addSubview(line)
            }
            y -= index == 2 ? 58 : 34
        }
    }

    @objc private func showHotkeys() { openHotkeys?() }
    @objc private func showPermissions() { openPermissions?() }
    @objc private func retryMonitor() { retryDoubleTap?(); reload() }

    @objc private func export() {
        guard let value = snapshot?() else { return }
        let panel = NSSavePanel()
        panel.nameFieldStringValue = "OpenAll-诊断.json"
        panel.allowedContentTypes = [.json]
        guard panel.runModal() == .OK, let url = panel.url else { return }
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.prettyPrinted, .sortedKeys]
        encoder.dateEncodingStrategy = .iso8601
        if let data = try? encoder.encode(value) { try? data.write(to: url, options: .atomic) }
    }
}
