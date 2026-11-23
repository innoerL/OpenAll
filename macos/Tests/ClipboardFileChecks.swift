import AppKit

// 模拟访达写入文件 URL，只操作独立的系统剪贴板和临时目录。
enum DesignPreview {
    static let enabled = false
    static let home = FileManager.default.temporaryDirectory
}

@main struct ClipboardFileChecks {
    static func main() throws {
        let fm = FileManager.default
        let root = fm.temporaryDirectory.appendingPathComponent("OpenAll-file-check-" + UUID().uuidString)
        let folder = root.appendingPathComponent("带 空格的目录", isDirectory: true)
        let archive = root.appendingPathComponent("备份 #1.zip", isDirectory: false)
        let history = root.appendingPathComponent("history")
        try fm.createDirectory(at: folder, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: root) }
        try Data("内容".utf8).write(to: archive)
        let board = NSPasteboard.withUniqueName()
        defer { board.releaseGlobally() }
        let store = ClipboardStore(pasteboard: board, directory: history)
        for urls in [[archive], [folder, archive]] {
            board.clearContents()
            precondition(board.writeObjects(urls as [NSURL]))
            store.poll(force: true, allowOwnApp: true)
            let item = store.records[0]
            precondition(item.kind == "files" && item.filePaths == urls.map(\.path))
            precondition(store.search("备份").first?.id == item.id)
            precondition(store.copy(item, plainText: true))
            let pasted = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly:true]) as? [URL]
            precondition(pasted?.map(\.path) == urls.map(\.path))
        }
        let record = store.records[0]
        precondition(record.folderIndices == [0])
        try fm.removeItem(at: archive)
        let reloaded = ClipboardStore(pasteboard: board, directory: history)
        precondition(reloaded.records.count == 2 && reloaded.copy(reloaded.records[0]))
        let paths = (board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly:true]) as? [URL])?.map(\.path)
        precondition(paths == [folder.path, archive.path])
        let json = history.appendingPathComponent("history.json")
        var legacy = try JSONSerialization.jsonObject(with: Data(contentsOf: json)) as! [[String: Any]]
        for index in legacy.indices { legacy[index].removeValue(forKey: "folderIndices") }
        try JSONSerialization.data(withJSONObject: legacy).write(to: json)
        let old = ClipboardStore(pasteboard: board, directory: history)
        precondition(old.records[0].filePaths == [folder.path, archive.path] && old.records[0].folderIndices == nil)
        print("文件剪贴板通过单选、多选、搜索、原生 URL 回写、缺失文件与旧历史回归")
    }
}
