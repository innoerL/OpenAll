import AppKit
import ImageIO
import UniformTypeIdentifiers

/// 在后台从原文件读取少量预览像素，文件记录始终保存原路径。
final class ClipboardFilePreview {
    let image: NSImage
    let isThumbnail: Bool

    private init(image: NSImage, isThumbnail: Bool) {
        self.image = image
        self.isThumbnail = isThumbnail
    }

    private static let cache: NSCache<NSString, ClipboardFilePreview> = {
        let cache = NSCache<NSString, ClipboardFilePreview>()
        cache.countLimit = 256
        cache.totalCostLimit = 24 * 1024 * 1024
        return cache
    }()

    static func isImageCandidate(_ path: String) -> Bool {
        let ext = (path as NSString).pathExtension
        return UTType(filenameExtension: ext.lowercased())?.conforms(to: .image) == true
    }

    static func thumbnail(at url: URL, maxPixels: Int) -> CGImage? {
        guard maxPixels > 0, url.isFileURL, (try? url.resourceValues(forKeys: [.isRegularFileKey]).isRegularFile) == true,
              let source = CGImageSourceCreateWithURL(url as CFURL, [kCGImageSourceShouldCache: false] as CFDictionary),
              let identifier = CGImageSourceGetType(source), UTType(identifier as String)?.conforms(to: .image) == true else { return nil }
        let options: [CFString: Any] = [
            kCGImageSourceCreateThumbnailFromImageAlways: true,
            kCGImageSourceThumbnailMaxPixelSize: maxPixels,
            kCGImageSourceCreateThumbnailWithTransform: true,
            kCGImageSourceShouldCacheImmediately: true
        ]
        return CGImageSourceCreateThumbnailAtIndex(source, CGImageSourceGetPrimaryImageIndex(source), options as CFDictionary)
    }

    static func load(path: String, maxPixels: Int) -> ClipboardFilePreview? {
        let url = URL(fileURLWithPath: path, isDirectory: false)
        guard let values = try? url.resourceValues(forKeys: [.isRegularFileKey, .contentModificationDateKey, .fileSizeKey]) else { return nil }
        let wantsThumbnail = values.isRegularFile == true && isImageCandidate(path)
        // 同一历史记录可能指向已替换的图片，按文件版本与目标像素尺寸分别缓存。
        let modified = values.contentModificationDate?.timeIntervalSinceReferenceDate.bitPattern ?? 0
        let key = "\(modified)/\(values.fileSize ?? -1)/\(wantsThumbnail ? maxPixels : 0)/\(path)" as NSString
        if let existing = cache.object(forKey: key) { return existing }
        let preview: ClipboardFilePreview
        let cost: Int
        if wantsThumbnail, let bitmap = thumbnail(at: url, maxPixels: maxPixels) {
            let size = NSSize(width: bitmap.width, height: bitmap.height)
            preview = ClipboardFilePreview(image: NSImage(cgImage: bitmap, size: size), isThumbnail: true)
            cost = bitmap.bytesPerRow * bitmap.height
        } else {
            preview = ClipboardFilePreview(image: NSWorkspace.shared.icon(forFile: path), isThumbnail: false)
            cost = 0
        }
        cache.setObject(preview, forKey: key, cost: cost)
        return preview
    }
}
