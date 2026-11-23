import AppKit
import ImageIO
import UniformTypeIdentifiers

// 模拟访达写入文件 URL，只操作独立的系统剪贴板和临时目录。
enum DesignPreview {
    static let enabled = false
    static let home = FileManager.default.temporaryDirectory
}

@main struct ClipboardFileChecks {
    static func writeImage(_ url: URL, type: UTType, orientation: Int = 1) {
        let context = CGContext(data: nil, width: 1024, height: 256, bitsPerComponent: 8, bytesPerRow: 0,
                                space: CGColorSpace(name: CGColorSpace.sRGB)!, bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
        context.setFillColor(red: 1, green: 0, blue: 0, alpha: 1)
        context.fill(CGRect(x: 0, y: 0, width: context.width, height: context.height))
        let destination = CGImageDestinationCreateWithURL(url as CFURL, type.identifier as CFString, 1, nil)!
        CGImageDestinationAddImage(destination, context.makeImage()!, [kCGImagePropertyOrientation: orientation] as CFDictionary)
        precondition(CGImageDestinationFinalize(destination))
    }

    static func checkThumbnails(at root: URL, store: ClipboardStore, board: NSPasteboard, folder: URL) throws {
        let image = root.appendingPathComponent("项目 截图.PNG")
        let portrait = root.appendingPathComponent("旋转照片.jpg")
        writeImage(image, type: .png)
        writeImage(portrait, type: .jpeg, orientation: 6)
        let preview = ClipboardFilePreview.load(path: image.path, maxPixels: 64)!
        precondition(preview.isThumbnail && preview.image.size == NSSize(width: 64, height: 16))
        precondition(ClipboardFilePreview.load(path: image.path, maxPixels: 64) === preview)
        let small = ClipboardFilePreview.thumbnail(at: image, maxPixels: 32)!
        let color = NSBitmapImageRep(cgImage: small).colorAt(x: 10, y: 4)!.usingColorSpace(.sRGB)!
        precondition(color.redComponent > 0.85 && color.greenComponent < 0.25 && color.blueComponent < 0.25, "缩略图中心应为源图的红色，实际为 \(color)")
        let rotated = ClipboardFilePreview.thumbnail(at: portrait, maxPixels: 64)!
        precondition(rotated.width == 16 && rotated.height == 64)
        precondition(ClipboardFilePreview.load(path: folder.path, maxPixels: 64)?.isThumbnail == false)

        for urls in [[image], [portrait, folder, image]] {
            board.clearContents()
            precondition(board.writeObjects(urls as [NSURL]))
            store.poll(force: true, allowOwnApp: true)
            let item = store.records[0]
            precondition(item.kind == "files" && item.filePaths == urls.map(\.path) && item.imageName == nil)
            precondition(store.search("项目 截图").first?.id == item.id)
            precondition(store.copy(item, plainText: true))
            let pasted = board.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL]
            precondition(pasted?.map(\.path) == urls.map(\.path))
        }
        try Data("已损坏的图片".utf8).write(to: image)
        precondition(ClipboardFilePreview.load(path: image.path, maxPixels: 64)?.isThumbnail == false)
        try FileManager.default.removeItem(at: image)
        precondition(ClipboardFilePreview.load(path: image.path, maxPixels: 64) == nil)
    }

    static func checkCardTextSize(store: ClipboardStore, board: NSPasteboard, directory: URL) throws {
        // 缺少新字段和不认识的字号都保留用户的其他偏好。
        for json in [#"{"maxItems":42,"shelfLayout":"list"}"#, #"{"maxItems":42,"shelfLayout":"list","cardTextSize":"future"}"#] {
            let saved = try JSONDecoder().decode(ClipboardPreferences.self, from: Data(json.utf8))
            precondition(saved.cardTextSize == .large && saved.maxItems == 42 && saved.shelfLayout == .list)
        }
        precondition(ClipboardCardTextSize.allCases.map(\.points) == [14, 13, 12])
        precondition(ClipboardCardTextSize.allCases.map(\.monospacedPoints) == [12, 11, 10])
        var changes = 0
        store.addObserver { changes += 1 }
        for (index, option) in ClipboardCardTextSize.allCases.enumerated() {
            var next = store.preferences
            next.cardTextSize = option
            store.updatePreferences(next)
            let reloaded = ClipboardStore(pasteboard: board, directory: directory)
            precondition(changes == index + 1 && reloaded.preferences.cardTextSize == option)
        }
    }

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
        try checkThumbnails(at: root, store: old, board: board, folder: folder)
        try checkCardTextSize(store: old, board: board, directory: history)
        print("文件剪贴板通过单选、多选、搜索、原生 URL 回写、旧历史、图片下采样、方向、缓存和缺失或损坏文件回退检查")
        print("卡片正文字号通过三档映射、旧偏好兼容、变更通知和持久化回归")
    }
}
