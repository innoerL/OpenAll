import AppKit
import WebKit

private final class GoldPanel: NSPanel {
    override var canBecomeKey: Bool { true }
    override var canBecomeMain: Bool { true }
}

private final class GoldWebView: WKWebView, WindowThemeRefreshing {
    var onThemeChanged: (() -> Void)?
    func refreshWindowTheme() { onThemeChanged?() }
}

/// 金价窗口、后台调度与数据均属于 OpenAll；网页仅负责原金价界面的绘制。
final class GoldToolController: NSObject, WKScriptMessageHandlerWithReply, WKNavigationDelegate, NSWindowDelegate {
    var onAppearanceSettings: (() -> Void)?
    private var service: GoldService?
    private var panel: GoldPanel?
    private var webView: GoldWebView?
    private var edgeDock: GoldEdgeDock?
    private var latest: [String: Any] = [:]
    private var starting = false
    private var ready = false
    private var stopping = false
    private var requestedVisible = false
    private var pageLoaded = false
    private var view = "quotes"
    private var startupError: Error?
    private var localPage: URL?
    private var lastDragEvent: NSEvent?
    private var mouseMonitor: Any?
    private let directoryOverride: URL?
    private let fixture: Bool

    init(dataDirectory: URL? = nil, fixture: Bool = false) {
        directoryOverride = dataDirectory
        self.fixture = fixture
        super.init()
    }

    /// 可在宿主启动时调用，关闭金价面板不影响后续取价与正式展望落盘。
    func start() {
        guard !starting, !ready, !stopping else { return }
        starting = true
        startupError = nil
        service?.stop()
        do {
            let directory: URL
            if let directoryOverride { directory = directoryOverride }
            else if let custom = ProcessInfo.processInfo.environment["OPENALL_GOLD_DATA_DIR"], !custom.isEmpty {
                guard custom.hasPrefix("/") else { throw componentError("金价数据目录必须使用绝对路径。") }
                directory = URL(fileURLWithPath: custom, isDirectory: true)
            } else {
                directory = DesignPreview.home.appendingPathComponent("Library/Application Support/OpenAll/gold", isDirectory: true)
            }
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            let usesStandardDirectory = directoryOverride == nil &&
                (ProcessInfo.processInfo.environment["OPENALL_GOLD_DATA_DIR"] ?? "").isEmpty
            let legacyDirectory = !fixture && !DesignPreview.enabled && usesStandardDirectory ?
                DesignPreview.home.appendingPathComponent("Library/Application Support/GoldDesk", isDirectory: true) : nil
            let service = GoldService(dataDirectory: directory, legacyDirectory: legacyDirectory, fixture: fixture)
            self.service = service
            service.onSnapshot = { [weak self] state in self?.accept(state) }
            service.onError = { [weak self] error in self?.startupError = error }
            service.start { [weak self] result in
                guard let self, !self.stopping else { return }
                self.starting = false
                switch result {
                case .success(let state):
                    self.ready = true
                    self.accept(state)
                    if self.requestedVisible && self.panel == nil { self.showReadyWindow() }
                case .failure(let error):
                    self.startupError = error
                    if self.requestedVisible && !self.fixture { self.present(error) }
                }
            }
        } catch {
            starting = false
            startupError = error
            if requestedVisible && !fixture { present(error) }
        }
    }

    func show() {
        guard !stopping else { return }
        requestedVisible = true
        if ready || panel != nil { showReadyWindow() }
        else { start() }
    }

    private func showReadyWindow() {
        do {
            if panel == nil { try createWindow() }
            guard let panel else { return }
            edgeDock?.resume()
            // 展开动画自行管理透明度，重复搜索唤回也不覆盖正在进行的淡入。
            edgeDock?.expand()
            if panel.isMiniaturized { panel.deminiaturize(nil) }
            panel.ignoresMouseEvents = false
            panel.makeKeyAndOrderFront(nil)
            NSApp.activate(ignoringOtherApps: true)
            if pageLoaded { publish() }
        } catch {
            startupError = error
            if !fixture { present(error) }
        }
    }

