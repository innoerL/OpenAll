import AppKit

struct TextSnippet: Codable, Identifiable {
    var id: UUID
    var keyword: String
    var name: String
    var body: String
    var createdAt: Date
}

final class SnippetStore {
    private let file: URL
    private(set) var items: [TextSnippet] = []
    var onChange: (() -> Void)?

    init(file: URL? = nil) {
        self.file = file ?? DesignPreview.home
            .appendingPathComponent("Library/Application Support/OpenAll/snippets.json")
        if let data = try? Data(contentsOf: self.file),
           let saved = try? JSONDecoder().decode([TextSnippet].self, from: data) { items = saved }
    }

    @discardableResult func add(name: String, keyword: String, body: String) -> Bool {
        let key = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !key.isEmpty, !key.contains(" "), !body.isEmpty,
              !items.contains(where: { $0.keyword.caseInsensitiveCompare(key) == .orderedSame }) else { return false }
        let title = name.trimmingCharacters(in: .whitespacesAndNewlines)
        items.append(TextSnippet(id: UUID(), keyword: key, name: title.isEmpty ? key : title,
                                 body: body, createdAt: Date()))
        save()
        return true
    }

    @discardableResult func add(from record: ClipboardRecord) -> TextSnippet? {
        guard record.kind == "text" || record.kind == "link" else { return nil }
        var number = 1
        while items.contains(where: { $0.keyword == "clip\(number)" }) { number += 1 }
        let keyword = "clip\(number)"
        guard add(name: String(record.title.prefix(32)), keyword: keyword, body: record.text) else { return nil }
        return items.last
    }

    @discardableResult func addQuick(body: String) -> TextSnippet? {
        guard !body.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else { return nil }
        var number = 1
        while items.contains(where: { $0.keyword == "selected\(number)" }) { number += 1 }
        guard add(name: String(body.replacingOccurrences(of: "\n", with: " ").prefix(32)),
                  keyword: "selected\(number)", body: body) else { return nil }
        return items.last
    }

    @discardableResult func update(id: UUID, name: String, keyword: String, body: String) -> Bool {
        guard let index = items.firstIndex(where: { $0.id == id }) else { return false }
        let key = keyword.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !key.isEmpty, !key.contains(" "), !body.isEmpty,
              !items.contains(where: { $0.id != id && $0.keyword.caseInsensitiveCompare(key) == .orderedSame }) else { return false }
        items[index].name = name.trimmingCharacters(in: .whitespacesAndNewlines)
        items[index].keyword = key
        items[index].body = body
        save()
        return true
    }

    func remove(id: UUID) { items.removeAll { $0.id == id }; save() }
    func item(id: UUID) -> TextSnippet? { items.first { $0.id == id } }

    func search(_ query: String) -> [TextSnippet] {
        let key = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !key.isEmpty else { return [] }
        return items.filter { $0.keyword.contains(key) || $0.name.localizedCaseInsensitiveContains(key) }
    }

    func expand(_ item: TextSnippet, clipboard: String, date: Date = Date()) -> String {
        let day = DateFormatter()
        day.dateFormat = "yyyy-MM-dd"
        let time = DateFormatter()
        time.dateFormat = "HH:mm"
        var expanded = item.body
        let pattern = #"\{\{(?:date|time):([^{}]+)\}\}"#
        if let expression = try? NSRegularExpression(pattern: pattern) {
            for match in expression.matches(in: expanded, range: NSRange(expanded.startIndex..., in: expanded)).reversed() {
                guard let full = Range(match.range, in: expanded), let formatRange = Range(match.range(at: 1), in: expanded) else { continue }
                let format = String(expanded[formatRange])
                guard format.count <= 128, !format.contains(where: { $0.isNewline }) else { continue }
                let formatter = DateFormatter()
                formatter.locale = Locale(identifier: "zh_CN")
                formatter.dateFormat = format
                let value = formatter.string(from: date)
                if !value.isEmpty { expanded.replaceSubrange(full, with: value) }
            }
        }
        return expanded.replacingOccurrences(of: "{{date}}", with: day.string(from: date))
            .replacingOccurrences(of: "{{time}}", with: time.string(from: date))
            .replacingOccurrences(of: "{{clipboard}}", with: clipboard)
    }

    private func save() {
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(items) { try? data.write(to: file, options: .atomic) }
        onChange?()
    }
}
