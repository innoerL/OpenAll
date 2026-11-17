import Foundation

enum FileSearchFilter: Equatable {
    case all
    case documents
    case images
    case fileExtension(String)

    static let documentExtensions: Set<String> = [
        "pdf", "doc", "docx", "docm", "dot", "dotx", "dotm", "rtf", "rtfd", "txt", "text", "md", "markdown",
        "pages", "xls", "xlsx", "xlsm", "xlsb", "xlt", "xltx", "csv", "tsv", "numbers",
        "ppt", "pptx", "pptm", "pot", "potx", "key", "keynote", "odt", "ods", "odp",
        "xmind", "mm", "mindnode", "opml", "epub", "mobi", "azw", "azw3", "djvu"
    ]
    static let imageExtensions: Set<String> = [
        "jpg", "jpeg", "jpe", "png", "gif", "heic", "heif", "tif", "tiff", "bmp", "webp", "avif",
        "svg", "svgz", "ico", "icns", "psd", "psb", "ai", "eps", "raw", "dng", "cr2", "cr3", "nef", "arw", "orf", "rw2", "raf"
    ]

    var title: String {
        switch self {
        case .all: return "文件"
        case .documents: return "文档"
        case .images: return "图片"
        case .fileExtension(let value): return ".\(value) 文件"
        }
    }

    private var extensions: Set<String>? {
        switch self {
        case .all: return nil
        case .documents: return Self.documentExtensions
        case .images: return Self.imageExtensions
        case .fileExtension(let value): return [value.lowercased()]
        }
    }

    func matchesName(_ name: String) -> Bool {
        guard let extensions else { return true }
        let lower = name.localizedLowercase
        return extensions.contains { lower.hasSuffix("." + $0) }
    }

    func matches(_ url: URL, isDirectory: Bool, isPackage: Bool) -> Bool {
        guard self != .all else { return true }
        // Pages 等文档包可以是目录；普通的同名文件夹不属于文档或图片。
        return (!isDirectory || isPackage) && matchesName(url.lastPathComponent)
    }

    func spotlightPredicate(term: String) -> NSPredicate {
        let name = NSPredicate(format: "%K CONTAINS[cd] %@", "kMDItemFSName", term)
        guard let extensions else { return name }
        let suffixes = extensions.sorted().map {
            NSPredicate(format: "%K ENDSWITH[cd] %@", "kMDItemFSName", "." + $0)
        }
        let notFolder = NSCompoundPredicate(notPredicateWithSubpredicate:
            NSPredicate(format: "%K == %@", "kMDItemContentType", "public.folder"))
        // NSMetadataQuery 不接受只有一个子句的 OR，单后缀直接使用比较谓词。
        let suffix = suffixes.count == 1 ? suffixes[0] : NSCompoundPredicate(orPredicateWithSubpredicates: suffixes)
        return NSCompoundPredicate(andPredicateWithSubpredicates: [name,
            suffix, notFolder])
    }
}

struct FileSearchRequest: Equatable {
    let term: String
    let filter: FileSearchFilter

    // 常见后缀允许省略点；不熟悉的后缀显式加点，避免吞掉普通的“名称 关键词”搜索。
    private static let commonExtensions = FileSearchFilter.documentExtensions.union(FileSearchFilter.imageExtensions).union([
        "json", "jsonl", "ndjson", "yaml", "yml", "toml", "xml", "properties", "ini", "env", "conf", "config", "log",
        "sql", "swift", "c", "cc", "cpp", "h", "hpp", "m", "rs", "go", "java", "kt", "kts", "js", "jsx", "ts", "tsx",
        "py", "ipynb", "rb", "php", "sh", "zsh", "bash", "fish", "lua", "r", "cs", "css", "scss", "less", "vue", "svelte",
        "html", "htm", "zip", "rar", "7z", "tar", "tar.gz", "gz", "bz2", "xz", "zst", "dmg", "iso", "pkg", "app",
        "mp3", "wav", "flac", "aac", "ogg", "m4a", "mp4", "mov", "mkv", "webm", "avi", "m4v", "srt", "vtt", "sqlite", "db"
    ])

    static func parse(_ input: String, preservingCommands commands: [String] = []) -> FileSearchRequest? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        let split = text.firstIndex(where: { $0.isWhitespace })
        let prefix = (split.map { String(text[..<$0]) } ?? text).lowercased()
        let term = split.map { String(text[$0...]).trimmingCharacters(in: .whitespacesAndNewlines) } ?? ""
        let filter: FileSearchFilter
        switch prefix {
        case "文件", "file", "files": filter = .all
        case "文档", "document", "documents", "docs": filter = .documents
        case "图片", "images", "photos": filter = .images
        default:
            // 裸 json/markdown 等继续打开工具；完整的命令名和别名优先于同名后缀。
            // json 加关键词是用户明确指定的文件搜索语法，故不应用此命令例外。
            guard !term.isEmpty else { return nil }
            let reserved = ["sql 执行计划", "sql 参数还原", "sql 格式化", "sql format", "sql restore", "config diff", "log timeline"] + commands
            if prefix != "json", reserved.contains(where: { $0.localizedCaseInsensitiveCompare(text) == .orderedSame }) { return nil }
            let suffix = prefix.hasPrefix(".") ? String(prefix.dropFirst()) : prefix
            let allowed = CharacterSet(charactersIn: "abcdefghijklmnopqrstuvwxyz0123456789_+.-")
            guard !suffix.isEmpty, suffix.count <= 32, !suffix.hasPrefix("."), !suffix.hasSuffix("."),
                  suffix.unicodeScalars.allSatisfy({ allowed.contains($0) }),
                  prefix.hasPrefix(".") || commonExtensions.contains(suffix) else { return nil }
            filter = .fileExtension(suffix)
        }
        return FileSearchRequest(term: term, filter: filter)
    }
}

