import AppKit
import Foundation
import SQLite3

// 独立入口只使用临时目录与 fixture，绝不访问用户目录或真实行情网络。
@main
struct GoldServiceRegression {
    static var service: GoldService?
    static func main() {
        do {
            guard CommandLine.arguments.count == 3 else { throw failure("参数：后台资源目录、输出快照") }
            let root = FileManager.default.temporaryDirectory.appendingPathComponent("openall-native-gold-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: root, withIntermediateDirectories: true)
            try checkMigration(root)
            let sentinel = root.appendingPathComponent("quotes.sqlite")
            let original = Data("fixture 不得打开此文件".utf8)
            try original.write(to: sentinel)
            let backend = GoldService(dataDirectory: root, legacyDirectory: root, fixture: true,
                                      resourceDirectory: URL(fileURLWithPath: CommandLine.arguments[1]))
            service = backend
            backend.onError = { error in fail(error) }
            backend.start { result in
                do {
                    let snapshot = try result.get()
                    try JSONSerialization.data(withJSONObject: snapshot, options: [.sortedKeys]).write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
                    guard Thread.isMainThread, snapshot["currency"] as? String == "USD", snapshot["imported"] as? Bool == false,
                          let instruments = snapshot["instruments"] as? [String: Any],
                          let gold = instruments["gold"] as? [String: Any], (gold["history"] as? [Any])?.count == 366,
                          gold["status"] as? String == "done", let outlook = snapshot["outlook"] as? [String: Any],
                          let forecasts = outlook["forecasts"] as? [String: Any], let prediction = forecasts["gold"] as? [String: Any],
                          (prediction["days"] as? [Any])?.count == 3 else {
                        let instruments = snapshot["instruments"] as? [String: Any] ?? [:]
                        let gold = instruments["gold"] as? [String: Any] ?? [:]
                        throw failure("初始快照或预测不完整：main=\(Thread.isMainThread)，history=\((gold["history"] as? [Any])?.count ?? 0)，status=\(gold["status"] ?? "缺失")")
                    }
                    backend.setCurrency("CNY") { result in
                        do {
                            let converted = try result.get()
                            guard converted["currency"] as? String == "CNY" else { throw failure("币种转换失败") }
                            backend.setPreference("combined", value: true) { result in
                                do {
                                    guard try result.get()["combined"] as? Bool == true else { throw failure("偏好保存失败") }
                                    backend.getPreference("combined") { value in
                                        do {
                                            guard value as? Bool == true, try Data(contentsOf: sentinel) == original else { throw failure("fixture 隔离或偏好读取失败") }
                                            backend.stop()
                                            try FileManager.default.removeItem(at: root)
                                            print("原生金价：fixture 隔离、历史、模型快照、币种、偏好与 WAL 迁移已通过")
                                            exit(0)
                                        } catch { fail(error) }
                                    }
                                } catch { fail(error) }
                            }
                        } catch { fail(error) }
                    }
                } catch { fail(error) }
            }
            DispatchQueue.main.asyncAfter(deadline: .now() + 60) { fail(failure("原生金价回归超时")) }
            RunLoop.main.run()
        } catch { fail(error) }
    }

    static func checkMigration(_ root: URL) throws {
        let legacy = root.appendingPathComponent("legacy")
        try FileManager.default.createDirectory(at: legacy, withIntermediateDirectories: true)
        let source = legacy.appendingPathComponent("quotes.sqlite")
        var original: OpaquePointer?
        guard sqlite3_open(source.path, &original) == SQLITE_OK, let original else { throw failure("创建迁移样例失败") }
        defer { sqlite3_close(original) }
        func execute(_ sql: String) throws {
            guard sqlite3_exec(original, sql, nil, nil, nil) == SQLITE_OK else { throw failure("写入 WAL 样例失败：" + String(cString: sqlite3_errmsg(original))) }
        }
        try execute("""
        PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE jobs(kind TEXT NOT NULL, instrument TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL, retry_at INTEGER, detail TEXT, PRIMARY KEY(kind,instrument,slot));
        CREATE TABLE quotes(instrument TEXT NOT NULL, slot TEXT NOT NULL, fetched_at INTEGER NOT NULL, price REAL NOT NULL, date TEXT NOT NULL, quote_time TEXT, source TEXT NOT NULL, note TEXT NOT NULL, PRIMARY KEY(instrument,slot));
        CREATE TABLE history(instrument TEXT NOT NULL, date TEXT NOT NULL, price REAL NOT NULL, source TEXT NOT NULL, PRIMARY KEY(instrument,date));
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        INSERT INTO quotes VALUES('gold','2026-11-20',1,42,'2026-11-20',NULL,'测试行情','');
        INSERT INTO settings VALUES('currency','"CNY"');
        """)
        func verifyImport(_ name: String, query: String) throws {
            let wal = URL(fileURLWithPath: source.path + "-wal")
            let sourceBefore = try Data(contentsOf: source), walBefore = try Data(contentsOf: wal)
            let destination = root.appendingPathComponent(name)
            guard !walBefore.isEmpty else { throw failure("样例遗漏了 WAL 数据") }
            let lock = NSLock()
            var successes = 0, errors: [Error] = []
            DispatchQueue.concurrentPerform(iterations: 2) { _ in
                do {
                    if try GoldDatabase.importLegacy(destination: destination, legacyDirectory: legacy) {
                        lock.lock(); successes += 1; lock.unlock()
                    }
                } catch {
                    lock.lock(); errors.append(error); lock.unlock()
                }
            }
            if let error = errors.first { throw error }
            guard successes == 1 else { throw failure("并发迁移必须只发布一个副本") }
            var copied: OpaquePointer?
            guard sqlite3_open_v2(destination.path, &copied, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let copied else { throw failure("读取导入副本失败") }
            defer { sqlite3_close(copied) }
            var statement: OpaquePointer?
            guard sqlite3_prepare_v2(copied, query, -1, &statement, nil) == SQLITE_OK, let statement else { throw failure("导入结构缺失") }
            defer { sqlite3_finalize(statement) }
            guard sqlite3_step(statement) == SQLITE_ROW, sqlite3_column_int(statement, 0) == 42,
                  try Data(contentsOf: source) == sourceBefore, try Data(contentsOf: wal) == walBefore,
                  try !GoldDatabase.importLegacy(destination: destination, legacyDirectory: legacy) else { throw failure("WAL 完整性、只读或目标优先规则失败") }
        }
        try verifyImport("four.sqlite", query: "SELECT price FROM quotes WHERE (SELECT value FROM settings WHERE key='currency')='\"CNY\"'")
        try execute("""
        CREATE TABLE forecast_checks(model_version TEXT NOT NULL, instrument TEXT NOT NULL, origin TEXT NOT NULL, target TEXT NOT NULL, issued_at INTEGER NOT NULL, origin_fetched_at INTEGER NOT NULL, origin_price REAL NOT NULL, estimate TEXT NOT NULL, target_fetched_at INTEGER, target_price REAL, actual TEXT, PRIMARY KEY(model_version,instrument,origin,target));
        INSERT INTO forecast_checks VALUES('3.0.0','gold','2026-11-20','2026-11-23',1,1,42,'{"mid":42}',NULL,NULL,NULL);
        """)
        try verifyImport("five.sqlite", query: "SELECT json_extract(estimate,'$.mid') FROM forecast_checks")
        let rejected = root.appendingPathComponent("rejected.sqlite")
        func verifyRejection(_ reason: String) throws {
            do { _ = try GoldDatabase.importLegacy(destination: rejected, legacyDirectory: legacy) }
            catch {
                guard error.localizedDescription.contains(reason), !FileManager.default.fileExists(atPath: rejected.path) else { throw error }
                return
            }
            throw failure("错误的旧库应当拒绝导入")
        }
        try execute("UPDATE forecast_checks SET estimate='[]'")
        try verifyRejection("旧库预测包含损坏的记录")
        try execute("DROP TABLE forecast_checks; UPDATE settings SET value='损坏'")
        try verifyRejection("旧库设置包含损坏的 JSON")
        try execute("ALTER TABLE quotes RENAME COLUMN fetched_at TO unknown_time")
        try verifyRejection("quotes 表结构不兼容")
    }

    static func failure(_ text: String) -> NSError { NSError(domain: "GoldRegression", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
    static func fail(_ error: Error) -> Never { fputs("金价回归失败：\(error.localizedDescription)\n", stderr); exit(1) }
}