    private func createWindow() throws {
        guard let resources = Bundle.main.resourceURL else { throw componentError("无法读取 OpenAll 内置资源。") }
        let directory = resources.appendingPathComponent("gold-ui", isDirectory: true)
        let page = directory.appendingPathComponent("index.html")
        guard FileManager.default.fileExists(atPath: page.path) else { throw componentError("未找到 OpenAll 内置金价界面，请重新安装完整应用。") }
        localPage = page.standardizedFileURL
        let window = GoldPanel(contentRect: placement(), styleMask: [.borderless, .resizable, .miniaturizable, .nonactivatingPanel],
            backing: .buffered, defer: false)
        window.title = "OpenAll · 金价"
        window.minSize = NSSize(width: 345, height: 396)
        window.isReleasedWhenClosed = false
        window.hidesOnDeactivate = false
        window.hasShadow = true
        window.backgroundColor = OpenAllTheme.canvas
        window.appearance = OpenAllTheme.appearance
        window.collectionBehavior = [.fullScreenAuxiliary]
        window.delegate = self
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        configuration.preferences.javaScriptCanOpenWindowsAutomatically = false
        configuration.userContentController.addScriptMessageHandler(self, contentWorld: .page, name: "openallGold")
        configuration.userContentController.addUserScript(WKUserScript(source: Self.bridgeScript,
            injectionTime: .atDocumentStart, forMainFrameOnly: true))
        let web = GoldWebView(frame: NSRect(origin: .zero, size: window.frame.size), configuration: configuration)
        web.autoresizingMask = [.width, .height]
        web.navigationDelegate = self
        web.setValue(false, forKey: "drawsBackground")
        web.onThemeChanged = { [weak self] in self?.refreshTheme() }
        window.contentView = web
        panel = window
        webView = web
        let dock = GoldEdgeDock(window: window)
        dock.pinned = { [weak self] in self?.boolean("pinned", default: true) ?? true }
        dock.persistPosition = { [weak self] frame in self?.savePosition(frame) }
        dock.onMotion = { [weak self] side, collapsed in
            guard let self else { return }
            self.emit("edge", ["side": side as Any? ?? NSNull(), "collapsed": collapsed])
            self.publish()
        }
        edgeDock = dock
        dock.syncOnTop()
        // 保留真实 mouseDown 事件，异步网页桥接仍能启动 AppKit 拖动会话。
        mouseMonitor = NSEvent.addLocalMonitorForEvents(matching: .leftMouseDown) { [weak self] event in
            if event.window === self?.panel { self?.lastDragEvent = event }
            return event
        }
        savePosition(window.frame)
        web.loadFileURL(page, allowingReadAccessTo: directory)
    }

    private func placement(current: NSRect? = nil) -> NSRect {
        let saved = latest["position"] as? [String: Any]
        let usesAppKitCoordinates = saved?["coordinateSystem"] as? String == "appkit"
        let primaryTop = NSScreen.screens.first?.frame.maxY ?? 900
        let previous: NSRect? = saved.flatMap { point in
            guard let x = (point["x"] as? NSNumber)?.doubleValue, let y = (point["y"] as? NSNumber)?.doubleValue,
                  x.isFinite, y.isFinite else { return nil }
            // Electron 保存左上原点；先按同一屏幕坐标映射选屏，再用实际窗口高度计算原点。
            return NSRect(x: x, y: usesAppKitCoordinates ? y : primaryTop - y - 100,
                width: current?.width ?? 462, height: 100)
        }
        let area = current.map { GoldEdgeDock.area(for: $0) } ?? previous.map { GoldEdgeDock.area(for: $0) } ??
            NSScreen.main?.visibleFrame ?? NSRect(x: 0, y: 0, width: 1440, height: 900)
        let width = min(current?.width ?? 462, area.width)
        let height = min(view == "outlook" ? 735 : boolean("combined") ? 612 : 826, area.height)
        let x = min(max(current?.minX ?? previous?.minX ?? area.maxX - width - 28, area.minX), area.maxX - width)
        let storedY = previous.map { usesAppKitCoordinates ? $0.minY : $0.maxY - height }
        let y = min(max(current.map { $0.maxY - height } ?? storedY ?? area.maxY - height - 32, area.minY), area.maxY - height)
        return NSRect(x: x, y: y, width: width, height: height)
    }

