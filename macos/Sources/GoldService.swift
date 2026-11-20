import AppKit
import Foundation
import JavaScriptCore
import Network
import SQLite3
import WebKit

private func goldError(_ message: String) -> NSError {
    NSError(domain: "OpenAllGold", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

// JSContext、SQLite 与定时任务始终在同一串行队列中运行，窗口回调统一回到主线程。
final class GoldService {
    typealias Snapshot = [String: Any]
    typealias Completion = (Result<Snapshot, Error>) -> Void
    var onSnapshot: ((Snapshot) -> Void)?
    var onError: ((Error) -> Void)?

    private let queue = DispatchQueue(label: "local.openall.gold", qos: .utility)
    private let dataDirectory: URL
    private let legacyDirectory: URL?
    private let resourceDirectory: URL
    private let fixture: Bool
    private var context: JSContext?
    private var database: GoldDatabase?
    private var network: GoldNetwork?
    private var officialReaders: [Int: GoldOfficialReader] = [:]
    private var monitor: NWPathMonitor?
    private var timer: DispatchSourceTimer?
    private var wakeObserver: NSObjectProtocol?
    private var stopped = false
    private var completions: [Int: Completion] = [:]
    private var nextCompletion = 0

    init(dataDirectory: URL, legacyDirectory: URL? = nil, fixture: Bool = false, resourceDirectory: URL? = nil) {
        self.dataDirectory = dataDirectory
        self.legacyDirectory = legacyDirectory
        self.fixture = fixture
        self.resourceDirectory = resourceDirectory ?? Bundle.main.resourceURL!.appendingPathComponent("gold-backend", isDirectory: true)
    }

    func start(completion: Completion? = nil) {
        queue.async { [self] in
            do {
                guard !stopped else { throw goldError("金价服务已关闭") }
                if context == nil {
                    do { try initialize() }
                    catch { context = nil; database?.close(); database = nil; throw error }
                }
                nextCompletion += 1
                let identifier = nextCompletion
                if let completion { completions[identifier] = completion }
                _ = try call("start", [identifier])
            } catch { deliver(.failure(error), completion) }
        }
    }

    func snapshot(_ completion: @escaping Completion) { perform("snapshot", [], completion) }

    func setCurrency(_ value: String, completion: Completion? = nil) { perform("currency", [value], completion) }

    func getPreference(_ key: String, completion: @escaping (Any?) -> Void) {
        queue.async { [self] in
            let value = try? call("preference", [key]).toString().flatMap { text in
                try JSONSerialization.jsonObject(with: Data(text.utf8), options: [.fragmentsAllowed])
            }
            DispatchQueue.main.async { completion(value is NSNull ? nil : value) }
        }
    }

    func setPreference(_ key: String, value: Any, completion: Completion? = nil) {
        // 窗口只能修改展示偏好，不能覆盖调度器、行情上下文与预测记录。
        let allowed = ["pinned", "dark", "combined", "edgeEnabled", "position"]
        guard allowed.contains(key), let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let encoded = String(data: data, encoding: .utf8) else {
            deliver(.failure(goldError("金价偏好格式无效")), completion); return
        }
        perform("setPreference", [key, encoded], completion)
    }

    func recheckNetwork() { queue.async { [self] in _ = try? call("recheck", []) } }

    func stop() {
        queue.async { [self] in
            guard !stopped else { return }
            stopped = true
            timer?.cancel(); timer = nil
            monitor?.cancel(); monitor = nil
            if let observer = wakeObserver { NSWorkspace.shared.notificationCenter.removeObserver(observer) }
            wakeObserver = nil
            _ = try? call("stop", [], allowStopped: true)
            network?.stop(); network = nil
            database?.close(); database = nil
            context = nil
            let callbacks = completions.values
            completions.removeAll()
            for callback in callbacks { deliver(.failure(goldError("金价服务已关闭")), callback) }
            DispatchQueue.main.async { [self] in
                officialReaders.values.forEach { $0.cancel() }
                officialReaders.removeAll()
            }
        }
    }

    private func initialize() throws {
        let imported: Bool
        let filename: String
        if fixture {
            // 样例完全使用内存数据库；即使传入真实数据路径，也不会访问它。
            filename = ":memory:"
            imported = false
        } else {
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let destination = dataDirectory.appendingPathComponent("quotes.sqlite")
            imported = try GoldDatabase.importLegacy(destination: destination, legacyDirectory: legacyDirectory)
            filename = destination.path
        }
        let db = GoldDatabase(filename: filename)
        database = db
        let vm = JSContext()!
        context = vm
        vm.exceptionHandler = { context, exception in context?.exception = exception }
        let moduleNames = ["store", "scheduler", "sources", "time", "currency", "changes", "outlook", "market-context", "macro-calendar", "forecast-verification", "fixture"]
        var modules: [String: String] = [:]
        for name in moduleNames {
            modules[name + ".cjs"] = try String(contentsOf: resourceDirectory.appendingPathComponent(name + ".cjs"), encoding: .utf8)
        }
        vm.setObject(modules, forKeyedSubscript: "__moduleSources" as NSString)
        vm.setObject(["filename": filename, "fixture": fixture, "imported": imported], forKeyedSubscript: "__configuration" as NSString)
        let sql: @convention(block) (String) -> String = { [weak db] request in
            do { return try db?.request(request) ?? "{\"error\":\"数据库已关闭\"}" }
            catch { return GoldService.json(["error": error.localizedDescription]) }
        }
        let parseURL: @convention(block) (String) -> String = { raw in
            guard let url = URL(string: raw), let scheme = url.scheme, let host = url.host else { return "{\"error\":\"URL 无效\"}" }
            let port = url.port.map { ":\($0)" } ?? ""
            return GoldService.json(["href": url.absoluteString, "origin": "\(scheme)://\(host)\(port)", "username": url.user ?? "", "password": url.password ?? ""])
        }
        let request: @convention(block) (String) -> Void = { [weak self] input in self?.request(input) }
        let publish: @convention(block) (String) -> Void = { [weak self] input in
            guard let self, let snapshot = try? self.decodeSnapshot(input) else { return }
            DispatchQueue.main.async { [weak self] in self?.onSnapshot?(snapshot) }
        }
        let started: @convention(block) (Int, String, String) -> Void = { [weak self] identifier, message, input in
            guard let self else { return }
            let callback = self.completions.removeValue(forKey: identifier)
            if !message.isEmpty { self.deliver(.failure(goldError(message)), callback) }
            else { self.deliver(Result { try self.decodeSnapshot(input) }, callback) }
        }
        let report: @convention(block) (String) -> Void = { [weak self] message in self?.deliver(.failure(goldError(message)), nil) }
        vm.setObject(sql, forKeyedSubscript: "__sql" as NSString)
        vm.setObject(parseURL, forKeyedSubscript: "__parseURL" as NSString)
        vm.setObject(request, forKeyedSubscript: "__request" as NSString)
        vm.setObject(publish, forKeyedSubscript: "__publish" as NSString)
        vm.setObject(started, forKeyedSubscript: "__started" as NSString)
        vm.setObject(report, forKeyedSubscript: "__report" as NSString)
        let bootstrap = try String(contentsOf: resourceDirectory.appendingPathComponent("bootstrap.js"), encoding: .utf8)
        vm.evaluateScript(bootstrap, withSourceURL: resourceDirectory.appendingPathComponent("bootstrap.js"))
        if let exception = vm.exception { context = nil; db.close(); throw goldError(exception.toString() ?? "初始化金价模块失败") }
        if !fixture { startHostEvents() }
    }

    private func startHostEvents() {
        network = GoldNetwork()
        let monitor = NWPathMonitor()
        self.monitor = monitor
        // 首次路径回调前不假定在线，断网启动时不会先发出一轮行情请求。
        _ = try? call("network", [false])
        monitor.pathUpdateHandler = { [weak self] path in _ = try? self?.call("network", [path.status == .satisfied]) }
        monitor.start(queue: queue)
        let timer = DispatchSource.makeTimerSource(queue: queue)
        self.timer = timer
        timer.schedule(deadline: .now() + 3, repeating: 3, leeway: .milliseconds(250))
        timer.setEventHandler { [weak self] in
            guard let self else { return }
            _ = try? self.call("tick", ["timer"])
        }
        timer.resume()
        wakeObserver = NSWorkspace.shared.notificationCenter.addObserver(forName: NSWorkspace.didWakeNotification, object: nil, queue: nil) { [weak self] _ in
            guard let self else { return }
            self.queue.async { _ = try? self.call("network", [self.monitor?.currentPath.status == .satisfied, true]) }
        }
    }

    private func request(_ input: String) {
        guard let payload = try? JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any],
              let identifier = payload["id"] as? Int, let kind = payload["kind"] as? String else { return }
        guard !fixture, !stopped else { complete(identifier, error: "离线样例禁止网络访问", value: NSNull()); return }
        if kind == "fetch" {
            network?.fetch(payload) { [weak self] result in
                guard let self else { return }
                self.queue.async {
                    switch result {
                    case .success(let response): self.complete(identifier, error: "", value: response)
                    case .failure(let error): self.complete(identifier, error: error.localizedDescription, value: NSNull())
                    }
                }
            }
        } else if kind == "official" {
            DispatchQueue.main.async { [weak self] in
                guard let self else { return }
                let reader = GoldOfficialReader { [weak self] result in
                    guard let self else { return }
                    self.officialReaders.removeValue(forKey: identifier)
                    self.queue.async {
                        switch result {
                        case .success(let text): self.complete(identifier, error: "", value: text)
                        case .failure(let error): self.complete(identifier, error: error.localizedDescription, value: NSNull())
                        }
                    }
                }
                self.officialReaders[identifier] = reader
                reader.start()
            }
        }
    }

    private func complete(_ identifier: Int, error: String, value: Any) {
        guard !stopped, let context else { return }
        context.objectForKeyedSubscript("__complete")?.call(withArguments: [identifier, error, value])
    }

    private func perform(_ method: String, _ arguments: [Any], _ completion: Completion?) {
        queue.async { [self] in
            let result = Result { () -> Snapshot in
                let value = try call(method, arguments)
                guard let text = value.toString() else { throw goldError("金价快照为空") }
                return try decodeSnapshot(text)
            }
            deliver(result, completion)
        }
    }

    private func call(_ method: String, _ arguments: [Any], allowStopped: Bool = false) throws -> JSValue {
        guard (!stopped || allowStopped), let context else { throw goldError("金价服务尚未就绪") }
        context.exception = nil
        guard let value = context.objectForKeyedSubscript("__gold")?.invokeMethod(method, withArguments: arguments) else {
            throw goldError("金价模块调用失败")
        }
        if let exception = context.exception { throw goldError(exception.toString() ?? "金价模块执行失败") }
        return value
    }

    private func decodeSnapshot(_ text: String) throws -> Snapshot {
        guard let value = try JSONSerialization.jsonObject(with: Data(text.utf8)) as? Snapshot else { throw goldError("金价快照格式无效") }
        return value
    }

    private func deliver(_ result: Result<Snapshot, Error>, _ completion: Completion?) {
        DispatchQueue.main.async { [weak self] in
            if let completion { completion(result) }
            else if case .failure(let error) = result { self?.onError?(error) }
        }
    }

    private static func json(_ value: Any) -> String {
        guard let data = try? JSONSerialization.data(withJSONObject: value, options: [.fragmentsAllowed]),
              let text = String(data: data, encoding: .utf8) else { return "null" }
        return text
    }
}

// 仅暴露原 Store 使用的同步 SQL 子集；语句不跨线程，绑定值不拼接 SQL。
final class GoldDatabase {
    private let filename: String
    private var handle: OpaquePointer?
    init(filename: String) { self.filename = filename }
    deinit { close() }
    func close() { if let handle { sqlite3_close_v2(handle); self.handle = nil } }

    func request(_ input: String) throws -> String {
        guard let request = try JSONSerialization.jsonObject(with: Data(input.utf8)) as? [String: Any],
              let action = request["action"] as? String, let sql = request["sql"] as? String else { throw goldError("SQL 请求无效") }
        let value: Any
        if action == "open" {
            guard sql == filename else { throw goldError("不允许访问其他金价数据库") }
            if handle == nil, sqlite3_open_v2(filename, &handle, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE | SQLITE_OPEN_FULLMUTEX, nil) != SQLITE_OK {
                let message = failure(); close(); throw message
            }
            value = NSNull()
        } else if action == "close" { close(); value = NSNull() }
        else {
            guard let handle else { throw goldError("金价数据库未打开") }
            if action == "exec" {
                guard sqlite3_exec(handle, sql, nil, nil, nil) == SQLITE_OK else { throw failure() }
                value = NSNull()
            } else {
                var statement: OpaquePointer?
                guard sqlite3_prepare_v2(handle, sql, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure() }
                defer { sqlite3_finalize(statement) }
                let parameters = request["parameters"] as? [Any] ?? []
                guard parameters.count == Int(sqlite3_bind_parameter_count(statement)) else { throw goldError("SQL 参数数量无效") }
                for (offset, parameter) in parameters.enumerated() {
                    let index = Int32(offset + 1)
                    let code: Int32
                    if parameter is NSNull { code = sqlite3_bind_null(statement, index) }
                    else if let number = parameter as? NSNumber { code = sqlite3_bind_double(statement, index, number.doubleValue) }
                    else if let string = parameter as? String {
                        code = string.withCString { sqlite3_bind_text(statement, index, $0, -1, unsafeBitCast(-1, to: sqlite3_destructor_type.self)) }
                    } else { throw goldError("SQL 绑定值类型无效") }
                    guard code == SQLITE_OK else { throw failure() }
                }
                var rows: [[String: Any]] = []
                var status = sqlite3_step(statement)
                while status == SQLITE_ROW {
                    var row: [String: Any] = [:]
                    for index in 0..<sqlite3_column_count(statement) {
                        let name = String(cString: sqlite3_column_name(statement, index))
                        switch sqlite3_column_type(statement, index) {
                        case SQLITE_INTEGER: row[name] = sqlite3_column_int64(statement, index)
                        case SQLITE_FLOAT: row[name] = sqlite3_column_double(statement, index)
                        case SQLITE_TEXT: row[name] = String(cString: sqlite3_column_text(statement, index))
                        default: row[name] = NSNull()
                        }
                    }
                    rows.append(row)
                    status = sqlite3_step(statement)
                }
                guard status == SQLITE_DONE else { throw failure() }
                value = action == "run" ? ["changes": sqlite3_changes(handle), "lastInsertRowid": sqlite3_last_insert_rowid(handle)] : rows
            }
        }
        return String(data: try JSONSerialization.data(withJSONObject: ["value": value]), encoding: .utf8)!
    }

    private func failure() -> NSError { goldError(handle.map { String(cString: sqlite3_errmsg($0)) } ?? "无法打开金价数据库") }

    static func importLegacy(destination: URL, legacyDirectory: URL?) throws -> Bool {
        let manager = FileManager.default
        guard !manager.fileExists(atPath: destination.path), let legacyDirectory else { return false }
        let source = legacyDirectory.appendingPathComponent("quotes.sqlite")
        guard manager.fileExists(atPath: source.path), source.standardizedFileURL != destination.standardizedFileURL else { return false }
        let temporary = destination.appendingPathExtension("importing-" + UUID().uuidString)
        var old: OpaquePointer?
        var copied: OpaquePointer?
        defer {
            if let old { sqlite3_close_v2(old) }
            if let copied { sqlite3_close_v2(copied) }
            try? manager.removeItem(at: temporary)
        }
        do {
            guard sqlite3_open_v2(source.path, &old, SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX, nil) == SQLITE_OK, let old else { throw goldError("无法只读打开旧数据库") }
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(old, "SELECT name FROM sqlite_master WHERE type = 'table'", -1, &statement, nil) == SQLITE_OK, let statement else { throw goldError("旧数据库结构无效") }
            var names = Set<String>()
            while sqlite3_step(statement) == SQLITE_ROW { names.insert(String(cString: sqlite3_column_text(statement, 0))) }
            sqlite3_finalize(statement)
            guard Set(["jobs", "quotes", "history", "settings", "forecast_checks"]).isSubset(of: names) else { throw goldError("旧数据库不是兼容的金价桌台记录") }
            guard sqlite3_open_v2(temporary.path, &copied, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, nil) == SQLITE_OK,
                  let copied, let backup = sqlite3_backup_init(copied, "main", old, "main") else { throw goldError("无法创建旧记录副本") }
            let deadline = Date().addingTimeInterval(5)
            var status: Int32
            repeat {
                status = sqlite3_backup_step(backup, 256)
                if status == SQLITE_BUSY || status == SQLITE_LOCKED { Thread.sleep(forTimeInterval: 0.025) }
            } while (status == SQLITE_OK || status == SQLITE_BUSY || status == SQLITE_LOCKED) && Date() < deadline
            let finish = sqlite3_backup_finish(backup)
            guard status == SQLITE_DONE, finish == SQLITE_OK else { throw goldError("旧数据库忙碌或无法完成一致性备份") }
            // 先把副本收束为单文件，避免发布后仍依赖临时路径的 WAL / SHM。
            guard sqlite3_exec(copied, "PRAGMA journal_mode=DELETE", nil, nil, nil) == SQLITE_OK else { throw goldError("无法收束导入副本") }
            // 原子发布且不覆盖另一个启动实例刚创建的记录。
            guard link(temporary.path, destination.path) == 0 else {
                if errno == EEXIST { return false }
                throw goldError("无法保存导入记录")
            }
            return true
        } catch { throw goldError("导入金价桌台记录失败，原数据未修改：\(error.localizedDescription)") }
    }
}

private final class GoldNetwork: NSObject, URLSessionTaskDelegate {
    private lazy var session: URLSession = {
        let configuration = URLSessionConfiguration.ephemeral
        configuration.requestCachePolicy = .reloadIgnoringLocalCacheData
        configuration.httpCookieStorage = nil
        configuration.urlCache = nil
        return URLSession(configuration: configuration, delegate: self, delegateQueue: nil)
    }()
    func stop() { session.invalidateAndCancel() }
    func fetch(_ payload: [String: Any], completion: @escaping (Result<[String: Any], Error>) -> Void) {
        guard let address = payload["url"] as? String, let url = URL(string: address), url.scheme == "https" else { completion(.failure(goldError("行情地址必须使用 HTTPS"))); return }
        var request = URLRequest(url: url)
        request.httpMethod = payload["method"] as? String ?? "GET"
        request.timeoutInterval = min(30, max(1, (payload["timeout"] as? Double ?? 15000) / 1000))
        for (key, value) in payload["headers"] as? [String: String] ?? [:] { request.setValue(value, forHTTPHeaderField: key) }
        let task = session.dataTask(with: request) { data, response, error in
            if let error {
                let code = (error as NSError).code
                let label: String
                switch code {
                case NSURLErrorNotConnectedToInternet: label = "ERR_INTERNET_DISCONNECTED"
                case NSURLErrorCannotFindHost, NSURLErrorDNSLookupFailed: label = "ENOTFOUND"
                case NSURLErrorTimedOut: label = "ETIMEDOUT"
                case NSURLErrorNetworkConnectionLost: label = "ECONNRESET"
                case NSURLErrorCannotConnectToHost: label = "ERR_CONNECTION_REFUSED"
                default: label = "网络请求失败"
                }
                completion(.failure(goldError("\(label)：\(error.localizedDescription)"))); return
            }
            guard let response = response as? HTTPURLResponse, let data, data.count <= 16 * 1024 * 1024 else { completion(.failure(goldError("行情响应为空或过大"))); return }
            var encoding = String.Encoding.utf8
            if let charset = response.textEncodingName {
                let converted = CFStringConvertIANACharSetNameToEncoding(charset as CFString)
                if converted != kCFStringEncodingInvalidId { encoding = String.Encoding(rawValue: CFStringConvertEncodingToNSStringEncoding(converted)) }
            }
            guard let text = String(data: data, encoding: encoding) else { completion(.failure(goldError("行情文本编码无效"))); return }
            completion(.success(["status": response.statusCode, "body": text]))
        }
        task.taskDescription = payload["redirect"] as? String
        task.resume()
    }
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(task.taskDescription == "error" || request.url?.scheme != "https" ? nil : request)
    }
}

