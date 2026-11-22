import AppKit
import Carbon
import SQLite3
import WebKit
import UniformTypeIdentifiers

struct LinkAlias: Codable {
    var name: String
    var title: String
    var template: String
    var alternateNames: [String]

    var allNames: [String] { [name] + alternateNames }

    init(name: String, title: String, template: String, alternateNames: [String] = []) {
        self.name = name
        self.title = title
        self.template = template
        self.alternateNames = alternateNames
    }

    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        name = try values.decode(String.self, forKey: .name)
        title = try values.decode(String.self, forKey: .title)
        template = try values.decode(String.self, forKey: .template)
        alternateNames = try values.decodeIfPresent([String].self, forKey: .alternateNames) ?? []
    }
}

struct Entry: Equatable {
    enum Kind: Equatable { case application, file, alias, bookmark, history, calculator, timeValue, command, translate, comparison, clipboard, json, unicode, markdown, idGenerator, converter, imageTool, snippet }
    let kind: Kind
    let title: String
    let detail: String
    let value: String
    let rank: Int

    var returnAction: String {
        switch kind {
        case .calculator, .timeValue: return "复制"
        case .snippet: return "使用片段"
        default: return "打开"
        }
    }
}

final class ChromeIndex {
    private(set) var bookmarks: [Entry] = []
    private(set) var profiles: [(name: String, path: URL)] = []
    private let defaultBase = DesignPreview.home.appendingPathComponent("Library/Application Support/Google/Chrome")
    private(set) var searchedPath = ""

    func clear() { bookmarks = []; profiles = [] }

    func refresh(customPath: String = "", loadBookmarks: Bool = true) {
        profiles = []
        bookmarks = []
        let fm = FileManager.default
        let requested = customPath.trimmingCharacters(in: .whitespacesAndNewlines)
        let expanded = (requested as NSString).expandingTildeInPath
        let supplied = requested.isEmpty ? defaultBase : URL(fileURLWithPath: expanded, isDirectory: true)
        let selected = ["Bookmarks", "History"].contains(supplied.lastPathComponent)
            ? supplied.deletingLastPathComponent() : supplied
        searchedPath = selected.path
        let base = selected
        var profileNames: [String: String] = [:]
        let state = base.appendingPathComponent("Local State")
        if let data = try? Data(contentsOf: state),
           let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
           let profile = json["profile"] as? [String: Any],
           let cache = profile["info_cache"] as? [String: [String: Any]] {
            for (folder, info) in cache { profileNames[folder] = info["name"] as? String ?? folder }
        }
        let folders: [URL]
        if base.lastPathComponent == "Default" || base.lastPathComponent.hasPrefix("Profile ") {
            folders = [base]
        } else {
            folders = (try? fm.contentsOfDirectory(at: base, includingPropertiesForKeys: nil)) ?? []
        }
        for folder in folders where folder.lastPathComponent == "Default" || folder.lastPathComponent.hasPrefix("Profile ") {
            let bookmarkFile = folder.appendingPathComponent("Bookmarks")
            let historyFile = folder.appendingPathComponent("History")
            guard fm.fileExists(atPath: bookmarkFile.path) || fm.fileExists(atPath: historyFile.path) else { continue }
            let name = profileNames[folder.lastPathComponent] ?? folder.lastPathComponent
            profiles.append((name, folder))
            if loadBookmarks, let data = try? Data(contentsOf: bookmarkFile),
               let json = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
               let roots = json["roots"] as? [String: Any] {
                for value in roots.values { collect(value, profile: name) }
            }
        }
        profiles.sort { $0.name.localizedStandardCompare($1.name) == .orderedAscending }
    }

    private func collect(_ raw: Any, profile: String) {
        guard let node = raw as? [String: Any] else { return }
        if let url = node["url"] as? String, let title = node["name"] as? String,
           URL(string: url)?.scheme?.hasPrefix("http") == true {
            bookmarks.append(Entry(kind: .bookmark, title: title.isEmpty ? url : title,
                                   detail: "Chrome 书签 · \(profile) · \(url)", value: url, rank: 55))
        }
        if let children = node["children"] as? [Any] { for child in children { collect(child, profile: profile) } }
    }

    func searchHistory(_ query: String, limit: Int = 30, pinyinEnabled: Bool = false) -> [Entry] {
        guard !query.isEmpty else { return [] }
        let pinyinSearch = pinyinEnabled && query.count >= 3 && query.unicodeScalars.allSatisfy(\.isASCII)
        var found: [Entry] = []
        for profile in profiles {
            let path = profile.path.appendingPathComponent("History").absoluteString + "?immutable=1"
            var db: OpaquePointer?
            guard sqlite3_open_v2(path, &db, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX | SQLITE_OPEN_URI, nil) == SQLITE_OK else {
                if db != nil { sqlite3_close(db) }; continue
            }
            sqlite3_busy_timeout(db, 100)
            var statement: OpaquePointer?
            let sql = pinyinSearch
                ? "SELECT title, url FROM urls WHERE hidden = 0 ORDER BY last_visit_time DESC LIMIT 5000"
                : "SELECT title, url FROM urls WHERE hidden = 0 AND (title LIKE ?1 ESCAPE '\\' OR url LIKE ?1 ESCAPE '\\') ORDER BY last_visit_time DESC LIMIT ?2"
            if sqlite3_prepare_v2(db, sql, -1, &statement, nil) == SQLITE_OK {
                if !pinyinSearch {
                    let pattern = "%" + query.replacingOccurrences(of: "%", with: "\\%").replacingOccurrences(of: "_", with: "\\_") + "%"
                    _ = pattern.withCString { sqlite3_bind_text(statement, 1, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
                    sqlite3_bind_int(statement, 2, Int32(limit))
                }
                while sqlite3_step(statement) == SQLITE_ROW {
                    guard let rawURL = sqlite3_column_text(statement, 1) else { continue }
                    let url = String(cString: rawURL)
                    guard URL(string: url)?.scheme?.hasPrefix("http") == true else { continue }
                    let title = sqlite3_column_text(statement, 0).map { String(cString: $0) } ?? url
                    if pinyinSearch && !PinyinMatcher.matches(title, query: query, enabled: true)
                        && !url.localizedCaseInsensitiveContains(query) { continue }
                    found.append(Entry(kind: .history, title: title.isEmpty ? url : title,
                                       detail: "Chrome 历史 · \(profile.name) · \(url)", value: url, rank: 30))
                    if found.count >= limit { break }
                }
            }
            sqlite3_finalize(statement)
            sqlite3_close(db)
        }
        return Array(found.prefix(limit))
    }
}

final class AliasStore {
    private(set) var items: [LinkAlias] = []
    private let file = DesignPreview.home
        .appendingPathComponent("Library/Application Support/OpenAll/aliases.json")
    init() {
        load()
        if DesignPreview.enabled || !UserDefaults.standard.bool(forKey: "OpenAllDefaultAliasesV1") {
            let defaults = [
                LinkAlias(name: "xhs", title: "小红书", template: "https://www.xiaohongshu.com/search_result?keyword={query}", alternateNames: ["xiaohongshu", "hongshu"]),
                LinkAlias(name: "gg", title: "Google", template: "https://www.google.com/search?q={query}", alternateNames: ["google", "g"]),
                LinkAlias(name: "bd", title: "百度", template: "https://www.baidu.com/s?wd={query}", alternateNames: ["baidu", "b"]),
                LinkAlias(name: "gh", title: "GitHub", template: "https://github.com/search?q={query}", alternateNames: ["github", "git"])
            ]
            for item in defaults where !items.contains(where: { $0.name.caseInsensitiveCompare(item.name) == .orderedSame }) {
                items.append(item)
            }
            save()
            if !DesignPreview.enabled { UserDefaults.standard.set(true, forKey: "OpenAllDefaultAliasesV1") }
        }
        if DesignPreview.enabled || !UserDefaults.standard.bool(forKey: "OpenAllDefaultAliasesV2") {
            let additions = [
                LinkAlias(name: "google", title: "Google", template: "https://www.google.com/search?q={query}", alternateNames: ["谷歌"]),
                LinkAlias(name: "zh", title: "知乎", template: "https://www.zhihu.com/search?type=content&q={query}", alternateNames: ["知乎", "zhihu"]),
                LinkAlias(name: "x", title: "X (Twitter)", template: "https://x.com/search?q={query}", alternateNames: ["twitter", "推特"]),
                LinkAlias(name: "fb", title: "Facebook", template: "https://www.facebook.com/search/top?q={query}", alternateNames: ["facebook", "脸书"]),
                LinkAlias(name: "yt", title: "YouTube", template: "https://www.youtube.com/results?search_query={query}", alternateNames: ["youtube", "油管"]),
                LinkAlias(name: "wiki", title: "维基百科", template: "https://zh.wikipedia.org/w/index.php?search={query}", alternateNames: ["wikipedia", "维基"])
            ]
            for item in additions where !items.contains(where: { existing in
                existing.allNames.contains { name in item.allNames.contains { $0.localizedCaseInsensitiveCompare(name) == .orderedSame } }
            }) { items.append(item) }
            save()
            if !DesignPreview.enabled { UserDefaults.standard.set(true, forKey: "OpenAllDefaultAliasesV2") }
        }
    }
    func load() {
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode([LinkAlias].self, from: data) { items = saved }
        else {
            let old = DesignPreview.home.appendingPathComponent("Library/Application Support/XunQi/aliases.json")
            if let data = try? Data(contentsOf: old), let saved = try? JSONDecoder().decode([LinkAlias].self, from: data) { items = saved; save() }
        }
    }
    func add(_ item: LinkAlias) {
        items.removeAll { $0.name.caseInsensitiveCompare(item.name) == .orderedSame }
        items.append(item)
        save()
    }
    func remove(at index: Int) { items.remove(at: index); save() }
    func replace(at index: Int, with item: LinkAlias) {
        guard items.indices.contains(index) else { return }
        items[index] = item
        save()
    }
    private func save() {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: file, options: .atomic) }
    }
}

struct LaunchSettings: Codable {
    var keyCode: UInt32 = UInt32(kVK_Space)
    var modifiers: UInt32 = UInt32(cmdKey)
    var keyLabel: String = "Space"
    var doubleTap: String = "option"
    var clipboardKeyCode: UInt32 = UInt32(kVK_ANSI_V)
    var clipboardModifiers: UInt32 = UInt32(cmdKey | shiftKey)
    var clipboardKeyLabel: String = "V"
    var stackKeyCode: UInt32 = UInt32(kVK_ANSI_C)
    var stackModifiers: UInt32 = UInt32(cmdKey | shiftKey)
    var stackKeyLabel: String = "C"
    var selectionKeyCode: UInt32 = UInt32(kVK_ANSI_A)
    var selectionModifiers: UInt32 = UInt32(controlKey | optionKey)
    var selectionKeyLabel: String = "A"
    var doubleTapKeyCode: UInt32? = 58
    var doubleTapModifiers: UInt32 = 0
    var doubleTapKeyLabel: String = "⌥"
    var searchShortcutMode = "combo"
    var pinyinEnabled = true
    var searchBookmarks = false
    var searchHistory = false
    var searchFiles = false
    var chromePath = ""
    var updateFeedURL = ""

    init() {}
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        keyCode = try values.decodeIfPresent(UInt32.self, forKey: .keyCode) ?? UInt32(kVK_Space)
        modifiers = try values.decodeIfPresent(UInt32.self, forKey: .modifiers) ?? UInt32(cmdKey)
        keyLabel = try values.decodeIfPresent(String.self, forKey: .keyLabel) ?? "Space"
        doubleTap = try values.decodeIfPresent(String.self, forKey: .doubleTap) ?? "option"
        clipboardKeyCode = try values.decodeIfPresent(UInt32.self, forKey: .clipboardKeyCode) ?? UInt32(kVK_ANSI_V)
        clipboardModifiers = try values.decodeIfPresent(UInt32.self, forKey: .clipboardModifiers) ?? UInt32(cmdKey | shiftKey)
        clipboardKeyLabel = try values.decodeIfPresent(String.self, forKey: .clipboardKeyLabel) ?? "V"
        stackKeyCode = try values.decodeIfPresent(UInt32.self, forKey: .stackKeyCode) ?? UInt32(kVK_ANSI_C)
        stackModifiers = try values.decodeIfPresent(UInt32.self, forKey: .stackModifiers) ?? UInt32(cmdKey | shiftKey)
        stackKeyLabel = try values.decodeIfPresent(String.self, forKey: .stackKeyLabel) ?? "C"
        selectionKeyCode = try values.decodeIfPresent(UInt32.self, forKey: .selectionKeyCode) ?? UInt32(kVK_ANSI_A)
        selectionModifiers = try values.decodeIfPresent(UInt32.self, forKey: .selectionModifiers) ?? UInt32(controlKey | optionKey)
        selectionKeyLabel = try values.decodeIfPresent(String.self, forKey: .selectionKeyLabel) ?? "A"
        doubleTapKeyCode = try values.decodeIfPresent(UInt32.self, forKey: .doubleTapKeyCode)
        doubleTapModifiers = try values.decodeIfPresent(UInt32.self, forKey: .doubleTapModifiers) ?? 0
        doubleTapKeyLabel = try values.decodeIfPresent(String.self, forKey: .doubleTapKeyLabel) ?? ""
        searchShortcutMode = try values.decodeIfPresent(String.self, forKey: .searchShortcutMode)
            ?? (doubleTapKeyCode == nil ? "combo" : "double")
        pinyinEnabled = try values.decodeIfPresent(Bool.self, forKey: .pinyinEnabled) ?? true
        searchBookmarks = try values.decodeIfPresent(Bool.self, forKey: .searchBookmarks) ?? false
        searchHistory = try values.decodeIfPresent(Bool.self, forKey: .searchHistory) ?? false
        searchFiles = try values.decodeIfPresent(Bool.self, forKey: .searchFiles) ?? false
        chromePath = try values.decodeIfPresent(String.self, forKey: .chromePath) ?? ""
        updateFeedURL = try values.decodeIfPresent(String.self, forKey: .updateFeedURL) ?? ""
        if doubleTapKeyCode == nil {
            let codes: [String: UInt32] = ["command": 55, "option": 58, "control": 59, "shift": 56]
            doubleTapKeyCode = doubleTap == "off" ? nil : (codes[doubleTap] ?? 58)
            doubleTapKeyLabel = ["command": "⌘", "option": "⌥", "control": "⌃", "shift": "⇧"][doubleTap] ?? (doubleTap == "off" ? "" : "⌥")
        }
    }
}

final class SettingsStore {
    private(set) var value = LaunchSettings()
    private let file = DesignPreview.home
        .appendingPathComponent("Library/Application Support/OpenAll/settings.json")
    init() {
        if let data = try? Data(contentsOf: file), let saved = try? JSONDecoder().decode(LaunchSettings.self, from: data) { value = saved }
    }
    func update(_ next: LaunchSettings) {
        value = next
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(next) { try? data.write(to: file, options: .atomic) }
    }
}

func shortcutDescription(_ settings: LaunchSettings) -> String {
    shortcutDescription(code: settings.keyCode, modifiers: settings.modifiers, label: settings.keyLabel)
}

func shortcutDescription(code: UInt32, modifiers: UInt32, label: String) -> String {
    var text = ""
    if modifiers & UInt32(controlKey) != 0 { text += "⌃" }
    if modifiers & UInt32(optionKey) != 0 { text += "⌥" }
    if modifiers & UInt32(shiftKey) != 0 { text += "⇧" }
    if modifiers & UInt32(cmdKey) != 0 { text += "⌘" }
    return text + label
}

final class SearchField: NSTextField {
    var onMove: ((Int) -> Void)?
    var onAccept: (() -> Void)?
    var onDismiss: (() -> Void)?
    var onSettings: (() -> Void)?
    var onActions: (() -> Void)?
    override func performKeyEquivalent(with event: NSEvent) -> Bool {
        if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers == "," { onSettings?(); return true }
        if event.modifierFlags.contains(.command) && event.charactersIgnoringModifiers?.lowercased() == "k" { onActions?(); return true }
        return super.performKeyEquivalent(with: event)
    }
    override func keyDown(with event: NSEvent) {
        switch event.keyCode {
        case 125: onMove?(1)
        case 126: onMove?(-1)
        case 36: onAccept?()
        case 53: onDismiss?()
        default: super.keyDown(with: event)
        }
    }
}

final class LauncherPanel: NSPanel {
    override func cancelOperation(_ sender: Any?) { orderOut(nil) }
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

final class ResultRowView: NSTableRowView {
    override func drawSelection(in dirtyRect: NSRect) {
        guard selectionHighlightStyle != .none else { return }
        OpenAllTheme.accent.withAlphaComponent(0.18).setFill()
        NSBezierPath(roundedRect: bounds.insetBy(dx: 5, dy: 2), xRadius: 6, yRadius: 6).fill()
    }
}

final class SearchSurfaceView: NSVisualEffectView {
    var onResize: (() -> Void)?
    override func resizeSubviews(withOldSize oldSize: NSSize) {
        super.resizeSubviews(withOldSize: oldSize)
        onResize?()
    }
}

final class SearchResultRowView: NSTableRowView {
    var returnAction = ""

    override func drawSelection(in dirtyRect: NSRect) {
        guard selectionHighlightStyle != .none else { return }
        let row = bounds.insetBy(dx: 5, dy: 2)
        OpenAllTheme.accent.withAlphaComponent(0.16).setFill()
        NSBezierPath(roundedRect: row, xRadius: 6, yRadius: 6).fill()
        let label = NSAttributedString(string: "↵  " + returnAction, attributes: [
            .font: NSFont.systemFont(ofSize: 12, weight: .medium), .foregroundColor: OpenAllTheme.ink
        ])
        let size = label.size()
        let badge = NSRect(x: row.maxX - ceil(size.width) - 26, y: row.midY - 11,
                           width: ceil(size.width) + 14, height: 22)
        OpenAllTheme.ink.withAlphaComponent(0.16).setStroke()
        NSBezierPath(roundedRect: badge, xRadius: 5, yRadius: 5).stroke()
        label.draw(at: NSPoint(x: badge.minX + 7, y: round(badge.midY - size.height / 2)))
    }
}

final class TranslationWindow: NSObject, WKNavigationDelegate {
    private let translationURL = URL(string: "https://fanyi.youdao.com/index.html#/TextTranslate")!
    private var window: NSWindow?
    private var webView: WKWebView?
    private var pending = ""
    private var attempts = 0
    private var loadingLabel: NSTextField?
    private var loadFailed = false
    private var stateView: NSView?
    private var stateDetail: NSTextField?
    private var sourceExcerpt: NSTextField?
    private var retryButton: NSButton?
    private var connectionProgress: NSProgressIndicator?
    private var connectionIcon: NSImageView?
    private var connectionBrowser: NSButton?
    func show(_ text: String) {
        pending = text
        attempts = 0
        if window == nil {
            let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
            let size = NSSize(width: min(580, screen.width * 0.94), height: min(320, screen.height * 0.92))
            let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                             styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
            w.isReleasedWhenClosed = false
            WindowChrome.apply(w, title: "有道翻译")
            w.minSize = NSSize(width: 580, height: 320)
            w.center()
            let view = WKWebView(frame: NSRect(x: 0, y: 0, width: w.contentView!.bounds.width, height: w.contentView!.bounds.height - WindowChrome.height))
            view.autoresizingMask = [.width, .height]
            view.navigationDelegate = self
            w.contentView?.addSubview(view)
            let state = NSView(frame: view.frame)
            state.autoresizingMask = [.width, .height]
            state.wantsLayer = true
            state.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
            w.contentView?.addSubview(state)
            let card = NSView(frame: NSRect(x: (size.width - 440) / 2, y: (view.frame.height - 200) / 2, width: 440, height: 200))
            card.autoresizingMask = [.minXMargin, .maxXMargin, .minYMargin, .maxYMargin]
            state.addSubview(card)
            let icon = NSImageView(frame: NSRect(x: 10, y: 114, width: 40, height: 36))
            icon.image = NSImage(systemSymbolName: "wifi.exclamationmark", accessibilityDescription: "翻译连接失败")
            icon.contentTintColor = OpenAllTheme.accentText
            icon.imageScaling = .scaleProportionallyUpOrDown
            icon.isHidden = true
            card.addSubview(icon)
            connectionIcon = icon
            let progress = NSProgressIndicator(frame: NSRect(x: 14, y: 118, width: 28, height: 28))
            progress.style = .spinning
            progress.startAnimation(nil)
            card.addSubview(progress)
            connectionProgress = progress
            let label = NSTextField(labelWithString: "正在连接有道翻译")
            label.alignment = .left
            label.font = .systemFont(ofSize: 20, weight: .semibold)
            label.textColor = OpenAllTheme.ink
            label.frame = NSRect(x: 68, y: 125, width: 364, height: 30)
            card.addSubview(label)
            let detail = NSTextField(labelWithString: "连接完成后，即可输入或粘贴内容进行翻译。")
            detail.alignment = .left
            detail.font = .systemFont(ofSize: 13)
            detail.textColor = OpenAllTheme.muted
            detail.frame = NSRect(x: 68, y: 99, width: 364, height: 22)
            card.addSubview(detail)
            let excerpt = NSTextField(wrappingLabelWithString: "")
            excerpt.font = .systemFont(ofSize: 12, weight: .medium)
            excerpt.textColor = OpenAllTheme.ink
            excerpt.maximumNumberOfLines = 2
            excerpt.lineBreakMode = .byWordWrapping
            excerpt.frame = NSRect(x: 68, y: 58, width: 360, height: 37)
            card.addSubview(excerpt)
            sourceExcerpt = excerpt
            let retry = NSButton(title: "重新连接", target: self, action: #selector(retryTranslation))
            retry.frame = NSRect(x: 68, y: 19, width: 100, height: 32)
            WindowChrome.styleAction(retry, primary: true)
            retry.isHidden = true
            retry.isEnabled = false
            card.addSubview(retry)
            let browser = NSButton(title: "在浏览器打开 ↗", target: self, action: #selector(openTranslationBrowser))
            browser.frame = NSRect(x: 68, y: 19, width: 130, height: 32)
            WindowChrome.styleOutputAction(browser)
            card.addSubview(browser)
            connectionBrowser = browser
            stateView = state
            stateDetail = detail
            retryButton = retry
            loadingLabel = label
            WindowChrome.installControls(on: w)
            window = w
            webView = view
        }
        let excerpt = text.prefix(96).split(whereSeparator: \.isWhitespace).joined(separator: " ")
        sourceExcerpt?.stringValue = excerpt.isEmpty ? "" : "待译原文　" + excerpt
        sourceExcerpt?.isHidden = excerpt.isEmpty
        WindowChrome.present(window)
        WindowChrome.activate()
        if DesignPreview.enabled { return }
        if loadFailed || webView?.url?.fragment != translationURL.fragment {
            loadFailed = false
            loadingLabel?.stringValue = "正在连接有道翻译"
            stateDetail?.stringValue = "连接完成后，即可输入或粘贴内容进行翻译。"
            stateView?.isHidden = false
            retryButton?.isHidden = true
            retryButton?.isEnabled = false
            connectionBrowser?.frame.origin.x = 68
            connectionIcon?.isHidden = true
            connectionProgress?.isHidden = false
            connectionProgress?.startAnimation(nil)
            loadingLabel?.isHidden = false
            webView?.load(URLRequest(url: translationURL))
        }
        else { fill() }
    }
    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        waitForPage(remaining: 35)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        showConnectionFailure()
    }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        showConnectionFailure()
    }
    private func showConnectionFailure() {
        loadFailed = true
        loadingLabel?.stringValue = "暂时无法连接有道翻译"
        stateDetail?.stringValue = "请检查网络连接，或在浏览器中继续。"
        retryButton?.isHidden = false
        retryButton?.isEnabled = true
        connectionBrowser?.frame.origin.x = 178
        connectionIcon?.isHidden = false
        connectionProgress?.stopAnimation(nil)
        connectionProgress?.isHidden = true
        stateView?.isHidden = false
        loadingLabel?.isHidden = false
    }
    @objc private func retryTranslation() {
        loadFailed = true
        show(pending)
    }