    private func boolean(_ key: String, default fallback: Bool = false) -> Bool { latest[key] as? Bool ?? fallback }

    private func savePosition(_ frame: NSRect) {
        guard service != nil, !latest.isEmpty, !stopping else { return }
        let position: [String: Any] = ["x": frame.minX, "y": frame.minY, "coordinateSystem": "appkit"]
        latest["position"] = position
        service?.setPreference("position", value: position)
    }

    private static func colorCSS(_ color: NSColor) -> String {
        let color = color.usingColorSpace(.sRGB) ?? color
        return "rgba(\(Int((color.redComponent * 255).rounded())),\(Int((color.greenComponent * 255).rounded())),\(Int((color.blueComponent * 255).rounded())),\(color.alphaComponent))"
    }

    private func snapshot() -> [String: Any] {
        var state = latest
        state["theme"] = ["background": Self.colorCSS(OpenAllTheme.canvas), "surface": Self.colorCSS(OpenAllTheme.surface),
            "foreground": Self.colorCSS(OpenAllTheme.ink), "secondary": Self.colorCSS(OpenAllTheme.muted),
            "border": Self.colorCSS(OpenAllTheme.rule), "accent": Self.colorCSS(OpenAllTheme.accent), "dark": !OpenAllTheme.isLight]
        state["dark"] = !OpenAllTheme.isLight
        state["pinned"] = boolean("pinned", default: true)
        state["combined"] = boolean("combined")
        state["edgeEnabled"] = boolean("edgeEnabled", default: true)
        state["dockSide"] = edgeDock?.side as Any? ?? NSNull()
        state["view"] = view
        return state
    }

    private func accept(_ state: [String: Any]) {
        latest = state
        // 第一份本地快照已带持久化偏好，先显示缓存或加载态，不等待网络请求完成。
        if requestedVisible && panel == nil && !fixture { showReadyWindow() }
        publish()
    }
    private func publish() { emit("snapshot", snapshot()) }

    private func refreshTheme() {
        panel?.backgroundColor = OpenAllTheme.canvas
        panel?.appearance = OpenAllTheme.appearance
        publish()
    }

    private func emit(_ kind: String, _ value: Any) {
        guard pageLoaded, let webView,
              let data = try? JSONSerialization.data(withJSONObject: ["kind": kind, "value": value]),
              let json = String(data: data, encoding: .utf8) else { return }
        webView.evaluateJavaScript("window.__openallGoldDeliver(\(json));") { _, _ in }
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage,
                               replyHandler: @escaping (Any?, String?) -> Void) {
        guard !stopping, message.frameInfo.isMainFrame, message.webView === webView,
              message.frameInfo.request.url?.standardizedFileURL == localPage,
              let body = message.body as? [String: Any], let name = body["name"] as? String else {
            replyHandler(nil, "金价操作仅允许内置金价页面调用。")
            return
        }
        let payload = body["payload"]
        switch name {
        case "read": service?.snapshot { [weak self] result in self?.finish(result, reply: replyHandler) }
        case "pin": setPreference("pinned", value: !boolean("pinned", default: true), reply: replyHandler)
        case "layout":
            guard let combined = payload as? Bool else { replyHandler(nil, "布局参数必须为布尔值。"); return }
            setPreference("combined", value: combined, reply: replyHandler)
        case "edge": setPreference("edgeEnabled", value: !boolean("edgeEnabled", default: true), reply: replyHandler)
        case "currency":
            guard let currency = payload as? String, ["USD", "EUR", "CNY"].contains(currency) else {
                replyHandler(nil, "不支持的金价币种。"); return
            }
            service?.setCurrency(currency) { [weak self] result in self?.finish(result, reply: replyHandler) }
        case "view":
            view = payload as? String == "outlook" ? "outlook" : "quotes"
            if let panel { edgeDock?.reflow(placement(current: panel.frame)) }
            publish(); replyHandler(snapshot(), nil)
        case "appearance": onAppearanceSettings?(); replyHandler(true, nil)
        case "minimize": edgeDock?.prepareForMinimize(); panel?.miniaturize(nil); replyHandler(true, nil)
        case "close": hide(); replyHandler(true, nil)
        case "drag":
            if let event = lastDragEvent, ProcessInfo.processInfo.systemUptime - event.timestamp < 1 { panel?.performDrag(with: event) }
            replyHandler(true, nil)
        case "source":
            guard let key = payload as? String, let address = Self.sourceURLs[key], let url = URL(string: address) else {
                replyHandler(nil, "未知报价来源。"); return
            }
            if !fixture { NSWorkspace.shared.open(url) }
            replyHandler(true, nil)
        case "event":
            let events = (latest["outlook"] as? [String: Any])?["events"] as? [[String: Any]] ?? []
            guard let address = payload as? String, let url = URL(string: address), url.scheme == "https",
                  events.contains(where: { $0["url"] as? String == address }) else {
                replyHandler(nil, "仅支持当前快照列出的国际事件链接。"); return
            }
            if !fixture { NSWorkspace.shared.open(url) }
            replyHandler(true, nil)
        case "network": service?.recheckNetwork(); replyHandler(true, nil)
        default: replyHandler(nil, "未知金价操作。")
        }
    }

