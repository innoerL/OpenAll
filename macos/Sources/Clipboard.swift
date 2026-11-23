import AppKit
import ApplicationServices
import Carbon
import CryptoKit
import Vision

enum ClipboardShelfLayout: String, Codable {
    case cards, list
}

struct ClipboardPreferences: Codable {
    var enabled = true
    var maxItems = 300
    var maxItemBytes = 20_000_000
    var retentionDays = 30
    var directPaste = true
    var ignoreApplications: [String] = []
    var plainTextByDefault = false
    var shelfLayout: ClipboardShelfLayout = .cards
    var pausedUntil: Date? = nil
    var pinboards: [String] = ["收藏"]
    var pinboardColors: [String: String] = ["收藏": "blue"]

    init() {}
    init(from decoder: Decoder) throws {
        let values = try decoder.container(keyedBy: CodingKeys.self)
        enabled = try values.decodeIfPresent(Bool.self, forKey: .enabled) ?? true
        maxItems = try values.decodeIfPresent(Int.self, forKey: .maxItems) ?? 300
        maxItemBytes = try values.decodeIfPresent(Int.self, forKey: .maxItemBytes) ?? 20_000_000
        retentionDays = try values.decodeIfPresent(Int.self, forKey: .retentionDays) ?? 30
        directPaste = try values.decodeIfPresent(Bool.self, forKey: .directPaste) ?? true
        ignoreApplications = try values.decodeIfPresent([String].self, forKey: .ignoreApplications) ?? []
        plainTextByDefault = try values.decodeIfPresent(Bool.self, forKey: .plainTextByDefault) ?? false
        shelfLayout = (try? values.decode(ClipboardShelfLayout.self, forKey: .shelfLayout)) ?? .cards
        pausedUntil = try values.decodeIfPresent(Date.self, forKey: .pausedUntil)
        pinboards = try values.decodeIfPresent([String].self, forKey: .pinboards) ?? ["收藏"]
        pinboardColors = try values.decodeIfPresent([String: String].self, forKey: .pinboardColors) ?? ["收藏": "blue"]
    }
}

struct ClipboardRecord: Codable {
    var id: UUID
    var date: Date
    var kind: String
    var title: String
    var text: String
    var filePaths: [String]
    var folderIndices: [Int]? = nil
    var imageName: String?
    var richTextName: String?
    var htmlName: String? = nil
    var sourceName: String
    var sourceBundleID: String? = nil
    var digest: String
    var pinned: Bool
    var pinboard: String? = nil
    var recognizedText: String? = nil
}

enum ClipboardFormat {
    static func label(for record: ClipboardRecord) -> String {
        if record.kind == "image" { return "图片" }
        if record.kind == "link" { return "链接" }
        if record.kind == "files" {
            let extensions = Set(record.filePaths.map { ($0 as NSString).pathExtension.lowercased() })
            if extensions == ["json"] { return "JSON 文件" }
            if extensions.isSubset(of: ["md", "markdown"]) && !extensions.isEmpty { return "Markdown 文件" }
            return "文件"
        }
        if isJSON(record.text) { return "JSON" }
        if isMarkdown(record.text) { return "Markdown" }
        if record.htmlName != nil { return "HTML" }
        if record.richTextName != nil { return "富文本" }
        return "文本"
    }

    static func matches(_ record: ClipboardRecord, query: String) -> Bool {
        let term = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        guard !term.isEmpty else { return true }
        if record.title.localizedCaseInsensitiveContains(term) || record.text.localizedCaseInsensitiveContains(term)
            || (record.kind == "files" && record.filePaths.contains { ($0 as NSString).lastPathComponent.localizedCaseInsensitiveContains(term) })
            || record.sourceName.localizedCaseInsensitiveContains(term)
            || record.recognizedText?.localizedCaseInsensitiveContains(term) == true { return true }
        let formatTerms = ["图片", "照片", "image", "png", "链接", "网址", "url", "文件", "路径", "file",
                           "json", "markdown", "md", "html", "富文本", "文本", "text"]
        guard formatTerms.contains(where: { $0.contains(term) }) else { return false }
        let label = label(for: record).lowercased()
        var terms = [label]
        if record.kind == "text" { terms += ["文本", "text"] }
        if label.contains("json") { terms.append("json") }
        if label.contains("markdown") { terms += ["markdown", "md"] }
        if label == "图片" { terms += ["image", "png", "照片"] }
        if label == "链接" { terms += ["url", "网址"] }
        if label == "文件" { terms += ["file", "路径"] }
        return terms.contains { $0.contains(term) }
    }