private struct IndexedFile {
    let url: URL
    let name: String
    let isDirectory: Bool
    let isPackage: Bool
    init(_ url: URL) {
        self.url = url
        name = url.lastPathComponent.localizedLowercase
        let values = try? url.resourceValues(forKeys: [.isDirectoryKey, .isPackageKey])
        isDirectory = values?.isDirectory ?? false
        isPackage = values?.isPackage ?? false
    }
}

final class FileSearchIndex {
    private let searchRoots: [URL]?
    private var query: NSMetadataQuery?
    private var completionObserver: NSObjectProtocol?
    private var updateObserver: NSObjectProtocol?
    private var spotlightFiles: [URL] = []
    private var localMatches: [URL] = []
    private var localFiles: [IndexedFile] = []
    private var searchGeneration = 0
    private var scanGeneration = 0
    private var enabled = false
    private var hasLocalIndex = false
    private var rescanAfterCurrent = false
    private var lastScan = Date.distantPast
    private(set) var results: [URL] = []
    private(set) var isSearching = false
    private(set) var isIndexing = false
    private(set) var unreadableFolders: [String] = []
    private(set) var scannedCount = 0
    private(set) var searchTerm = ""
    private(set) var searchFilter: FileSearchFilter = .all
    var indexedCount: Int { localFiles.count }
    var lastIndexedAt: Date? { hasLocalIndex ? lastScan : nil }
    var onChange: (() -> Void)?

    init(searchRoots: [URL]? = nil) { self.searchRoots = searchRoots }

    func setEnabled(_ value: Bool) {
        if enabled == value {
            if value && !isIndexing && Date().timeIntervalSince(lastScan) > 300 { buildLocalIndex() }
            return
        }
        enabled = value
        if value {
            buildLocalIndex()
        } else {
            scanGeneration += 1
            rescanAfterCurrent = false
            hasLocalIndex = false
            isIndexing = false
            localFiles = []
            localMatches = []
            scannedCount = 0
            unreadableFolders = []
            search("")
        }
    }

    func rescan() {
        guard enabled else { return }
        if isIndexing { rescanAfterCurrent = true; return }
        buildLocalIndex()
    }