    @objc private func openTranslationBrowser() { NSWorkspace.shared.open(translationURL) }

    func showFailureForDesign() {
        guard DesignPreview.enabled else { return }
        showConnectionFailure()
    }

    private func waitForPage(remaining: Int) {
        webView?.evaluateJavaScript("document.body?.innerText?.length ?? 0") { [weak self] result, _ in
            guard let self else { return }
            if (result as? Int ?? 0) > 80 {
                self.loadingLabel?.isHidden = true
                self.stateView?.isHidden = true
                if let window = self.window, window.frame.width < 960 {
                    window.setContentSize(NSSize(width: 1080, height: 700))
                    window.center()
                }
                self.fill()
            } else if remaining > 0 && !self.loadFailed {
                DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { [weak self] in
                    self?.waitForPage(remaining: remaining - 1)
                }
            } else if !self.loadFailed {
                self.loadingLabel?.stringValue = "网页加载缓慢，请稍候…"
                self.retryButton?.isHidden = false
                self.retryButton?.isEnabled = true
                self.connectionBrowser?.frame.origin.x = 178
            }
        }
    }
    private func fill() {
        guard !pending.isEmpty, attempts < 35 else { return }
        attempts += 1
        let encoded = (try? JSONSerialization.data(withJSONObject: [pending]))
            .flatMap { String(data: $0, encoding: .utf8) } ?? "[]"
        let script = """
        (() => {
          const text = \(encoded)[0];
          if (location.hash !== '#/TextTranslate') { location.hash = '#/TextTranslate'; return false; }
          const fields = [...document.querySelectorAll('textarea, [contenteditable="true"], input[type="text"]')];
          const field = document.querySelector('#js_fanyi_input') ?? fields.filter(x => x.offsetWidth > 100 && x.offsetHeight > 20 && !x.disabled)
            .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)[0];
          if (!field) return false;
          field.focus();
          if (field.isContentEditable) field.textContent = text;
          else { const setter = Object.getOwnPropertyDescriptor(field.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, 'value')?.set; setter?.call(field, text); }
          field.dispatchEvent(new InputEvent('input', {bubbles:true, data:text, inputType:'insertText'}));
          field.dispatchEvent(new Event('change', {bubbles:true}));
          return true;
        })()
        """
        webView?.evaluateJavaScript(script) { [weak self] result, _ in
            guard let self = self else { return }
            if (result as? Bool) == true { self.pending = ""; self.sourceExcerpt?.isHidden = true }
            else { DispatchQueue.main.asyncAfter(deadline: .now() + 0.7) { self.fill() } }
        }
    }
}

final class Launcher: NSObject, NSApplicationDelegate, NSWindowDelegate, NSTableViewDataSource, NSTableViewDelegate, NSTextFieldDelegate, NSMenuDelegate {
    private var chrome = ChromeIndex()
    private let fileSearch = FileSearchIndex()
    private let aliases = AliasStore()
    private let commandAliases = CommandAliasStore()
    private let settings = SettingsStore()
    private let translator = TranslationWindow()
    private let comparer = TextCompareV2Window()
    private let jsonTool = JSONToolWindow()
    private let goldTool = GoldToolController()
    private let unicodeTool = UnicodeToolWindow()
    private let markdownTool = MarkdownToolWindow()
    private let commandManual = CommandManualWindow()
    private let idGenerator = IDGeneratorWindow()
    private let developerConverter = DeveloperConverterWindow()
    private let backendWorkbench = BackendWorkbenchWindow()
    private let imageTool = ImageToolWindow()
    private let localTextTool = LocalTextToolWindow()
    private let clipboardStore = ClipboardStore()
    private let snippets = SnippetStore()
    private let ranking = SearchRankingStore()
    private let commandFavorites = CommandFavorites()
    private let updater = UpdateManager()
    private lazy var clipboardWindow = ClipboardShelfWindow(store: clipboardStore)
    private lazy var stackWindow = PasteStackWindow(store: clipboardStore)
    private lazy var selectionWindow: SelectionActionWindow = {
        let window = SelectionActionWindow()
        window.onChoose = { [weak self] kind, content in self?.performSelectedAction(kind, content: content) }
        return window
    }()
    private var apps: [Entry] = []
    private var results: [Entry] = []
    private var titleMatchTerm = ""
    private var panel: NSPanel!
    private var field: SearchField!
    private var table: NSTableView!
    private var scroll: NSScrollView!
    private var divider: NSView!
    private var footer: NSTextField!
    private var brand: NSTextField!
    private var pinButton: NSButton!
    private var displayedResults: [Entry] = []
    private var displayedQuery = ""
    private var searchTargetFrame: NSRect?
    private let searchIconCache = NSCache<NSString, NSImage>()
    private let searchTextCache = NSCache<NSString, NSString>()
    private let searchIndexQueue = DispatchQueue(label: "local.openall.search-index", qos: .userInitiated)
    private var searchIndexRevision = 0
    private var indexRefreshRunning = false
    private var verifySearchAnimations = false
    private var pinnedSearch = false
    private var status: NSStatusItem!
    private var hotkey: EventHotKeyRef?
    private var clipboardHotkey: EventHotKeyRef?
    private var stackHotkey: EventHotKeyRef?
    private var selectionHotkey: EventHotKeyRef?
    private var stackPasteHotkey: EventHotKeyRef?
    private var stackPasteSuspended = false
    private var hotkeyHandler: EventHandlerRef?
    private let doubleTapMonitor = DoubleTapMonitor()
    private var lastDoubleTapPress: TimeInterval = 0
    private var shortcutAvailable = false
    private var clipboardShortcutAvailable = false
    private var stackShortcutAvailable = false
    private var selectionShortcutAvailable = false
    private var actionEntry: Entry?
    private var recordMonitor: Any?
    private weak var recordButton: NSButton?
    private weak var settingsStatus: NSTextField?
    private var settingsWindow: SettingsWindow?
    private weak var permissionsView: PermissionsView?
    private weak var searchFileHint: NSTextField?
    private var settingsBody: NSView?
    private var settingsTabIndex = 0
    private var settingsSearchManager = false
    private var updateSettingsExpanded = false
    private var chromeAdvancedExpanded = false
    private var settingsNavigation: [SettingsNavItem] = []
    private weak var clipboardStatus: NSTextField?
    private var previousApplication: NSRunningApplication?
    private var refreshTimer: Timer?
    private var chromePathField: NSTextField?
    private weak var updateStatus: NSTextField?
    private var appearanceCustomExpanded = false
    private weak var appearancePreview: NSView?
    private weak var appearanceAccentSample: NSView?
    private weak var backgroundHexLabel: NSTextField?
    private weak var accentHexLabel: NSTextField?
    private weak var backgroundSwatch: NSButton?
    private weak var accentSwatch: NSButton?
    private var appearancePresetButtons: [AppearancePresetButton] = []
    private let backgroundPresets = [("石墨", OpenAllTheme.defaultBackgroundHex), ("深蓝", "#172838"), ("暖棕", "#30251F"), ("雾白", "#F2F1ED"), ("跟随系统", "SYSTEM")]
    private let accentPresets = [("香槟", OpenAllTheme.defaultAccentHex), ("海蓝", "#5E9CCD"), ("青绿", "#63B8A4"), ("珊瑚", "#D9917B")]
    private var choosingAppearanceTag = 1

    func applicationDidFinishLaunching(_ notification: Notification) {
        goldTool.onAppearanceSettings = { [weak self] in
            guard let self else { return }
            self.settingsTabIndex = 7
            self.showSettings()
        }
        WindowChrome.rememberCurrentTheme()
        if DesignPreview.enabled {
            NSApp.setActivationPolicy(.prohibited)
            buildWindow()
            Task { @MainActor in
                do { try await self.renderDesignSnapshots() }
                catch { print("预览失败：\(error)"); exit(1) }
                NSApp.terminate(nil)
            }
            return
        }
        NSApp.setActivationPolicy(.accessory)
        if let path = Bundle.main.path(forResource: "OpenAll-icon", ofType: "png"),
           let icon = NSImage(contentsOfFile: path) { NSApp.applicationIconImage = icon }
        buildWindow()
        DistributedNotificationCenter.default.addObserver(self, selector: #selector(systemAppearanceChanged),
                                                          name: NSNotification.Name("AppleInterfaceThemeChangedNotification"), object: nil)
        updater.onStatus = { [weak self] message in self?.updateStatus?.stringValue = message }
        fileSearch.onChange = { [weak self] in
            self?.update()
            self?.permissionsView?.refreshFileStatus()
            self?.refreshFileSearchHint()
        }
        buildMenu()
        registerHotkey()
        clipboardStore.start()
        clipboardWindow.snippets = snippets
        clipboardWindow.onSendToTool = { [weak self] tool, text in
            guard let self else { return }
            switch tool {
            case "translate": self.translator.show(text)
            case "comparison": self.comparer.show(text)
            case "json": self.jsonTool.show(text)
            case "markdown": self.markdownTool.show(text)
            default: break
            }
        }
        clipboardWindow.onOpenActions = { [weak self] item in self?.showClipboardItemActions(item) }
        clipboardWindow.onCompareText = { [weak self] left, right in self?.comparer.show(left, right: right) }
        snippets.onChange = { [weak self] in self?.update() }
        _ = clipboardStore.addObserver { [weak self] in self?.syncStackPasteHotkey() }
        installDoubleTapMonitor()
        refreshIndex()
        refreshTimer = Timer.scheduledTimer(withTimeInterval: 90, repeats: true) { [weak self] _ in self?.refreshIndex() }
        show()
    }

    func applicationWillTerminate(_ notification: Notification) {
        goldTool.stop()
    }