    private static func isJSON(_ value: String) -> Bool {
        let clean = value.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean.utf8.count <= 1_000_000,
              (clean.hasPrefix("{") && clean.hasSuffix("}") || clean.hasPrefix("[") && clean.hasSuffix("]")),
              let data = clean.data(using: .utf8) else { return false }
        return (try? JSONSerialization.jsonObject(with: data)) != nil
    }

    private static func isMarkdown(_ value: String) -> Bool {
        guard !value.isEmpty else { return false }
        let sample = String(value.prefix(20_000))
        let markers = [#"(?m)^#{1,6}\s+\S"#, #"(?m)^\s*```"#,
                       #"(?m)^\s*(?:[-*+]|\d+\.)\s+\S"#, #"(?m)^>\s+\S"#,
                       #"!?\[[^\]]+\]\([^)]+\)"#, #"\*\*[^*]+\*\*"#]
        return markers.contains { sample.range(of: $0, options: .regularExpression) != nil }
    }
}

final class ClipboardStore {
    private let directory: URL
    private let pasteboard: NSPasteboard
    var deliveryPasteboard: NSPasteboard { pasteboard }
    private var historyURL: URL { directory.appendingPathComponent("history.json") }
    private var preferencesURL: URL { directory.appendingPathComponent("preferences.json") }
    private var timer: Timer?
    private let recognitionQueue = DispatchQueue(label: "OpenAll.ClipboardOCR", qos: .utility)
    private var lastChangeCount: Int
    private var suspendUntil = Date.distantPast
    private(set) var records: [ClipboardRecord] = []
    private(set) var preferences = ClipboardPreferences()
    private(set) var stackActive = false
    private(set) var stackIDs: [UUID] = []
    var isPaused: Bool { preferences.pausedUntil.map { $0 > Date() } ?? false }
    var onChange: (() -> Void)?
    private var observers: [UUID: () -> Void] = [:]

    @discardableResult func addObserver(_ observer: @escaping () -> Void) -> UUID {
        let id = UUID()
        observers[id] = observer
        return id
    }

    private func notifyChange() {
        onChange?()
        for observer in observers.values { observer() }
    }

    init(pasteboard: NSPasteboard = .general, directory: URL? = nil) {
        self.pasteboard = pasteboard
        self.directory = directory ?? DesignPreview.home
            .appendingPathComponent("Library/Application Support/OpenAll/Clipboard")
        lastChangeCount = pasteboard.changeCount
        if let data = try? Data(contentsOf: historyURL),
           let saved = try? JSONDecoder().decode([ClipboardRecord].self, from: data) { records = saved }
        if let data = try? Data(contentsOf: preferencesURL),
           let saved = try? JSONDecoder().decode(ClipboardPreferences.self, from: data) { preferences = saved }
    }

    func seedPreviewRecords() {
        guard DesignPreview.enabled else { return }
        let samples = [
            ("发布检查清单", "- 确认构建通过\n- 检查交互与布局\n- 验证 Markdown 图形预览\n- 核对剪贴板首卡选择\n- 更新使用说明\n- 生成通用架构安装包\n- 检查签名与版本\n- 记录回归结果"),
            ("项目地址", "https://example.com/openall"),
            ("会议记录", "周一评审界面\n周二修复反馈\n周三验证发布"),
            ("常用命令", "swift build\nopen OpenAll.app"),
            ("设计备忘", "保持操作入口清晰，重要状态始终可见"),
            ("搜索关键词", "Markdown 流程图预览"),
            ("接口响应", "{\"ok\":true,\"count\":3}"),
            ("项目速记", "# 项目进展\n\n- 修复搜索\n- 验证发布")
        ]
        records = samples.enumerated().map { index, sample in
            ClipboardRecord(id: UUID(), date: Date().addingTimeInterval(Double(-index * 180)),
                            kind: index == 1 ? "link" : "text", title: sample.0, text: sample.1,
                            filePaths: [], imageName: nil, richTextName: nil, sourceName: "访达",
                            sourceBundleID: "com.apple.finder",
                            digest: "preview-\(index)", pinned: false)
        }
        let sampleImage = NSImage(size: NSSize(width: 320, height: 180))
        sampleImage.lockFocus()
        NSColor(calibratedRed: 0.21, green: 0.28, blue: 0.34, alpha: 1).setFill()
        NSRect(x: 0, y: 0, width: 320, height: 180).fill()
        ("会议记录" as NSString).draw(at: NSPoint(x: 26, y: 113), withAttributes: [.font: NSFont.systemFont(ofSize: 30, weight: .medium), .foregroundColor: NSColor.white])
        ("周一 10:30 · 设计评审" as NSString).draw(at: NSPoint(x: 26, y: 58), withAttributes: [.font: NSFont.systemFont(ofSize: 21), .foregroundColor: NSColor.white.withAlphaComponent(0.8)])
        sampleImage.unlockFocus()
        if let tiff = sampleImage.tiffRepresentation,
           let data = NSBitmapImageRep(data: tiff)?.representation(using: .png, properties: [:]) {
            try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
            try? data.write(to: directory.appendingPathComponent("preview-image.png"))
            records[2].kind = "image"
            records[2].title = "图片 · 320 × 180"
            records[2].text = ""
            records[2].imageName = "preview-image.png"
            records[2].sourceName = "预览"
        }
        records[5].kind = "files"
        records[5].title = "项目说明.md"
        records[5].text = ""
        records[5].filePaths = [DesignPreview.home.appendingPathComponent("Documents/项目说明.md").path]
    }