    private func setPreference(_ key: String, value: Any, reply: @escaping (Any?, String?) -> Void) {
        service?.setPreference(key, value: value) { [weak self] result in
            guard let self else { reply(nil, "金价窗口已关闭。"); return }
            switch result {
            case .failure(let error): reply(nil, error.localizedDescription)
            case .success(let state):
                self.latest = state
                if key == "edgeEnabled" { self.edgeDock?.setEnabled(self.boolean(key, default: true)) }
                if key == "pinned" { self.edgeDock?.syncOnTop() }
                if key == "combined", let panel = self.panel { self.edgeDock?.reflow(self.placement(current: panel.frame)) }
                self.publish(); reply(self.snapshot(), nil)
            }
        }
    }

    private func finish(_ result: Result<[String: Any], Error>, reply: @escaping (Any?, String?) -> Void) {
        switch result {
        case .success(let state): accept(state); reply(snapshot(), nil)
        case .failure(let error): reply(nil, error.localizedDescription)
        }
    }

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        pageLoaded = true
        publish()
        edgeDock?.setEnabled(boolean("edgeEnabled", default: true))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { startupError = error }

    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                 decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        decisionHandler(navigationAction.targetFrame?.isMainFrame == true &&
            navigationAction.request.url?.standardizedFileURL == localPage ? .allow : .cancel)
    }

    func windowDidMove(_ notification: Notification) { edgeDock?.noteMove() }
    func windowDidResize(_ notification: Notification) { if let panel { savePosition(panel.frame) } }
    func windowWillMiniaturize(_ notification: Notification) { edgeDock?.prepareForMinimize() }
    func windowShouldClose(_ sender: NSWindow) -> Bool { hide(); return false }

    private func hide() { requestedVisible = false; edgeDock?.suspend(); panel?.orderOut(nil) }

    func stop() {
        guard !stopping else { return }
        stopping = true
        service?.stop(); service = nil
        edgeDock?.stop(); edgeDock = nil
        if let mouseMonitor { NSEvent.removeMonitor(mouseMonitor) }
        mouseMonitor = nil
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "openallGold", contentWorld: .page)
        webView?.navigationDelegate = nil
        panel?.delegate = nil
        panel?.orderOut(nil); panel?.close()
        panel = nil; webView = nil
    }

    private func componentError(_ description: String) -> NSError {
        NSError(domain: "OpenAllGold", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }

    private func present(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.messageText = "无法打开金价"
        alert.runModal()
    }

    private static let sourceURLs = [
        "gold": "https://gold-api.com/assets/gold", "goldHistory": "https://goldprice.dev/prices/xau-usd",
        "ctf": "https://www.ctfmall.com/todaygold", "ctfFallback": "https://www.jinjia.com.cn/chowtaifook/",
        "ctfHistory": "https://www.sojinjia.cn/pinpai/zhoudafu/lishi", "fx": "https://frankfurter.dev/",
        "DCOILWTICO": "https://fred.stlouisfed.org/series/DCOILWTICO", "DTWEXBGS": "https://fred.stlouisfed.org/series/DTWEXBGS",
        "DFII10": "https://fred.stlouisfed.org/series/DFII10", "news": "https://news.un.org/zh/",
        "fomc": "https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm",
        "bls": "https://www.bls.gov/schedule/news_release/bls.ics", "eia": "https://www.eia.gov/petroleum/supply/weekly/schedule.php"
    ]

    private static let bridgeScript = """
    (() => {
      const snapshots = new Set();
      const edges = new Set();
      const request = (name, payload) => window.webkit.messageHandlers.openallGold.postMessage({name, payload: payload ?? null});
      const watch = (set, listener) => { set.add(listener); return () => set.delete(listener); };
      Object.defineProperty(window, 'openallGold', {value: Object.freeze({
        read: () => request('read'), watch: listener => watch(snapshots, listener),
        watchEdge: listener => watch(edges, listener), action: request
      }), writable: false, configurable: false});
      Object.defineProperty(window, '__openallGoldDeliver', {value: ({kind, value}) => {
        if (kind === 'snapshot') snapshots.forEach(fn => fn(value));
        if (kind === 'edge') edges.forEach(fn => fn(value.side, value.collapsed));
      }, writable: false, configurable: false});
      for (const event of ['online', 'offline']) window.addEventListener(event, () => request('network').catch(() => {}));
    })();
    """

    @MainActor func verifyForDesign() async throws {
        // 验收始终创建隔离实例；不启动当前控制器，也不读取或迁移真实用户数据。
        let directory = DesignPreview.home.appendingPathComponent("Library/Application Support/OpenAll/gold-native-check-\(UUID().uuidString)", isDirectory: true)
        let output = DesignPreview.output.appendingPathComponent("gold", isDirectory: true)
        try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
        let tool = GoldToolController(dataDirectory: directory, fixture: true)
        var checks: [String] = []
        var screenshots: [String] = []
        var failure: Error?
        defer { tool.stop() }
        func check(_ value: Bool, _ label: String) throws {
            guard value else { throw componentError("金价原生验收失败：\(label)") }
            checks.append(label)
        }
        func capture(_ name: String) async throws {
            _ = try await tool.execute("await document.fonts.ready; await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))); return true;")
            guard let web = tool.webView else { throw componentError("金价网页未创建。") }
            let image = try await web.takeSnapshot(configuration: nil)
            guard let tiff = image.tiffRepresentation, let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]) else { throw componentError("无法截取金价界面。") }
            try png.write(to: output.appendingPathComponent(name + ".png"))
            screenshots.append(name + ".png")
        }
        do {
            tool.show()
            try await tool.until("加载原生金价窗口") {
                if let error = tool.startupError { throw error }
                guard tool.ready, tool.pageLoaded else { return false }
                return try await tool.execute("return window.OpenAllGoldUI?.ready === true;") as? Bool == true
            }
            guard let panel = tool.panel, let dock = tool.edgeDock else { throw componentError("未创建金价原生窗口。") }
            let originalWindow = panel
            let storedPosition = tool.latest["position"]
            let visibleArea = GoldEdgeDock.area(for: panel.frame)
            let primaryTop = NSScreen.screens.first?.frame.maxY ?? 900
            tool.latest["position"] = ["x": visibleArea.minX + 30, "y": primaryTop - visibleArea.maxY + 20]
            let migratedBounds = tool.placement()
            try check(abs(migratedBounds.minY - max(visibleArea.minY, visibleArea.maxY - migratedBounds.height - 20)) < 0.01,
                "迁移旧 Electron 左上坐标到 AppKit 左下坐标")
            tool.latest["position"] = storedPosition
            try check((storedPosition as? [String: Any])?["coordinateSystem"] as? String == "appkit", "原生位置保存坐标系标记")
            let state = tool.snapshot()
            let instruments = state["instruments"] as? [String: [String: Any]] ?? [:]
            try check(["gold", "ctf"].allSatisfy {
                instruments[$0]?["quote"] is [String: Any] && (instruments[$0]?["history"] as? [Any] ?? []).count >= 365
            }, "双品种报价与近一年曲线")
            let forecasts = (state["outlook"] as? [String: Any])?["forecasts"] as? [String: [String: Any]] ?? [:]
            try check(["gold", "ctf"].allSatisfy { (forecasts[$0]?["days"] as? [Any] ?? []).count == 7 }, "双品种七日展望")
            try check(try await tool.execute("return typeof require === 'undefined' && typeof goldDesk === 'undefined' && !!window.openallGold;") as? Bool == true,
                "WebKit 页面只暴露 OpenAll 金价桥接")
            tool.show()
            try check(tool.panel === originalWindow, "搜索重复打开复用原生窗口")
            if tool.boolean("edgeEnabled", default: true) { _ = try await tool.execute("return await openallGold.action('edge');") }
            _ = try await tool.execute("document.querySelector('#gold canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true})); return true;")
            try check(try await tool.execute("return !document.querySelector('#gold .hover').hidden;") as? Bool == true, "曲线支持键盘查值")
            try await capture("gold-quotes")
            _ = try await tool.execute("return await openallGold.action('layout',true);")
            try await tool.until("合并报价卡与曲线") { try await tool.execute("return !document.querySelector('#combined').hidden;") as? Bool == true }
            for currency in ["EUR", "CNY", "USD"] {
                _ = try await tool.execute("return await openallGold.action('currency','\(currency)');")
                let quote = (tool.latest["instruments"] as? [String: [String: Any]])?["gold"]?["quote"] as? [String: Any]
                try check(tool.latest["currency"] as? String == currency && (quote?["price"] as? Double ?? 0) > 0, "\(currency) 每克报价与曲线换算")
            }
            let pinned = tool.boolean("pinned", default: true)
            _ = try await tool.execute("return await openallGold.action('pin');")
            try check(tool.boolean("pinned", default: true) != pinned && panel.level == (pinned ? .normal : .floating), "置顶偏好同步 AppKit 窗口层级")
            try await capture("gold-combined")
            _ = try await tool.execute("document.querySelector('#outlook-view').click(); return true;")
            try await tool.until("七日展望页面") { try await tool.execute("return !document.querySelector('#outlook').hidden;") as? Bool == true }
            _ = try await tool.execute("document.querySelector('#forecast-ctf').click(); return true;")
            try check(try await tool.execute("return document.querySelectorAll('#forecast-rows tr').length === 7 && !!document.querySelector('#verification-note').textContent;") as? Bool == true,
                "七日表格与实际报价验证展示")
            let checkPrices = """
            const state = await openallGold.read();
            const {date, price} = state.instruments.ctf.quote;
            const days = state.outlook.forecasts.ctf.days;
            const rows = [...document.querySelectorAll('#forecast-rows tr')];
            const header = document.querySelector('.forecast-baseline');
            const format = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:0});
            const actual = new Intl.NumberFormat('zh-CN',{maximumFractionDigits:2}).format(price);
            return header.textContent.includes('今日周大福牌价') && header.querySelector('time').dateTime === date &&
              header.querySelector('strong').textContent.trim() === actual + ' 人民币/克' &&
              document.querySelector('#forecast-price-heading').textContent === '每日参考价' &&
              rows.length === 7 && days.length === 7 && rows.every((row,i) => {
                const day = days[i];
                return day.pointMethod === 'joint-history' && Number.isFinite(day.mid) &&
                  row.querySelector('time').dateTime === day.date &&
                  row.cells[1].matches('.forecast-price') && row.cells[1].textContent === format.format(day.mid) &&
                  row.cells[2].matches('.forecast-direction') && row.cells[2].textContent.includes(day.confidence + '%') &&
                  row.cells[3].matches('.forecast-range') && row.cells[3].textContent.includes(format.format(day.high));
              });
            """
            try check(try await tool.execute(checkPrices) as? Bool == true, "周大福当日牌价表头与七个目标日参考价对应模型输出")
            // 用 WebKit 的原生键盘事件操作两段详情，截图前恢复首屏。
            guard let browser = tool.webView else { throw componentError("未出现金价内容视图") }
            _ = panel.makeFirstResponder(browser)
            for id in ["verification-breakdown", "method-details"] {
                let focused = try await tool.execute("const details=document.getElementById('\(id)'), summary=details.querySelector('summary'); summary.focus(); return !details.open && document.activeElement===summary;")
                try check(focused as? Bool == true, "键盘可聚焦详情摘要：\(id)")
                for opened in [true, false] {
                    for type in [NSEvent.EventType.keyDown, .keyUp] {
                        guard let event = NSEvent.keyEvent(with: type, location: .zero, modifierFlags: [],
                            timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: panel.windowNumber,
                            context: nil, characters: "\r", charactersIgnoringModifiers: "\r", isARepeat: false, keyCode: 36)
                        else { throw componentError("无法创建回车事件") }
                        if type == .keyDown { browser.keyDown(with: event) } else { browser.keyUp(with: event) }
                    }
                    try await tool.until("回车切换详情 \(id)") {
                        try await tool.execute("return document.getElementById('\(id)').open===\(opened);") as? Bool == true
                    }
                }
            }
            _ = try await tool.execute("document.activeElement.blur(); document.querySelector('main').scrollTop=0; window.scrollTo(0,0); return true;")
            let originalFrame = panel.frame
            panel.setFrame(NSRect(origin: originalFrame.origin, size: NSSize(width: 345, height: originalFrame.height)), display: true)
            try await tool.until("窄窗七日参考价布局") {
                try await tool.execute("return innerWidth <= 345 && document.querySelector('#forecast-table').getBoundingClientRect().right <= document.querySelector('#outlook').getBoundingClientRect().right;") as? Bool == true
            }
            try await capture("gold-outlook-narrow")
            panel.setFrame(originalFrame, display: true)
            try await capture("gold-outlook")
            let preserved = try await tool.execute("window.__goldCheckDocument=document; window.__goldCheckCanvas=document.querySelector('#gold canvas'); return document.querySelector('#gold .hover').textContent;") as? String
            try await OpenAllTheme.withTemporaryAppearanceForDesign(background: NSColor(srgbRed: 0.93, green: 0.95, blue: 0.97, alpha: 1),
                accent: NSColor(srgbRed: 0.18, green: 0.36, blue: 0.70, alpha: 1)) {
                try await tool.until("宿主背景色与强调色即时同步") {
                    try await tool.execute("const s=getComputedStyle(document.documentElement); return s.getPropertyValue('--background').replaceAll(' ','')==='rgba(237,242,247,1.0)' && s.getPropertyValue('--accent').replaceAll(' ','')==='rgba(46,92,179,1.0)';") as? Bool == true
                }
                try check(try await tool.execute("return document===window.__goldCheckDocument && document.querySelector('#gold canvas')===window.__goldCheckCanvas && document.querySelector('#forecast-ctf').getAttribute('aria-pressed')==='true' && !document.querySelector('#outlook').hidden;") as? Bool == true,
                    "调整宿主外观保留页面、曲线节点与展望品种")
                try check(try await tool.execute("return document.querySelector('#gold .hover').textContent;") as? String == preserved, "外观刷新保留曲线查值")
                try check(try await tool.execute("const s=getComputedStyle(document.documentElement); return s.getPropertyValue('--gold-line')!==s.getPropertyValue('--ctf-line') && s.getPropertyValue('--rise')!==s.getPropertyValue('--fall') && s.getPropertyValue('--rise')!==s.getPropertyValue('--flat');") as? Bool == true,
                    "品种曲线与涨跌持平保持独立语义颜色")
                try await capture("gold-outlook-light")
            }
            var appearanceOpened = false
            tool.onAppearanceSettings = { appearanceOpened = true }
            _ = try await tool.execute("return await openallGold.action('appearance');")
            try check(appearanceOpened, "外观按钮打开宿主设置")
            try check(try await tool.execute("try { await openallGold.action('event','https://example.invalid/'); return false; } catch { return true; }") as? Bool == true, "拒绝快照外的事件链接")
            try check(try await tool.execute("try { await openallGold.action('source','unknown'); return false; } catch { return true; }") as? Bool == true, "来源链接仅接受内置白名单")
            _ = try await tool.execute("return await openallGold.action('view','quotes');")
            let area = GoldEdgeDock.area(for: panel.frame)
            panel.setFrameOrigin(NSPoint(x: area.minX, y: max(area.minY, area.maxY - panel.frame.height - 25)))
            _ = try await tool.execute("return await openallGold.action('edge');")
            try await tool.until("左侧贴边收起") { dock.collapsed && !panel.isVisible && dock.rail.isVisible }
            try check(dock.side == "left" && !dock.rail.isOpaque && !dock.rail.canBecomeKey, "透明非激活贴边竖条")
            let focus = NSApp.keyWindow
            let hoverTime = ProcessInfo.processInfo.systemUptime
            dock.checkHoverForDesign(at: NSPoint(x: area.midX, y: area.midY), now: hoverTime)
            let hotspot = NSPoint(x: dock.rail.frame.midX, y: dock.rail.frame.midY)
            dock.checkHoverForDesign(at: hotspot, now: hoverTime + 0.01)
            dock.checkHoverForDesign(at: hotspot, now: hoverTime + 0.10)
            try await tool.until("展开左侧窗口") { !dock.collapsed && panel.alphaValue == 1 }
            try check(NSApp.keyWindow === focus, "悬停式展开不抢键盘焦点")
            dock.setEnabled(false)
            panel.setFrameOrigin(NSPoint(x: area.maxX - panel.frame.width, y: panel.frame.minY))
            dock.setEnabled(true)
            try await tool.until("右侧贴边收起") { dock.side == "right" && dock.collapsed && !panel.isVisible }
            tool.show()
            try check(!dock.collapsed && panel.isVisible, "搜索唤回已贴边收起窗口")
            _ = try await tool.execute("return await openallGold.action('edge');")
            _ = try await tool.execute("return await openallGold.action('minimize');")
            try await tool.until("最小化") { panel.isMiniaturized }
            tool.show()
            try await tool.until("恢复最小化") { !panel.isMiniaturized && panel.isVisible }
            checks.append("最小化后可通过搜索恢复")
            let retained = tool.snapshot()
            _ = try await tool.execute("return await openallGold.action('close');")
            try check(!panel.isVisible && !dock.rail.isVisible && tool.ready, "关闭时隐藏面板与贴边条，后台继续运行")
            _ = try await tool.execute("return await openallGold.read();")
            try check((tool.latest["outlook"] as? [String: Any])?["forecasts"] != nil, "窗口关闭后后台快照与预测继续可读")
            tool.show()
            try check(["pinned", "combined", "currency", "edgeEnabled"].allSatisfy { String(describing: tool.snapshot()[$0]) == String(describing: retained[$0]) },
                "重新打开保留偏好与行情")
            try check(tool.panel === originalWindow, "隐藏后重新打开保留原生窗口与网页状态")
        } catch { failure = error }
        let report: [String: Any] = ["passed": failure == nil, "platform": "macos", "runtime": "AppKit + WKWebView + JavaScriptCore",
            "checks": checks, "screenshots": screenshots, "errors": failure.map { [$0.localizedDescription] } ?? []]
        let data = try JSONSerialization.data(withJSONObject: report, options: [.prettyPrinted, .sortedKeys])
        try data.write(to: output.appendingPathComponent("report.json"))
        print("金价原生界面检查：\(checks.count) 项，\(failure == nil ? "通过" : "失败")")
        if let failure { throw failure }
    }

    @MainActor private func execute(_ source: String) async throws -> Any? {
        guard let webView else { throw componentError("金价网页未创建。") }
        return try await webView.callAsyncJavaScript(source, arguments: [:], in: nil, contentWorld: .page)
    }

    @MainActor private func until(_ label: String, condition: () async throws -> Bool) async throws {
        let deadline = ProcessInfo.processInfo.systemUptime + 15
        while try await !condition() {
            guard ProcessInfo.processInfo.systemUptime < deadline else { throw componentError("等待金价原生验收超时：\(label)") }
            try await Task.sleep(nanoseconds: 50_000_000)
        }
    }
}
