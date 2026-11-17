import Foundation
import CryptoKit

struct SearchUsage: Codable {
    var count: Int
    var lastUsed: Date
}

struct SearchManualRule: Codable {
    var kind: String
    var title: String
    var value: String
    var pinned: Bool
    var hidden: Bool
}

final class SearchRankingStore {
    private let file: URL
    private let rulesFile: URL
    private let fingerprints = NSCache<NSString, NSString>()
    private var usage: [String: SearchUsage] = [:]
    private var rules: [String: SearchManualRule] = [:]
    var hasUsageHistory: Bool { !usage.isEmpty }
    var manualRules: [SearchManualRule] {
        rules.values.sorted { $0.title.localizedStandardCompare($1.title) == .orderedAscending }
    }

    init(file: URL? = nil) {
        fingerprints.countLimit = 4096
        self.file = file ?? DesignPreview.home
            .appendingPathComponent("Library/Application Support/OpenAll/search-usage.json")
        rulesFile = self.file.deletingLastPathComponent().appendingPathComponent("search-rules.json")
        if let data = try? Data(contentsOf: self.file),
           let saved = try? JSONDecoder().decode([String: SearchUsage].self, from: data) { usage = saved }
        if let data = try? Data(contentsOf: rulesFile),
           let saved = try? JSONDecoder().decode([String: SearchManualRule].self, from: data) { rules = saved }
    }

    func record(kind: String, value: String, at date: Date = Date()) {
        let key = fingerprint(kind: kind, value: value)
        let previous = usage[key]
        usage[key] = SearchUsage(count: min(1000, (previous?.count ?? 0) + 1), lastUsed: date)
        if usage.count > 3000 {
            let keep = usage.sorted { $0.value.lastUsed > $1.value.lastUsed }.prefix(2400)
            usage = Dictionary(uniqueKeysWithValues: keep.map { ($0.key, $0.value) })
        }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(usage) { try? data.write(to: file, options: .atomic) }
    }

    struct Signals {
        let bonus: Int
        let pinned: Bool
        let hidden: Bool
    }

    func signals(kind: String, value: String, at date: Date = Date()) -> Signals {
        guard !usage.isEmpty || !rules.isEmpty else { return Signals(bonus: 0, pinned: false, hidden: false) }
        let key = fingerprint(kind: kind, value: value)
        return Signals(bonus: score(usage[key], at: date), pinned: rules[key]?.pinned == true, hidden: rules[key]?.hidden == true)
    }

    func bonus(kind: String, value: String, at date: Date = Date()) -> Int {
        guard !usage.isEmpty else { return 0 }
        return score(usage[fingerprint(kind: kind, value: value)], at: date)
    }

    private func score(_ entry: SearchUsage?, at date: Date) -> Int {
        guard let entry else { return 0 }
        let days = max(0, date.timeIntervalSince(entry.lastUsed) / 86400)
        let frequency = min(42, Int(log2(Double(entry.count + 1)) * 11))
        let recent = days < 1 ? 18 : days < 7 ? 12 : days < 30 ? 6 : 0
        return frequency + recent
    }

    func isHidden(kind: String, value: String) -> Bool {
        guard !rules.isEmpty else { return false }
        return rules[fingerprint(kind: kind, value: value)]?.hidden == true
    }

    func isPinned(kind: String, value: String) -> Bool {
        guard !rules.isEmpty else { return false }
        return rules[fingerprint(kind: kind, value: value)]?.pinned == true
    }

    func togglePinned(kind: String, title: String, value: String) {
        let key = fingerprint(kind: kind, value: value)
        let wasPinned = rules[key]?.pinned == true
        if wasPinned { rules.removeValue(forKey: key) }
        else { rules[key] = SearchManualRule(kind: kind, title: title, value: value, pinned: true, hidden: false) }
        saveRules()
    }

    func toggleHidden(kind: String, title: String, value: String) {
        let key = fingerprint(kind: kind, value: value)
        let wasHidden = rules[key]?.hidden == true
        if wasHidden { rules.removeValue(forKey: key) }
        else { rules[key] = SearchManualRule(kind: kind, title: title, value: value, pinned: false, hidden: true) }
        saveRules()
    }

    func resetRule(kind: String, value: String) {
        rules.removeValue(forKey: fingerprint(kind: kind, value: value))
        saveRules()
    }

    func clearUsage() {
        usage.removeAll()
        try? FileManager.default.removeItem(at: file)
    }

    private func saveRules() {
        try? FileManager.default.createDirectory(at: rulesFile.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(rules) { try? data.write(to: rulesFile, options: .atomic) }
    }

    private func fingerprint(kind: String, value: String) -> String {
        // 只缓存稳定的身份键，使用次数和手工规则仍实时读取，变更立即生效。
        let identity = (kind + ":" + value) as NSString
        if let cached = fingerprints.object(forKey: identity) { return cached as String }
        let key = SHA256.hash(data: Data((identity as String).utf8)).map { String(format: "%02x", $0) }.joined()
        fingerprints.setObject(key as NSString, forKey: identity)
        return key
    }
}