    func start() {
        trim()
        for item in records where item.kind == "image" && item.recognizedText == nil {
            if let name = item.imageName { scheduleRecognition(id: item.id, at: directory.appendingPathComponent(name)) }
        }
        timer?.invalidate()
        timer = Timer.scheduledTimer(withTimeInterval: 0.55, repeats: true) { [weak self] _ in self?.poll() }
    }

    func updatePreferences(_ next: ClipboardPreferences) {
        preferences = next
        persist(next, at: preferencesURL)
        trim()
    }

    func setShelfLayout(_ layout: ClipboardShelfLayout) {
        preferences.shelfLayout = layout
        persist(preferences, at: preferencesURL)
    }

    func suspendRecording(for seconds: TimeInterval) {
        suspendUntil = max(suspendUntil, Date().addingTimeInterval(seconds))
    }

    func poll(force: Bool = false, allowOwnApp: Bool = false) {
        let board = pasteboard
        guard force || board.changeCount != lastChangeCount else { return }
        lastChangeCount = board.changeCount
        guard Date() >= suspendUntil else { return }
        guard !isPaused && (preferences.enabled || stackActive) else { return }
        let source = NSWorkspace.shared.frontmostApplication
        let bundleID = source?.bundleIdentifier ?? ""
        if (bundleID == Bundle.main.bundleIdentifier && !allowOwnApp) ||
            preferences.ignoreApplications.contains(where: { $0.caseInsensitiveCompare(bundleID) == .orderedSame }) { return }
        let types = Set(board.types?.map(\.rawValue) ?? [])
        if types.contains("org.nspasteboard.ConcealedType") || types.contains("com.agilebits.onepassword") { return }

        let fileURLs = board.pasteboardItems?.compactMap { $0.string(forType: .fileURL) }
            .compactMap { URL(string: $0) }.filter(\.isFileURL) ?? []
        let paths = fileURLs.map(\.path)
        let folderIndices = fileURLs.prefix(3).indices.filter { fileURLs[$0].hasDirectoryPath }
        let text = board.string(forType: .string) ?? ""
        guard text.utf8.count <= preferences.maxItemBytes,
              paths.joined(separator: "\n").utf8.count <= preferences.maxItemBytes else { return }
        var kind = "text"
        var imageData: Data?
        var richData: Data?
        var htmlData: Data?
        var title = text.replacingOccurrences(of: "\n", with: " ").trimmingCharacters(in: .whitespacesAndNewlines)
        if !paths.isEmpty {
            kind = "files"
            title = paths.count == 1 ? (paths[0] as NSString).lastPathComponent : "\(paths.count) 个文件"
        } else if let image = NSImage(pasteboard: board),
                  let tiff = image.tiffRepresentation,
                  let bitmap = NSBitmapImageRep(data: tiff),
                  let png = bitmap.representation(using: .png, properties: [:]), png.count <= preferences.maxItemBytes {
            kind = "image"
            imageData = png
            title = "图片 · \(bitmap.pixelsWide) × \(bitmap.pixelsHigh)"
        } else if !text.isEmpty {
            if let rtf = board.data(forType: .rtf), rtf.count <= 5_000_000 { richData = rtf }
            if let html = board.data(forType: .html), html.count <= 5_000_000 { htmlData = html }
            if URL(string: text)?.scheme?.hasPrefix("http") == true && !text.contains("\n") { kind = "link" }
        } else { return }
        let digestData: Data
        if let imageData { digestData = imageData }
        else if kind == "files" { digestData = Data(paths.joined(separator: "\n").utf8) }
        else { digestData = Data(text.utf8) }
        let digest = kind + ":" + SHA256.hash(data: digestData).map { String(format: "%02x", $0) }.joined()
        if records.first?.digest == digest {
            if stackActive, let id = records.first?.id { stackIDs.append(id); notifyChange() }
            return
        }
        let previous = records.first(where: { $0.digest == digest })
        let wasPinned = previous?.pinned ?? false
        let previousID = previous?.id
        if let old = records.first(where: { $0.digest == digest }) {
            records.removeAll { $0.id == old.id }
            removeBlobs(for: old)
        }
        let id = UUID()
        if let previousID { stackIDs = stackIDs.map { $0 == previousID ? id : $0 } }
        let imageName = imageData == nil ? nil : id.uuidString + ".png"
        let richName = richData == nil ? nil : id.uuidString + ".rtf"
        let htmlName = htmlData == nil ? nil : id.uuidString + ".html"
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let imageData, let imageName { try? imageData.write(to: directory.appendingPathComponent(imageName), options: .atomic) }
        if let richData, let richName { try? richData.write(to: directory.appendingPathComponent(richName), options: .atomic) }
        if let htmlData, let htmlName { try? htmlData.write(to: directory.appendingPathComponent(htmlName), options: .atomic) }
        records.insert(ClipboardRecord(id: id, date: Date(), kind: kind,
                                       title: String(title.prefix(500)), text: text,
                                       filePaths: paths, folderIndices: folderIndices.isEmpty ? nil : folderIndices, imageName: imageName, richTextName: richName, htmlName: htmlName,
                                       sourceName: bundleID == Bundle.main.bundleIdentifier ? (previous?.sourceName ?? "未知应用") : (source?.localizedName ?? "未知应用"),
                                       sourceBundleID: bundleID == Bundle.main.bundleIdentifier ? previous?.sourceBundleID : source?.bundleIdentifier,
                                       digest: digest,
                                       pinned: wasPinned, pinboard: previous?.pinboard,
                                       recognizedText: previous?.recognizedText), at: 0)
        if stackActive { stackIDs.append(id) }
        trim()
        save()
        if let imageName, previous?.recognizedText == nil {
            scheduleRecognition(id: id, at: directory.appendingPathComponent(imageName))
        }
    }

