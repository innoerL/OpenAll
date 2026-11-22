import AppKit
import WebKit

private final class ComparisonV2Bridge: NSObject, WKScriptMessageHandler {
    weak var owner: TextCompareV2Window?

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.frameInfo.isMainFrame else { return }
        owner?.receive(message)
    }
}

/// 正式文本对比窗口，左右编辑区直接显示差异。
final class TextCompareV2Window: NSObject, WKNavigationDelegate, NSWindowDelegate, ClipboardTextPasteReceiving {
    private var window: NSWindow?
    private var webView: WKWebView?
    private let bridge = ComparisonV2Bridge()
    private var pending: (String, String)?
    private var pendingVersion = 0
    private var ready = false
    private var filling = false
    private var pendingNotice: String?

    func show(_ left: String, right: String = "") {
        if window == nil { build() }
        if [left, right].contains(where: { $0.utf16.count > 10000000 }) {
            pendingNotice = "内容超过 1000 万字符，已保留当前内容"
            showPendingNotice()
            WindowChrome.present(window)
            return
        }
        pendingNotice = nil
        if !left.isEmpty || !right.isEmpty {
            pending = (left, right)
            pendingVersion += 1
        }
        if let webView, ready { Self.applyTheme(webView); fill() }
        WindowChrome.present(window)
        WindowChrome.activate()
        if let webView {
            let focused = window?.firstResponder as? NSView
            // 重复打开窗口时保留 WK 内部编辑焦点，避免中断输入法组合状态。
            if focused !== webView && focused?.isDescendant(of: webView) != true {
                window?.makeFirstResponder(webView)
            }
        }
        focusEditorIfNeeded()
        showPendingNotice()
    }

    private func showPendingNotice() {
        guard ready, let webView, let message = pendingNotice,
              let data = try? JSONSerialization.data(withJSONObject: [message]), let encoded = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.compareV2.notice(\(encoded)[0])") { _, _ in }
    }