    @MainActor private func renderDesignSnapshots() async throws {
        if ProcessInfo.processInfo.environment["OPENALL_MANUAL_CHECK"] == "1" {
            commandManual.show()
            try await commandManual.verifyForDesign()
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_GOLD_CHECK"] == "1" {
            for (index, query) in ["金价", "gold", "金价桌台"].enumerated() {
                field.stringValue = query
                update()
                guard results.first?.kind == .command, results.first?.value == "gold" else {
                    throw NSError(domain: "GoldRoutingRegression", code: 1,
                                  userInfo: [NSLocalizedDescriptionKey: "金价入口搜索失败：\(query)"])
                }
                try DesignPreview.capture(panel, name: "gold-search-\(index + 1)")
            }
            try await goldTool.verifyForDesign()
            print("金价原生入口与内置组件专项检查通过")
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_SETTINGS_CHECK"] == "1" {
            settingsTabIndex = 0
            showSettings()
            guard let window = settingsWindow, let general = settingsNavigation.first(where: { $0.tag == 0 }),
                  let appearance = settingsNavigation.first(where: { $0.tag == 7 }) else {
                throw NSError(domain: "SettingsWindow", code: 1)
            }
            // 常规截图进程不可激活；只有实际焦点检查需要键盘主窗口。
            let originalPolicy = NSApp.activationPolicy()
            NSApp.setActivationPolicy(.accessory)
            NSApp.activate(ignoringOtherApps: true)
            window.makeKeyAndOrderFront(nil)
            defer { window.orderOut(nil); NSApp.setActivationPolicy(originalPolicy) }
            let activationLimit = Date().addingTimeInterval(3)
            while !window.isKeyWindow && Date() < activationLimit { try await Task.sleep(nanoseconds: 20_000_000) }
            guard window.isKeyWindow else { throw NSError(domain: "SettingsKeyWindow", code: 1) }
            let originalFrames = settingsNavigation.map(\.frame)
            func sidebarShows(_ tag: Int, focus: SettingsNavItem? = nil) -> Bool {
                settingsTabIndex == tag && settingsNavigation.filter(\.selected).map(\.tag) == [tag] &&
                settingsNavigation.filter(\.showsKeyboardFocus).map(\.tag) == (focus.map { [$0.tag] } ?? [])
            }
            func key(_ code: UInt16, _ text: String, shift: Bool = false) throws {
                for type in [NSEvent.EventType.keyDown, .keyUp] {
                    guard let event = NSEvent.keyEvent(with: type, location: .zero,
                        modifierFlags: shift ? .shift : [], timestamp: ProcessInfo.processInfo.systemUptime,
                        windowNumber: window.windowNumber, context: nil, characters: text,
                        charactersIgnoringModifiers: text, isARepeat: false, keyCode: code) else {
                        throw NSError(domain: "SettingsKeyEvent", code: Int(code))
                    }
                    window.sendEvent(event)
                }
            }
            guard sidebarShows(0) else { throw NSError(domain: "SettingsInitialFocus", code: 1) }
            window.recalculateKeyViewLoop()
            // 以实际键序为准。关闭系统键盘导航时，普通按钮可被 Tab 正常跳过。
            let canTabToSidebar = appearance.canBecomeKeyView
            print("设置侧栏可用 Tab 遍历：\(canTabToSidebar)，系统完整键盘访问：\(NSApp.isFullKeyboardAccessEnabled)")
            if canTabToSidebar {
                for _ in 0..<64 {
                    try key(48, "\t")
                    if window.firstResponder === appearance { break }
                }
                guard sidebarShows(0, focus: appearance) else { throw NSError(domain: "SettingsTabFocus", code: 1) }
                try key(48, "\u{19}", shift: true)
                guard !appearance.showsKeyboardFocus, settingsTabIndex == 0 else { throw NSError(domain: "SettingsBacktab", code: 1) }
                try key(48, "\t")
                guard sidebarShows(0, focus: appearance) else { throw NSError(domain: "SettingsTabReturn", code: 1) }
                try key(49, " ")
                guard sidebarShows(7, focus: appearance) else { throw NSError(domain: "SettingsSpace", code: 1) }
            } else {
                try key(48, "\t")
                guard sidebarShows(0) else { throw NSError(domain: "SettingsSkippedButton", code: 1) }
                appearance.performClick(nil)
                guard settingsTabIndex == 7 else { throw NSError(domain: "SettingsPointerSelection", code: 1) }
            }

            // NSButton 在鼠标按下时进入跟踪循环，预先放入抬起事件使这次点击完整结束。
            let location = general.convert(NSPoint(x: general.bounds.midX, y: general.bounds.midY), to: nil)
            func mouse(_ type: NSEvent.EventType) throws -> NSEvent {
                guard let event = NSEvent.mouseEvent(with: type, location: location, modifierFlags: [],
                    timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: window.windowNumber,
                    context: nil, eventNumber: 1, clickCount: 1, pressure: type == .leftMouseDown ? 1 : 0) else {
                    throw NSError(domain: "SettingsMouseEvent", code: 1)
                }
                return event
            }
            NSApp.postEvent(try mouse(.leftMouseUp), atStart: true)
            window.sendEvent(try mouse(.leftMouseDown))
            guard sidebarShows(0), (!general.acceptsFirstResponder || window.firstResponder === general), settingsNavigation.map(\.frame) == originalFrames else {
                throw NSError(domain: "SettingsPointerFocus", code: 1)
            }
            try DesignPreview.capture(window, name: "settings-mouse-general")
            window.orderOut(nil)
            performCommand("diagnostics")
            window.makeKeyAndOrderFront(nil)
            guard let diagnostics = settingsNavigation.first(where: { $0.tag == 6 }), sidebarShows(6),
                  (!diagnostics.acceptsFirstResponder || window.firstResponder === diagnostics) else {
                throw NSError(domain: "SettingsReopenFocus", code: 1)
            }
            appearance.performClick(nil)
            for (name, color) in [("settings-dark", "#242626"), ("settings-light", "#F2F1ED")] {
                try await OpenAllTheme.withTemporaryAppearanceForDesign(background: OpenAllTheme.color(color), accent: nil) {
                    self.renderSettings()
                    let selected = self.appearancePresetButtons.filter(\.chosen)
                    guard selected.count == 2, selected.contains(where: { $0.tag == 100 }),
                          let background = selected.first(where: { $0.tag < 100 }),
                          OpenAllTheme.hex(background.swatchColor) == color,
                          let preview = self.appearancePreview, preview.layer?.borderWidth == 1,
                          let fill = self.settingsBody?.layer?.backgroundColor, let actual = NSColor(cgColor: fill),
                          OpenAllTheme.hex(actual) == color else {
                        throw NSError(domain: "SettingsPalette", code: 1)
                    }
                    try DesignPreview.capture(window, name: name)
                }
            }
            clipboardStore.seedPreviewRecords()
            clipboardWindow.show(target: nil)
            guard let shelf = DesignPreview.lastWindow, clipboardWindow.verifySearchAppearanceForDesign() else {
                throw NSError(domain: "ClipboardAppearance", code: 1)
            }
            try DesignPreview.capture(shelf, name: "clipboard-solid")
            print("设置即时选中、深浅主题预览与剪贴板焦点检查通过")
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_APPEARANCE_CHECK"] == "1" {
            clipboardStore.seedPreviewRecords()
            clipboardWindow.show(target: nil)
            guard clipboardWindow.verifySearchAppearanceForDesign() else { throw NSError(domain: "ClipboardAppearanceRegression", code: 1) }
            guard clipboardWindow.verifySearchSelectionForDesign() else { throw NSError(domain: "ClipboardSearchSelectionRegression", code: 1) }
            guard try clipboardWindow.verifySearchFocusForDesign() else { throw NSError(domain: "ClipboardSearchFocusRegression", code: 1) }
            guard try clipboardWindow.verifyFocusedDeletionForDesign() else { throw NSError(domain: "ClipboardFocusRegression", code: 1) }
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "clipboard-appearance")
            print("剪贴板主题、过滤计数、多选、搜索焦点与卡片删除检查通过")
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_SEARCH_LATENCY_CHECK"] == "1" {
            try await verifySearchLatencyForDesign()
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_COMPARISON_CHECK"] == "1" {
            idGenerator.show()
            guard idGenerator.verifyForDesign() else { throw NSError(domain: "IDGeneratorRegression", code: 1) }
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "06-id")
            comparer.showDesignSample()
            guard try await comparer.verifyForDesign() else { throw NSError(domain: "ComparisonRegression", code: 1) }
            comparer.show("")
            try await DesignPreview.captureWeb(DesignPreview.lastWindow!, name: "08-comparison")
            guard try await comparer.verifyPerformanceForDesign() else { throw NSError(domain: "ComparisonPerformanceRegression", code: 1) }
            print("文本对比与身份证专项检查通过")
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_JSON_CHECK"] == "1" {
            guard try jsonTool.verifyFoldingForDesign() else { throw NSError(domain: "JSONFoldingRegression", code: 1) }
            guard try await jsonTool.verifyPerformanceForDesign() else { throw NSError(domain: "JSONPerformanceRegression", code: 1) }
            print("JSON 折叠编辑与大文本专项检查通过")
            return
        }
        if ProcessInfo.processInfo.environment["OPENALL_PERFORMANCE_CHECK"] == "1" {
            let rounds = min(10, max(1, Int(ProcessInfo.processInfo.environment["OPENALL_STRESS_ROUNDS"] ?? "1") ?? 1))
            for round in 1...rounds {
                print("压力测试第 \(round) / \(rounds) 轮")
                guard try await jsonTool.verifyPerformanceForDesign() else { throw NSError(domain: "JSONPerformanceRegression", code: 1) }
                comparer.showDesignSample()
                guard try await comparer.verifyPerformanceForDesign() else { throw NSError(domain: "ComparisonPerformanceRegression", code: 1) }
            }
            print("大文本专项检查通过")
            return
        }
        resizePanel()
        try DesignPreview.capture(panel, name: "01-search")
        field.stringValue = "设置"
        update()
        try DesignPreview.capture(panel, name: "01-search-settings")
        field.stringValue = "格式"
        update()
        try DesignPreview.capture(panel, name: "01-search-tools")
        commandAliases.update(id: "settings", names: ["偏好"])
        field.stringValue = "偏好"
        update()
        try DesignPreview.capture(panel, name: "01-search-custom-alias")
        field.stringValue = "知乎"
        update()
        try DesignPreview.capture(panel, name: "01-search-zhihu")
        field.stringValue = "2026-11-03 13:09:36 +8 +40M"
        update()
        try DesignPreview.capture(panel, name: "01-search-time")
        for query in ["文本对比", "diff", "文本对比 V2", "diff2", "diff v2"] {
            field.stringValue = query
            update()
            guard results.first?.kind == .comparison, results.first?.value == "",
                  !results.contains(where: { $0.kind == .command && $0.value == "comparisonV2" }) else {
                throw NSError(domain: "ComparisonRoutingRegression", code: 1)
            }
        }
        field.stringValue = "文本对比"
        update()
        try DesignPreview.capture(panel, name: "01-search-comparison")
        field.stringValue = "json"
        update()
        guard results.first?.kind == .json else {
            throw NSError(domain: "JSONToolRoutingRegression", code: 1)
        }
        field.stringValue = ""
        update()
        if ProcessInfo.processInfo.environment["OPENALL_SEARCH_DESIGN_ONLY"] == "1" || ProcessInfo.processInfo.environment["OPENALL_SEARCH_SIZE_CHECK"] == "1" {
            try verifyRestoredSearchForDesign()
            try await verifySearchAnimationForDesign()
            return
        }
        guard ClipboardShelfWindow.verifyLocalTargetsForDesign() else { throw NSError(domain: "LocalClipboardRegression", code: 1) }
        clipboardStore.seedPreviewRecords()
        clipboardWindow.show(target: nil)
        try await Task.sleep(nanoseconds: 350_000_000)
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "02-clipboard")
        try clipboardWindow.captureEditingForDesign()
        clipboardWindow.showSelectedPreviewForDesign()
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "02-clipboard-preview")
        clipboardWindow.showSearchForDesign("json")
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "02-clipboard-json")
        clipboardWindow.showSearchForDesign("Markdown")
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "02-clipboard-markdown")
        guard clipboardWindow.verifySearchSelectionForDesign() else {
            throw NSError(domain: "ClipboardSearchSelectionRegression", code: 1)
        }
        guard try clipboardWindow.verifySearchFocusForDesign() else {
            throw NSError(domain: "ClipboardSearchFocusRegression", code: 1)
        }
        guard try clipboardWindow.verifyFocusedDeletionForDesign() else {
            throw NSError(domain: "ClipboardFocusedDeletionRegression", code: 1)
        }
        for index in 0..<9 {
            settingsTabIndex = index
            showSettings()
            try DesignPreview.capture(settingsWindow!, name: "02-settings-\(index)")
            if index == 4 {
                guard let editor = settingsBody?.subviews.compactMap({ $0 as? SnippetEditorView }).first,
                      editor.verifyCreationForDesign() else { throw NSError(domain: "SnippetEditRegression", code: 1) }
            }
            if index == 8 {
                guard let editor = settingsBody?.subviews.compactMap({ $0 as? CommandAliasEditorView }).first,
                      editor.verifyFilterForDesign() else { throw NSError(domain: "CommandAliasFilterRegression", code: 1) }
            }
            if index == 7 {
                appearanceCustomExpanded = true
                showSettings()
                try DesignPreview.capture(settingsWindow!, name: "02-settings-7-custom")
                appearanceCustomExpanded = false
            }
            if index == 3 {
                guard let editor = settingsBody?.subviews.compactMap({ $0 as? AliasEditorView }).first,
                      editor.verifyScrollRetentionForDesign() else {
                    throw NSError(domain: "AliasScrollRegression", code: 1)
                }
            }
        }
        settingsTabIndex = 1
        settingsSearchManager = true
        showSettings()
        try DesignPreview.capture(settingsWindow!, name: "02-settings-search-manager")
        settingsSearchManager = false
        let savedSearchSettings = settings.value
        var advancedSearchSettings = savedSearchSettings
        advancedSearchSettings.searchBookmarks = true
        settings.update(advancedSearchSettings)
        chromeAdvancedExpanded = true
        showSettings()
        try DesignPreview.capture(settingsWindow!, name: "02-settings-search-advanced")
        chromeAdvancedExpanded = false
        settings.update(savedSearchSettings)
        _ = snippets.add(name: "客户回复", keyword: "reply", body: "你好，感谢反馈。\n我们会在今天完成确认，并同步处理结果。")
        settingsTabIndex = 4
        showSettings()
        try DesignPreview.capture(settingsWindow!, name: "02-settings-snippet-edit")
        let previewBoard = NSPasteboard.withUniqueName()
        defer { previewBoard.releaseGlobally() }
        let stackStore = ClipboardStore(pasteboard: previewBoard, directory: DesignPreview.home.appendingPathComponent("Stack"))
        stackStore.beginStack(captureCurrent: false)
        for value in ["会议纪要 · 产品体验", "确认新版交互与快捷键", "周五前完成回归测试"] {
            previewBoard.clearContents()
            previewBoard.setString(value, forType: .string)
            stackStore.poll(force: true, allowOwnApp: true)
        }
        let stackPreview = PasteStackWindow(store: stackStore)
        stackPreview.showForDesign()
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "11-paste-stack")
        translator.show("Open the project folder to review the changes.")
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "12-translation-loading")
        translator.showFailureForDesign()
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "12-translation-failed")
        jsonTool.show("{\"project\":\"OpenAll\",\"count\":2}", initialOperation: 0)
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "03-json")
        guard try jsonTool.verifyFoldingForDesign() else {
            throw NSError(domain: "JSONFoldingRegression", code: 1)
        }
        for mode in ConversionMode.allCases {
            developerConverter.showDesignSample(mode)
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "03-converter-\(mode.rawValue)")
        }
        for mode in BackendMode.allCases {
            backendWorkbench.showDesignSample(mode)
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "03-backend-\(mode.rawValue)")
        }
        for (name, mode) in [("config-format", LocalTextToolWindow.Mode.configuration),
                             ("sql-format", .sql)] {
            let previewTool = LocalTextToolWindow()
            previewTool.showDesignSample(mode)
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "03-\(name)")
        }
        commandManual.show()
        try await commandManual.verifyForDesign()
        guard MarkdownRenderer.verifyRenderingForDesign() else { throw NSError(domain: "MarkdownRenderRegression", code: 1) }
        markdownTool.show("""
        # 项目记录

        ## 本周进展
        OpenAll 将常用操作放在键盘触手可及的位置：搜索、剪贴板与开发工具可以连续使用。

        - [x] 支持在 JSON 中原地格式化和编辑
        - [x] 文本对比左右区域可直接修改
        - [ ] 收集下一轮使用反馈

        ## 验收清单
        | 场景 | 预期结果 |
        | --- | --- |
        | 剪贴板粘贴 | 保留目标编辑区与选区 |
        | 大内容处理 | 计算期间仍可继续操作 |
        | 搜索定位 | 当前匹配清楚可见 |

        > 每次调整都需要回到真实的使用路径中检查。

        ## 常用快捷键
        使用 `⌘F` 查找内容，使用 `⌘Z` 撤销最近一次修改。
        """)
        try await markdownTool.waitForPreviewForDesign()
        try await DesignPreview.captureWeb(DesignPreview.lastWindow!, name: "04-markdown")
        markdownTool.showHelpForDesign()
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "04-markdown-help")
        unicodeTool.show("你好，OpenAll 👋")
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "05-unicode")
        idGenerator.show()
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "06-id")
        let imageSample = DesignPreview.home.appendingPathComponent("Library/Application Support/OpenAll/Clipboard/preview-image.png")
        if let image = NSImage(contentsOf: imageSample) { imageTool.show(image) }
        else { imageTool.show() }
        try await Task.sleep(nanoseconds: 500_000_000)
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "07-image")
        guard NSApp.sendAction(Selector(("cropImage")), to: imageTool, from: nil),
              let crop = DesignPreview.lastWindow, crop.contentView != nil else {
            throw NSError(domain: "ImageCropPreview", code: 1)
        }
        try DesignPreview.capture(crop, name: "07-image-crop")
        comparer.showDesignSample()
        guard try await comparer.verifyForDesign() else {
            throw NSError(domain: "ComparisonRegression", code: 1)
        }
        comparer.show("")
        try await DesignPreview.captureWeb(DesignPreview.lastWindow!, name: "08-comparison")
        selectionWindow.show(.text("第一行：这段选中的内容会完整显示在可滚动区域中。\n第二行：即使文字较长，也不会被压缩成一条难以阅读的摘要。\n第三行：选择操作后即可继续处理。"))
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "09-selection-text")
        guard selectionWindow.focusPreviewThenActionsForDesign() else {
            throw NSError(domain: "SelectionFocusRegression", code: 1)
        }
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "09-selection-return")
        let previewImage = Bundle.main.path(forResource: "OpenAll-icon", ofType: "png").flatMap { NSImage(contentsOfFile: $0) }
        if let previewImage {
            selectionWindow.show(.image(previewImage))
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "09-selection-image")
        }
        // 识别前后截同一张样本图片，使用应用正式的本地 Vision 识别器。
        let sample = NSImage(size: NSSize(width: 800, height: 210), flipped: false) { bounds in
            NSColor.white.setFill()
            NSBezierPath(rect: bounds).fill()
            ("OPENALL NOTES" as NSString).draw(at: NSPoint(x: 30, y: 115),
                withAttributes: [.font: NSFont.boldSystemFont(ofSize: 48), .foregroundColor: NSColor.black])
            ("Meeting room 12345" as NSString).draw(at: NSPoint(x: 30, y: 45),
                withAttributes: [.font: NSFont.systemFont(ofSize: 36), .foregroundColor: NSColor.black])
            return true
        }
        selectionWindow.show(nil, message: "正在识别图片文字…", image: sample)
        try DesignPreview.capture(DesignPreview.lastWindow!, name: "10-selection-ocr")
        let (text, recognitionError): (String?, String?) = await withCheckedContinuation { continuation in
            ImageTextRecognizer.recognize(sample) { continuation.resume(returning: ($0, $1)) }
        }
        if let text {
            guard text.contains("12345") else { throw NSError(domain: "SelectionOCRPreview", code: 1) }
            selectionWindow.show(.text(text))
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "10-selection-ocr-result")
        } else {
            selectionWindow.show(nil, message: recognitionError)
            try DesignPreview.capture(DesignPreview.lastWindow!, name: "10-selection-ocr-unavailable")
            print("本机 Vision 未返回识别结果：\(recognitionError ?? "未识别到文字")")
        }
        let visibleCount = NSApp.windows.filter { $0.isVisible }.count
        guard visibleCount == 0 else { throw NSError(domain: "DesignPreviewVisibleWindow", code: visibleCount) }
        print("离屏预览完成，visibleWindows=0：\(DesignPreview.output.path)")
    }

    @MainActor private func verifySearchLatencyForDesign() async throws {
        let folder = DesignPreview.home.appendingPathComponent("SearchLatency/Default")
        try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
        let nodes = (0..<240).map { index in
            ["type": "url", "name": "项目资料 \(index) 配置格式与界面设计", "url": "https://example.test/project/\(index)"]
        }
        let data: [String: Any] = ["roots": ["bookmark_bar": ["children": nodes]]]
        try JSONSerialization.data(withJSONObject: data).write(to: folder.appendingPathComponent("Bookmarks"))
        var prefs = settings.value
        prefs.searchBookmarks = true; prefs.searchHistory = false; prefs.searchFiles = false
        settings.update(prefs)
        prefs.chromePath = folder.path
        settings.update(prefs)
        let indexStart = ProcessInfo.processInfo.systemUptime
        refreshIndex()
        while indexRefreshRunning {
            guard ProcessInfo.processInfo.systemUptime - indexStart < 30 else { throw NSError(domain: "SearchIndexTimeout", code: 1) }
            try await Task.sleep(nanoseconds: 10_000_000)
        }
        let indexMilliseconds = (ProcessInfo.processInfo.systemUptime - indexStart) * 1000
        let queries = ["p", "pe", "pei", "peiz", "peizh", "peizhi", "格", "格式", "j", "js", "json", "", "终", "终端", "?", "?json", "zzzz-no-match", ""]
        var rounds: [[Double]] = []
        for _ in 0..<4 {
            var samples: [Double] = []
            for query in queries {
                field.stringValue = query
                let start = ProcessInfo.processInfo.systemUptime
                update()
                table.layoutSubtreeIfNeeded()
                samples.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
            }
            rounds.append(samples)
        }
        let warm = Array(rounds.dropFirst().joined()).sorted()
        // 同时覆盖真实使用后的权重表，避免仅空历史的测量掩盖排序成本。
        ranking.record(kind: "bookmark", value: "https://example.test/project/7")
        ranking.togglePinned(kind: "bookmark", title: "项目资料 7", value: "https://example.test/project/7")
        var rankedSamples: [Double] = []
        for _ in 0..<4 {
            for query in queries {
                field.stringValue = query
                let start = ProcessInfo.processInfo.systemUptime
                update(); table.layoutSubtreeIfNeeded()
                rankedSamples.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
            }
        }
        rankedSamples.sort()
        field.stringValue = "配置"; update()
        guard results.first?.value == "https://example.test/project/7" else { throw NSError(domain: "SearchPinnedOrder", code: 1) }
        ranking.toggleHidden(kind: "bookmark", title: "项目资料 7", value: "https://example.test/project/7")
        update()
        guard !results.contains(where: { $0.value == "https://example.test/project/7" }) else { throw NSError(domain: "SearchHiddenOrder", code: 1) }
        ranking.resetRule(kind: "bookmark", value: "https://example.test/project/7")
        // 扫描中连续修改来源，最终只能发布最后一次设置，保持查询与选择。
        field.stringValue = "格式"; update()
        table.selectRowIndexes(IndexSet(integer: 1), byExtendingSelection: false)
        let selectedValue = results[1].value
        prefs.searchBookmarks = false; settings.update(prefs); refreshIndex()
        prefs.chromePath = folder.path + "/missing"; settings.update(prefs); refreshIndex()
        prefs.searchBookmarks = true; prefs.chromePath = folder.path; settings.update(prefs); refreshIndex()
        let deadline = ProcessInfo.processInfo.systemUptime + 30
        var lastTick = ProcessInfo.processInfo.systemUptime
        var maximumTickGap: Double = 0
        while indexRefreshRunning {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw NSError(domain: "SearchRefreshTimeout", code: 1) }
            try await Task.sleep(nanoseconds: 10_000_000)
            let tick = ProcessInfo.processInfo.systemUptime
            maximumTickGap = max(maximumTickGap, (tick - lastTick) * 1000)
            lastTick = tick
        }
        guard chrome.bookmarks.count == 240, field.stringValue == "格式",
              results.indices.contains(table.selectedRow), results[table.selectedRow].value == selectedValue else {
            throw NSError(domain: "SearchIndexLatestRevision", code: 1)
        }
        print("搜索索引与排序检查通过：后台扫描、最新设置生效、查询选择保留、置顶隐藏即时更新")
        let report: [String: Any] = ["applications": apps.count, "bookmarks": chrome.bookmarks.count,
            "index_ready_ms": indexMilliseconds, "queries": queries, "cold_ms": rounds[0], "warm_median_ms": warm[warm.count / 2],
            "warm_p95_ms": warm[Int(Double(warm.count - 1) * 0.95)], "warm_max_ms": warm.last ?? 0,
            "with_ranking_median_ms": rankedSamples[rankedSamples.count / 2],
            "with_ranking_p95_ms": rankedSamples[Int(Double(rankedSamples.count - 1) * 0.95)],
            "refresh_maximum_main_tick_gap_ms": maximumTickGap]
        try FileManager.default.createDirectory(at: DesignPreview.output, withIntermediateDirectories: true)
        let output = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try output.write(to: DesignPreview.output.appendingPathComponent("latency.json"))
        print(String(data: output, encoding: .utf8)!)
    }

    @MainActor private func verifyRestoredSearchForDesign() throws {
        guard panel.frame.size == NSSize(width: 720, height: 76),
              field.frame == NSRect(x: 62, y: 5, width: 560, height: 44), field.font?.pointSize == 15,
              field.placeholderAttributedString?.string == "搜索应用、文件与更多" else { throw NSError(domain: "RestoredSearchGeometry", code: 1) }
        apps = [Entry(kind: .application, title: "Terminal", detail: "应用 · /System/Applications/Utilities/Terminal.app", value: "/System/Applications/Utilities/Terminal.app", rank: 70)]
        for (query, name) in [("终端", "01-search-application"), ("?", "01-search-catalog"), ("2+3", "01-search-calculator"), ("文件 报告", "01-search-file-disabled"), ("zz-unmatched-982741", "01-search-no-results"), ("翻译 为产品上线前的最终验证准备一份完整的检查清单，确认搜索、快捷键和剪贴板在不同应用中都能连续使用", "01-search-long-query")] {
            field.stringValue = query; update()
            if query == "终端" { guard results.first?.kind == .application else { throw NSError(domain: "RestoredSearchApplication", code: 1) } }
            if query == "?" {
                guard results.count > 7, table.rowHeight == 56 else { throw NSError(domain: "RestoredSearchCatalog", code: 1) }
                move(1)
                guard table.selectedRow == 1, footer.stringValue.contains("⌘K 操作") else { throw NSError(domain: "RestoredSearchNavigation", code: 1) }
            }
            if query == "2+3" {
                let row = table.rowView(atRow: 0, makeIfNecessary: true) as? SearchResultRowView
                guard results.first?.value == "5", row?.returnAction == "复制", footer.stringValue == "⌘K 操作" else {
                    throw NSError(domain: "SearchCalculatorAction", code: 1)
                }
            }
            if query == "文件 报告" { guard results.isEmpty, footer.stringValue.contains("文件搜索已关闭") else { throw NSError(domain: "RestoredSearchFiles", code: 1) } }
            if query.hasPrefix("zz-") {
                activateSelection()
                guard results.isEmpty, scroll.isHidden, field.stringValue == query, footer.stringValue.contains("没有匹配结果") else { throw NSError(domain: "RestoredSearchEmpty", code: 1) }
            }
            if query.hasPrefix("翻译 ") { guard results.first?.value == String(query.dropFirst(3)) else { throw NSError(domain: "RestoredSearchTranslation", code: 1) } }
            try DesignPreview.capture(panel, name: name)
        }
        // 旧的小尺寸字段直接忽略，其余偏好仍可正常读取。
        let legacy = try JSONDecoder().decode(LaunchSettings.self, from: Data(#"{"searchInterfaceSize":"small","pinyinEnabled":false}"#.utf8))
        guard !legacy.pinyinEnabled,
              !String(data: try JSONEncoder().encode(legacy), encoding: .utf8)!.contains("searchInterfaceSize") else {
            throw NSError(domain: "RemovedSearchSizeMigration", code: 1)
        }
        field.stringValue = "格式"; update()
        panel.makeFirstResponder(field); field.selectText(nil)
        guard let editor = field.currentEditor() as? NSTextView else { throw NSError(domain: "RestoredSearchFocus", code: 1) }
        editor.insertText("中文测试", replacementRange: NSRange(location: NSNotFound, length: 0))
        guard field.stringValue == "中文测试" else { throw NSError(domain: "RestoredSearchTyping", code: 1) }
        editor.selectAll(nil); editor.deleteBackward(nil)
        guard field.stringValue.isEmpty, results.isEmpty else { throw NSError(domain: "RestoredSearchDelete", code: 1) }
        field.stringValue = "设置"; update(); field.onAccept?()
        guard settingsWindow != nil else { throw NSError(domain: "RestoredSearchReturn", code: 1) }
        settingsTabIndex = 1; renderSettings()
        guard settingsBody?.subviews.contains(where: { $0.identifier?.rawValue == "searchInterfaceSize" }) == false else { throw NSError(domain: "RestoredSearchSizeSetting", code: 1) }
        try DesignPreview.capture(settingsWindow!, name: "02-settings-search")
        guard ClipboardShelfWindow.verifyLocalTargetsForDesign(), NSApp.windows.allSatisfy({ !$0.isVisible }) else { throw NSError(domain: "RestoredSearchToolPaste", code: 1) }
        print("搜索恢复检查通过：0.25.1 几何尺寸、应用/功能/文件前缀、目录与键盘导航、无结果、翻译全文、中文编辑、旧小尺寸配置兼容、工具间粘贴")
    }

    @MainActor private func verifySearchAnimationForDesign() async throws {
        field.stringValue = ""; update()
        panel.makeFirstResponder(field)
        let editor = panel.firstResponder
        let top = panel.frame.maxY
        verifySearchAnimations = true
        defer { verifySearchAnimations = false }
        field.stringValue = "?"; update()
        var intermediateFrames = 0
        for _ in 0..<25 {
            try await Task.sleep(nanoseconds: 10_000_000)
            if panel.frame.height > 76 && panel.frame.height < 512 { intermediateFrames += 1 }
            guard abs(panel.frame.maxY - top) < 1,
                  abs(field.frame.minY - (panel.contentView!.bounds.height - 71)) < 1 else {
                throw NSError(domain: "SearchAnimationAnchor", code: 1)
            }
        }
        guard abs(panel.frame.height - 512) < 1 else { throw NSError(domain: "SearchAnimationExpand", code: 1) }
        for query in ["格", "格式", "?", "json", "", "?json"] {
            field.stringValue = query; update()
            try await Task.sleep(nanoseconds: 20_000_000)
        }
        try await Task.sleep(nanoseconds: 250_000_000)
        guard abs(panel.frame.height - CGFloat(120 + min(results.count, 7) * 56)) < 1,
              panel.frame.width == 720, panel.firstResponder === editor, field.stringValue == "?json",
              !results.isEmpty, table.selectedRow == 0 else { throw NSError(domain: "SearchAnimationRetarget", code: 1) }
        table.selectRowIndexes(IndexSet(integer: 0), byExtendingSelection: false)
        let stable = panel.frame
        update(); update()
        guard panel.frame == stable else { throw NSError(domain: "SearchIdenticalResultsLayout", code: 1) }
        if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && intermediateFrames == 0 {
            throw NSError(domain: "SearchAnimationMissingFrames", code: 1)
        }
        print("搜索动画检查通过：中间帧 \(intermediateFrames)、顶部与编辑焦点固定、连续输入重定向、重复结果不伸缩")
    }

    private func buildWindow() {
        panel = LauncherPanel(contentRect: NSRect(x: 0, y: 0, width: 720, height: 76),
                              styleMask: [.titled, .fullSizeContentView, .nonactivatingPanel], backing: .buffered, defer: false)
        panel.title = "OpenAll"
        panel.delegate = self
        panel.isFloatingPanel = true
        panel.level = .floating
        // 设计验收时保持面板可见，正式启动仍在失焦后自动隐藏。
        panel.hidesOnDeactivate = !ProcessInfo.processInfo.arguments.contains("--design-review")
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.standardWindowButton(.closeButton)?.isHidden = true
        panel.standardWindowButton(.miniaturizeButton)?.isHidden = true
        panel.standardWindowButton(.zoomButton)?.isHidden = true
        panel.isOpaque = false
        panel.backgroundColor = .clear
        panel.hasShadow = true
        panel.center()
        let root = SearchSurfaceView(frame: panel.contentView!.bounds)
        root.appearance = OpenAllTheme.appearance
        root.material = .hudWindow
        root.blendingMode = .behindWindow
        root.state = .active
        root.wantsLayer = true
        root.layer?.cornerRadius = 16
        root.layer?.masksToBounds = true
        root.layer?.borderWidth = 1
        root.layer?.borderColor = OpenAllTheme.rule.cgColor
        root.autoresizingMask = [.width, .height]
        panel.contentView = root
        let darkSurface = NSView(frame: root.bounds)
        darkSurface.autoresizingMask = [.width, .height]
        darkSurface.wantsLayer = true
        darkSurface.layer?.backgroundColor = OpenAllTheme.canvas.withAlphaComponent(0.96).cgColor
        root.addSubview(darkSurface)
        ButtonPressFeedback.install(on: panel)
        let icon = NSImageView(frame: NSRect(x: 25, y: 26, width: 24, height: 24))
        icon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: "搜索")
        icon.contentTintColor = OpenAllTheme.ink.withAlphaComponent(0.82)
        icon.tag = 101
        root.addSubview(icon)
        field = SearchField(frame: NSRect(x: 62, y: 5, width: 560, height: 44))
        field.placeholderAttributedString = NSAttributedString(string: "搜索应用、文件与更多",
            attributes: [.foregroundColor: OpenAllTheme.muted.withAlphaComponent(0.48),
                         .font: NSFont.systemFont(ofSize: 15, weight: .light)])
        field.font = NSFont.systemFont(ofSize: 15, weight: .regular)
        field.textColor = OpenAllTheme.ink
        field.isBezeled = false
        field.drawsBackground = false
        field.focusRingType = .none
        field.delegate = self
        field.onMove = { [weak self] delta in self?.move(delta) }
        field.onAccept = { [weak self] in self?.activateSelection() }
        field.onDismiss = { [weak self] in self?.panel.orderOut(nil) }
        field.onSettings = { [weak self] in self?.showSettings() }
        field.onActions = { [weak self] in self?.showActions() }
        root.addSubview(field)
        pinButton = NSButton(frame: NSRect(x: 656, y: 23, width: 38, height: 30))
        pinButton.isBordered = false
        pinButton.title = ""
        pinButton.font = .systemFont(ofSize: 11, weight: .medium)
        pinButton.image = NSImage(systemSymbolName: "pin", accessibilityDescription: "固定搜索窗口")
        pinButton.imagePosition = .imageOnly
        pinButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 15, weight: .regular)
        pinButton.contentTintColor = OpenAllTheme.ink
        pinButton.toolTip = "固定窗口在所有应用上层"
        pinButton.target = self
        pinButton.action = #selector(toggleSearchPin)
        root.addSubview(pinButton)
        divider = NSView(frame: NSRect(x: 18, y: 6, width: 684, height: 1))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        root.addSubview(divider)
        scroll = NSScrollView(frame: NSRect(x: 12, y: 34, width: 696, height: 8))
        scroll.hasVerticalScroller = false
        scroll.drawsBackground = false
        table = NSTableView(frame: scroll.bounds)
        table.style = .plain
        table.headerView = nil
        table.rowHeight = 56
        table.intercellSpacing = NSSize(width: 0, height: 0)
        table.backgroundColor = .clear
        table.selectionHighlightStyle = .regular
        let col = NSTableColumn(identifier: NSUserInterfaceItemIdentifier("result"))
        col.width = 696
        table.addTableColumn(col)
        table.dataSource = self
        table.delegate = self
        table.target = self
        table.doubleAction = #selector(activateSelection)
        let actions = NSMenu(title: "操作")
        actions.delegate = self
        table.menu = actions
        scroll.documentView = table
        root.addSubview(scroll)
        footer = NSTextField(labelWithString: "输入名称或 ? 浏览全部")
        footer.font = .systemFont(ofSize: 12, weight: .regular)
        footer.textColor = OpenAllTheme.muted
        footer.frame = NSRect(x: 24, y: 7, width: 570, height: 18)
        root.addSubview(footer)
        brand = NSTextField(labelWithString: "OPENALL")
        brand.font = .systemFont(ofSize: 10, weight: .semibold)
        brand.textColor = OpenAllTheme.muted.withAlphaComponent(0.72)
        brand.alignment = .right
        brand.frame = NSRect(x: 606, y: 11, width: 90, height: 16)
        brand.isHidden = true
        searchIconCache.countLimit = 128
        searchTextCache.countLimit = 4096
        root.onResize = { [weak self] in self?.layoutSearchContents() }
    }

    func windowDidResignKey(_ notification: Notification) {
        if ProcessInfo.processInfo.arguments.contains("--design-review") { return }
        if let window = notification.object as? NSWindow, window === panel, !pinnedSearch { panel.orderOut(nil) }
    }

    @objc private func toggleSearchPin() {
        pinnedSearch.toggle()
        panel.hidesOnDeactivate = !pinnedSearch
        panel.level = pinnedSearch ? .statusBar : .floating
        pinButton.image = NSImage(systemSymbolName: pinnedSearch ? "pin.fill" : "pin", accessibilityDescription: "固定搜索窗口")
        pinButton.title = ""
        pinButton.toolTip = pinnedSearch ? "取消固定搜索窗口" : "固定搜索窗口在前台"
        pinButton.contentTintColor = pinnedSearch ? OpenAllTheme.accentText : OpenAllTheme.ink
        pinButton.toolTip = pinnedSearch ? "取消固定" : "固定窗口在所有应用上层"
    }

    private func buildMenu() {
        let menuBar = NSMenu()
        let applicationItem = NSMenuItem()
        let applicationMenu = NSMenu(title: "OpenAll")
        applicationMenu.addItem(withTitle: "打开搜索", action: #selector(show), keyEquivalent: "").target = self
        applicationMenu.addItem(NSMenuItem.separator())
        applicationMenu.addItem(withTitle: "剪贴板抽屉", action: #selector(showClipboard), keyEquivalent: "").target = self
        applicationMenu.addItem(withTitle: "复制堆栈", action: #selector(showStack), keyEquivalent: "").target = self
        applicationMenu.addItem(withTitle: "对选中内容操作", action: #selector(showSelectionActions), keyEquivalent: "").target = self
        applicationMenu.addItem(NSMenuItem.separator())
        applicationMenu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: ",").target = self
        applicationMenu.addItem(NSMenuItem.separator())
        applicationMenu.addItem(withTitle: "退出 OpenAll", action: #selector(quit), keyEquivalent: "q").target = self
        applicationItem.submenu = applicationMenu
        menuBar.addItem(applicationItem)
        let editItem = NSMenuItem()
        let editMenu = NSMenu(title: "编辑")
        for (title, action, key) in [("撤销", "undo:", "z"), ("重做", "redo:", "Z"),
                                     ("剪切", "cut:", "x"), ("复制", "copy:", "c"),
                                     ("粘贴", "paste:", "v"), ("全选", "selectAll:", "a")] {
            let item = NSMenuItem(title: title, action: Selector(action), keyEquivalent: key.lowercased())
            if key == "Z" { item.keyEquivalentModifierMask = [.command, .shift] }
            editMenu.addItem(item)
        }
        editItem.submenu = editMenu
        menuBar.addItem(editItem)
        NSApp.mainMenu = menuBar

        status = NSStatusBar.system.statusItem(withLength: NSStatusItem.squareLength)
        let menuImage = Bundle.main.path(forResource: "MenuIcon", ofType: "png").flatMap { NSImage(contentsOfFile: $0) }
            ?? NSImage(systemSymbolName: "square.stack.3d.up.fill", accessibilityDescription: "OpenAll")
        menuImage?.isTemplate = true
        menuImage?.size = NSSize(width: 18, height: 18)
        status.button?.image = menuImage
        status.button?.imagePosition = .imageOnly
        let menu = NSMenu()
        menu.addItem(withTitle: "打开搜索", action: #selector(show), keyEquivalent: "")
        menu.addItem(withTitle: "剪贴板历史", action: #selector(showClipboard), keyEquivalent: "")
        menu.addItem(withTitle: "复制堆栈", action: #selector(showStack), keyEquivalent: "")
        menu.addItem(withTitle: "对选中内容操作", action: #selector(showSelectionActions), keyEquivalent: "")
        menu.addItem(withTitle: "设置…", action: #selector(showSettings), keyEquivalent: "")
        menu.addItem(withTitle: "重新扫描应用和 Chrome", action: #selector(refreshIndex), keyEquivalent: "")
        menu.addItem(NSMenuItem.separator())
        menu.addItem(withTitle: "退出 OpenAll", action: #selector(quit), keyEquivalent: "")
        for item in menu.items { item.target = self }
        status.menu = menu
    }

    private func registerHotkey() {
        if let hotkey { UnregisterEventHotKey(hotkey); self.hotkey = nil }
        if let clipboardHotkey { UnregisterEventHotKey(clipboardHotkey); self.clipboardHotkey = nil }
        if let stackHotkey { UnregisterEventHotKey(stackHotkey); self.stackHotkey = nil }
        if let selectionHotkey { UnregisterEventHotKey(selectionHotkey); self.selectionHotkey = nil }
        let id = EventHotKeyID(signature: OSType(0x58554E51), id: 1)
        shortcutAvailable = settings.value.searchShortcutMode == "combo"
            && RegisterEventHotKey(settings.value.keyCode, settings.value.modifiers, id,
                                   GetApplicationEventTarget(), 0, &hotkey) == noErr
        let clipboardID = EventHotKeyID(signature: OSType(0x58554E51), id: 2)
        let clipboardAvailable = RegisterEventHotKey(settings.value.clipboardKeyCode, settings.value.clipboardModifiers,
                                                     clipboardID, GetApplicationEventTarget(), 0, &clipboardHotkey) == noErr
        let stackID = EventHotKeyID(signature: OSType(0x58554E51), id: 3)
        let stackAvailable = RegisterEventHotKey(settings.value.stackKeyCode, settings.value.stackModifiers,
                                                 stackID, GetApplicationEventTarget(), 0, &stackHotkey) == noErr
        clipboardShortcutAvailable = clipboardAvailable
        stackShortcutAvailable = stackAvailable
        let selectionID = EventHotKeyID(signature: OSType(0x58554E51), id: 5)
        selectionShortcutAvailable = RegisterEventHotKey(settings.value.selectionKeyCode, settings.value.selectionModifiers,
                                                         selectionID, GetApplicationEventTarget(), 0, &selectionHotkey) == noErr
        if hotkeyHandler == nil {
            var spec = EventTypeSpec(eventClass: OSType(kEventClassKeyboard), eventKind: UInt32(kEventHotKeyPressed))
            InstallEventHandler(GetApplicationEventTarget(), { _, event, context -> OSStatus in
                guard let context = context else { return OSStatus(eventNotHandledErr) }
                let launcher = Unmanaged<Launcher>.fromOpaque(context).takeUnretainedValue()
                var hotkeyID = EventHotKeyID()
                GetEventParameter(event, EventParamName(kEventParamDirectObject), EventParamType(typeEventHotKeyID),
                                  nil, MemoryLayout<EventHotKeyID>.size, nil, &hotkeyID)
                guard hotkeyID.signature == OSType(0x58554E51) else { return OSStatus(eventNotHandledErr) }
                if hotkeyID.id == 4 { launcher.handleStackPasteHotkey() }
                else if hotkeyID.id == 2 { launcher.toggleClipboard() }
                else if hotkeyID.id == 3 { launcher.toggleStack() }
                else if hotkeyID.id == 5 { launcher.showSelectionActions() }
                else if hotkeyID.id == 1 { launcher.toggleSearch() }
                else { return OSStatus(eventNotHandledErr) }
                return noErr
            }, 1, &spec, Unmanaged.passUnretained(self).toOpaque(), &hotkeyHandler)
        }
        status?.button?.toolTip = settings.value.searchShortcutMode == "double"
            ? "搜索唤起方式：双击修饰键" : shortcutAvailable
            ? "启动快捷键：\(shortcutDescription(settings.value))" : "快捷键被系统或其他应用占用，请在设置中更换"
        if footer != nil { footer.stringValue = settings.value.searchShortcutMode == "double" || shortcutAvailable
            ? "↵ 打开  ·  ⌘K 操作  ·  ? 功能" : "快捷键被占用 · 可从菜单栏打开或更换快捷键" }
        clipboardStatus?.stringValue = (clipboardAvailable && stackAvailable) ? "剪贴板与复制堆栈快捷键已启用" : "剪贴板或复制堆栈快捷键被占用"
    }

    private func installDoubleTapMonitor() {
        doubleTapMonitor.stop()
        lastDoubleTapPress = 0
        guard settings.value.searchShortcutMode == "double", settings.value.doubleTapKeyCode != nil else { return }
        doubleTapMonitor.onEvent = { [weak self] event in self?.handleDoubleTapEvent(event) }
        _ = doubleTapMonitor.start()
    }

    private func handleDoubleTapEvent(_ event: NSEvent) {
        guard settings.value.searchShortcutMode == "double", let key = settings.value.doubleTapKeyCode else { return }
        let modifierKeys: [UInt32: Set<UInt16>] = [55: [55, 54], 54: [55, 54],
                                                   58: [58, 61], 61: [58, 61],
                                                   59: [59, 62], 62: [59, 62],
                                                   56: [56, 60], 60: [56, 60]]
        let matchingKeys = modifierKeys[key] ?? [UInt16(key)]
        if !matchingKeys.contains(event.keyCode) {
            if event.type == .keyDown { lastDoubleTapPress = 0 }
            return
        }
        let active = event.modifierFlags.intersection([.command, .option, .control, .shift])
        var wanted: NSEvent.ModifierFlags = []
        if settings.value.doubleTapModifiers & UInt32(cmdKey) != 0 { wanted.insert(.command) }
        if settings.value.doubleTapModifiers & UInt32(optionKey) != 0 { wanted.insert(.option) }
        if settings.value.doubleTapModifiers & UInt32(controlKey) != 0 { wanted.insert(.control) }
        if settings.value.doubleTapModifiers & UInt32(shiftKey) != 0 { wanted.insert(.shift) }
        let ownModifier: NSEvent.ModifierFlags = [55, 54].contains(event.keyCode) ? .command :
            [58, 61].contains(event.keyCode) ? .option : [59, 62].contains(event.keyCode) ? .control :
            [56, 60].contains(event.keyCode) ? .shift : []
        let now = ProcessInfo.processInfo.systemUptime
        let pressed = event.type == .keyDown || (event.type == .flagsChanged && active.contains(ownModifier))
        let repeatingKey = event.type == .keyDown && event.isARepeat
        if pressed && !repeatingKey && active == wanted.union(ownModifier) {
            let elapsed = now - lastDoubleTapPress
            if lastDoubleTapPress > 0 && elapsed >= 0.06 && elapsed <= 0.7 {
                lastDoubleTapPress = 0
                toggleSearch()
            } else {
                lastDoubleTapPress = now
            }
        }
    }

    @objc private func show() {
        field.stringValue = ""
        table.deselectAll(nil)
        if NSWorkspace.shared.frontmostApplication?.bundleIdentifier != Bundle.main.bundleIdentifier {
            previousApplication = NSWorkspace.shared.frontmostApplication
        }
        let screen = NSScreen.screens.first { $0.frame.contains(NSEvent.mouseLocation) } ?? NSScreen.main
        if let visible = screen?.visibleFrame {
            var frame = panel.frame
            frame.origin.x = visible.midX - frame.width / 2
            frame.origin.y = visible.maxY - max(120, visible.height * 0.22) - frame.height
            panel.setFrame(frame, display: false)
        }
        // 显示前完成空态布局，避免重新打开时先闪出上次的结果高度。
        searchTargetFrame = nil
        update()
        panel.makeKeyAndOrderFront(nil)
        WindowChrome.activate()
        panel.makeFirstResponder(field)
        (field.currentEditor() as? NSTextView)?.insertionPointColor = OpenAllTheme.accentText
        field.selectText(nil)
    }
    private func toggleSearch() {
        if panel.isVisible { panel.orderOut(nil) }
        else { show() }
    }
    private func toggleClipboard() {
        if clipboardWindow.isVisible { clipboardWindow.dismiss() }
        else { showClipboard() }
    }
    private func toggleStack() {
        if clipboardStore.stackActive { clipboardStore.endStack() }
        else { showStack() }
    }
    private func syncStackPasteHotkey() {
        if !clipboardStore.stackActive || stackPasteSuspended || !AXIsProcessTrusted() {
            if let stackPasteHotkey { UnregisterEventHotKey(stackPasteHotkey); self.stackPasteHotkey = nil }
            if !clipboardStore.stackActive || !AXIsProcessTrusted() { stackWindow.setPasteHotkeyActive(false) }
            return
        }
        guard stackPasteHotkey == nil else { return }
        let id = EventHotKeyID(signature: OSType(0x58554E51), id: 4)
        let registered = RegisterEventHotKey(UInt32(kVK_ANSI_V), UInt32(cmdKey), id,
                                             GetApplicationEventTarget(), 0, &stackPasteHotkey) == noErr
        stackWindow.setPasteHotkeyActive(registered)
    }
    private func handleStackPasteHotkey() {
        guard clipboardStore.stackActive else { return }
        stackPasteSuspended = true
        syncStackPasteHotkey()
        stackWindow.takeNextFromHotkey()
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.35) { [weak self] in
            guard let self else { return }
            self.stackPasteSuspended = false
            self.syncStackPasteHotkey()
        }
    }
    @objc private func showClipboard() {
        let front = NSWorkspace.shared.frontmostApplication
        let own = front?.processIdentifier == ProcessInfo.processInfo.processIdentifier
        let local = own ? NSApp.keyWindow : nil
        clipboardWindow.show(target: own && local == nil ? previousApplication : front, localWindow: local)
    }
    @objc private func showStack() {
        let front = NSWorkspace.shared.frontmostApplication
        clipboardWindow.dismiss()
        stackWindow.show(target: front?.bundleIdentifier == Bundle.main.bundleIdentifier ? previousApplication : front)
        syncStackPasteHotkey()
    }
    @objc private func showSelectionActions() {
        if let item = clipboardWindow.currentCard {
            showClipboardItemActions(item)
            return
        }
        if selectionWindow.isVisible { selectionWindow.hide(); return }
        let front = NSWorkspace.shared.frontmostApplication
        let target = front?.bundleIdentifier == Bundle.main.bundleIdentifier ? previousApplication : front
        SelectionCapture.capture(from: target, clipboardStore: clipboardStore) { [weak self] content, message in
            guard let self else { return }
            self.selectionWindow.show(content, message: message)
        }
    }

    private func performSelectedAction(_ kind: SelectionActionKind, content: SelectedContent) {
        let text: String?
        switch content {
        case .text(let value): text = value
        case .files(let urls): text = urls.map(\.path).joined(separator: "\n")
        case .image: text = nil
        }
        switch kind {
        case .copy:
            NSPasteboard.general.clearContents()
            if case .image(let image) = content { NSPasteboard.general.writeObjects([image]) }
            else if let text { NSPasteboard.general.setString(text, forType: .string) }
        case .translate: if let text { translator.show(text) }
        case .comparison: if let text { comparer.show(text) }
        case .json: if let text { jsonTool.show(text) }
        case .jsonFormat: if let text { jsonTool.show(text, initialOperation: 0) }
        case .jsonCompact: if let text { jsonTool.show(text, initialOperation: 1) }
        case .markdown: if let text { markdownTool.show(text) }
        case .unicode: if let text { unicodeTool.show(text, decode: nil) }
        case .converter: if let text { developerConverter.show(text) }
        case .snippet: if let text { _ = snippets.addQuick(body: text) }
        case .openURL:
            if let text, let url = URL(string: text), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                NSWorkspace.shared.open(url)
            }
        case .copyDomain:
            if let text, let domain = URL(string: text)?.host {
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(domain, forType: .string)
            }
        case .imageTool:
            switch content {
            case .image(let image): imageTool.show(image)
            case .files(let urls): if let first = urls.first { imageTool.show(url: first) }
            case .text: break
            }
        case .recognizeText:
            let image: NSImage?
            switch content {
            case .image(let value): image = value
            case .files(let urls): image = urls.first.flatMap { NSImage(contentsOf: $0) }
            case .text: image = nil
            }
            if let image {
                selectionWindow.show(nil, message: "正在识别图片文字…", image: image)
                let displayToken = selectionWindow.displayToken
                ImageTextRecognizer.recognize(image) { [weak self] result, error in
                    guard let self, self.selectionWindow.isVisible,
                          self.selectionWindow.displayToken == displayToken else { return }
                    self.selectionWindow.show(result.map(SelectedContent.text), message: error)
                }
            }
        case .open:
            if case .files(let urls) = content {
                for url in urls.prefix(30) { NSWorkspace.shared.open(url) }
            }
        case .reveal:
            if case .files(let urls) = content { NSWorkspace.shared.activateFileViewerSelecting(urls) }
        case .preview:
            if case .files(let urls) = content, let first = urls.first {
                let process = Process()
                process.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
                process.arguments = ["-p", first.path]
                try? process.run()
            }
        }
    }

    private func showClipboardItemActions(_ item: ClipboardRecord) {
        let content: SelectedContent
        switch item.kind {
        case "image":
            guard let url = clipboardStore.imageURL(for: item), let image = NSImage(contentsOf: url) else { return }
            content = .image(image)
        case "files": content = .files(item.filePaths.map { URL(fileURLWithPath: $0) })
        default: content = .text(item.text)
        }
        clipboardWindow.dismiss()
        selectionWindow.show(content)
    }

    @objc private func showSearchResultActions() {
        guard let item = actionEntry else { return }
        let content: SelectedContent
        switch item.kind {
        case .application, .file: content = .files([URL(fileURLWithPath: item.value)])
        case .alias, .bookmark, .history, .calculator, .timeValue: content = .text(item.value)
        case .snippet:
            guard let id = UUID(uuidString: item.value), let snippet = snippets.item(id: id) else { return }
            content = .text(snippet.body)
        default: return
        }
        panel.orderOut(nil)
        selectionWindow.show(content)
    }

    private func performCommand(_ id: String) {
        switch id {
        case "translate": translator.show("")
        case "comparison", "comparisonV2": comparer.show("")
        case "json": jsonTool.show("")
        case "gold": goldTool.show()
        case "unicode": unicodeTool.show("", decode: nil)
        case "markdown": markdownTool.show("")
        case "id": idGenerator.show()
        case "converter": developerConverter.show()
        case "configDiff": backendWorkbench.show(.config)
        case "explain": backendWorkbench.show(.explain)
        case "logTimeline": backendWorkbench.show(.logs)
        case "sqlRestore": backendWorkbench.show(.sql)
        case "configFormat": localTextTool.show(.configuration)
        case "sqlFormat": localTextTool.show(.sql)
        case "manual": commandManual.show()
        case "image": imageTool.show()
        case "clipboard": showClipboard()
        case "stack": showStack()
        case "selection": showSelectionActions()
        case "settings": showSettings()
        case "searchSettings": settingsSearchManager = false; settingsTabIndex = 1; showSettings()
        case "permissions": settingsTabIndex = 5; showSettings()
        case "diagnostics": settingsTabIndex = 6; showSettings()
        case "snippets": settingsTabIndex = 4; showSettings()
        case "linkAliases": settingsTabIndex = 3; showSettings()
        case "commandAliases": settingsTabIndex = 8; showSettings()
        default: break
        }
    }
    @objc private func quit() { NSApp.terminate(nil) }

    @objc private func refreshIndex() {
        fileSearch.setEnabled(settings.value.searchFiles)
        searchIndexRevision += 1
        // 扫描期间再次请求只保留最新设置，不把多次全量扫描排成队列。
        guard !indexRefreshRunning else { return }
        indexRefreshRunning = true
        let revision = searchIndexRevision
        let prefs = settings.value
        let running = NSWorkspace.shared.runningApplications.compactMap { application -> Entry? in
            guard let url = application.bundleURL, url.pathExtension.lowercased() == "app" else { return nil }
            return Entry(kind: .application, title: application.localizedName ?? url.deletingPathExtension().lastPathComponent,
                         detail: "应用 · \(url.path)", value: url.path, rank: 70)
        }
        let commandNames = CommandCatalog.all(settings: prefs).flatMap { [$0.title] + $0.keywords + commandAliases.names(for: $0.id) }
        searchIndexQueue.async { [weak self] in
            let nextChrome = ChromeIndex()
            if prefs.searchBookmarks || prefs.searchHistory {
                nextChrome.refresh(customPath: prefs.chromePath, loadBookmarks: prefs.searchBookmarks)
            }
            let nextApps = Self.scanApplications(running: running)
            if prefs.pinyinEnabled {
                // 首次拼音转换随索引一起在后台完成，发布后输入无需等待整批中文转写。
                PinyinMatcher.prepare(nextApps.map(\.title) + nextApps.map { URL(fileURLWithPath: $0.value).deletingPathExtension().lastPathComponent }
                    + nextChrome.bookmarks.map(\.title) + commandNames)
            }
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                self.indexRefreshRunning = false
                guard revision == self.searchIndexRevision else { self.refreshIndex(); return }
                self.apps = nextApps
                self.chrome = nextChrome
                self.searchTextCache.removeAllObjects()
                self.searchIconCache.removeAllObjects()
                self.update()
                if self.settingsWindow?.isVisible == true && self.settingsTabIndex == 1 { self.renderSettings() }
            }
        }
    }

    private static func scanApplications(running: [Entry]) -> [Entry] {
        let fm = FileManager.default
        let roots = ["/Applications", "/System/Applications", "/System/Library/CoreServices/Applications",
                     fm.homeDirectoryForCurrentUser.appendingPathComponent("Applications").path]
        var found: [Entry] = []
        var seen = Set<String>()
        for root in roots {
            guard let enumerator = fm.enumerator(at: URL(fileURLWithPath: root), includingPropertiesForKeys: nil,
                                                  options: [.skipsHiddenFiles, .skipsPackageDescendants]) else { continue }
            for case let url as URL in enumerator where url.pathExtension.lowercased() == "app" {
                guard !seen.contains(url.path) else { continue }
                seen.insert(url.path)
                let bundle = Bundle(url: url)
                let title = (bundle?.object(forInfoDictionaryKey: "CFBundleDisplayName") as? String)
                    ?? (bundle?.object(forInfoDictionaryKey: "CFBundleName") as? String)
                    ?? url.deletingPathExtension().lastPathComponent
                found.append(Entry(kind: .application, title: title, detail: "应用 · \(url.path)", value: url.path, rank: 70))
            }
        }
        for application in running where seen.insert(application.value).inserted { found.append(application) }
        return found
    }

    func controlTextDidChange(_ obj: Notification) { update() }
    func control(_ control: NSControl, textView: NSTextView, doCommandBy selector: Selector) -> Bool {
        switch selector {
        case #selector(NSResponder.moveDown(_:)): move(1); return true
        case #selector(NSResponder.moveUp(_:)): move(-1); return true
        case #selector(NSResponder.insertNewline(_:)): activateSelection(); return true
        case #selector(NSResponder.cancelOperation(_:)): panel.orderOut(nil); return true
        default: return false
        }
    }
    private func searchableAddress(_ item: Entry) -> String {
        let key = "\(item.kind):\(item.value)" as NSString
        if let cached = searchTextCache.object(forKey: key) { return cached as String }
        let value = item.kind == .application ? URL(fileURLWithPath: item.value).deletingPathExtension().lastPathComponent
            : URL(string: item.value).map { ($0.host ?? "") + $0.path } ?? ""
        searchTextCache.setObject(value as NSString, forKey: key)
        return value
    }

    private func update() {
        guard table != nil else { return }
        let entered = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        let exactMode = entered.hasPrefix("=")
        let original = (exactMode ? String(entered.dropFirst()) : entered).trimmingCharacters(in: .whitespacesAndNewlines)
        let q = original.lowercased()
        let searchScope = ["书签 ", "历史 ", "应用 "].first { q.hasPrefix($0) }
        let exactTerm = searchScope.map { String(original.dropFirst($0.count)).trimmingCharacters(in: .whitespaces) } ?? original
        let term = exactTerm.hasPrefix("?") || exactTerm.hasPrefix("？") ? String(exactTerm.dropFirst()).trimmingCharacters(in: .whitespaces) : exactTerm
        titleMatchTerm = term.utf16.count <= 256 ? term : ""
        let pinyin = settings.value.pinyinEnabled
        let catalog = CommandCatalog.all(settings: settings.value)
        var list: [Entry] = []
        if q.hasPrefix("?") || q.hasPrefix("？") {
            fileSearch.search("")
            let filter = String(original.dropFirst()).trimmingCharacters(in: .whitespacesAndNewlines)
            results = CommandCatalog.search(filter, settings: settings.value, pinyinEnabled: pinyin,
                                            aliases: commandAliases)
                .filter { command in
                    !exactMode || ([command.title] + command.keywords + commandAliases.names(for: command.id))
                        .contains { $0.localizedCaseInsensitiveCompare(filter) == .orderedSame }
                }
                .sorted { left, right in
                    let a = commandFavorites.contains(left.id), b = commandFavorites.contains(right.id)
                    return a == b ? left.title.localizedStandardCompare(right.title) == .orderedAscending : a
                }
                .map { command in
                    Entry(kind: .command, title: (commandFavorites.contains(command.id) ? "★ " : "") + command.title,
                          detail: command.detail + " · " + command.keywords.joined(separator: " / "),
                          value: command.id, rank: 110)
                }
            footer.stringValue = results.isEmpty ? "没有匹配的命令" : searchNavigationHint
            presentSearchResults()
            return
        }
        let reservedFilePrefixes = catalog.flatMap {
            [$0.title] + $0.keywords + commandAliases.names(for: $0.id)
        }
        if let fileRequest = FileSearchRequest.parse(original, preservingCommands: reservedFilePrefixes) {
            guard settings.value.searchFiles else {
                fileSearch.search("")
                results = []
                footer.stringValue = "文件搜索已关闭 · 请在设置 → 搜索中开启"
                presentSearchResults()
                return
            }
            let term = fileRequest.term
            fileSearch.search(term, filter: fileRequest.filter)
            list = fileSearch.results.map { url in
                var directory: ObjCBool = false
                FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
                return Entry(kind: .file, title: url.lastPathComponent,
                             detail: "\(directory.boolValue ? "文件夹" : "文件") · \(url.path)", value: url.path, rank: 80)
            }
            results = Array(list.filter { !exactMode || $0.title.localizedCaseInsensitiveCompare(term) == .orderedSame }
                .map { ($0, ranking.signals(kind: String(describing: $0.kind), value: $0.value)) }
                .filter { !$0.1.hidden }
                .sorted { a, b in
                    if a.1.pinned != b.1.pinned { return a.1.pinned }
                    return a.1.bonus == b.1.bonus ? a.0.title.localizedStandardCompare(b.0.title) == .orderedAscending : a.1.bonus > b.1.bonus
                }.prefix(80).map { $0.0 })
            if term.isEmpty {
                footer.stringValue = "输入\(fileRequest.filter.title)关键词 · 如 文件 报告、文档 合同、图片 截图、json 配置"
            } else if fileSearch.isIndexing && results.isEmpty {
                footer.stringValue = "正在扫描本机文件名…"
            } else if fileSearch.isSearching && results.isEmpty {
                footer.stringValue = "正在搜索 Spotlight 索引…"
            } else if results.isEmpty && !fileSearch.unreadableFolders.isEmpty {
                footer.stringValue = "未找到 · 无法读取：\(fileSearch.unreadableFolders.joined(separator: "、"))"
            } else {
                footer.stringValue = results.isEmpty ? "未找到\(fileRequest.filter.title) · 可检查文件权限和搜索范围" :
                    (fileSearch.unreadableFolders.isEmpty ? searchNavigationHint : "\(searchNavigationHint) · 部分目录未授权")
            }
            presentSearchResults()
            return
        }
        if q.hasPrefix("翻译") || q.hasPrefix("translate ") {
            let text = q.hasPrefix("翻译") ? String(original.dropFirst(2)).trimmingCharacters(in: .whitespaces) : String(original.dropFirst(10))
            list.append(Entry(kind: .translate, title: "在有道翻译中打开", detail: text.isEmpty ? "打开网页版" : text, value: text, rank: 110))
        }
        let comparisonNames = catalog.first(where: { $0.id == "comparison" }).map {
            [$0.title] + $0.keywords + commandAliases.names(for: $0.id)
        } ?? []
        let comparisonRequested = comparisonNames.contains { $0.localizedCaseInsensitiveCompare(q) == .orderedSame }
        let comparisonPrefix = ["文本对比 ", "diff "].first { q.hasPrefix($0) }
        if comparisonRequested || comparisonPrefix != nil {
            let text = comparisonRequested ? "" : comparisonPrefix.map {
                String(original.dropFirst($0.count)).trimmingCharacters(in: .whitespaces)
            } ?? ""
            list.append(Entry(kind: .comparison, title: "打开文本对比", detail: text.isEmpty ? "左右直接编辑 · 原处显示差异" : "将输入内容放入左侧", value: text, rank: 115))
        }
        if q == "json" || q.hasPrefix("json ") || q == "json格式化" || q.hasPrefix("json格式化 ") {
            let text = q.hasPrefix("json格式化") ? String(original.dropFirst(7)).trimmingCharacters(in: .whitespaces) : String(original.dropFirst(4)).trimmingCharacters(in: .whitespaces)
            list.append(Entry(kind: .json, title: "打开 JSON 工具", detail: "格式化 · 校验 · 转义 · 压缩", value: text, rank: 116))
        }
        let unicodeDecode = q == "unicode转中文" || q.hasPrefix("unicode转中文 ")
        let unicodeEncode = q == "中文转unicode" || q.hasPrefix("中文转unicode ")
        let unicodeGeneral = q == "unicode" || q.hasPrefix("unicode ") || q == "中文编码"
        if unicodeDecode || unicodeEncode || unicodeGeneral {
            let prefix = unicodeDecode ? "unicode转中文" : unicodeEncode ? "中文转unicode" : q.hasPrefix("unicode") ? "unicode" : "中文编码"
            let text = String(original.dropFirst(prefix.count)).trimmingCharacters(in: .whitespaces)
            let title = unicodeDecode ? "Unicode → 中文" : unicodeEncode ? "中文 → Unicode" : "Unicode ↔ 中文"
            list.append(Entry(kind: .unicode, title: title, detail: "Unicode 转义与中文实时互转", value: text, rank: 117))
        }
        if q == "mark" || q == "markdown" || q.hasPrefix("mark ") || q.hasPrefix("markdown ") {
            let prefixCount = q.hasPrefix("markdown") ? 8 : 4
            let text = String(original.dropFirst(prefixCount)).trimmingCharacters(in: .whitespaces)
            list.append(Entry(kind: .markdown, title: "打开 Markdown 编辑与预览", detail: "左侧编辑 · 右侧实时预览", value: text, rank: 117))
        }
        if q == "身份证" || q == "身份证生成器" || q == "idgen" {
            list.append(Entry(kind: .idGenerator, title: "生成身份证测试号", detail: "随机地区和生日 · 有效校验位", value: "", rank: 117))
        }
        if ["图片处理", "image", "图片快处理"].contains(q) {
            list.append(Entry(kind: .imageTool, title: "打开图片快处理", detail: "缩放 · 压缩 · 格式转换 · 元数据", value: "", rank: 117))
        }
        if list.isEmpty && q.count >= 3 {
            if PinyinMatcher.matches("文本对比", query: q, enabled: pinyin) {
                list.append(Entry(kind: .comparison, title: "打开文本对比", detail: "左右直接编辑 · 原处显示差异", value: "", rank: 115))
            }
            if PinyinMatcher.matches("翻译", query: q, enabled: pinyin) {
                list.append(Entry(kind: .translate, title: "在有道翻译中打开", detail: "打开网页版", value: "", rank: 110))
            }
            if PinyinMatcher.matches("剪贴板", query: q, enabled: pinyin) {
                list.append(Entry(kind: .clipboard, title: "打开剪贴板历史", detail: "搜索、固定、粘贴", value: "", rank: 110))
            }
        }
        if q == "剪贴板" || q == "clipboard" || q == "粘贴板" {
            list.append(Entry(kind: .clipboard, title: "打开剪贴板历史", detail: "搜索、固定、复制、粘贴", value: "", rank: 115))
        }
        if q.hasPrefix(";") {
            let keyword = String(q.dropFirst())
            list += snippets.search(keyword).map {
                Entry(kind: .snippet, title: ";\($0.keyword)  \($0.name)", detail: "常用片段",
                      value: $0.id.uuidString, rank: 118)
            }
        }
        let directKinds: [String: String] = ["translate": "translate", "comparison": "comparison",
            "json": "json", "unicode": "unicode", "markdown": "markdown", "id": "idGenerator",
            "image": "imageTool", "clipboard": "clipboard"]
        for command in catalog
            where !q.isEmpty && commandAliases.matches(command, query: q, pinyinEnabled: pinyin) {
            if let kind = directKinds[command.id], list.contains(where: { String(describing: $0.kind) == kind }) { continue }
            let names = [command.title] + command.keywords + commandAliases.names(for: command.id)
            let exact = names.contains { $0.localizedCaseInsensitiveCompare(q) == .orderedSame }
            let customMatch = commandAliases.names(for: command.id).first {
                PinyinMatcher.matches($0, query: q, enabled: pinyin)
            }
            list.append(Entry(kind: .command,
                              title: command.id == "settings" ? "打开 OpenAll 设置" : command.title,
                              detail: customMatch.map { "匹配别名：\($0) · \(command.detail)" } ?? command.detail, value: command.id,
                              rank: exact ? 135 : 92))
        }
        let calculatorPrefix = q.hasPrefix("calc ") || q.hasPrefix("= ")
        let expression = calculatorPrefix ? String(original.dropFirst(q.hasPrefix("calc ") ? 5 : 2)) : original
        let calculatorIntent = calculatorPrefix ||
            (expression.rangeOfCharacter(from: .decimalDigits) != nil &&
             expression.rangeOfCharacter(from: CharacterSet(charactersIn: "+-*/×÷()%√^&|<>")) != nil) ||
            ["sqrt", "cos", "sin", "tan", "ln", "log"].contains { q.hasPrefix($0 + "(") }
        let timeEntries = TimeResults.entries(for: original)
        if timeEntries.isEmpty, calculatorIntent, let result = ExpressionParser(expression).parse() {
            let formatted = result.rounded() == result && abs(result) < 1e15 ? String(Int64(result)) : String(format: "%.12g", result)
            list.append(Entry(kind: .calculator, title: formatted, detail: "计算结果", value: formatted, rank: 120))
        }
        list += timeEntries.map {
            Entry(kind: .timeValue, title: $0.value, detail: $0.label, value: $0.value, rank: 119)
        }
        let directTool = comparisonRequested || q.hasPrefix("翻译") || q.hasPrefix("translate ") || q == "文本对比" || q.hasPrefix("文本对比 ") || q == "文本" || q == "wenben"
            || q == "diff" || q.hasPrefix("diff ") || q == "剪贴板" || q == "clipboard" || q == "粘贴板"
            || q == "json" || q.hasPrefix("json ") || q == "json格式化" || q.hasPrefix("json格式化 ")
            || unicodeDecode || unicodeEncode || unicodeGeneral
            || q == "mark" || q == "markdown" || q.hasPrefix("mark ") || q.hasPrefix("markdown ")
            || q == "身份证" || q == "身份证生成器" || q == "idgen" || calculatorIntent || q.hasPrefix(";")
            || ["图片处理", "image", "图片快处理"].contains(q)
            || ["结构化配置对比", "配置对比", "配置差异", "sql 执行计划", "执行计划",
                "日志时间线", "日志聚合", "sql 参数还原", "参数还原"].contains(q)
            || !timeEntries.isEmpty
        if !list.isEmpty && directTool && !exactMode {
            fileSearch.search("")
            results = list.filter { (!exactMode || $0.title.localizedCaseInsensitiveCompare(original) == .orderedSame)
                && !ranking.isHidden(kind: String(describing: $0.kind), value: $0.value) }
            footer.stringValue = searchNavigationHint
            presentSearchResults()
            return
        }
        for item in aliases.items {
            if let matched = item.allNames.first(where: { name in
                let key = name.lowercased()
                return q == key || (q.hasPrefix(key + " ") && item.template.contains("{query}"))
            }) {
                let arg = String(original.dropFirst(matched.count)).trimmingCharacters(in: .whitespaces)
                let safe = CharacterSet(charactersIn: "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~")
                let url = item.template.replacingOccurrences(of: "{query}", with: arg.addingPercentEncoding(withAllowedCharacters: safe) ?? "")
                let domain = URL(string: url)?.host ?? url
                let action = arg.isEmpty ? "打开网站" : "搜索“\(arg)”"
                list.append(Entry(kind: .alias, title: item.title, detail: "\(action) · \(domain)", value: url, rank: 105))
            }
        }
        if !q.isEmpty {
            let filter = q.hasPrefix("书签 ") ? String(q.dropFirst(3)) : q.hasPrefix("历史 ") ? String(q.dropFirst(3)) : q.hasPrefix("应用 ") ? String(q.dropFirst(3)) : q
            let onlyBookmarks = q.hasPrefix("书签 ")
            let onlyHistory = q.hasPrefix("历史 ")
            let onlyApps = q.hasPrefix("应用 ")
            if settings.value.searchFiles && !onlyBookmarks && !onlyHistory && !onlyApps && filter.count >= 2 {
                fileSearch.search(filter)
                list += fileSearch.results.prefix(25).map { url in
                    var directory: ObjCBool = false
                    FileManager.default.fileExists(atPath: url.path, isDirectory: &directory)
                    return Entry(kind: .file, title: url.lastPathComponent,
                                 detail: "\(directory.boolValue ? "文件夹" : "文件") · \(url.path)", value: url.path, rank: 58)
                }
            } else { fileSearch.search("") }
            if !onlyBookmarks && !onlyHistory {
                list += apps.filter {
                    let bundleName = searchableAddress($0)
                    return ($0.value.hasSuffix("/Terminal.app") && (filter == "终端" || filter == "zhongduan"))
                        || ($0.value.hasSuffix("/System Settings.app") && ["设置", "系统设置", "xitongshezhi", "settings"].contains(filter))
                        || PinyinMatcher.matches($0.title, query: filter, enabled: pinyin)
                        || PinyinMatcher.matches(bundleName, query: filter, enabled: pinyin)
                }
            }
            if settings.value.searchBookmarks && !onlyApps && !onlyHistory {
                list += chrome.bookmarks.filter {
                    let address = searchableAddress($0)
                    return PinyinMatcher.matches($0.title, query: filter, enabled: pinyin)
                        || (filter.count >= 2 && address.localizedCaseInsensitiveContains(filter))
                }
            }
            if settings.value.searchHistory && !onlyApps && !onlyBookmarks && (filter.count >= 2 || onlyHistory) {
                list += chrome.searchHistory(filter, pinyinEnabled: pinyin)
            }
        } else { fileSearch.search("") }
        if !exactMode && list.isEmpty && q.count >= 3 {
            list += apps.filter { SearchFuzzy.matches($0.title, query: q) ||
                SearchFuzzy.matches(searchableAddress($0), query: q) }
                .map { Entry(kind: .application, title: $0.title, detail: "可能想找：\($0.detail)", value: $0.value, rank: 10) }
            list += catalog.filter { command in
                ([command.title] + command.keywords + commandAliases.names(for: command.id))
                    .contains { SearchFuzzy.matches($0, query: q) }
            }.map { Entry(kind: .command, title: $0.title, detail: "可能想找的功能 · \($0.detail)", value: $0.id, rank: 10) }
            if settings.value.searchBookmarks {
                list += chrome.bookmarks.filter { SearchFuzzy.matches($0.title, query: q) }
                    .map { Entry(kind: .bookmark, title: $0.title, detail: "可能想找的书签 · \($0.detail)", value: $0.value, rank: 8) }
            }
        }
        // 排序权重每项只计算一次，避免排序比较器反复哈希和读取规则。
        let ranked = list.compactMap { item -> (Entry, Int)? in
            if exactMode {
                let bundleName = item.kind == .application ? searchableAddress(item) : ""
                let exactApplication = item.kind == .application && (
                    bundleName.localizedCaseInsensitiveCompare(exactTerm) == .orderedSame ||
                    (item.value.hasSuffix("/Terminal.app") && ["终端", "zhongduan"].contains(exactTerm.lowercased())) ||
                    (item.value.hasSuffix("/System Settings.app") && ["设置", "系统设置", "xitongshezhi", "settings"].contains(exactTerm.lowercased())))
                let exact = item.title.localizedCaseInsensitiveCompare(exactTerm) == .orderedSame || exactApplication ||
                    (item.kind == .command && catalog.first(where: { $0.id == item.value })
                        .map { ($0.keywords + commandAliases.names(for: $0.id)).contains { $0.localizedCaseInsensitiveCompare(exactTerm) == .orderedSame } } == true)
                guard exact else { return nil }
            }
            let signals = ranking.signals(kind: String(describing: item.kind), value: item.value)
            guard !signals.hidden else { return nil }
            let title = item.title.lowercased()
            let score = item.rank + (title == q ? 30 : 0) + (title.hasPrefix(q) ? 10 : 0)
                + signals.bonus + (signals.pinned ? 1000 : 0)
            return (item, score)
        }
        results = Array(ranked.sorted { a, b in
            a.1 == b.1 ? a.0.title.localizedStandardCompare(b.0.title) == .orderedAscending : a.1 > b.1
        }.prefix(80).map { $0.0 })
        footer.stringValue = exactMode
            ? (results.isEmpty ? "没有精确匹配 · 例如 =终端" : "精确匹配 · \(searchNavigationHint)")
            : searchNavigationHint
        presentSearchResults()
    }

    private var searchNavigationHint: String {
        if results.isEmpty { return "没有匹配结果 · 输入 ? 浏览命令" }
        return results.count > 1 ? "↑↓ 选择    ⌘K 操作" : "⌘K 操作"
    }

    private func presentSearchResults() {
        let queryChanged = displayedQuery != field.stringValue
        let selected = displayedResults.indices.contains(table.selectedRow) ? displayedResults[table.selectedRow] : nil
        if displayedResults != results {
            displayedResults = results
            table.reloadData()
        }
        if !results.isEmpty {
            // 同一次查询的异步文件结果到达时保留已选项，输入变化时从首项开始。
            let row = !queryChanged ? selected.flatMap { chosen in results.firstIndex { $0.kind == chosen.kind && $0.value == chosen.value } } ?? 0 : 0
            if table.selectedRow != row { table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false) }
            if queryChanged { table.scrollRowToVisible(row) }
        }
        displayedQuery = field.stringValue
        resizePanel()
    }

    private func resizePanel() {
        guard panel != nil else { return }
        let idle = field.stringValue.isEmpty
        let height = idle ? CGFloat(76) : CGFloat(120 + min(results.count, 7) * 56)
        divider.isHidden = idle
        footer.isHidden = idle
        scroll.isHidden = idle || results.isEmpty
        var frame = panel.frame
        frame.origin.y = frame.maxY - height
        frame.size = NSSize(width: 720, height: height)
        if searchTargetFrame != frame {
            searchTargetFrame = frame
            if panel.frame != frame {
                // 直接重定向到最新高度，不排队；辅助功能要求减少动态效果时立即完成。
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = (panel.isVisible || verifySearchAnimations) && !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion ? 0.14 : 0
                    panel.animator().setFrame(frame, display: false)
                }
            }
        }
        layoutSearchContents()
    }

    private func layoutSearchContents() {
        guard let root = panel?.contentView, footer != nil else { return }
        let height = root.bounds.height
        func place(_ view: NSView?, _ frame: NSRect) {
            if view?.frame != frame { view?.frame = frame }
        }
        // 每帧按实际窗口高度排版，输入框保持顶部位置，避免伸缩时跳动或丢失编辑焦点。
        place(root.viewWithTag(101), NSRect(x: 25, y: height - 50, width: 24, height: 24))
        place(field, NSRect(x: 62, y: height - 71, width: 560, height: 44))
        place(pinButton, NSRect(x: 656, y: height - 53, width: 38, height: 30))
        place(divider, NSRect(x: 18, y: height - 80, width: 684, height: 1))
        place(scroll, NSRect(x: 12, y: 34, width: 696, height: max(0, height - 120)))
        let size = NSSize(width: scroll.contentSize.width, height: max(scroll.contentSize.height, CGFloat(results.count) * 56))
        if table.frame.size != size { table.setFrameSize(size) }
    }

    func numberOfRows(in tableView: NSTableView) -> Int { results.count }
    func tableView(_ tableView: NSTableView, rowViewForRow row: Int) -> NSTableRowView? {
        let view = SearchResultRowView()
        view.returnAction = results[row].returnAction
        return view
    }
    func tableView(_ tableView: NSTableView, viewFor tableColumn: NSTableColumn?, row: Int) -> NSView? {
        let id = NSUserInterfaceItemIdentifier("entry")
        let cell = (tableView.makeView(withIdentifier: id, owner: self) as? NSTableCellView) ?? NSTableCellView(frame: NSRect(x: 0, y: 0, width: 640, height: 56))
        if cell.identifier == nil {
            cell.identifier = id
            let icon = NSImageView(frame: NSRect(x: 18, y: 14, width: 28, height: 28))
            icon.tag = 3
            icon.imageScaling = .scaleProportionallyUpOrDown
            let title = NSTextField(labelWithString: "")
            title.tag = 1; title.font = .systemFont(ofSize: 14, weight: .medium)
            title.textColor = OpenAllTheme.ink
            title.lineBreakMode = .byTruncatingTail
            title.frame = NSRect(x: 58, y: 28, width: cell.bounds.width - 160, height: 22)
            title.autoresizingMask = [.width]
            let detail = NSTextField(labelWithString: "")
            detail.tag = 2; detail.font = .systemFont(ofSize: 12)
            detail.textColor = OpenAllTheme.muted
            detail.lineBreakMode = .byTruncatingMiddle
            detail.frame = NSRect(x: 58, y: 9, width: cell.bounds.width - 160, height: 18)
            detail.autoresizingMask = [.width]
            cell.addSubview(icon); cell.addSubview(title); cell.addSubview(detail)
        }
        if let title = cell.viewWithTag(1) as? NSTextField {
            let value = results[row].title
            title.stringValue = value
            if !titleMatchTerm.isEmpty {
                let match = (String(value.prefix(256)) as NSString).range(of: titleMatchTerm, options: .caseInsensitive)
                if match.location != NSNotFound {
                    let marked = NSMutableAttributedString(attributedString: title.attributedStringValue)
                    marked.addAttributes([.foregroundColor: OpenAllTheme.accentText,
                                          .font: NSFont.systemFont(ofSize: 14, weight: .semibold)], range: match)
                    title.attributedStringValue = marked
                }
            }
        }
        cell.viewWithTag(2).flatMap { $0 as? NSTextField }?.stringValue = results[row].detail
        let item = results[row]
        cell.setAccessibilityHelp("回车" + item.returnAction)
        let symbol: String
        switch item.kind {
        case .application: symbol = "app"
        case .file: symbol = "doc"
        case .alias: symbol = "link"
        case .bookmark: symbol = "bookmark"
        case .history: symbol = "clock.arrow.circlepath"
        case .calculator: symbol = "equal.square"
        case .timeValue: symbol = "clock"
        case .command:
            symbol = CommandCatalog.all(settings: settings.value).first(where: { $0.id == item.value })?.symbol ?? "command"
        case .translate: symbol = "character.bubble"
        case .comparison: symbol = "rectangle.split.2x1"
        case .clipboard: symbol = "doc.on.clipboard"
        case .json: symbol = "curlybraces"
        case .unicode: symbol = "character.cursor.ibeam"
        case .markdown: symbol = "text.book.closed"
        case .idGenerator: symbol = "person.text.rectangle"
        case .converter: symbol = "arrow.left.arrow.right"
        case .imageTool: symbol = "photo"
        case .snippet: symbol = "text.insert"
        }
        let nativeIcon = item.kind == .application || item.kind == .file
        let cacheKey = (nativeIcon ? "file:" + item.value : "symbol:" + symbol) as NSString
        let image: NSImage?
        if let cached = searchIconCache.object(forKey: cacheKey) { image = cached }
        else {
            image = nativeIcon ? NSWorkspace.shared.icon(forFile: item.value) : NSImage(systemSymbolName: symbol, accessibilityDescription: nil)
            if let image { searchIconCache.setObject(image, forKey: cacheKey) }
        }
        cell.viewWithTag(3).flatMap { $0 as? NSImageView }?.image = image
        cell.viewWithTag(3).flatMap { $0 as? NSImageView }?.contentTintColor = item.kind == .application || item.kind == .file ? nil : OpenAllTheme.ink.withAlphaComponent(0.85)
        return cell
    }
    private func move(_ delta: Int) {
        guard !results.isEmpty else { return }
        let next = max(0, min(results.count - 1, table.selectedRow + delta))
        table.selectRowIndexes(IndexSet(integer: next), byExtendingSelection: false)
        table.scrollRowToVisible(next)
    }
    private func showActions() {
        guard table.selectedRow >= 0, table.selectedRow < results.count else { return }
        actionEntry = results[table.selectedRow]
        let menu = NSMenu(title: "操作")
        populateActions(menu, for: actionEntry!)
        let row = table.rect(ofRow: table.selectedRow)
        menu.popUp(positioning: nil, at: NSPoint(x: row.minX + 24, y: row.minY), in: table)
    }

    func menuNeedsUpdate(_ menu: NSMenu) {
        let row = table.clickedRow >= 0 ? table.clickedRow : table.selectedRow
        guard results.indices.contains(row) else { menu.removeAllItems(); return }
        table.selectRowIndexes(IndexSet(integer: row), byExtendingSelection: false)
        actionEntry = results[row]
        populateActions(menu, for: results[row])
    }

    private func populateActions(_ menu: NSMenu, for item: Entry) {
        menu.removeAllItems()
        func add(_ title: String, _ action: Selector) {
            menu.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
        }
        if item.kind == .command {
            add("执行", #selector(activateSelection))
            if item.value != "searchSettings" { add(commandFavorites.contains(item.value) ? "取消收藏" : "收藏命令", #selector(toggleCommandFavorite)) }
            return
        }
        add(item.returnAction, #selector(activateSelection))
        if [.application, .file, .alias, .bookmark, .history, .calculator, .timeValue, .snippet].contains(item.kind) {
            add("对内容操作…", #selector(showSearchResultActions))
        }
        switch item.kind {
        case .application, .file, .alias, .bookmark, .history, .calculator, .timeValue, .snippet:
            add(item.kind == .file || item.kind == .application ? "复制路径" : "复制内容", #selector(copyActionValue))
        default: break
        }
        if item.kind == .file || item.kind == .application {
            add("在访达中显示", #selector(revealActionFile))
            if item.kind == .file {
                add("使用其他应用打开…", #selector(openActionFileWithApplication))
                add("快速预览", #selector(previewActionFile))
            }
        }
        if item.kind == .alias || item.kind == .bookmark || item.kind == .history || item.kind == .snippet {
            let tools = NSMenu(title: "发送到工具")
            for (title, action) in [("翻译", #selector(sendActionToTranslation)),
                                    ("文本对比", #selector(sendActionToComparison)),
                                    ("JSON", #selector(sendActionToJSON)),
                                    ("Markdown", #selector(sendActionToMarkdown))] {
                tools.addItem(withTitle: title, action: action, keyEquivalent: "").target = self
            }
            let parent = NSMenuItem(title: "发送到工具", action: nil, keyEquivalent: "")
            parent.submenu = tools
            menu.addItem(parent)
        }
        if item.kind != .timeValue && item.kind != .calculator {
            menu.addItem(.separator())
            let kind = String(describing: item.kind)
            add(ranking.isPinned(kind: kind, value: item.value) ? "取消置顶" : "置顶此结果", #selector(togglePinnedSearchResult))
            add("隐藏此结果", #selector(hideSearchResult))
            if ranking.isPinned(kind: kind, value: item.value) {
                add("恢复默认排序", #selector(resetSearchResult))
            }
        }
    }

    @objc private func togglePinnedSearchResult() {
        guard let item = actionEntry else { return }
        ranking.togglePinned(kind: String(describing: item.kind), title: item.title, value: item.value)
        update()
    }

    @objc private func hideSearchResult() {
        guard let item = actionEntry else { return }
        ranking.toggleHidden(kind: String(describing: item.kind), title: item.title, value: item.value)
        update()
    }

    @objc private func resetSearchResult() {
        guard let item = actionEntry else { return }
        ranking.resetRule(kind: String(describing: item.kind), value: item.value)
        update()
    }

    @objc private func toggleCommandFavorite() {
        guard let item = actionEntry, item.kind == .command else { return }
        commandFavorites.toggle(item.value)
        update()
    }

    private func actionText() -> String? {
        guard let item = actionEntry else { return nil }
        if item.kind == .snippet, let id = UUID(uuidString: item.value), let snippet = snippets.item(id: id) {
            return snippets.expand(snippet, clipboard: NSPasteboard.general.string(forType: .string) ?? "")
        }
        return item.value
    }
    @objc private func copyActionValue() {
        guard let value = actionText() else { return }
        if let item = actionEntry { ranking.record(kind: String(describing: item.kind), value: item.value) }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(value, forType: .string)
        panel.orderOut(nil)
    }
    @objc private func revealActionFile() {
        guard let item = actionEntry else { return }
        NSWorkspace.shared.activateFileViewerSelecting([URL(fileURLWithPath: item.value)])
        panel.orderOut(nil)
    }
    @objc private func openActionFileWithApplication() {
        guard let item = actionEntry, item.kind == .file else { return }
        let chooser = NSOpenPanel()
        chooser.allowedContentTypes = [.applicationBundle]
        chooser.allowsOtherFileTypes = false
        chooser.prompt = "打开"
        guard chooser.runModal() == .OK, let application = chooser.url else { return }
        NSWorkspace.shared.open([URL(fileURLWithPath: item.value)], withApplicationAt: application,
                                configuration: NSWorkspace.OpenConfiguration()) { _, error in
            if let error { DispatchQueue.main.async { NSAlert(error: error).runModal() } }
        }
        panel.orderOut(nil)
    }
    @objc private func previewActionFile() {
        guard let item = actionEntry else { return }
        let process = Process()
        process.executableURL = URL(fileURLWithPath: "/usr/bin/qlmanage")
        process.arguments = ["-p", item.value]
        try? process.run()
        panel.orderOut(nil)
    }
    @objc private func sendActionToTranslation() { if let text = actionText() { translator.show(text); panel.orderOut(nil) } }
    @objc private func sendActionToComparison() { if let text = actionText() { comparer.show(text); panel.orderOut(nil) } }
    @objc private func sendActionToJSON() { if let text = actionText() { jsonTool.show(text); panel.orderOut(nil) } }
    @objc private func sendActionToMarkdown() { if let text = actionText() { markdownTool.show(text); panel.orderOut(nil) } }

    @objc private func activateSelection() {
        guard table.selectedRow >= 0 && table.selectedRow < results.count else { return }
        let item = results[table.selectedRow]
        ranking.record(kind: String(describing: item.kind), value: item.value)
        switch item.kind {
        case .command: performCommand(item.value)
        case .application:
            NSWorkspace.shared.openApplication(at: URL(fileURLWithPath: item.value), configuration: NSWorkspace.OpenConfiguration()) { _, _ in }
        case .file: NSWorkspace.shared.open(URL(fileURLWithPath: item.value))
        case .alias, .bookmark, .history:
            if let url = URL(string: item.value), ["http", "https"].contains(url.scheme?.lowercased() ?? "") { NSWorkspace.shared.open(url) }
        case .calculator, .timeValue: NSPasteboard.general.clearContents(); NSPasteboard.general.setString(item.value, forType: .string)
        case .translate: translator.show(item.value)
        case .comparison: comparer.show(item.value)
        case .clipboard: showClipboard()
        case .json: jsonTool.show(item.value)
        case .unicode:
            let decode: Bool? = item.title == "Unicode → 中文" ? true : item.title == "中文 → Unicode" ? false : nil
            unicodeTool.show(item.value, decode: decode)
        case .markdown: markdownTool.show(item.value)
        case .idGenerator: idGenerator.show()
        case .converter: developerConverter.show()
        case .imageTool: imageTool.show()
        case .snippet:
            if let id = UUID(uuidString: item.value), let snippet = snippets.item(id: id) {
                let clipboard = NSPasteboard.general.string(forType: .string) ?? ""
                let content = snippets.expand(snippet, clipboard: clipboard)
                NSPasteboard.general.clearContents()
                NSPasteboard.general.setString(content, forType: .string)
                if let target = previousApplication, AXIsProcessTrusted() {
                    target.activate(options: [])
                    DispatchQueue.main.asyncAfter(deadline: .now() + 0.18) {
                        let source = CGEventSource(stateID: .hidSystemState)
                        for down in [true, false] {
                            let event = CGEvent(keyboardEventSource: source, virtualKey: CGKeyCode(kVK_ANSI_V), keyDown: down)
                            event?.flags = .maskCommand
                            event?.setIntegerValueField(.eventSourceUserData, value: 0x4F414C4C)
                            event?.post(tap: .cghidEventTap)
                        }
                    }
                }
            }
        }
        panel.orderOut(nil)
    }

    @objc private func showSettings() {
        WindowChrome.activate()
        if !DesignPreview.enabled && settings.value.searchShortcutMode == "double"
            && settings.value.doubleTapKeyCode != nil && !doubleTapMonitor.isActive { installDoubleTapMonitor() }
        if settingsWindow == nil {
            let window = SettingsWindow(contentRect: NSRect(x: 0, y: 0, width: 930, height: 560),
                                  styleMask: [.titled, .closable, .miniaturizable], backing: .buffered, defer: false)
            window.isReleasedWhenClosed = false
            WindowChrome.apply(window, title: "OpenAll 设置")
            window.center()
            let root = NSView(frame: window.contentView!.bounds)
            root.wantsLayer = true
            root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
            window.contentView = root
            let sidebar = NSView(frame: NSRect(x: 0, y: 0, width: 180, height: 514))
            sidebar.wantsLayer = true
            sidebar.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
            root.addSubview(sidebar)
            let sidebarRule = NSView(frame: NSRect(x: 179, y: 0, width: 1, height: 514))
            sidebarRule.wantsLayer = true
            sidebarRule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
            root.addSubview(sidebarRule)
            settingsNavigation = []
            let navigation = [("通用", "gearshape.fill", 0), ("搜索", "magnifyingglass", 1),
                              ("剪贴板", "square.on.square", 2), ("网址别名", "link", 3),
                              ("功能别名", "command.square", 8), ("常用片段", "text.badge.plus", 4),
                              ("权限", "lock.shield", 5), ("诊断", "waveform.path.ecg", 6),
                              ("外观", "paintpalette", 7)]
            for (row, item) in navigation.enumerated() {
                let y = 447 - CGFloat(row) * 40 - CGFloat(row / 3) * 13
                if row == 3 || row == 6 {
                    let divider = NSBox(frame: NSRect(x: 21, y: y + 46, width: 137, height: 1))
                    divider.boxType = .separator
                    sidebar.addSubview(divider)
                }
                let control = SettingsNavItem(frame: NSRect(x: 10, y: y, width: 160, height: 40),
                                              title: item.0, symbol: item.1)
                control.tag = item.2
                control.onChoose = { [weak self] in
                    self?.settingsTabIndex = item.2
                    if item.2 == 1 { self?.settingsSearchManager = false }
                    self?.renderSettings()
                }
                sidebar.addSubview(control)
                settingsNavigation.append(control)
            }
            let body = NSView(frame: NSRect(x: 196, y: -12, width: 708, height: 536))
            body.wantsLayer = true
            body.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
            root.addSubview(body)
            WindowChrome.installControls(on: window)
            settingsWindow = window
            settingsBody = body
        }
        settingsWindow?.setNavigationFocusVisible(false)
        renderSettings()
        WindowChrome.present(settingsWindow)
        settingsWindow?.makeFirstResponder(settingsNavigation.first { $0.tag == settingsTabIndex })
    }

    private func settingLabel(_ title: String, y: CGFloat, width: CGFloat = 150) -> NSTextField {
        let label = NSTextField(labelWithString: title)
        label.font = .systemFont(ofSize: 13, weight: .regular)
        label.textColor = OpenAllTheme.ink
        label.frame = NSRect(x: 28, y: y, width: width, height: 24)
        return label
    }

    private func shortcutControl(_ title: String, tag: Int, frame: NSRect) -> NSButton {
        let button = NSButton(title: title, target: self, action: #selector(beginRecording(_:)))
        button.tag = tag
        button.frame = frame
        button.isBordered = false
        button.wantsLayer = true
        button.layer?.cornerRadius = 6
        button.layer?.borderWidth = 0.5
        button.layer?.borderColor = OpenAllTheme.rule.cgColor
        button.layer?.backgroundColor = OpenAllTheme.raised.cgColor
        button.font = .systemFont(ofSize: 12, weight: .medium)
        button.contentTintColor = OpenAllTheme.ink
        return button
    }

    private func renderSettings() {
        guard let body = settingsBody else { return }
        defer { WindowChrome.refineSettingsTypography(in: body) }
        body.subviews.forEach { $0.removeFromSuperview() }
        for button in settingsNavigation { button.selected = button.tag == settingsTabIndex }
        switch settingsTabIndex {
        case 0:
            func label(_ text: String, _ x: CGFloat, _ y: CGFloat, _ width: CGFloat, secondary: Bool = false) {
                let field = settingLabel(text, y: y, width: width)
                field.frame.origin.x = x
                field.textColor = secondary ? OpenAllTheme.muted : OpenAllTheme.ink
                field.font = .systemFont(ofSize: secondary ? 12 : 14, weight: secondary ? .regular : .medium)
                body.addSubview(field)
            }
            let title = settingLabel("快捷键", y: 474, width: 500)
            title.font = .systemFont(ofSize: 21, weight: .semibold)
            body.addSubview(title)
            label("点击快捷键重新录制 · Esc 取消", 28, 445, 600, secondary: true)
            label("搜索唤起方式", 28, 397, 220)
            let groupRight: CGFloat = 644
            let keyWidth: CGFloat = 136
            let keyX = groupRight - 16 - keyWidth
            let modeFrame = NSRect(x: groupRight - 244, y: 394, width: 244, height: 32)
            let modeBackground = NSView(frame: modeFrame)
            modeBackground.wantsLayer = true
            modeBackground.layer?.cornerRadius = 7
            modeBackground.layer?.backgroundColor = OpenAllTheme.surface.cgColor
            modeBackground.layer?.borderColor = OpenAllTheme.rule.cgColor
            modeBackground.layer?.borderWidth = 0.5
            body.addSubview(modeBackground)
            let isDouble = settings.value.searchShortcutMode == "double"
            for (text, tag, selected) in [("组合快捷键", 0, !isDouble), ("双击修饰键", 1, isDouble)] {
                let button = NSButton(title: text, target: self, action: #selector(changeSearchShortcutMode(_:)))
                button.tag = tag
                button.frame = NSRect(x: modeFrame.minX + 3 + CGFloat(tag) * 119, y: modeFrame.minY + 3, width: 119, height: 26)
                WindowChrome.styleAction(button)
                button.layer?.cornerRadius = 5
                button.layer?.backgroundColor = (selected ? OpenAllTheme.accent.withAlphaComponent(0.16) : .clear).cgColor
                button.layer?.borderWidth = selected ? 0.5 : 0
                button.layer?.borderColor = OpenAllTheme.accentText.withAlphaComponent(0.5).cgColor
                button.contentTintColor = selected ? OpenAllTheme.accentText : OpenAllTheme.muted
                button.setAccessibilityValue(selected ? "已选中" : "未选中")
                body.addSubview(button)
            }
            let bindings = NSView(frame: NSRect(x: 28, y: 90, width: groupRight - 28, height: 284))
            bindings.wantsLayer = true
            bindings.layer?.cornerRadius = 9
            bindings.layer?.backgroundColor = OpenAllTheme.surface.cgColor
            bindings.layer?.borderWidth = 0.5
            bindings.layer?.borderColor = OpenAllTheme.rule.cgColor
            body.addSubview(bindings)
            let names: [UInt32: String] = [55:"Command ⌘",54:"Command ⌘",58:"Option ⌥",61:"Option ⌥",59:"Control ⌃",62:"Control ⌃",56:"Shift ⇧",60:"Shift ⇧"]
            let doubleTitle = settings.value.doubleTapKeyCode.map { "双击 " + (names[$0] ?? shortcutDescription(code: $0, modifiers: settings.value.doubleTapModifiers, label: settings.value.doubleTapKeyLabel)) } ?? "双击 Option ⌥"
            label("打开搜索", 44, 337, 220)
            let active = shortcutControl(isDouble ? doubleTitle : shortcutDescription(settings.value), tag: isDouble ? 4 : 1, frame: NSRect(x: keyX, y: 337, width: keyWidth, height: 30))
            body.addSubview(active)
            recordButton = active
            if isDouble && !doubleTapMonitor.isActive {
                let repair = NSButton(title: AXIsProcessTrusted() ? "重试监听" : "前往授权", target: self, action: AXIsProcessTrusted() ? #selector(retryDoubleTapFromSettings) : #selector(openPermissionsTab))
                repair.frame = NSRect(x: keyX - 100, y: 337, width: 90, height: 30)
                WindowChrome.styleAction(repair)
                body.addSubview(repair)
            }
            let ready = isDouble ? doubleTapMonitor.isActive : shortcutAvailable
            let warning = OpenAllTheme.isLight ? (NSColor.systemOrange.blended(withFraction: 0.48, of: .black) ?? .systemOrange) : .systemOrange
            let state = NSTextField(labelWithString: ready ? "已启用" : isDouble ? "监听未启动，请检查辅助功能权限" : "已被占用，点击上方快捷键重录")
            state.font = .systemFont(ofSize: 12)
            state.textColor = ready ? OpenAllTheme.muted : warning
            state.alignment = .right
            state.frame = NSRect(x: groupRight - 326, y: 311, width: 310, height: 22)
            if !ready { active.layer?.borderColor = warning.withAlphaComponent(0.5).cgColor }
            body.addSubview(state)
            settingsStatus = state
            let shortcuts: [(String, String, String, Int)] = [
                ("剪贴板", "查找、预览与粘贴历史记录", shortcutDescription(code: settings.value.clipboardKeyCode, modifiers: settings.value.clipboardModifiers, label: settings.value.clipboardKeyLabel), 2),
                ("复制堆栈", "连续收集内容，按顺序粘贴", shortcutDescription(code: settings.value.stackKeyCode, modifiers: settings.value.stackModifiers, label: settings.value.stackKeyLabel), 3),
                ("对选中内容操作", "将当前选择交给相应工具处理", shortcutDescription(code: settings.value.selectionKeyCode, modifiers: settings.value.selectionModifiers, label: settings.value.selectionKeyLabel), 5)]
            for (index, item) in shortcuts.enumerated() {
                let y = CGFloat(263 - index * 71)
                let rule = NSView(frame: NSRect(x: 44, y: y + 40, width: groupRight - 60, height: 0.5))
                rule.wantsLayer = true
                rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
                body.addSubview(rule)
                label(item.0, 44, y, 250)
                label(item.1, 44, y - 20, 360, secondary: true)
                body.addSubview(shortcutControl(item.2, tag: item.3, frame: NSRect(x: keyX, y: y - 10, width: keyWidth, height: 30)))
            }
            label("再次按同一快捷键，可关闭对应窗口。", 28, 46, 450, secondary: true)
            let diagnostics = NSButton(title: "查看诊断 →", target: self, action: #selector(openDiagnosticsTab))
            diagnostics.frame = NSRect(x: groupRight - 80, y: 40, width: 80, height: 32)
            WindowChrome.styleOutputAction(diagnostics)
            body.addSubview(diagnostics)
        case 1:
            if settingsSearchManager {
                renderSearchManager(in: body)
                body.subviews.forEach { $0.frame.origin.y += 25 }
                return
            }
            chromePathField = nil
            func text(_ title: String, _ y: CGFloat, width: CGFloat = 620, secondary: Bool = false) -> NSTextField {
                let value = settingLabel(title, y: y, width: width)
                value.font = .systemFont(ofSize: secondary ? 12 : 14, weight: secondary ? .regular : .medium)
                value.textColor = secondary ? OpenAllTheme.muted : OpenAllTheme.ink
                body.addSubview(value)
                return value
            }
            func group(_ bottom: CGFloat, _ height: CGFloat) {
                let view = NSView(frame: NSRect(x: 28, y: bottom + height + 6, width: 536, height: 1))
                view.wantsLayer = true
                view.layer?.cornerRadius = 0
                view.layer?.backgroundColor = OpenAllTheme.rule.cgColor
                body.addSubview(view, positioned: .below, relativeTo: nil)
            }
            text("搜索", 474).font = .systemFont(ofSize: 21, weight: .semibold)
            let pinyin = WindowChrome.checkbox("中文支持拼音和首字母匹配", target: self, action: #selector(pinyinChanged(_:)))
            pinyin.state = settings.value.pinyinEnabled ? .on : .off
            pinyin.frame = NSRect(x: 28, y: 432, width: 600, height: 30)
            body.addSubview(pinyin)
            let chromeEnabled = settings.value.searchBookmarks || settings.value.searchHistory
            let showDirectory = chromeEnabled && chromeAdvancedExpanded
            group(showDirectory ? 196 : 270, showDirectory ? 190 : 116)
            _ = text("Chrome", 358)
            for (name, tag, enabled, y) in [("书签",10,settings.value.searchBookmarks,328.0),("浏览历史",11,settings.value.searchHistory,328.0)] {
                let toggle = WindowChrome.checkbox(name, target: self, action: #selector(searchSourceChanged(_:)))
                toggle.tag = tag
                toggle.state = enabled ? .on : .off
                toggle.frame = NSRect(x: tag == 11 ? 224 : 28, y: y, width: 180, height: 28)
                body.addSubview(toggle)
            }
            let status = !chromeEnabled ? "已关闭 · 开启后自动检测配置" : chrome.profiles.isEmpty ? "尚未发现配置，可指定目录" : "已发现 \(chrome.profiles.count) 个配置"
            _ = text(status, 292, secondary: true)
            let detect = NSButton(title: "重新检测", target: self, action: #selector(redetectChrome))
            detect.frame = NSRect(x: 440, y: 328, width: 124, height: 28)
            WindowChrome.styleAction(detect)
            detect.isEnabled = chromeEnabled
            detect.isHidden = !chromeEnabled
            body.addSubview(detect)
            let advanced = NSButton(title: showDirectory ? "收起目录  ⌃" : "指定目录  ⌄", target: self, action: #selector(toggleChromeAdvanced))
            advanced.frame = NSRect(x: 440, y: 288, width: 124, height: 28)
            WindowChrome.styleAction(advanced)
            advanced.isEnabled = chromeEnabled
            advanced.isHidden = !chromeEnabled
            body.addSubview(advanced)
            if showDirectory {
                let path = NSTextField(frame: NSRect(x: 28, y: 250, width: 536, height: 30))
                path.placeholderString = "自动发现；也可输入 Chrome 数据目录"
                path.stringValue = settings.value.chromePath
                path.target = self
                path.action = #selector(chromePathChanged(_:))
                WindowChrome.styleInput(path)
                path.isEnabled = chromeEnabled
                body.addSubview(path)
                chromePathField = path
                _ = text("通常位于 ~/Library/Application Support/Google/Chrome", 220, secondary: true)
            }
            let offset: CGFloat = showDirectory ? 12 : 84
            group(76 + offset, 122)
            _ = text("文件搜索", 170 + offset)
            let files = WindowChrome.checkbox("搜索文件和文件夹", target: self, action: #selector(searchSourceChanged(_:)))
            files.tag = 12
            files.state = settings.value.searchFiles ? .on : .off
            files.frame = NSRect(x: 28, y: 132 + offset, width: 350, height: 30)
            body.addSubview(files)
            let rescan = NSButton(title: "重新扫描", target: self, action: #selector(rescanFilesFromSettings))
            rescan.frame = NSRect(x: 440, y: 132 + offset, width: 124, height: 30)
            WindowChrome.styleAction(rescan)
            rescan.isEnabled = settings.value.searchFiles
            rescan.isHidden = !settings.value.searchFiles
            body.addSubview(rescan)
            let hint = NSTextField(wrappingLabelWithString: "")
            hint.font = .systemFont(ofSize: 12)
            hint.frame = NSRect(x: 28, y: 84 + offset, width: 536, height: 38)
            body.addSubview(hint)
            searchFileHint = hint
            refreshFileSearchHint()
            let manage = NSButton(title: "管理置顶与隐藏结果 →", target: self, action: #selector(openSearchManager))
            manage.frame = NSRect(x: 28, y: showDirectory ? 28 : 108, width: 220, height: 32)
            WindowChrome.styleAction(manage)
            body.addSubview(manage)
        case 2:
            let recordingCard = NSView(frame: NSRect(x: 18, y: 283, width: 672, height: 143))
            WindowChrome.styleSettingsSection(recordingCard)
            recordingCard.layer?.backgroundColor = NSColor.clear.cgColor
            body.addSubview(recordingCard)
            for y in [340.0, 288.0] {
                let rule = NSView(frame: NSRect(x: 28, y: y, width: 536, height: 1))
                rule.wantsLayer = true
                rule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
                body.addSubview(rule)
            }
            let heading = settingLabel("剪贴板历史", y: 474, width: 250)
            heading.font = .systemFont(ofSize: 18, weight: .medium)
            body.addSubview(heading)
            for (name, y) in [("存储", 260.0)] {
                let label = settingLabel(name, y: y, width: 150)
                label.font = .systemFont(ofSize: 10)
                label.textColor = OpenAllTheme.muted
                body.addSubview(label)
            }
            let enabled = WindowChrome.checkbox("自动记录剪贴板", target: self, action: #selector(clipboardPreferenceChanged(_:)))
            enabled.tag = 1
            enabled.state = clipboardStore.preferences.enabled ? .on : .off
            enabled.frame = NSRect(x: 28, y: 421, width: 240, height: 28)
            body.addSubview(enabled)
            let preferences = clipboardStore.preferences
            let recordingState: String
            if !preferences.enabled {
                recordingState = "已关闭，新复制的内容不会存入历史。"
            } else if let until = preferences.pausedUntil, until > Date() {
                if until == .distantFuture {
                    recordingState = "已暂停，选择“持续记录”即可恢复。"
                } else {
                    let formatter = DateFormatter()
                    formatter.dateFormat = "M 月 d 日 HH:mm"
                    recordingState = "已暂停，将于 " + formatter.string(from: until) + " 自动恢复。"
                }
            } else {
                recordingState = "正在记录新复制的内容。"
            }
            let recordingHint = settingLabel(recordingState, y: 395, width: 510)
            recordingHint.frame.origin.x = 50
            recordingHint.font = .systemFont(ofSize: 10.5)
            recordingHint.textColor = OpenAllTheme.muted
            body.addSubview(recordingHint)
            let scheduleLabel = settingLabel("记录安排", y: 359)
            scheduleLabel.frame.origin.x = 50
            body.addSubview(scheduleLabel)
            let pause = NSPopUpButton(frame: NSRect(x: 324, y: 355, width: 240, height: 28))
            for title in ["持续记录", "暂停 1 小时", "暂停至明天", "暂停至手动恢复"] { pause.addItem(withTitle: title) }
            let remaining = clipboardStore.preferences.pausedUntil?.timeIntervalSinceNow ?? 0
            pause.selectItem(at: remaining <= 0 ? 0 : remaining <= 3600 ? 1 : remaining < 86400 ? 2 : 3)
            pause.target = self
            pause.action = #selector(clipboardPauseChanged(_:))
            pause.isEnabled = clipboardStore.preferences.enabled
            WindowChrome.stylePopUp(pause)
            body.addSubview(pause)
            let plain = WindowChrome.checkbox("默认粘贴为纯文本（关闭则保留原样式）", target: self, action: #selector(clipboardPreferenceChanged(_:)))
            plain.tag = 3
            plain.state = clipboardStore.preferences.plainTextByDefault ? .on : .off
            plain.frame = NSRect(x: 28, y: 302, width: 536, height: 28)
            body.addSubview(plain)
            body.addSubview(settingLabel("保留时间", y: 226))
            let capacity = NSPopUpButton(frame: NSRect(x: 324, y: 220, width: 240, height: 28))
            for (days, title) in [(7, "一周"), (30, "一月"), (90, "三月"), (365, "一年")] {
                capacity.addItem(withTitle: title)
                capacity.lastItem?.representedObject = days
            }
            capacity.selectItem(withTitle: [7: "一周", 30: "一月", 90: "三月", 365: "一年"][clipboardStore.preferences.retentionDays] ?? "一月")
            capacity.target = self
            capacity.action = #selector(clipboardCapacityChanged(_:))
            WindowChrome.stylePopUp(capacity)
            body.addSubview(capacity)
            let sizeLabel = settingLabel("单条内容大小上限", y: 186, width: 220)
            sizeLabel.frame.origin.x = 28
            body.addSubview(sizeLabel)
            let size = NSPopUpButton(frame: NSRect(x: 324, y: 180, width: 240, height: 28))
            for megabytes in [5, 10, 20, 50] {
                size.addItem(withTitle: "\(megabytes) MB")
                size.lastItem?.representedObject = megabytes
            }
            size.selectItem(withTitle: "\(clipboardStore.preferences.maxItemBytes / 1_000_000) MB")
            size.target = self
            size.action = #selector(clipboardSizeChanged(_:))
            WindowChrome.stylePopUp(size)
            body.addSubview(size)
            body.addSubview(settingLabel("排除应用", y: 146))
            let excluded = NSPopUpButton(frame: NSRect(x: 324, y: 140, width: 240, height: 28))
            let count = clipboardStore.preferences.ignoreApplications.count
            excluded.addItem(withTitle: count == 0 ? "未排除应用 · 点击选择" : "已排除 \(count) 个应用 · 点击修改")
            let options = apps.compactMap { entry -> (String, String)? in
                guard let identifier = Bundle(url: URL(fileURLWithPath: entry.value))?.bundleIdentifier else { return nil }
                return (entry.title, identifier)
            }
            var identifiers = Set<String>()
            for (name, identifier) in options.sorted(by: { $0.0.localizedStandardCompare($1.0) == .orderedAscending }) {
                guard identifiers.insert(identifier).inserted else { continue }
                excluded.addItem(withTitle: name)
                excluded.lastItem?.representedObject = identifier
                excluded.lastItem?.state = clipboardStore.preferences.ignoreApplications.contains(identifier) ? .on : .off
            }
            excluded.target = self
            excluded.action = #selector(clipboardExcludedChanged(_:))
            excluded.selectItem(at: 0)
            WindowChrome.stylePopUp(excluded)
            body.addSubview(excluded)
            let note = settingLabel("只在本机保存；排除应用和隐藏内容不会记录。", y: 98, width: 536)
            note.font = .systemFont(ofSize: 11)
            note.textColor = .secondaryLabelColor
            body.addSubview(note)
            let open = NSButton(title: "打开剪贴板历史", target: self, action: #selector(showClipboard))
            open.frame = NSRect(x: 28, y: 54, width: 220, height: 28)
            WindowChrome.styleAction(open)
            body.addSubview(open)
            let clear = NSButton(title: "清理历史…  ▾", target: self, action: #selector(showClearMenu(_:)))
            clear.frame = NSRect(x: 422, y: 54, width: 142, height: 28)
            WindowChrome.styleAction(clear)
            clear.layer?.backgroundColor = NSColor.systemRed.withAlphaComponent(0.07).cgColor
            clear.layer?.borderColor = NSColor.systemRed.withAlphaComponent(0.22).cgColor
            clear.contentTintColor = NSColor.systemRed.withAlphaComponent(0.72)
            body.addSubview(clear)
        case 3:
            let editor = AliasEditorView(frame: body.bounds, store: aliases) { [weak self] in self?.update() }
            body.addSubview(editor)
        case 4:
            body.addSubview(SnippetEditorView(frame: body.bounds, store: snippets))
        case 5:
            let permissions = PermissionsView(frame: body.bounds)
            permissions.fileSearch = fileSearch
            permissions.fileSearchEnabled = settings.value.searchFiles
            permissions.onRetryFiles = { [weak self] in self?.fileSearch.rescan() }
            permissions.onEnableFiles = { [weak self] in self?.enableFileSearchFromPermissions() }
            permissions.onOpenSearchSettings = { [weak self] in
                self?.settingsTabIndex = 1
                self?.renderSettings()
            }
            permissions.refreshFileStatus()
            body.addSubview(permissions)
            permissionsView = permissions
        case 6:
            let diagnostics = DiagnosticsView(frame: body.bounds)
            diagnostics.openHotkeys = { [weak self] in
                self?.settingsTabIndex = 0
                self?.renderSettings()
            }
            diagnostics.openPermissions = { [weak self] in
                self?.settingsTabIndex = 5
                self?.renderSettings()
            }
            diagnostics.retryDoubleTap = { [weak self] in self?.installDoubleTapMonitor() }
            diagnostics.snapshot = { [weak self] in self?.diagnosticSnapshot() ?? DiagnosticSnapshot(
                version: "未知", build: "", macOS: "", architecture: "", accessibilityEffective: false,
                searchHotkeyActive: false, clipboardHotkeyActive: false, stackHotkeyActive: false,
                selectionHotkeyActive: false,
                doubleTapConfigured: false, doubleTapActive: false, chromeProfileCount: 0, chromeBookmarksEnabled: false,
                chromeHistoryEnabled: false, fileSearchEnabled: false, fileIndexCount: 0,
                fileIndexing: false, unreadableFolderCount: 0, clipboardRecordingEnabled: false,
                clipboardPaused: false, clipboardItemCount: 0, exportedAt: Date()) }
            body.addSubview(diagnostics)
            diagnostics.reload()
        case 7:
            let heading = settingLabel("外观", y: 456, width: 250)
            heading.font = .systemFont(ofSize: 21, weight: .semibold)
            body.addSubview(heading)
            let instruction = settingLabel("配色自动应用到所有窗口。", y: 427, width: 640)
            instruction.font = .systemFont(ofSize: 11)
            instruction.textColor = OpenAllTheme.muted
            body.addSubview(instruction)
            let presets = NSView(frame: NSRect(x: 28, y: 313, width: 640, height: 91))
            WindowChrome.styleSettingsSection(presets)
            body.addSubview(presets)
            appearancePresetButtons = []
            for (row, title, values) in [(0, "背景色", backgroundPresets), (1, "强调色", accentPresets)] {
                let y = CGFloat(row == 0 ? 54 : 10)
                let label = NSTextField(labelWithString: title)
                label.font = .systemFont(ofSize: 13, weight: .medium)
                label.textColor = OpenAllTheme.ink
                label.frame = NSRect(x: 0, y: y + 6, width: 82, height: 22)
                presets.addSubview(label)
                for (index, value) in values.enumerated() {
                    let button = AppearancePresetButton(frame: NSRect(x: 90 + CGFloat(index) * 108, y: y, width: 106, height: 34))
                    button.swatchTitle = value.0
                    button.swatchColor = (value.1 == "SYSTEM" ? OpenAllTheme.systemCanvas : OpenAllTheme.color(value.1)) ?? OpenAllTheme.canvas
                    button.isBordered = false
                    button.font = .systemFont(ofSize: 12, weight: .medium)
                    button.wantsLayer = true
                    button.layer?.cornerRadius = 8
                    button.layer?.backgroundColor = NSColor.clear.cgColor
                    button.layer?.borderWidth = 0
                    button.tag = row * 100 + index
                    button.target = self
                    button.action = #selector(applyAppearancePreset(_:))
                    button.toolTip = "将\(title)设为\(value.0)"
                    button.setAccessibilityRole(.radioButton)
                    button.setAccessibilityLabel(button.toolTip!)
                    presets.addSubview(button)
                    appearancePresetButtons.append(button)
                }
            }
            let customTitle = NSButton(title: appearanceCustomExpanded ? "⌄ 自定义颜色" : "› 自定义颜色", target: self, action: #selector(toggleAppearanceCustom))
            customTitle.frame = NSRect(x: 28, y: 276, width: 114, height: 28)
            WindowChrome.styleOutputAction(customTitle)
            body.addSubview(customTitle)
            customTitle.alignment = .left
            let reset = NSButton(title: "恢复默认配色", target: self, action: #selector(resetAppearance))
            reset.frame = NSRect(x: 546, y: 276, width: 122, height: 28)
            WindowChrome.styleOutputAction(reset)
            reset.alignment = .right
            body.addSubview(reset)
            let controls = NSView(frame: NSRect(x: 28, y: 194, width: 640, height: 76))
            controls.isHidden = !appearanceCustomExpanded
            WindowChrome.styleSettingsSection(controls)
            body.addSubview(controls)
            for (title, x, tag, color) in [("背景色", CGFloat(20), 1, OpenAllTheme.canvas),
                                           ("强调色", CGFloat(326), 2, OpenAllTheme.accent)] {
                let label = NSTextField(labelWithString: title)
                label.font = .systemFont(ofSize: 11, weight: .medium)
                label.textColor = OpenAllTheme.muted
                label.frame = NSRect(x: x, y: 46, width: 70, height: 18)
                controls.addSubview(label)
                let swatch = NSButton(frame: NSRect(x: x, y: 11, width: 44, height: 30))
                swatch.title = ""
                swatch.isBordered = false
                swatch.wantsLayer = true
                swatch.layer?.cornerRadius = 7
                swatch.layer?.backgroundColor = color.cgColor
                swatch.layer?.borderWidth = 1
                swatch.layer?.borderColor = OpenAllTheme.rule.cgColor
                swatch.tag = tag
                swatch.target = self
                swatch.action = #selector(chooseAppearanceColor(_:))
                swatch.toolTip = "选择\(title)"
                swatch.setAccessibilityLabel("选择\(title)")
                controls.addSubview(swatch)
                let hex = NSTextField(labelWithString: OpenAllTheme.hex(color))
                hex.font = .monospacedSystemFont(ofSize: 12, weight: .regular)
                hex.textColor = OpenAllTheme.muted
                hex.frame = NSRect(x: x + 55, y: 16, width: 90, height: 20)
                controls.addSubview(hex)
                let choose = NSButton(title: "选择颜色…", target: self, action: #selector(chooseAppearanceColor(_:)))
                choose.tag = tag
                choose.frame = NSRect(x: x + 166, y: 10, width: 105, height: 31)
                WindowChrome.styleAction(choose)
                controls.addSubview(choose)
                if tag == 1 { backgroundHexLabel = hex; backgroundSwatch = swatch }
                else { accentHexLabel = hex; accentSwatch = swatch }
            }
            let preview = NSView(frame: NSRect(x: 28, y: appearanceCustomExpanded ? 55 : 141, width: 640, height: 116))
            WindowChrome.styleCard(preview, radius: 10)
            preview.layer?.borderWidth = 1
            body.addSubview(preview)
            appearancePreview = preview
            let searchIcon = NSImageView(frame: NSRect(x: 20, y: 80, width: 15, height: 15))
            searchIcon.image = NSImage(systemSymbolName: "magnifyingglass", accessibilityDescription: nil)
            searchIcon.contentTintColor = OpenAllTheme.muted
            preview.addSubview(searchIcon)
            let previewTitle = NSTextField(labelWithString: "搜索 JSON")
            previewTitle.font = .systemFont(ofSize: 13, weight: .medium)
            previewTitle.textColor = OpenAllTheme.ink
            previewTitle.frame = NSRect(x: 44, y: 74, width: 200, height: 22)
            preview.addSubview(previewTitle)
            let previewSubtitle = NSTextField(labelWithString: "应用、文件与工具")
            previewSubtitle.font = .systemFont(ofSize: 11)
            previewSubtitle.textColor = OpenAllTheme.muted
            previewSubtitle.alignment = .right
            previewSubtitle.frame = NSRect(x: 369, y: 75, width: 250, height: 20)
            preview.addSubview(previewSubtitle)
            let sample = NSView(frame: NSRect(x: 10, y: 10, width: 620, height: 56))
            sample.wantsLayer = true
            sample.layer?.cornerRadius = 6
            let icon = NSImageView(frame: NSRect(x: 13, y: 16, width: 24, height: 24))
            icon.image = NSImage(systemSymbolName: "curlybraces", accessibilityDescription: nil)
            icon.contentTintColor = OpenAllTheme.accentText
            sample.addSubview(icon)
            let name = NSTextField(labelWithString: "JSON 工具")
            name.font = .systemFont(ofSize: 13, weight: .semibold)
            name.textColor = OpenAllTheme.ink
            name.frame = NSRect(x: 46, y: 26, width: 420, height: 20)
            sample.addSubview(name)
            let detail = NSTextField(labelWithString: "格式化、折叠和编辑")
            detail.font = .systemFont(ofSize: 11)
            detail.textColor = OpenAllTheme.muted
            detail.frame = NSRect(x: 46, y: 8, width: 420, height: 18)
            sample.addSubview(detail)
            preview.addSubview(sample)
            appearanceAccentSample = sample
            refreshAppearanceControls()
        case 8:
            let editor = CommandAliasEditorView(frame: body.bounds, store: commandAliases,
                                                settings: settings.value) { [weak self] in self?.update() }
            body.addSubview(editor)
        default:
            break
        }
    }

    @objc private func toggleAppearanceCustom() { appearanceCustomExpanded.toggle(); renderSettings() }

    @objc private func toggleChromeAdvanced() { chromeAdvancedExpanded.toggle(); renderSettings() }

    private func refreshFileSearchHint() {
        guard let hint = searchFileHint else { return }
        if !settings.value.searchFiles {
            hint.stringValue = "开启后搜索桌面、文稿与下载等目录；macOS 会在首次访问受保护目录时请求授权。"
            hint.textColor = OpenAllTheme.muted
        } else if !fileSearch.unreadableFolders.isEmpty {
            let names = fileSearch.unreadableFolders.map { ["Downloads": "下载", "Documents": "文稿", "Desktop": "桌面"][$0] ?? $0 }
            hint.stringValue = "无法读取：\(names.joined(separator: "、"))。请到“权限与隐私 → 文件与文件夹”开启后重新扫描。"
            hint.textColor = .systemOrange
        } else if fileSearch.isIndexing {
            hint.stringValue = "正在扫描桌面、文稿与下载等目录；请留意 macOS 的访问授权提示。"
            hint.textColor = OpenAllTheme.muted
        } else {
            hint.stringValue = "已索引 \(fileSearch.indexedCount) 项。未找到下载文件时，请检查权限后点“重新扫描文件”。"
            hint.textColor = OpenAllTheme.muted
        }
    }

    @objc private func rescanFilesFromSettings() { fileSearch.rescan(); refreshFileSearchHint() }

    @objc private func redetectChrome() { refreshIndex(); renderSettings() }

    @objc private func toggleUpdateSettings() {
        updateSettingsExpanded.toggle()
        renderSettings()
    }

    @objc private func openSearchManager() {
        settingsSearchManager = true
        renderSettings()
    }

    @objc private func closeSearchManager() {
        settingsSearchManager = false
        renderSettings()
    }

    private func renderSearchManager(in body: NSView) {
        let heading = settingLabel("搜索排序管理", y: 449, width: 260)
        heading.font = .systemFont(ofSize: 18, weight: .medium)
        body.addSubview(heading)
        let back = NSButton(title: "← 返回搜索设置", target: self, action: #selector(closeSearchManager))
        back.frame = NSRect(x: 174, y: 445, width: 147, height: 32)
        WindowChrome.styleOutputAction(back)
        body.addSubview(back)
        let hint = NSTextField(wrappingLabelWithString: "管理置顶与隐藏的搜索结果。")
        hint.font = .systemFont(ofSize: 12)
        hint.textColor = .secondaryLabelColor
        hint.frame = NSRect(x: 28, y: 395, width: 640, height: 35)
        body.addSubview(hint)
        let rules = ranking.manualRules
        let scroll = NSScrollView(frame: NSRect(x: 28, y: 116, width: 640, height: 270))
        scroll.drawsBackground = false
        scroll.hasVerticalScroller = true
        let contentHeight = max(270, CGFloat(rules.count) * 50 + 10)
        let content = NSView(frame: NSRect(x: 0, y: 0, width: 620, height: contentHeight))
        if rules.isEmpty {
            hint.isHidden = true
            let emptyTitle = NSTextField(labelWithString: "暂无置顶或隐藏的结果")
            emptyTitle.font = .systemFont(ofSize: 15, weight: .semibold)
            emptyTitle.textColor = OpenAllTheme.ink
            emptyTitle.alignment = .center
            emptyTitle.frame = NSRect(x: 0, y: 175, width: 620, height: 24)
            content.addSubview(emptyTitle)
            let instructions = NSTextField(labelWithString: "在搜索中选中结果，按 ⌘K 即可置顶或隐藏。")
            instructions.textColor = OpenAllTheme.muted
            instructions.alignment = .center
            instructions.frame = NSRect(x: 0, y: 147, width: 620, height: 22)
            content.addSubview(instructions)
            let start = NSButton(title: "打开搜索", target: self, action: #selector(show))
            start.frame = NSRect(x: 251, y: 94, width: 118, height: 32)
            WindowChrome.styleAction(start, primary: true)
            content.addSubview(start)
        }
        for (index, rule) in rules.enumerated() {
            let y = contentHeight - CGFloat(index + 1) * 50
            let title = NSTextField(labelWithString: rule.title)
            title.font = .systemFont(ofSize: 13, weight: .medium)
            title.lineBreakMode = .byTruncatingMiddle
            title.frame = NSRect(x: 12, y: y + 23, width: 430, height: 20)
            content.addSubview(title)
            let detail = NSTextField(labelWithString: "\(rule.hidden ? "已隐藏" : "已置顶") · \(rule.kind)")
            detail.font = .systemFont(ofSize: 11)
            detail.textColor = .secondaryLabelColor
            detail.frame = NSRect(x: 12, y: y + 6, width: 430, height: 16)
            content.addSubview(detail)
            let restore = NSButton(title: "恢复默认", target: self, action: #selector(restoreSearchRule(_:)))
            restore.tag = index
            restore.frame = NSRect(x: 470, y: y + 11, width: 115, height: 28)
            WindowChrome.styleAction(restore)
            content.addSubview(restore)
        }
        scroll.documentView = content
        body.addSubview(scroll)
        guard ranking.hasUsageHistory else { return }
        let clear = NSButton(title: "清除本机使用排序记录", target: self, action: #selector(clearSearchUsage))
        let historyRule = NSView(frame: NSRect(x: 28, y: 100, width: 620, height: 1))
        historyRule.wantsLayer = true
        historyRule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        body.addSubview(historyRule)
        body.addSubview(settingLabel("使用频率记录", y: 65, width: 220))
        clear.frame = NSRect(x: 444, y: 57, width: 204, height: 32)
        WindowChrome.styleOutputAction(clear)
        body.addSubview(clear)
        let note = settingLabel("清除后重新学习使用频率，手动规则会保留。", y: 39, width: 480)
        note.font = .systemFont(ofSize: 11)
        note.textColor = .secondaryLabelColor
        body.addSubview(note)
    }

    @objc private func restoreSearchRule(_ sender: NSButton) {
        let rules = ranking.manualRules
        guard rules.indices.contains(sender.tag) else { return }
        ranking.resetRule(kind: rules[sender.tag].kind, value: rules[sender.tag].value)
        renderSettings()
        update()
    }

    @objc private func clearSearchUsage() {
        ranking.clearUsage()
        renderSettings()
        update()
    }

    @objc private func chooseAppearanceColor(_ sender: NSButton) {
        choosingAppearanceTag = sender.tag
        let panel = NSColorPanel.shared
        panel.showsAlpha = false
        panel.color = sender.tag == 1 ? OpenAllTheme.canvas : OpenAllTheme.accent
        panel.setTarget(self)
        panel.setAction(#selector(appearancePanelChanged(_:)))
        panel.makeKeyAndOrderFront(nil)
    }

    @objc private func applyAppearancePreset(_ sender: NSButton) {
        NSColorPanel.shared.close()
        let isBackground = sender.tag < 100
        let index = sender.tag % 100
        let hex = isBackground ? backgroundPresets[index].1 : accentPresets[index].1
        if isBackground && hex == "SYSTEM" { OpenAllTheme.followSystem() }
        else if let color = OpenAllTheme.color(hex) {
            if isBackground { OpenAllTheme.setBackground(color) }
            else { OpenAllTheme.setAccent(color) }
        } else { return }
        WindowChrome.refreshAllWindows()
        renderSettings()
    }

    private func refreshAppearanceControls() {
        for button in appearancePresetButtons {
            let isBackground = button.tag < 100
            let index = button.tag % 100
            let preset = isBackground ? backgroundPresets[index] : accentPresets[index]
            let current = isBackground ? OpenAllTheme.hex(OpenAllTheme.canvas) : OpenAllTheme.hex(OpenAllTheme.accent)
            let selected = preset.1 == "SYSTEM" ? OpenAllTheme.followsSystem :
                (!isBackground || !OpenAllTheme.followsSystem) && current == preset.1
            button.chosen = selected
        }
        appearancePreview?.layer?.backgroundColor = OpenAllTheme.surface.cgColor
        appearancePreview?.layer?.borderColor = OpenAllTheme.rule.cgColor
        appearanceAccentSample?.layer?.backgroundColor = OpenAllTheme.accent.withAlphaComponent(0.15).cgColor
        backgroundSwatch?.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        accentSwatch?.layer?.backgroundColor = OpenAllTheme.accent.cgColor
        let backgroundIsCustom = !appearancePresetButtons.contains { $0.tag < 100 && $0.chosen }
        let accentIsCustom = !appearancePresetButtons.contains { $0.tag >= 100 && $0.chosen }
        backgroundHexLabel?.stringValue = OpenAllTheme.hex(OpenAllTheme.canvas) + (backgroundIsCustom ? "  ✓" : "")
        accentHexLabel?.stringValue = OpenAllTheme.hex(OpenAllTheme.accent) + (accentIsCustom ? "  ✓" : "")
    }

    @objc private func appearancePanelChanged(_ sender: NSColorPanel) {
        if choosingAppearanceTag == 1 { OpenAllTheme.setBackground(sender.color) }
        else { OpenAllTheme.setAccent(sender.color) }
        WindowChrome.refreshAllWindows()
        renderSettings()
    }

    @objc private func resetAppearance() {
        NSColorPanel.shared.close()
        OpenAllTheme.reset()
        WindowChrome.refreshAllWindows()
        renderSettings()
    }

    @objc private func systemAppearanceChanged() {
        DispatchQueue.main.async { [weak self] in
            guard let self, OpenAllTheme.followsSystem else { return }
            WindowChrome.refreshAllWindows()
            if self.settingsTabIndex == 7 { self.renderSettings() }
        }
    }

    @objc private func updateFeedChanged(_ sender: NSTextField) {
        var next = settings.value
        next.updateFeedURL = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.update(next)
        renderSettings()
    }
    @objc private func checkForUpdates() { updater.check(feed: settings.value.updateFeedURL) }
    @objc private func installUpdate() { updater.installAvailable() }
    @objc private func rollbackUpdate() { updater.rollback() }

    @objc private func clipboardPreferenceChanged(_ sender: NSButton) {
        var next = clipboardStore.preferences
        if sender.tag == 1 { next.enabled = sender.state == .on }
        else if sender.tag == 3 { next.plainTextByDefault = sender.state == .on }
        clipboardStore.updatePreferences(next)
        if sender.tag == 1 { renderSettings() }
    }
    @objc private func pinyinChanged(_ sender: NSButton) {
        var next = settings.value
        next.pinyinEnabled = sender.state == .on
        settings.update(next)
        update()
    }
    @objc private func searchSourceChanged(_ sender: NSButton) {
        var next = settings.value
        if sender.tag == 10 { next.searchBookmarks = sender.state == .on }
        else if sender.tag == 11 { next.searchHistory = sender.state == .on }
        else if sender.tag == 12 { next.searchFiles = sender.state == .on }
        settings.update(next)
        refreshIndex()
        renderSettings()
    }
    private func enableFileSearchFromPermissions() {
        var next = settings.value
        next.searchFiles = true
        settings.update(next)
        refreshIndex()
        renderSettings()
    }
    @objc private func chromePathChanged(_ sender: NSTextField) {
        var next = settings.value
        next.chromePath = sender.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        settings.update(next)
        refreshIndex()
        renderSettings()
    }
    @objc private func clipboardCapacityChanged(_ sender: NSPopUpButton) {
        var next = clipboardStore.preferences
        next.retentionDays = sender.selectedItem?.representedObject as? Int ?? 30
        clipboardStore.updatePreferences(next)
    }
    @objc private func clipboardSizeChanged(_ sender: NSPopUpButton) {
        var next = clipboardStore.preferences
        next.maxItemBytes = (sender.selectedItem?.representedObject as? Int ?? 20) * 1_000_000
        clipboardStore.updatePreferences(next)
    }
    @objc private func clipboardExcludedChanged(_ sender: NSPopUpButton) {
        guard let identifier = sender.selectedItem?.representedObject as? String else { return }
        var next = clipboardStore.preferences
        if next.ignoreApplications.contains(identifier) {
            next.ignoreApplications.removeAll { $0 == identifier }
        } else {
            next.ignoreApplications.append(identifier)
        }
        clipboardStore.updatePreferences(next)
        renderSettings()
    }
    @objc private func clipboardPauseChanged(_ sender: NSPopUpButton) {
        let now = Date()
        let until: Date?
        switch sender.indexOfSelectedItem {
        case 1: until = now.addingTimeInterval(3600)
        case 2: until = Calendar.current.date(byAdding: .day, value: 1, to: Calendar.current.startOfDay(for: now))
        case 3: until = Date.distantFuture
        default: until = nil
        }
        clipboardStore.setPaused(until: until)
        renderSettings()
    }
    @objc private func showClearMenu(_ sender: NSButton) {
        let menu = NSMenu(title: "清理未固定记录")
        for (index, title) in ["最近 1 小时", "最近 1 天", "最近 7 天", "全部未固定记录"].enumerated() {
            let item = menu.addItem(withTitle: title, action: #selector(clearClipboardByTime(_:)), keyEquivalent: "")
            item.tag = index + 1
            item.target = self
        }
        menu.popUp(positioning: nil, at: NSPoint(x: 0, y: sender.bounds.height), in: sender)
    }
    @objc private func clearClipboardByTime(_ sender: NSMenuItem) {
        switch sender.tag {
        case 1: clipboardStore.clearUnpinned(since: Date().addingTimeInterval(-3600))
        case 2: clipboardStore.clearUnpinned(since: Date().addingTimeInterval(-86400))
        case 3: clipboardStore.clearUnpinned(since: Date().addingTimeInterval(-7 * 86400))
        case 4: clipboardStore.clearUnpinned()
        default: return
        }
    }
    private func diagnosticSnapshot() -> DiagnosticSnapshot {
        #if arch(arm64)
        let architecture = "arm64"
        #else
        let architecture = "x86_64"
        #endif
        return DiagnosticSnapshot(
            version: Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "未知",
            build: Bundle.main.object(forInfoDictionaryKey: "CFBundleVersion") as? String ?? "未知",
            macOS: ProcessInfo.processInfo.operatingSystemVersionString,
            architecture: architecture,
            accessibilityEffective: AXIsProcessTrusted(),
            searchHotkeyActive: settings.value.searchShortcutMode == "double" ? doubleTapMonitor.isActive : shortcutAvailable,
            clipboardHotkeyActive: clipboardShortcutAvailable, stackHotkeyActive: stackShortcutAvailable,
            selectionHotkeyActive: selectionShortcutAvailable,
            doubleTapConfigured: settings.value.searchShortcutMode == "double" && settings.value.doubleTapKeyCode != nil,
            doubleTapActive: doubleTapMonitor.isActive, chromeProfileCount: chrome.profiles.count,
            chromeBookmarksEnabled: settings.value.searchBookmarks, chromeHistoryEnabled: settings.value.searchHistory,
            fileSearchEnabled: settings.value.searchFiles, fileIndexCount: fileSearch.isIndexing ? fileSearch.scannedCount : fileSearch.indexedCount,
            fileIndexing: fileSearch.isIndexing, unreadableFolderCount: fileSearch.unreadableFolders.count,
            clipboardRecordingEnabled: clipboardStore.preferences.enabled, clipboardPaused: clipboardStore.isPaused,
            clipboardItemCount: clipboardStore.records.count, exportedAt: Date())
    }
    @objc private func openPermissionsTab() { settingsTabIndex = 5; renderSettings() }
    @objc private func openDiagnosticsTab() { settingsTabIndex = 6; renderSettings() }
    @objc private func retryDoubleTapFromSettings() { installDoubleTapMonitor(); renderSettings() }

    @objc private func changeSearchShortcutMode(_ sender: NSButton) {
        let mode = sender.tag == 1 ? "double" : "combo"
        guard settings.value.searchShortcutMode != mode else { return }
        var next = settings.value
        next.searchShortcutMode = mode
        if mode == "double" && next.doubleTapKeyCode == nil {
            next.doubleTapKeyCode = 58
            next.doubleTapKeyLabel = "⌥"
            next.doubleTapModifiers = 0
        }
        settings.update(next)
        registerHotkey()
        installDoubleTapMonitor()
        renderSettings()
    }

    @objc private func beginRecording(_ sender: NSButton) {
        if let hotkey { UnregisterEventHotKey(hotkey); self.hotkey = nil }
        if let clipboardHotkey { UnregisterEventHotKey(clipboardHotkey); self.clipboardHotkey = nil }
        if let stackHotkey { UnregisterEventHotKey(stackHotkey); self.stackHotkey = nil }
        if let selectionHotkey { UnregisterEventHotKey(selectionHotkey); self.selectionHotkey = nil }
        doubleTapMonitor.stop()
        sender.title = "请按快捷键…"
        if let recordMonitor { NSEvent.removeMonitor(recordMonitor) }
        recordMonitor = NSEvent.addLocalMonitorForEvents(matching: [.keyDown, .flagsChanged]) { [weak self] event in
            guard let self else { return event }
            if sender.tag != 4 && event.type == .flagsChanged { return event }
            if event.keyCode == 53 {
                let current = self.settings.value
                switch sender.tag {
                case 1: sender.title = shortcutDescription(current)
                case 2: sender.title = shortcutDescription(code: current.clipboardKeyCode, modifiers: current.clipboardModifiers, label: current.clipboardKeyLabel)
                case 3: sender.title = shortcutDescription(code: current.stackKeyCode, modifiers: current.stackModifiers, label: current.stackKeyLabel)
                case 5: sender.title = shortcutDescription(code: current.selectionKeyCode, modifiers: current.selectionModifiers, label: current.selectionKeyLabel)
                default: sender.title = current.doubleTapKeyCode == nil ? "双击：未设置" : "双击：" + shortcutDescription(code: current.doubleTapKeyCode ?? 0, modifiers: current.doubleTapModifiers, label: current.doubleTapKeyLabel)
                }
                self.registerHotkey()
                self.installDoubleTapMonitor()
            } else {
                var modifiers: UInt32 = 0
                if event.modifierFlags.contains(.command) { modifiers |= UInt32(cmdKey) }
                if event.modifierFlags.contains(.option) { modifiers |= UInt32(optionKey) }
                if event.modifierFlags.contains(.control) { modifiers |= UInt32(controlKey) }
                if event.modifierFlags.contains(.shift) { modifiers |= UInt32(shiftKey) }
                guard sender.tag == 4 || modifiers != 0 else { sender.title = "请同时按一个修饰键"; return nil }
                var next = self.settings.value
                let special: [UInt16: String] = [UInt16(kVK_Space): "Space", UInt16(kVK_Return): "↵", UInt16(kVK_Tab): "⇥", UInt16(kVK_Delete): "⌫"]
                let modifierNames: [UInt16: (String, UInt32)] = [55: ("⌘", UInt32(cmdKey)), 54: ("⌘", UInt32(cmdKey)),
                    58: ("⌥", UInt32(optionKey)), 61: ("⌥", UInt32(optionKey)),
                    59: ("⌃", UInt32(controlKey)), 62: ("⌃", UInt32(controlKey)),
                    56: ("⇧", UInt32(shiftKey)), 60: ("⇧", UInt32(shiftKey))]
                if event.type == .flagsChanged {
                    guard let modifier = modifierNames[event.keyCode] else { return event }
                    let flag: NSEvent.ModifierFlags = modifier.1 == UInt32(cmdKey) ? .command :
                        modifier.1 == UInt32(optionKey) ? .option : modifier.1 == UInt32(controlKey) ? .control : .shift
                    if !event.modifierFlags.contains(flag) { return event }
                }
                let label = modifierNames[event.keyCode]?.0 ?? special[event.keyCode] ?? event.charactersIgnoringModifiers?.uppercased() ?? "键码 \(event.keyCode)"
                if sender.tag == 1 {
                    next.keyCode = UInt32(event.keyCode)
                    next.modifiers = modifiers
                    next.keyLabel = label
                    next.searchShortcutMode = "combo"
                } else if sender.tag == 2 {
                    next.clipboardKeyCode = UInt32(event.keyCode)
                    next.clipboardModifiers = modifiers
                    next.clipboardKeyLabel = label
                } else if sender.tag == 3 {
                    next.stackKeyCode = UInt32(event.keyCode)
                    next.stackModifiers = modifiers
                    next.stackKeyLabel = label
                } else if sender.tag == 5 {
                    next.selectionKeyCode = UInt32(event.keyCode)
                    next.selectionModifiers = modifiers
                    next.selectionKeyLabel = label
                } else {
                    next.doubleTapKeyCode = UInt32(event.keyCode)
                    next.doubleTapModifiers = modifiers & ~(modifierNames[event.keyCode]?.1 ?? 0)
                    next.doubleTapKeyLabel = label
                    next.doubleTap = "none"
                    next.searchShortcutMode = "double"
                }
                self.settings.update(next)
                self.registerHotkey()
                self.installDoubleTapMonitor()
                let recorded = shortcutDescription(code: UInt32(event.keyCode), modifiers: sender.tag == 4 ? next.doubleTapModifiers : modifiers, label: label)
                sender.title = sender.tag == 4 ? "双击：" + recorded : recorded
                if sender.tag == 1 { self.settingsStatus?.stringValue = self.shortcutAvailable ? "快捷键已启用" : "快捷键被占用，请录制其他组合" }
            }
            if let monitor = self.recordMonitor { NSEvent.removeMonitor(monitor); self.recordMonitor = nil }
            if sender.tag == 4 || sender.tag == 1 { self.renderSettings() }
            return nil
        }
    }

    @objc private func disableDoubleTap() {
        var next = settings.value
        next.doubleTapKeyCode = nil
        next.doubleTapModifiers = 0
        next.doubleTapKeyLabel = ""
        next.doubleTap = "off"
        next.searchShortcutMode = "combo"
        settings.update(next)
        registerHotkey()
        installDoubleTapMonitor()
        renderSettings()
    }
}

#if TEST
let index = ChromeIndex()
index.refresh()
print("profiles=\(index.profiles.count) bookmarks=\(index.bookmarks.count) history_matches=\(index.searchHistory("google").count)")
print("calculator=\(ExpressionParser("23*(18+4)").parse() ?? -1)")
precondition(SearchFuzzy.matches("Terminal", query: "Termnal"))
precondition(!SearchFuzzy.matches("Terminal", query: "Excel"))
let formatSource = "server:\n    port: 8080\n    enabled: true"
let formattedConfig = LocalTextTools.formatConfiguration(formatSource)
precondition(formattedConfig != nil)
let originalFields = try ConfigDiff.parse(formatSource)
let formattedFields = try ConfigDiff.parse(formattedConfig!.0)
precondition(originalFields == formattedFields)
precondition(LocalTextTools.formatConfiguration("db.url = jdbc:mysql://localhost")?.0 == "db.url=jdbc:mysql://localhost")
precondition(LocalTextTools.formatConfiguration("password = secret  ")?.0 == "password=secret  ")
precondition(LocalTextTools.formatConfiguration(#"first\=last = value  "#)?.0 == #"first\=last=value  "#)
precondition(LocalTextTools.formatConfiguration("key=one\\\nnext=two") == nil)
precondition(LocalTextTools.formatConfiguration("parent: # 注释\n    child: value") == nil)
precondition(LocalTextTools.formatConfiguration("parent: &anchor\n    child: value") == nil)
let formattedSQL = LocalTextTools.formatSQL("select 'FROM x' as name from users where id = 1") ?? ""
precondition(formattedSQL.contains("'FROM x'") && formattedSQL.contains("\nFROM users"))
let joinedSQL = LocalTextTools.formatSQL("select u.id, count(o.id) from users u left join orders o on o.user_id = u.id group by u.id order by u.id;") ?? ""
precondition(joinedSQL.contains("\nLEFT JOIN orders") && joinedSQL.contains("\nGROUP BY u.id") && joinedSQL.contains("\nORDER BY u.id"))
precondition(LocalTextTools.formatSQL("select N'文字', 'it''s';")?.contains("N'文字'") == true)
precondition(LocalTextTools.formatSQL("select count (id) from users;")?.contains("count (id)") == true)
precondition(LocalTextTools.formatSQL("select $$hello from world$$;") == nil)
precondition(LocalTextTools.formatSQL(#"select E'a\n';"#) == nil)
precondition(LocalTextTools.formatSQL("select [name with spaces] from users;") == nil)
precondition(LocalTextTools.formatSQL("select 'hello'\n'world';") == nil)
precondition(LocalTextTools.formatSQL("select 'unterminated") == nil)
precondition(LocalTextTools.formatSQL("select _utf8'文字';") == nil)
precondition(LocalTextTools.formatSQL(#"select _utf8mb4"文字";"#) == nil)
precondition(LocalTextTools.formatSQL(#"select U&"name";"#) == nil)
precondition(LocalTextTools.formatSQL("select U&'name';") == nil)
let sampleSnippet = TextSnippet(id: UUID(), keyword: "date", name: "日期", body: "{{date:yyyy/MM/dd}}", createdAt: Date())
let localizedSnippet = TextSnippet(id: UUID(), keyword: "date_cn", name: "中文日期", body: "{{date:yyyy年MM月dd日 'at' HH:mm}}", createdAt: Date())
let localizedDate = SnippetStore(file: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)).expand(localizedSnippet, clipboard: "", date: Date(timeIntervalSince1970: 0))
precondition(localizedDate.contains("年") && localizedDate.contains("月") && localizedDate.contains(" at ") && !localizedDate.contains("{{"))
precondition(SnippetStore(file: FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)).expand(
    sampleSnippet, clipboard: "", date: Date(timeIntervalSince1970: 0)).contains("/"))
var recognizedCard = ClipboardRecord(id: UUID(), date: Date(), kind: "image", title: "图片", text: "",
                                     filePaths: [], imageName: nil, richTextName: nil, sourceName: "测试", digest: "test", pinned: false)
recognizedCard.recognizedText = "发票号码 12345"
precondition(ClipboardFormat.matches(recognizedCard, query: "12345"))
let savedCard = try JSONEncoder().encode(recognizedCard)
let restoredCard = try JSONDecoder().decode(ClipboardRecord.self, from: savedCard)
precondition(restoredCard.recognizedText == recognizedCard.recognizedText)
precondition(ImageProcessor.proportionalDimension(640, sourceDimension: 640, targetDimension: 360) == 360)
precondition(ImageProcessor.proportionalDimension(1, sourceDimension: 640, targetDimension: 1) == 1)
precondition(ImageProcessor.proportionalDimension(Int.max, sourceDimension: 640, targetDimension: 360) == nil)
precondition(ImageProcessor.proportionalDimension(100, sourceDimension: 0, targetDimension: 360) == nil)
precondition(ImageProcessor.proportionalDimension(12000, sourceDimension: 1, targetDimension: 2) == nil)
let sampleImage = NSImage(size: NSSize(width: 4, height: 3))
sampleImage.lockFocus(); NSColor.red.setFill(); NSRect(x: 0, y: 0, width: 4, height: 3).fill(); sampleImage.unlockFocus()
precondition(ImageProcessor.transformed(sampleImage, pixelSize: NSSize(width: 4, height: 3),
                                        crop: CGRect(x: 1, y: 0, width: 2, height: 2))?.size.width == 2)
precondition(ImageProcessor.transformed(sampleImage, pixelSize: NSSize(width: 4, height: 3),
                                        rotateRight: true)?.size.width == 3)
print("本轮功能检查通过")
#else
let app = NSApplication.shared
let delegate = Launcher()
app.delegate = delegate
app.run()
#endif