    func search(_ query: String) -> [ClipboardRecord] {
        let q = query.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !q.isEmpty else { return records }
        return records.filter { ClipboardFormat.matches($0, query: q) }
    }

    func togglePin(_ id: UUID) {
        guard let i = records.firstIndex(where: { $0.id == id }) else { return }
        records[i].pinned.toggle()
        records[i].pinboard = records[i].pinned ? (preferences.pinboards.first ?? "收藏") : nil
        save()
    }

    func setPinboard(_ id: UUID, name: String?) {
        guard let i = records.firstIndex(where: { $0.id == id }) else { return }
        records[i].pinboard = name
        records[i].pinned = name != nil
        save()
    }

    func addPinboard(_ name: String, color: String = "blue") -> Bool {
        let clean = name.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty, !preferences.pinboards.contains(where: { $0.caseInsensitiveCompare(clean) == .orderedSame }) else { return false }
        var next = preferences
        next.pinboards.append(clean)
        next.pinboardColors[clean] = color
        updatePreferences(next)
        return true
    }

    func setPinboardColor(_ name: String, color: String) {
        guard preferences.pinboards.contains(name) else { return }
        var next = preferences
        next.pinboardColors[name] = color
        updatePreferences(next)
    }

    func renamePinboard(_ oldName: String, to requested: String) -> Bool {
        let name = requested.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !name.isEmpty, let index = preferences.pinboards.firstIndex(of: oldName),
              !preferences.pinboards.contains(where: { $0 != oldName && $0.caseInsensitiveCompare(name) == .orderedSame }) else { return false }
        var next = preferences
        next.pinboards[index] = name
        next.pinboardColors[name] = next.pinboardColors.removeValue(forKey: oldName) ?? "blue"
        for recordIndex in records.indices where records[recordIndex].pinboard == oldName {
            records[recordIndex].pinboard = name
        }
        updatePreferences(next)
        save()
        return true
    }

