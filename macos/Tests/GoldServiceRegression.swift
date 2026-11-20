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
                          (prediction["days"] as? [Any])?.count == 7 else {
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
        let sql = """
        PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE TABLE jobs(value); CREATE TABLE quotes(value); CREATE TABLE history(value);
        CREATE TABLE settings(key,value); CREATE TABLE forecast_checks(value);
        INSERT INTO quotes VALUES(42); INSERT INTO settings VALUES('currency','CNY');
        """
        guard sqlite3_exec(original, sql, nil, nil, nil) == SQLITE_OK else { throw failure("写入 WAL 样例失败") }
        let sourceBefore = try Data(contentsOf: source)
        let walBefore = try Data(contentsOf: URL(fileURLWithPath: source.path + "-wal"))
        let destination = root.appendingPathComponent("imported.sqlite")
        guard try GoldDatabase.importLegacy(destination: destination, legacyDirectory: legacy) else { throw failure("WAL 导入没有执行") }
        var copied: OpaquePointer?
        guard sqlite3_open_v2(destination.path, &copied, SQLITE_OPEN_READONLY, nil) == SQLITE_OK, let copied else { throw failure("读取导入副本失败") }
        defer { sqlite3_close(copied) }
        var statement: OpaquePointer?
        guard sqlite3_prepare_v2(copied, "SELECT value FROM quotes", -1, &statement, nil) == SQLITE_OK, let statement else { throw failure("导入结构缺失：" + String(cString: sqlite3_errmsg(copied))) }
        defer { sqlite3_finalize(statement) }
        guard sqlite3_step(statement) == SQLITE_ROW, sqlite3_column_int(statement, 0) == 42,
              try Data(contentsOf: source) == sourceBefore,
              try Data(contentsOf: URL(fileURLWithPath: source.path + "-wal")) == walBefore,
              try !GoldDatabase.importLegacy(destination: destination, legacyDirectory: legacy) else { throw failure("WAL 完整性、只读或目标优先规则失败") }
    }

    static func failure(_ text: String) -> NSError { NSError(domain: "GoldRegression", code: 1, userInfo: [NSLocalizedDescriptionKey: text]) }
    static func fail(_ error: Error) -> Never { fputs("金价回归失败：\(error.localizedDescription)\n", stderr); exit(1) }
}