// 官方页面只在无消息桥接、无持久化 cookie 的独立 WebKit 存储中读取可见文本。
private final class GoldOfficialReader: NSObject, WKNavigationDelegate, WKUIDelegate {
    private var webView: WKWebView?
    private var timer: Timer?
    private var completion: ((Result<String, Error>) -> Void)?
    private let deadline = Date().addingTimeInterval(17)
    private var evaluating = false
    init(completion: @escaping (Result<String, Error>) -> Void) { self.completion = completion }
    func start() {
        let configuration = WKWebViewConfiguration()
        configuration.websiteDataStore = .nonPersistent()
        let webView = WKWebView(frame: NSRect(x: 0, y: 0, width: 900, height: 700), configuration: configuration)
        webView.navigationDelegate = self
        webView.uiDelegate = self
        self.webView = webView
        webView.load(URLRequest(url: URL(string: "https://www.ctfmall.com/todaygold")!))
        let timer = Timer(timeInterval: 0.275, repeats: true) { [weak self] _ in self?.poll() }
        self.timer = timer
        RunLoop.main.add(timer, forMode: .common)
    }
    func cancel() { finish(.failure(goldError("官网读取已取消"))) }
    private func poll() {
        guard Date() < deadline else { finish(.failure(goldError("周大福官网报价加载超时或不可用"))); return }
        guard !evaluating, let webView, webView.url?.absoluteString == "https://www.ctfmall.com/todaygold" else { return }
        evaluating = true
        webView.evaluateJavaScript("(document.body?.innerText ?? '').slice(0,12000)") { [weak self] value, _ in
            guard let self else { return }
            self.evaluating = false
            guard let text = value as? String,
                  text.range(of: #"更新于\s*\d{4}[年-]\d{1,2}[月-]\d{1,2}日?\s+\d{2}:\d{2}:\d{2}"#, options: .regularExpression) != nil,
                  text.range(of: #"足金\s*[（(]\s*饰品\s*[、，,]\s*工艺品类\s*[）)]\s*[\d,.]+\s*元\s*[／/]\s*克"#, options: .regularExpression) != nil else { return }
            self.finish(.success(text))
        }
    }
    private func finish(_ result: Result<String, Error>) {
        timer?.invalidate(); timer = nil
        webView?.stopLoading(); webView?.navigationDelegate = nil; webView?.uiDelegate = nil; webView = nil
        let callback = completion; completion = nil
        callback?(result)
    }
    func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction, decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
        let url = navigationAction.request.url
        let allowed = navigationAction.targetFrame?.isMainFrame == true && url?.absoluteString == "https://www.ctfmall.com/todaygold"
        decisionHandler(allowed ? .allow : .cancel)
    }
    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) { finish(.failure(error)) }
    func webView(_ webView: WKWebView, createWebViewWith configuration: WKWebViewConfiguration, for navigationAction: WKNavigationAction, windowFeatures: WKWindowFeatures) -> WKWebView? { nil }
}