    func removePinboard(_ name: String) {
        var next = preferences
        next.pinboards.removeAll { $0 == name }
        next.pinboardColors.removeValue(forKey: name)
        for index in records.indices where records[index].pinboard == name {
            records[index].pinboard = nil
            records[index].pinned = false
        }
        updatePreferences(next)
        save()
    }

    func beginStack(captureCurrent: Bool = true) {
        stackIDs.removeAll()
        stackActive = true
        if captureCurrent { poll(force: true, allowOwnApp: true) }
        if captureCurrent, stackIDs.isEmpty,
           let text = pasteboard.string(forType: .string), !text.isEmpty,
           let item = records.first(where: { $0.text == text }) { stackIDs.append(item.id) }
        notifyChange()
    }

    func endStack() {
        stackActive = false
        stackIDs.removeAll()
        notifyChange()
    }

    @discardableResult func prepareNextStackItem() -> Bool {
        while !stackIDs.isEmpty {
            let id = stackIDs.removeFirst()
            if let item = records.first(where: { $0.id == id }), copy(item, plainText: preferences.plainTextByDefault) {
                notifyChange()
                return true
            }
        }
        notifyChange()
        return false
    }

    func stackRecords() -> [ClipboardRecord] {
        stackIDs.compactMap { id in records.first(where: { $0.id == id }) }
    }

    func moveStackItemToFront(at index: Int) {
        guard stackIDs.indices.contains(index), index != 0 else { return }
        let item = stackIDs.remove(at: index)
        stackIDs.insert(item, at: 0)
        notifyChange()
    }

    func removeStackItem(at index: Int) {
        guard stackIDs.indices.contains(index) else { return }
        stackIDs.remove(at: index)
        notifyChange()
        if stackIDs.isEmpty { endStack() }
    }

    func imageURL(for item: ClipboardRecord) -> URL? {
        item.imageName.map { directory.appendingPathComponent($0) }
    }

    func dragWriters(for item: ClipboardRecord) -> [NSPasteboardWriting] {
        switch item.kind {
        case "files": return item.filePaths.map { URL(fileURLWithPath: $0) as NSURL }
        case "image":
            guard let name = item.imageName,
                  let image = NSImage(contentsOf: directory.appendingPathComponent(name)) else { return [] }
            return [image]
        case "link":
            if let url = URL(string: item.text), ["http", "https"].contains(url.scheme?.lowercased() ?? "") {
                return [url as NSURL]
            }
            fallthrough
        default:
            let writer = NSPasteboardItem()
            writer.setString(item.text, forType: .string)
            if let name = item.richTextName,
               let data = try? Data(contentsOf: directory.appendingPathComponent(name)) {
                writer.setData(data, forType: .rtf)
            }
            if let name = item.htmlName,
               let data = try? Data(contentsOf: directory.appendingPathComponent(name)) {
                writer.setData(data, forType: .html)
            }
            return [writer]
        }
    }

    func delete(_ id: UUID) {
        guard let i = records.firstIndex(where: { $0.id == id }) else { return }
        removeBlobs(for: records[i])
        records.remove(at: i)
        stackIDs.removeAll { $0 == id }
        save()
    }

    func clearUnpinned() {
        for item in records where !item.pinned { removeBlobs(for: item) }
        records.removeAll { !$0.pinned }
        save()
    }

    func clearUnpinned(since date: Date) {
        let removed = records.filter { !$0.pinned && $0.date >= date }
        for item in removed { removeBlobs(for: item) }
        let ids = Set(removed.map(\.id))
        records.removeAll { ids.contains($0.id) }
        stackIDs.removeAll { ids.contains($0) }
        save()
    }

    @discardableResult func mergeText(ids: [UUID]) -> ClipboardRecord? {
        guard ids.count >= 2 else { return nil }
        let contents = ids.compactMap { id -> String? in
            guard let item = records.first(where: { $0.id == id }),
                  item.kind == "text" || item.kind == "link" else { return nil }
            return item.text
        }
        guard contents.count == ids.count else { return nil }
        let merged = contents.joined(separator: "\n")
        guard merged.utf8.count <= preferences.maxItemBytes else { return nil }
        let id = UUID()
        let digest = "text:" + SHA256.hash(data: Data(merged.utf8)).map { String(format: "%02x", $0) }.joined()
        let item = ClipboardRecord(id: id, date: Date(), kind: "text",
                                   title: String(merged.replacingOccurrences(of: "\n", with: " ").prefix(500)),
                                   text: merged, filePaths: [], imageName: nil, richTextName: nil,
                                   sourceName: "OpenAll", sourceBundleID: Bundle.main.bundleIdentifier,
                                   digest: digest, pinned: false)
        records.insert(item, at: 0)
        trim()
        save()
        _ = copy(item, plainText: true)
        return item
    }