    private func build() {
        let screen = NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let size = NSSize(width: min(1040, screen.width * 0.92), height: min(600, screen.height * 0.86))
        let w = NSWindow(contentRect: NSRect(origin: .zero, size: size),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        w.delegate = self
        WindowChrome.apply(w, title: "文本对比")
        w.minSize = NSSize(width: 480, height: 460)
        w.center()
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        bridge.owner = self
        configuration.userContentController.add(bridge, name: "comparisonV2")
        let web = WKWebView(frame: NSRect(x: 0, y: 0, width: size.width, height: size.height - WindowChrome.height),
                            configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        w.contentView?.addSubview(web)
        WindowChrome.installControls(on: w, editorStyle: true)
        window = w
        webView = web
        if let file = Bundle.main.url(forResource: "diff-v2", withExtension: "html") {
            web.loadFileURL(file, allowingReadAccessTo: file.deletingLastPathComponent())
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        ready = true
        Self.applyTheme(webView)
        fill()
        focusEditorIfNeeded()
        showPendingNotice()
    }

    private func focusEditorIfNeeded() {
        guard ready, let webView else { return }
        // 首次进入即可粘贴；已有左右编辑焦点或输入法候选时不重新定位。
        webView.evaluateJavaScript("""
        (() => {
          const comparison = window.compareV2;
          if (comparison && comparison.state().composing === 0 &&
              !document.activeElement?.closest('.cm-content')) {
            comparison.focus(0);
          }
        })()
        """) { _, _ in }
    }

    func pasteClipboardText(_ text: String) -> Bool {
        guard ready, let webView, text.utf16.count <= 10000000,
              let data = try? JSONSerialization.data(withJSONObject: [text]),
              let encoded = String(data: data, encoding: .utf8) else { return false }
        webView.evaluateJavaScript("window.compareV2.pasteText(\(encoded)[0])") { _, _ in }
        return true
    }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        decisionHandler(url?.isFileURL == true && url?.lastPathComponent == "diff-v2.html" ? .allow : .cancel)
    }

    func windowDidBecomeKey(_ notification: Notification) {
        if let webView, ready { Self.applyTheme(webView) }
    }

    static func applyTheme(_ webView: WKWebView) {
        let palette: [String: Any] = [
            "canvas": OpenAllTheme.hex(OpenAllTheme.canvas),
            "surface": OpenAllTheme.hex(OpenAllTheme.editorCanvas),
            "raised": OpenAllTheme.hex(OpenAllTheme.raised),
            "ink": OpenAllTheme.hex(OpenAllTheme.ink),
            "muted": OpenAllTheme.hex(OpenAllTheme.muted),
            "secondary": OpenAllTheme.hex(OpenAllTheme.ink.blended(withFraction: 0.26, of: OpenAllTheme.editorCanvas) ?? OpenAllTheme.ink),
            "accent": OpenAllTheme.hex(OpenAllTheme.accentText),
            "rule": OpenAllTheme.isLight ? "rgba(0,0,0,.09)" : "rgba(255,255,255,.065)",
            "light": OpenAllTheme.isLight
        ]
        guard let data = try? JSONSerialization.data(withJSONObject: palette),
              let encoded = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.setOpenAllV2Theme?.(\(encoded))") { _, _ in }
    }

    private func fill() {
        guard ready, !filling, let pending, let webView,
              let data = try? JSONSerialization.data(withJSONObject: [pending.0, pending.1]),
              let encoded = String(data: data, encoding: .utf8) else { return }
        let version = pendingVersion
        filling = true
        webView.evaluateJavaScript("window.setTexts(...\(encoded))") { [weak self] _, error in
            guard let self else { return }
            self.filling = false
            if error == nil {
                if self.pendingVersion == version { self.pending = nil }
                else { self.fill() }
            }
        }
    }

    fileprivate func receive(_ message: WKScriptMessage) {
        guard message.webView === webView, let body = message.body as? [String: Any],
              body["action"] as? String == "copy", let side = body["side"] as? Int,
              (0...1).contains(side), let text = body["text"] as? String else { return }
        NSPasteboard.general.clearContents()
        if NSPasteboard.general.setString(text, forType: .string) {
            webView?.evaluateJavaScript("window.compareV2.copied(\(side))") { _, _ in }
        }
    }

    func showDesignSample() {
        guard DesignPreview.enabled else { return }
        show("""
        应用：OpenAll
        版本：0.23.4

        剪贴板
          布局：底部通栏
          卡片：大卡片 + 彩色类型栏
          自动粘贴：开启
          旧版试验开关：开启

        工具
          JSON 格式化
          文本对比
        """, right: """
        应用：OpenAll
        版本：0.24.0

        剪贴板
          布局：底部通栏
          卡片：大卡片 + 彩色类型栏
          自动粘贴：关闭

        工具
          JSON 格式化
          文本对比
          差异导航
        """)
    }

    @MainActor func verifyPerformanceForDesign() async throws -> Bool {
        guard DesignPreview.enabled, let webView else { return false }
        for _ in 0..<100 {
            if ready && !filling && pending == nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard ready, !filling, pending == nil else { return false }
        // 离屏窗口可能被 WebKit 节流；用公开调用模拟前台交互，区分算法耗时与测试调度延迟。
        let wake = Task { @MainActor in
            while !Task.isCancelled {
                _ = try? await webView.evaluateJavaScript("0")
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        defer { wake.cancel() }
        let value = try await webView.callAsyncJavaScript("return await window.compareV2.verifyPerformance();", arguments: [:], in: nil, contentWorld: .page)
        guard let report = value as? [String: Any] else { return false }
        print("文本对比大文本检查：\(report)")
        return report["passed"] as? Bool == true
    }

    @MainActor private func captureSearchLayouts(_ window: NSWindow, webView: WKWebView) async throws {
        _ = try await webView.evaluateJavaScript("window.compareV2.previewSearch(true)")
        try await DesignPreview.captureWeb(window, name: "08-comparison-search")
        let original = window.frame
        defer { window.setFrame(original, display: true) }
        window.setContentSize(NSSize(width: 480, height: window.contentView?.bounds.height ?? 600))
        let measurement = """
        (() => {
          const [top,bottom] = [...document.querySelectorAll('.pane')].map(p => p.getBoundingClientRect());
          return innerWidth <= 480 && top.width > 440 && top.bottom <= bottom.top + 1 &&
            /[上下]栏/.test(document.querySelector('#find-count').textContent) &&
            document.querySelector('.navigation').getBoundingClientRect().height > 0;
        })()
        """
        var stacked = false
        for _ in 0..<30 {
            if try await webView.evaluateJavaScript(measurement) as? Bool == true { stacked = true; break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard stacked else { throw NSError(domain: "ComparisonNarrowLayout", code: 1) }
        try await DesignPreview.captureWeb(window, name: "08-comparison-search-narrow")
        _ = try await webView.evaluateJavaScript("window.compareV2.previewSearch(false)")
    }

    @MainActor func verifyForDesign() async throws -> Bool {
        guard DesignPreview.enabled, let webView else { return false }
        for _ in 0..<100 {
            if ready && !filling && pending == nil { break }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
        guard ready, !filling, pending == nil else { return false }
        // 保持离屏验收的调度活跃，避免把后台节流误当作交互停顿。
        let wake = Task { @MainActor in
            while !Task.isCancelled {
                _ = try? await webView.evaluateJavaScript("0")
                try? await Task.sleep(nanoseconds: 50_000_000)
            }
        }
        defer { wake.cancel() }
        if ProcessInfo.processInfo.environment["OPENALL_DESIGN_LAYOUT_ONLY"] == "1", let window {
            try await captureSearchLayouts(window, webView: webView)
            return true
        }
        let value = try await webView.callAsyncJavaScript("return await window.compareV2.verify();", arguments: [:],
                                                        in: nil, contentWorld: .page)
        guard let report = value as? [String: Any] else { return false }
        if report["passed"] as? Bool != true {
            print("文本对比回归失败：\(report)")
            return false
        }
        print("文本对比检查通过：\((report["checks"] as? [String])?.count ?? 0) 项")
        if let window {
            let saved = try await webView.evaluateJavaScript("window.compareV2.texts()") as! [String]
            _ = try await webView.evaluateJavaScript("window.setTexts('左侧', '右侧'); window.compareV2.focus(1)")
            window.makeFirstResponder(webView)
            guard ClipboardShelfWindow.pasteForDesign(into: window, text: "右侧插入") else { return false }
            let right = try await webView.evaluateJavaScript("window.compareV2.texts()") as? [String]
            guard right == ["左侧", "右侧插入右侧"] else { print("内部剪贴板右侧失败：\(String(describing: right))"); return false }
            _ = try await webView.evaluateJavaScript("window.compareV2.focus(0)")
            guard ClipboardShelfWindow.pasteForDesign(into: window, text: "左侧插入") else { return false }
            let left = try await webView.evaluateJavaScript("window.compareV2.texts()") as? [String]
            guard left == ["左侧插入左侧", "右侧插入右侧"] else { return false }
            _ = try await webView.callAsyncJavaScript("window.setTexts(...texts)", arguments: ["texts": saved], in: nil, contentWorld: .page)
            print("内部剪贴板：文本对比左右焦点投递通过")
            try await captureSearchLayouts(window, webView: webView)
        }
        return true
    }
}