    func search(_ term: String, filter: FileSearchFilter = .all) {
        let clean = term.trimmingCharacters(in: .whitespacesAndNewlines)
        guard clean != searchTerm || filter != searchFilter else { return }
        stopSpotlight()
        searchTerm = clean
        searchFilter = filter
        searchGeneration += 1
        spotlightFiles = []
        localMatches = []
        refreshResults()
        guard enabled, !clean.isEmpty else { return }
        if !hasLocalIndex && !isIndexing { buildLocalIndex() }
        searchLocalFiles()
        let next = NSMetadataQuery()
        next.predicate = filter.spotlightPredicate(term: clean)
        // 显式测试根目录同时约束 Spotlight；正式应用未传根目录时仍搜索整机索引。
        if let searchRoots { next.searchScopes = searchRoots }
        else { next.searchScopes = [NSMetadataQueryLocalComputerScope] }
        completionObserver = NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidFinishGathering,
                                                                     object: next, queue: .main) { [weak self] _ in
            self?.collectSpotlight()
        }
        updateObserver = NotificationCenter.default.addObserver(forName: .NSMetadataQueryDidUpdate,
                                                                 object: next, queue: .main) { [weak self] _ in
            self?.collectSpotlight()
        }
        query = next
        isSearching = next.start()
    }

    private func buildLocalIndex() {
        guard enabled, !isIndexing else { return }
        isIndexing = true
        scannedCount = 0
        scanGeneration += 1
        let generation = scanGeneration
        let home = DesignPreview.home
        let folderNames = ["Desktop", "Documents", "Downloads", "Movies", "Pictures", "Public", "Applications"]
        let roots = searchRoots ?? folderNames.map { home.appendingPathComponent($0) }
        DispatchQueue.global(qos: .utility).async { [weak self] in
            let fm = FileManager.default
            var files: [IndexedFile] = []
            var seen = Set<String>()
            var unreadable: [String] = []
            if self?.searchRoots == nil,
               let topLevel = try? fm.contentsOfDirectory(at: home, includingPropertiesForKeys: nil,
                                                          options: [.skipsHiddenFiles]) {
                for url in topLevel where !folderNames.contains(url.lastPathComponent) {
                    var directory: ObjCBool = false
                    if fm.fileExists(atPath: url.path, isDirectory: &directory), !directory.boolValue,
                       seen.insert(url.path).inserted { files.append(IndexedFile(url)) }
                }
            }
            for root in roots {
                guard fm.fileExists(atPath: root.path) else { continue }
                guard (try? fm.contentsOfDirectory(at: root, includingPropertiesForKeys: nil,
                                                   options: [.skipsHiddenFiles])) != nil else {
                    unreadable.append(root.lastPathComponent)
                    continue
                }
                let countBeforeRoot = files.count
                let enumerator = fm.enumerator(at: root, includingPropertiesForKeys: [.isDirectoryKey, .isPackageKey],
                                               options: [.skipsHiddenFiles, .skipsPackageDescendants],
                                               errorHandler: { _, _ in
                                                   unreadable.append(root.lastPathComponent)
                                                   return true
                                               })
                while let url = enumerator?.nextObject() as? URL {
                    if seen.insert(url.path).inserted {
                        files.append(IndexedFile(url))
                        if files.count % 2500 == 0 {
                            let progress = files.count
                            DispatchQueue.main.async { [weak self] in
                                guard let self, self.scanGeneration == generation else { return }
                                self.scannedCount = progress
                                self.onChange?()
                            }
                        }
                    }
                    if files.count - countBeforeRoot >= 12_500 { break }
                }
            }
            DispatchQueue.main.async { [weak self] in
                guard let self, self.enabled, self.scanGeneration == generation else { return }
                self.localFiles = files
                self.scannedCount = files.count
                self.unreadableFolders = Array(Set(unreadable)).sorted()
                self.hasLocalIndex = true
                self.isIndexing = false
                self.lastScan = Date()
                self.searchLocalFiles()
                self.onChange?()
                if self.rescanAfterCurrent {
                    self.rescanAfterCurrent = false
                    self.buildLocalIndex()
                }
            }
        }
    }

    private func collectSpotlight() {
        guard let query else { return }
        var found: [URL] = []
        var seen = Set<String>()
        // 类型已进入 Spotlight 查询；无效条目不占结果额度。
        for index in 0..<query.resultCount {
            guard let item = query.result(at: index) as? NSMetadataItem,
                  let path = item.value(forAttribute: "kMDItemPath") as? String,
                  seen.insert(path).inserted else { continue }
            let url = URL(fileURLWithPath: path)
            guard searchFilter.matchesName(url.lastPathComponent) else { continue }
            found.append(url)
            if found.count >= 160 { break }
        }
        spotlightFiles = found
        isSearching = false
        refreshResults()
        onChange?()
    }

    private func refreshResults() {
        guard enabled, !searchTerm.isEmpty else { results = []; return }
        let term = searchTerm.localizedLowercase
        var seen = Set<String>()
        let matches = (spotlightFiles + localMatches).filter { url in
            url.lastPathComponent.localizedLowercase.contains(term) && searchFilter.matchesName(url.lastPathComponent)
                && seen.insert(url.path).inserted
        }
        results = Array(matches.sorted { first, second in
            func rank(_ url: URL) -> Int {
                let name = url.lastPathComponent.localizedLowercase
                var score = name == term ? 100 : name.hasPrefix(term) ? 70 : 40
                if url.path.contains("/Library/") { score -= 25 }
                if url.path.contains("/Applications/") { score += 15 }
                return score
            }
            let left = rank(first), right = rank(second)
            return left == right ? first.path.localizedStandardCompare(second.path) == .orderedAscending : left > right
        }.prefix(120))
    }

    private func searchLocalFiles() {
        guard enabled, !searchTerm.isEmpty, !localFiles.isEmpty else { return }
        let files = localFiles
        let term = searchTerm.localizedLowercase
        let filter = searchFilter
        let generation = searchGeneration
        DispatchQueue.global(qos: .userInitiated).async { [weak self] in
            let matches = files.filter {
                $0.name.contains(term) && filter.matches($0.url, isDirectory: $0.isDirectory, isPackage: $0.isPackage)
            }.sorted { left, right in
                func score(_ file: IndexedFile) -> Int {
                    var value = file.name == term ? 100 : file.name.hasPrefix(term) ? 70 : 40
                    if file.url.path.contains("/Library/") { value -= 25 }
                    if file.url.path.contains("/Applications/") { value += 15 }
                    return value
                }
                let a = score(left), b = score(right)
                return a == b ? left.url.path.localizedStandardCompare(right.url.path) == .orderedAscending : a > b
            }.prefix(120).map(\.url)
            DispatchQueue.main.async { [weak self] in
                guard let self, self.enabled, self.searchGeneration == generation else { return }
                self.localMatches = matches
                self.refreshResults()
                self.onChange?()
            }
        }
    }

    private func stopSpotlight() {
        query?.stop()
        query = nil
        if let completionObserver { NotificationCenter.default.removeObserver(completionObserver) }
        if let updateObserver { NotificationCenter.default.removeObserver(updateObserver) }
        completionObserver = nil
        updateObserver = nil
        isSearching = false
    }

    deinit { stopSpotlight() }
}