    func setPaused(until date: Date?) {
        var next = preferences
        next.pausedUntil = date
        updatePreferences(next)
    }

    @discardableResult func editText(_ id: UUID, text: String) -> Bool {
        guard let index = records.firstIndex(where: { $0.id == id }),
              records[index].kind == "text" || records[index].kind == "link" else { return false }
        let clean = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return false }
        let old = records[index]
        removeBlobs(for: old)
        records[index].text = text
        records[index].title = String(clean.replacingOccurrences(of: "\n", with: " ").prefix(500))
        records[index].kind = URL(string: clean)?.scheme?.hasPrefix("http") == true && !clean.contains("\n") ? "link" : "text"
        records[index].richTextName = nil
        records[index].htmlName = nil
        records[index].digest = records[index].kind + ":" + SHA256.hash(data: Data(text.utf8)).map { String(format: "%02x", $0) }.joined()
        save()
        return true
    }

    @discardableResult func copy(_ item: ClipboardRecord, plainText: Bool = false) -> Bool {
        let board = pasteboard
        board.clearContents()
        var success = false
        switch item.kind {
        case "image":
            if let name = item.imageName, let image = NSImage(contentsOf: directory.appendingPathComponent(name)) {
                success = board.writeObjects([image])
            }
        case "files":
            let urls = item.filePaths.map { URL(fileURLWithPath: $0) as NSURL }
            success = !urls.isEmpty && board.writeObjects(urls)
        default:
            if !plainText, let name = item.richTextName,
               let data = try? Data(contentsOf: directory.appendingPathComponent(name)) {
                board.setData(data, forType: .rtf)
            }
            if !plainText, let name = item.htmlName,
               let data = try? Data(contentsOf: directory.appendingPathComponent(name)) {
                board.setData(data, forType: .html)
            }
            success = board.setString(item.text, forType: .string)
        }
        lastChangeCount = board.changeCount
        if success, let index = records.firstIndex(where: { $0.id == item.id }) {
            var recent = records.remove(at: index)
            recent.date = Date()
            records.insert(recent, at: 0)
            save()
        }
        return success
    }

    private func trim() {
        let calendar = Calendar.current
        let cutoff: Date
        switch preferences.retentionDays {
        case 7: cutoff = calendar.date(byAdding: .day, value: -7, to: Date())!
        case 90: cutoff = calendar.date(byAdding: .month, value: -3, to: Date())!
        case 365: cutoff = calendar.date(byAdding: .year, value: -1, to: Date())!
        default: cutoff = calendar.date(byAdding: .month, value: -1, to: Date())!
        }
        records.removeAll { item in
            if item.pinned { return false }
            if item.date >= cutoff { return false }
            removeBlobs(for: item)
            return true
        }
        save()
    }

    private func removeBlobs(for item: ClipboardRecord) {
        for name in [item.imageName, item.richTextName, item.htmlName].compactMap({ $0 }) {
            try? FileManager.default.removeItem(at: directory.appendingPathComponent(name))
        }
    }

    private func scheduleRecognition(id: UUID, at url: URL) {
        recognitionQueue.async { [weak self] in
            guard let data = try? Data(contentsOf: url) else { return }
            let request = VNRecognizeTextRequest()
            request.recognitionLevel = .accurate
            request.recognitionLanguages = ["zh-Hans", "en-US"]
            let handler = VNImageRequestHandler(data: data)
            guard (try? handler.perform([request])) != nil else { return }
            let result = (request.results ?? []).compactMap { $0.topCandidates(1).first?.string }.joined(separator: "\n")
            DispatchQueue.main.async { [weak self] in
                guard let self, let index = self.records.firstIndex(where: { $0.id == id }) else { return }
                self.records[index].recognizedText = result
                self.save()
            }
        }
    }

    private func save() { persist(records, at: historyURL); notifyChange() }
    private func persist<T: Encodable>(_ value: T, at url: URL) {
        try? FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(value) { try? data.write(to: url, options: .atomic) }
    }
}

