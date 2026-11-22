import AppKit
import ImageIO
import UniformTypeIdentifiers
import CoreImage

enum ImageOutputFormat: Int, CaseIterable {
    case png, jpeg, heic, tiff
    var title: String {
        switch self { case .png: return "PNG"; case .jpeg: return "JPEG"; case .heic: return "HEIC"; case .tiff: return "TIFF" }
    }
    var type: UTType {
        switch self { case .png: return .png; case .jpeg: return .jpeg; case .heic: return .heic; case .tiff: return .tiff }
    }
    var fileExtension: String { title.lowercased() == "jpeg" ? "jpg" : title.lowercased() }
}

enum ImageProcessor {
    static func proportionalDimension(_ value: Int, sourceDimension: CGFloat, targetDimension: CGFloat) -> Int? {
        guard (1...12_000).contains(value), sourceDimension.isFinite, targetDimension.isFinite,
              sourceDimension > 0, targetDimension > 0 else { return nil }
        let scaled = (CGFloat(value) * targetDimension / sourceDimension).rounded()
        guard scaled.isFinite else { return nil }
        let bounded = max(1, scaled)
        guard bounded <= 12_000 else { return nil }
        return Int(exactly: bounded)
    }

    static func transformed(_ image: NSImage, pixelSize: NSSize, crop: CGRect? = nil, rotateRight: Bool? = nil) -> NSImage? {
        let size = pixelSize
        guard let data = render(image: image, sourceData: nil, width: Int(size.width), height: Int(size.height),
                                format: .png, quality: 1, removeMetadata: true),
              let source = CGImageSourceCreateWithData(data as CFData, nil),
              let original = CGImageSourceCreateImageAtIndex(source, 0, nil) else { return nil }
        let output: CGImage
        if let crop {
            guard let cropped = original.cropping(to: crop) else { return nil }
            output = cropped
        } else if let rotateRight {
            let oriented = CIImage(cgImage: original).oriented(forExifOrientation: rotateRight ? 6 : 8)
            guard let rotated = CIContext().createCGImage(oriented, from: oriented.extent) else { return nil }
            output = rotated
        } else { output = original }
        return NSImage(cgImage: output, size: NSSize(width: output.width, height: output.height))
    }

    static func paddedPNG(_ data: Data, targetBytes: Int) -> Data? {
        let signature = Data([137, 80, 78, 71, 13, 10, 26, 10])
        guard data.starts(with: signature), targetBytes >= data.count,
              targetBytes <= 100_000_000 else { return nil }
        if targetBytes == data.count { return data }
        let minimum = 12 + 14
        guard targetBytes - data.count >= minimum else { return nil }
        var offset = 8
        while offset + 12 <= data.count {
            let length = data[offset..<offset + 4].reduce(0) { ($0 << 8) | Int($1) }
            guard length <= data.count - offset - 12 else { return nil }
            let kind = data[(offset + 4)..<(offset + 8)]
            if kind.elementsEqual([73, 69, 78, 68]) {
                let payloadSize = targetBytes - data.count - 12
                var payload = Data("OpenAllPadding".utf8)
                payload.append(0)
                payload.append(Data(repeating: 0, count: payloadSize - payload.count))
                var result = Data(data.prefix(offset))
                appendUInt32(UInt32(payload.count), to: &result)
                let chunk = Data([111, 112, 65, 100]) + payload
                result.append(chunk)
                appendUInt32(crc32(chunk), to: &result)
                result.append(data.suffix(from: offset))
                return result.count == targetBytes ? result : nil
            }
            offset += length + 12
        }
        return nil
    }

    private static func appendUInt32(_ value: UInt32, to data: inout Data) {
        data.append(contentsOf: [UInt8((value >> 24) & 255), UInt8((value >> 16) & 255),
                                 UInt8((value >> 8) & 255), UInt8(value & 255)])
    }

    private static func crc32(_ data: Data) -> UInt32 {
        var crc: UInt32 = 0xffffffff
        for byte in data {
            crc ^= UInt32(byte)
            for _ in 0..<8 { crc = (crc >> 1) ^ ((crc & 1) == 1 ? 0xedb88320 : 0) }
        }
        return crc ^ 0xffffffff
    }

    static func render(image: NSImage, sourceData: Data?, width: Int, height: Int,
                       format: ImageOutputFormat, quality: CGFloat, removeMetadata: Bool) -> Data? {
        guard width > 0, height > 0, width <= 12_000, height <= 12_000,
              width * height <= 80_000_000,
              let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width, pixelsHigh: height,
                                            bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
                                            isPlanar: false, colorSpaceName: .deviceRGB,
                                            bytesPerRow: 0, bitsPerPixel: 0),
              let context = NSGraphicsContext(bitmapImageRep: bitmap) else { return nil }
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = context
        if format == .jpeg {
            NSColor.white.setFill()
            NSRect(x: 0, y: 0, width: width, height: height).fill()
        }
        image.draw(in: NSRect(x: 0, y: 0, width: width, height: height),
                   from: .zero, operation: .sourceOver, fraction: 1)
        context.flushGraphics()
        NSGraphicsContext.restoreGraphicsState()
        guard let cgImage = bitmap.cgImage else { return nil }
        let result = NSMutableData()
        guard let destination = CGImageDestinationCreateWithData(result, format.type.identifier as CFString, 1, nil) else { return nil }
        var properties: [CFString: Any] = [:]
        if !removeMetadata, let sourceData,
           let source = CGImageSourceCreateWithData(sourceData as CFData, nil),
           let original = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any] {
            for key in [kCGImagePropertyExifDictionary, kCGImagePropertyTIFFDictionary,
                        kCGImagePropertyIPTCDictionary, kCGImagePropertyGPSDictionary] {
                if let value = original[key] { properties[key] = value }
            }
            // 图像已经按当前方向绘制，不能沿用原文件的旋转标记或像素尺寸。
            if var exif = properties[kCGImagePropertyExifDictionary] as? [CFString: Any] {
                exif[kCGImagePropertyExifPixelXDimension] = width
                exif[kCGImagePropertyExifPixelYDimension] = height
                properties[kCGImagePropertyExifDictionary] = exif
            }
            if var tiff = properties[kCGImagePropertyTIFFDictionary] as? [CFString: Any] {
                tiff[kCGImagePropertyTIFFOrientation] = 1
                properties[kCGImagePropertyTIFFDictionary] = tiff
            }
            properties[kCGImagePropertyOrientation] = 1
        }
        if format == .jpeg || format == .heic {
            properties[kCGImageDestinationLossyCompressionQuality] = max(0.05, min(1, quality))
        }
        CGImageDestinationAddImage(destination, cgImage, properties as CFDictionary)
        guard CGImageDestinationFinalize(destination) else { return nil }
        return result as Data
    }
}

final class ImagePreviewCanvas: NSView {
    var imageSize = NSSize.zero { didSet { needsDisplay = true } }

    override func draw(_ dirtyRect: NSRect) {
        let background = OpenAllTheme.canvas.blended(withFraction: 0.16,
            of: OpenAllTheme.isLight ? .white : .black) ?? OpenAllTheme.canvas
        background.setFill()
        bounds.fill()
        guard imageSize.width > 0, imageSize.height > 0,
              imageSize.width.isFinite, imageSize.height.isFinite else { return }
        // 棋盘格只覆盖图片实际占据的区域，不延伸到预览留白。
        let available = bounds.insetBy(dx: 12, dy: 12)
        let scale = min(available.width / imageSize.width, available.height / imageSize.height)
        let fitted = NSSize(width: imageSize.width * scale, height: imageSize.height * scale)
        let imageRect = NSRect(x: available.midX - fitted.width / 2,
                               y: available.midY - fitted.height / 2,
                               width: fitted.width, height: fitted.height)
        NSGraphicsContext.saveGraphicsState()
        NSBezierPath(rect: imageRect).addClip()
        let size: CGFloat = 12
        let columns = Int(ceil(imageRect.width / size))
        let rows = Int(ceil(imageRect.height / size))
        for row in 0..<rows {
            for column in 0..<columns where (row + column).isMultiple(of: 2) {
                OpenAllTheme.ink.withAlphaComponent(0.11).setFill()
                NSRect(x: imageRect.minX + CGFloat(column) * size,
                       y: imageRect.minY + CGFloat(row) * size, width: size, height: size).fill()
            }
        }
        NSGraphicsContext.restoreGraphicsState()
    }
}

private final class ImageCropSheet: NSPanel {
    @objc func applyCrop() { sheetParent?.endSheet(self, returnCode: .OK) }
    override func cancelOperation(_ sender: Any?) { sheetParent?.endSheet(self, returnCode: .cancel) }
}

private final class ImageCropGuide: NSView, NSTextFieldDelegate {
    var updateFromFields: (() -> Void)?
    func controlTextDidChange(_ notification: Notification) { updateFromFields?() }

    let source: NSImage
    let pixels: NSSize
    var selection: NSRect { didSet { needsDisplay = true } }
    var didSelect: ((NSRect) -> Void)?
    private var start: NSPoint?
    private var imageRect: NSRect {
        let space = bounds.insetBy(dx: 7, dy: 7)
        let scale = min(space.width / pixels.width, space.height / pixels.height)
        let size = NSSize(width: pixels.width * scale, height: pixels.height * scale)
        return NSRect(x: bounds.midX - size.width / 2, y: bounds.midY - size.height / 2, width: size.width, height: size.height)
    }
    private func pixel(_ point: NSPoint) -> NSPoint {
        NSPoint(x: min(pixels.width, max(0, ((point.x - imageRect.minX) / imageRect.width * pixels.width).rounded())),
                y: min(pixels.height, max(0, ((point.y - imageRect.minY) / imageRect.height * pixels.height).rounded())))
    }
    override func resetCursorRects() { addCursorRect(imageRect, cursor: .crosshair) }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        start = imageRect.contains(point) ? pixel(point) : nil
    }
    override func mouseDragged(with event: NSEvent) {
        guard let start else { return }
        let end = pixel(convert(event.locationInWindow, from: nil))
        let rect = NSRect(x: min(start.x, end.x), y: min(start.y, end.y), width: abs(end.x - start.x), height: abs(end.y - start.y))
        guard !rect.isEmpty else { return }
        selection = rect
        didSelect?(rect)
    }
    override func mouseUp(with event: NSEvent) { mouseDragged(with: event); start = nil }
    func verifyDragForDesign(region: NSRect) -> Bool {
        guard DesignPreview.enabled, let window else { return false }
        let scale = imageRect.width / pixels.width
        func event(_ type: NSEvent.EventType, _ x: CGFloat, _ y: CGFloat) -> NSEvent? {
            let location = convert(NSPoint(x: imageRect.minX + x * scale, y: imageRect.minY + y * scale), to: nil)
            return NSEvent.mouseEvent(with: type, location: location, modifierFlags: [], timestamp: 0,
                                      windowNumber: window.windowNumber, context: nil, eventNumber: 0, clickCount: 1, pressure: 1)
        }
        guard let down = event(.leftMouseDown, region.minX, region.minY),
              let moved = event(.leftMouseDragged, region.maxX, region.maxY),
              let up = event(.leftMouseUp, region.maxX, region.maxY) else { return false }
        mouseDown(with: down); mouseDragged(with: moved); mouseUp(with: up)
        return true
    }

    init(frame: NSRect, source: NSImage, pixels: NSSize) {
        self.source = source
        self.pixels = pixels
        self.selection = NSRect(origin: .zero, size: pixels)
        super.init(frame: frame)
    }
    required init?(coder: NSCoder) { nil }
    override var isFlipped: Bool { true }

    override func draw(_ dirtyRect: NSRect) {
        OpenAllTheme.canvas.setFill()
        bounds.fill()
        let scale = imageRect.width / pixels.width
        source.draw(in: imageRect, from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
        guard !selection.isEmpty else { return }
        let region = NSRect(x: imageRect.minX + selection.minX * scale, y: imageRect.minY + selection.minY * scale,
                            width: selection.width * scale, height: selection.height * scale).intersection(imageRect)
        guard !region.isEmpty else { return }
        let shade = NSBezierPath(rect: imageRect)
        shade.appendRect(region)
        shade.windingRule = .evenOdd
        NSColor.black.withAlphaComponent(0.52).setFill()
        shade.fill()
        let stroke = NSBezierPath(rect: region)
        stroke.lineWidth = 2
        OpenAllTheme.accent.setStroke()
        stroke.stroke()
    }
}

final class ImageToolWindow: NSObject, NSTextFieldDelegate {
    private var window: NSWindow?
    private var preview: NSImageView!
    private var previewCanvas: ImagePreviewCanvas!
    private var previewHint: NSButton?
    private var previewCaption: NSTextField?
    private var previewScale: NSTextField?
    private var verifyCrop: (() throws -> Void)?
    private var chooseButton: NSButton?
    private var width: NSTextField!
    private var height: NSTextField!
    private var format: NSPopUpButton!
    private var quality: NSSlider!
    private var qualityLabel: NSTextField!
    private var metadata: NSButton!
    private var ratio: NSButton!
    private var status: NSTextField!
    private var summaryFields: [NSTextField] = []
    private var outputSizeValue: NSTextField!
    private var originalSizeValue: NSTextField!
    private var sizeDifference: NSTextField!
    private var targetSize: NSTextField!
    private var targetLabel: NSTextField!
    private var advancedButton: NSPopUpButton!
    private var sourceImage: NSImage?
    private var metadataSourceData: Data?
    private var sourceURL: URL?
    private var sourceSize = NSSize.zero
    private var outputData: Data?
    private var pending: DispatchWorkItem?
    private var editingDimensions = false
    private var copyButton: NSButton?
    private var saveButton: NSButton?
    private var transformButtons: [NSButton] = []

    func show(_ image: NSImage? = nil, url: URL? = nil) {
        if window == nil { build() }
        if let url { load(url: url) }
        else if let image { load(image: image, data: image.tiffRepresentation, url: nil) }
        else if sourceImage == nil, let pasted = NSImage(pasteboard: .general) {
            load(image: pasted, data: pasted.tiffRepresentation, url: nil)
        }
        WindowChrome.present(window)
        WindowChrome.activate()
    }

    private func build() {
        let panel = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 900, height: 540),
                             styleMask: [.titled, .closable], backing: .buffered, defer: false)
        WindowChrome.apply(panel, title: "图片处理")
        panel.isReleasedWhenClosed = false
        panel.center()
        let root = NSView(frame: panel.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.appearance = OpenAllTheme.appearance
        panel.contentView = root

        // 预览直接占据工作区；设置和导出固定在右侧，避免多层卡片抢占画面。
        previewCanvas = ImagePreviewCanvas(frame: NSRect(x: 24, y: 88, width: 552, height: 358))
        previewCanvas.wantsLayer = true
        previewCanvas.layer?.backgroundColor = (OpenAllTheme.canvas.blended(withFraction: 0.16,
            of: OpenAllTheme.isLight ? .white : .black) ?? OpenAllTheme.canvas).cgColor
        previewCanvas.layer?.cornerRadius = 6
        previewCanvas.layer?.masksToBounds = true
        root.addSubview(previewCanvas)
        preview = NSImageView(frame: NSRect(x: 36, y: 100, width: 528, height: 334))
        preview.imageScaling = .scaleProportionallyUpOrDown
        root.addSubview(preview)
        let empty = NSButton(title: "选择图片…", target: self, action: #selector(chooseImage))
        empty.frame = NSRect(x: 238, y: 251, width: 124, height: 32)
        WindowChrome.styleAction(empty)
        empty.image = NSImage(systemSymbolName: "photo", accessibilityDescription: nil)
        empty.imagePosition = .imageLeading
        root.addSubview(empty)
        previewHint = empty

        let choose = NSButton(title: "选择图片…", target: self, action: #selector(chooseImage))
        choose.frame = NSRect(x: 24, y: 462, width: 112, height: 28)
        WindowChrome.styleAction(choose)
        choose.layer?.backgroundColor = NSColor.clear.cgColor
        choose.layer?.borderWidth = 0
        choose.image = NSImage(systemSymbolName: "photo", accessibilityDescription: "选择图片")
        choose.imagePosition = .imageLeading
        choose.font = .systemFont(ofSize: 12)
        root.addSubview(choose)
        choose.isHidden = true
        chooseButton = choose
        for (title, symbol, x, buttonWidth, action) in [
            ("裁剪", "crop", 366.0, 68.0, #selector(cropImage)),
            ("左转", "rotate.left", 438.0, 62.0, #selector(rotateLeft)),
            ("右转", "rotate.right", 506.0, 62.0, #selector(rotateRight))
        ] {
            let button = NSButton(title: title, target: self, action: action)
            button.frame = NSRect(x: x, y: 462, width: buttonWidth, height: 28)
            WindowChrome.styleAction(button)
            button.layer?.backgroundColor = NSColor.clear.cgColor
            button.layer?.borderWidth = 0
            button.font = .systemFont(ofSize: 12)
            button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
            button.imagePosition = .imageLeading
            if title != "裁剪" { button.toolTip = "向\(title == "左转" ? "左" : "右")旋转 90°" }
            root.addSubview(button)
            transformButtons.append(button)
        }
        let hint = NSTextField(labelWithString: "选择图片或直接打开剪贴板图片")
        hint.textColor = OpenAllTheme.muted
        hint.font = .systemFont(ofSize: 12)
        hint.lineBreakMode = .byTruncatingMiddle
        hint.frame = NSRect(x: 24, y: 65, width: 350, height: 18)
        root.addSubview(hint)
        previewCaption = hint
        let scale = NSTextField(labelWithString: "")
        scale.font = .monospacedDigitSystemFont(ofSize: 11, weight: .regular)
        scale.textColor = OpenAllTheme.muted
        scale.alignment = .right
        scale.frame = NSRect(x: 384, y: 65, width: 192, height: 18)
        root.addSubview(scale)
        previewScale = scale

        let sidebar = NSView(frame: NSRect(x: 600, y: 0, width: 300, height: 506))
        sidebar.wantsLayer = true
        sidebar.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        root.addSubview(sidebar)
        let divider = NSView(frame: NSRect(x: 600, y: 0, width: 1, height: 506))
        divider.wantsLayer = true
        divider.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        root.addSubview(divider)
        for (name, y) in [("尺寸", 468.0), ("格式", 338.0)] {
            let section = NSTextField(labelWithString: name)
            section.frame = NSRect(x: 624, y: y, width: 160, height: 20)
            section.font = .systemFont(ofSize: 12, weight: .medium)
            section.textColor = OpenAllTheme.ink
            root.addSubview(section)
        }
        let unit = NSTextField(labelWithString: "像素")
        unit.frame = NSRect(x: 826, y: 468, width: 50, height: 18)
        unit.font = .systemFont(ofSize: 12)
        unit.textColor = OpenAllTheme.muted
        unit.alignment = .right
        root.addSubview(unit)
        for (name, x) in [("宽", 624.0), ("高", 758.0)] {
            let label = NSTextField(labelWithString: name)
            label.frame = NSRect(x: x, y: 441, width: 118, height: 16)
            label.font = .systemFont(ofSize: 12)
            label.textColor = OpenAllTheme.muted
            root.addSubview(label)
        }
        width = NSTextField(frame: NSRect(x: 624, y: 407, width: 118, height: 30))
        width.delegate = self
        WindowChrome.styleInput(width)
        root.addSubview(width)
        height = NSTextField(frame: NSRect(x: 758, y: 407, width: 118, height: 30))
        height.delegate = self
        WindowChrome.styleInput(height)
        root.addSubview(height)
        ratio = WindowChrome.checkbox("保持宽高比", target: self, action: #selector(settingsChanged))
        ratio.state = .on
        ratio.font = .systemFont(ofSize: 12)
        ratio.frame = NSRect(x: 624, y: 374, width: 252, height: 24)
        root.addSubview(ratio)

        format = NSPopUpButton(frame: NSRect(x: 624, y: 300, width: 252, height: 30))
        WindowChrome.stylePopUp(format)
        format.font = .systemFont(ofSize: 13)
        for choice in ImageOutputFormat.allCases { format.addItem(withTitle: choice.title) }
        format.target = self
        format.action = #selector(settingsChanged)
        root.addSubview(format)
        qualityLabel = NSTextField(labelWithString: "压缩质量 80%")
        qualityLabel.frame = NSRect(x: 624, y: 262, width: 252, height: 18)
        qualityLabel.font = .systemFont(ofSize: 12, weight: .medium)
        qualityLabel.textColor = OpenAllTheme.ink
        root.addSubview(qualityLabel)
        quality = NSSlider(value: 0.8, minValue: 0.1, maxValue: 1, target: self, action: #selector(settingsChanged))
        quality.trackFillColor = OpenAllTheme.accent
        quality.frame = NSRect(x: 624, y: 224, width: 252, height: 30)
        root.addSubview(quality)
        metadata = WindowChrome.checkbox("移除图片元数据", target: self, action: #selector(settingsChanged))
        metadata.state = .on
        metadata.font = .systemFont(ofSize: 12)
        metadata.frame = NSRect(x: 624, y: 188, width: 252, height: 24)
        root.addSubview(metadata)
        targetLabel = NSTextField(labelWithString: "目标体积")
        targetLabel.frame = NSRect(x: 624, y: 262, width: 252, height: 20)
        targetLabel.font = .systemFont(ofSize: 12, weight: .medium)
        targetLabel.textColor = OpenAllTheme.ink
        root.addSubview(targetLabel)
        targetSize = NSTextField(frame: .zero)
        targetSize.isHidden = true
        targetSize.delegate = self
        advancedButton = NSPopUpButton(frame: NSRect(x: 624, y: 224, width: 252, height: 30))
        WindowChrome.stylePopUp(advancedButton)
        advancedButton.font = .systemFont(ofSize: 13)
        advancedButton.target = self
        advancedButton.action = #selector(targetSizeChanged)
        advancedButton.menu?.autoenablesItems = false
        root.addSubview(advancedButton)

        let exportRule = NSView(frame: NSRect(x: 624, y: 180, width: 252, height: 1))
        exportRule.wantsLayer = true
        exportRule.layer?.backgroundColor = OpenAllTheme.rule.cgColor
        root.addSubview(exportRule)
        func metric(_ text: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat,
                    size: CGFloat = 12, prominent: Bool = false, right: Bool = false) -> NSTextField {
            let field = NSTextField(labelWithString: text)
            field.frame = NSRect(x: x, y: y, width: width, height: height)
            field.font = .monospacedDigitSystemFont(ofSize: size, weight: prominent ? .semibold : .regular)
            field.textColor = prominent ? OpenAllTheme.ink : OpenAllTheme.muted
            field.alignment = right ? .right : .left
            field.lineBreakMode = .byTruncatingTail
            field.isHidden = true
            root.addSubview(field)
            summaryFields.append(field)
            return field
        }
        _ = metric("导出大小", x: 624, y: 148, width: 70, height: 19)
        outputSizeValue = metric("", x: 695, y: 143, width: 181, height: 30, size: 19, prominent: true, right: true)
        _ = metric("原图大小", x: 624, y: 124, width: 70, height: 19)
        originalSizeValue = metric("", x: 695, y: 124, width: 181, height: 19, size: 13, right: true)
        sizeDifference = metric("", x: 624, y: 98, width: 252, height: 19, right: true)
        status = NSTextField(wrappingLabelWithString: "处理结果将在此显示")
        status.textColor = OpenAllTheme.muted
        status.font = .systemFont(ofSize: 12)
        status.frame = NSRect(x: 624, y: 95, width: 252, height: 54)
        root.addSubview(status)
        let copy = NSButton(title: "复制图片", target: self, action: #selector(copyResult))
        copy.frame = NSRect(x: 624, y: 54, width: 104, height: 32)
        WindowChrome.styleAction(copy)
        copy.font = .systemFont(ofSize: 12)
        copy.isEnabled = false
        copyButton = copy
        root.addSubview(copy)
        let save = NSButton(title: "保存文件…", target: self, action: #selector(saveResult))
        save.frame = NSRect(x: 740, y: 54, width: 136, height: 32)
        WindowChrome.styleAction(save, primary: true)
        save.font = .systemFont(ofSize: 12, weight: .medium)
        save.isEnabled = false
        saveButton = save
        root.addSubview(save)
        WindowChrome.installControls(on: panel, compact: true)
        window = panel
        scheduleRender()
    }

    @objc private func chooseImage() {
        let chooser = NSOpenPanel()
        chooser.allowedContentTypes = [.image]
        chooser.allowsMultipleSelection = false
        if chooser.runModal() == .OK, let url = chooser.url { load(url: url) }
    }

    private func load(url: URL) {
        guard let data = try? Data(contentsOf: url), let image = NSImage(data: data) else {
            setStatus("无法打开所选图片")
            return
        }
        load(image: image, data: data, url: url)
    }

    private func load(image: NSImage, data: Data?, url: URL?, preserveMetadata: Bool = false) {
        sourceImage = image
        previewHint?.isHidden = true
        chooseButton?.isHidden = false
        chooseButton?.title = "更换图片…"
        if let chooseButton { chooseButton.font = .systemFont(ofSize: 12) }
        if !preserveMetadata { metadataSourceData = data }
        sourceURL = url
        if let data, let source = CGImageSourceCreateWithData(data as CFData, nil),
           let properties = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [CFString: Any],
           let w = properties[kCGImagePropertyPixelWidth] as? Int,
           let h = properties[kCGImagePropertyPixelHeight] as? Int {
            sourceSize = NSSize(width: w, height: h)
        } else { sourceSize = image.size }
        previewCaption?.stringValue = sourceURL?.lastPathComponent ?? "剪贴板图片 · 保存不会覆盖原图"
        width.stringValue = String(Int(sourceSize.width))
        height.stringValue = String(Int(sourceSize.height))
        scheduleRender()
    }

    @objc private func rotateLeft() { rotate(right: false) }
    @objc private func rotateRight() { rotate(right: true) }
    private func rotate(right: Bool) {
        guard let sourceImage, let changed = ImageProcessor.transformed(sourceImage, pixelSize: sourceSize, rotateRight: right) else { return }
        load(image: changed, data: nil, url: nil, preserveMetadata: true)
        setStatus(right ? "已向右旋转 90°" : "已向左旋转 90°")
    }

    @objc private func cropImage() {
        guard let sourceImage, let parent = window, parent.attachedSheet == nil else { return }
        let bounds = NSRect(x: 0, y: 0, width: 472, height: 374)
        let panel = ImageCropSheet(contentRect: bounds, styleMask: [.titled, .fullSizeContentView], backing: .buffered, defer: false)
        panel.title = "裁剪图片"
        panel.titleVisibility = .hidden
        panel.titlebarAppearsTransparent = true
        panel.appearance = OpenAllTheme.appearance
        let container = NSView(frame: bounds)
        container.wantsLayer = true
        container.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        panel.contentView = container
        let title = NSTextField(labelWithString: "裁剪图片")
        title.font = .systemFont(ofSize: 18, weight: .semibold)
        title.textColor = OpenAllTheme.ink
        title.frame = NSRect(x: 20, y: 332, width: 420, height: 25)
        container.addSubview(title)
        let help = NSTextField(labelWithString: "原图 \(Int(sourceSize.width)) × \(Int(sourceSize.height)) 像素。拖出选区，或从左上角输入坐标。")
        help.font = .systemFont(ofSize: 12)
        help.textColor = OpenAllTheme.muted
        help.frame = NSRect(x: 20, y: 310, width: 432, height: 19)
        container.addSubview(help)
        let guide = ImageCropGuide(frame: NSRect(x: 20, y: 123, width: 432, height: 178), source: sourceImage, pixels: sourceSize)
        container.addSubview(guide)
        let cancel = NSButton(title: "取消", target: panel, action: #selector(NSResponder.cancelOperation(_:)))
        cancel.frame = NSRect(x: 284, y: 14, width: 76, height: 30)
        cancel.keyEquivalent = "\u{1b}"
        WindowChrome.styleAction(cancel)
        container.addSubview(cancel)
        let submit = NSButton(title: "裁剪", target: panel, action: #selector(ImageCropSheet.applyCrop))
        submit.frame = NSRect(x: 370, y: 14, width: 82, height: 30)
        submit.keyEquivalent = "\r"
        WindowChrome.styleAction(submit, primary: true)
        container.addSubview(submit)
        let labels = ["起点 X", "起点 Y", "宽", "高"]
        let maxSize = sourceSize
        let defaults = ["0", "0", String(Int(maxSize.width)), String(Int(maxSize.height))]
        var fields: [NSTextField] = []
        for index in 0..<4 {
            let label = NSTextField(labelWithString: labels[index])
            label.frame = NSRect(x: CGFloat(20 + index * 110), y: 94, width: 100, height: 18)
            label.textColor = OpenAllTheme.muted
            label.font = .systemFont(ofSize: 12, weight: .medium)
            container.addSubview(label)
            let field = NSTextField(frame: NSRect(x: CGFloat(20 + index * 110), y: 61, width: 100, height: 29))
            field.delegate = guide
            field.stringValue = defaults[index]
            field.setAccessibilityLabel(labels[index])
            WindowChrome.styleInput(field)
            container.addSubview(field)
            fields.append(field)
        }
        guide.didSelect = { rect in
            submit.isEnabled = true
            for (field,value) in zip(fields, [rect.minX, rect.minY, rect.width, rect.height]) { field.integerValue = Int(value) }
        }
        let updateGuide = { [weak guide] in
            guard let guide else { return }
            let numbers = fields.compactMap { Int($0.stringValue) }
            guard numbers.count == 4, numbers[0] >= 0, numbers[1] >= 0, numbers[2] > 0, numbers[3] > 0,
                  numbers[0] <= Int(maxSize.width) - numbers[2], numbers[1] <= Int(maxSize.height) - numbers[3] else {
                guide.selection = .zero
                submit.isEnabled = false
                return
            }
            guide.selection = NSRect(x: numbers[0], y: numbers[1], width: numbers[2], height: numbers[3])
            submit.isEnabled = true
        }
        guide.updateFromFields = updateGuide
        panel.initialFirstResponder = fields.first
        if DesignPreview.enabled {
            DesignPreview.lastWindow = panel
            verifyCrop = {
                let region = NSRect(x: 64, y: 45, width: 300, height: 210)
                let selected = guide.verifyDragForDesign(region: region)
                guard selected, zip(fields,[64,45,300,210]).allSatisfy({ abs($0.0.integerValue - $0.1) <= 2 }) else {
                    throw NSError(domain: "CropDragCoordinates", code: 1)
                }
                fields[2].integerValue = 284
                updateGuide()
                guard guide.selection.width == 284, submit.isEnabled else { throw NSError(domain: "CropInputGuide", code: 1) }
            }
            return
        }
        parent.beginSheet(panel) { [weak self] response in
            guard let self, response == .OK, self.sourceImage === sourceImage else { return }
            updateGuide()
            guard submit.isEnabled, let changed = ImageProcessor.transformed(sourceImage, pixelSize: maxSize, crop: guide.selection) else {
                self.setStatus("裁剪区域超出图片范围")
                return
            }
            self.load(image: changed, data: nil, url: nil, preserveMetadata: true)
            self.setStatus("已裁剪为 \(Int(guide.selection.width)) × \(Int(guide.selection.height))")
        }
    }

    func verifyCropForDesign() throws {
        guard DesignPreview.enabled, let verifyCrop else { throw NSError(domain: "MissingCropGuide", code: 1) }
        defer { self.verifyCrop = nil }
        try verifyCrop()
    }

    func controlTextDidChange(_ obj: Notification) {
        guard !editingDimensions, ratio.state == .on, sourceSize.width > 0, sourceSize.height > 0 else {
            scheduleRender(); return
        }
        editingDimensions = true
        if obj.object as? NSTextField === width, let value = Int(width.stringValue) {
            let scaled = ImageProcessor.proportionalDimension(value,
                sourceDimension: sourceSize.width, targetDimension: sourceSize.height)
            height.stringValue = scaled.map(String.init) ?? ""
        } else if obj.object as? NSTextField === height, let value = Int(height.stringValue) {
            let scaled = ImageProcessor.proportionalDimension(value,
                sourceDimension: sourceSize.height, targetDimension: sourceSize.width)
            width.stringValue = scaled.map(String.init) ?? ""
        }
        editingDimensions = false
        scheduleRender()
    }

    private func refreshTargetSizeMenu() {
        let text = targetSize.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        advancedButton.removeAllItems()
        advancedButton.addItem(withTitle: "不限")
        advancedButton.lastItem?.tag = 0
        var selectedTag = 0
        if let value = Double(text), value.isFinite, value > 0, value <= 100 {
            let display = value == value.rounded() ? String(Int(value)) : String(value)
            advancedButton.addItem(withTitle: "\(display) MB")
            advancedButton.lastItem?.tag = 2
            advancedButton.lastItem?.isEnabled = false
            selectedTag = 2
        }
        advancedButton.addItem(withTitle: "自定义…")
        advancedButton.lastItem?.tag = 1
        // 程序设置选择不会发送 action，重建菜单不会递归触发渲染。
        advancedButton.selectItem(withTag: selectedTag)
    }

    @objc private func targetSizeChanged() {
        switch advancedButton.selectedItem?.tag ?? 0 {
        case 0:
            targetSize.stringValue = ""
            scheduleRender()
        case 1:
            toggleAdvanced()
        default:
            refreshTargetSizeMenu()
        }
    }

    private func toggleAdvanced() {
        defer { refreshTargetSizeMenu() }
        let alert = NSAlert()
        alert.messageText = "PNG 目标体积"
        alert.informativeText = "按 MB 补足文件体积，不改变图像内容；最多 100 MB。留空可取消目标体积。"
        let entry = NSTextField(frame: NSRect(x: 0, y: 0, width: 220, height: 26))
        entry.placeholderString = "例如 1"
        entry.stringValue = targetSize.stringValue
        alert.accessoryView = entry
        alert.addButton(withTitle: "应用")
        alert.addButton(withTitle: "取消")
        if alert.runModal() == .alertFirstButtonReturn {
            let proposed = entry.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            if !proposed.isEmpty {
                guard let value = Double(proposed), value.isFinite, value > 0, value <= 100 else {
                    let error = NSAlert()
                    error.messageText = "请输入有效的目标体积"
                    error.informativeText = "请输入大于 0 且不超过 100 的 MB 数值，或留空取消目标体积。"
                    error.runModal()
                    return
                }
            }
            targetSize.stringValue = proposed
            scheduleRender()
        }
    }

    @objc private func settingsChanged() { scheduleRender() }

    private func scheduleRender() {
        pending?.cancel()
        // 设置一旦变化，旧编码结果立即失效，避免保存为新格式的扩展名。
        outputData = nil
        copyButton?.isEnabled = false
        saveButton?.isEnabled = false
        saveButton?.layer?.backgroundColor = OpenAllTheme.raised.withAlphaComponent(0.42).cgColor
        saveButton?.contentTintColor = OpenAllTheme.muted
        if sourceImage != nil { setStatus("正在更新预览…") }
        qualityLabel.stringValue = "压缩质量 \(Int((quality.doubleValue * 100).rounded()))%"
        let compressed = [ImageOutputFormat.jpeg.rawValue, ImageOutputFormat.heic.rawValue].contains(format.indexOfSelectedItem)
        quality.isEnabled = compressed && sourceImage != nil
        quality.isHidden = !compressed
        qualityLabel.isHidden = !compressed
        let loaded = sourceImage != nil
        for button in transformButtons { button.isEnabled = loaded }
        for control: NSControl in [width, height, ratio, format, metadata, targetSize] { control.isEnabled = loaded }
        metadata.frame.origin.y = 188
        let targetText = targetSize.stringValue.trimmingCharacters(in: .whitespaces)
        refreshTargetSizeMenu()
        advancedButton.toolTip = targetText.isEmpty ? "设置 PNG 目标体积，不改变图像内容" : "当前目标体积 \(targetText) MB；点击修改"
        advancedButton.isHidden = format.indexOfSelectedItem != ImageOutputFormat.png.rawValue
        targetLabel.isHidden = advancedButton.isHidden
        advancedButton.isEnabled = loaded
        qualityLabel.textColor = OpenAllTheme.ink
        let job = DispatchWorkItem { [weak self] in self?.render() }
        pending = job
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.18, execute: job)
    }

    private func render() {
        guard let sourceImage else { return }
        guard let w = Int(width.stringValue), let h = Int(height.stringValue), w > 0, h > 0 else {
            setStatus("请输入有效的宽度和高度")
            outputData = nil
            copyButton?.isEnabled = false
            saveButton?.isEnabled = false
            return
        }
        let outputFormat = ImageOutputFormat(rawValue: format.indexOfSelectedItem) ?? .png
        guard let data = ImageProcessor.render(image: sourceImage, sourceData: metadataSourceData, width: w, height: h,
                                               format: outputFormat, quality: CGFloat(quality.doubleValue),
                                               removeMetadata: metadata.state == .on),
              let rendered = NSImage(data: data) else {
            setStatus("生成失败；请检查尺寸或选择其他输出格式")
            outputData = nil
            copyButton?.isEnabled = false
            saveButton?.isEnabled = false
            return
        }
        var finalData = data
        if outputFormat == .png, !targetSize.stringValue.trimmingCharacters(in: .whitespaces).isEmpty {
            guard let mb = Double(targetSize.stringValue), mb > 0,
                  mb <= 100, let bytes = Int(exactly: (mb * 1_000_000).rounded()),
                  let padded = ImageProcessor.paddedPNG(data, targetBytes: bytes) else {
                setStatus("目标体积须大于当前 PNG 文件，且不超过 100 MB")
                outputData = nil
                copyButton?.isEnabled = false
                saveButton?.isEnabled = false
                return
            }
            finalData = padded
        }
        outputData = finalData
        copyButton?.isEnabled = true
        saveButton?.isEnabled = true
        saveButton?.layer?.backgroundColor = OpenAllTheme.accent.cgColor
        saveButton?.contentTintColor = OpenAllTheme.onAccent
        preview.image = rendered
        previewCanvas.imageSize = rendered.size
        let ratio = min(preview.bounds.width / max(1, rendered.size.width), preview.bounds.height / max(1, rendered.size.height))
        previewScale?.stringValue = "适应窗口 · \(Int((ratio * 100).rounded()))%"
        let outputSize = ByteCountFormatter.string(fromByteCount: Int64(finalData.count), countStyle: .file)
        let sourceSize = metadataSourceData?.count
        outputSizeValue.stringValue = outputSize + "  " + outputFormat.title
        outputSizeValue.toolTip = "\(finalData.count) 字节"
        var detail = "\(w) × \(h) 像素"
        originalSizeValue.stringValue = "—"
        originalSizeValue.toolTip = nil
        if let sourceSize, sourceSize > 0 {
            originalSizeValue.stringValue = ByteCountFormatter.string(fromByteCount: Int64(sourceSize), countStyle: .file)
            originalSizeValue.toolTip = "\(sourceSize) 字节"
            let percent = Int((Double(finalData.count - sourceSize) * 100 / Double(sourceSize)).rounded())
            let change = percent == 0 ? "体积相近" : (percent < 0 ? "减小 " : "增大 ") + "\(abs(percent))%"
            detail += " · " + change
        }
        sizeDifference.stringValue = detail
        summaryFields.forEach { $0.isHidden = false }
        status.isHidden = true
    }

    private func setStatus(_ message: String) {
        summaryFields.forEach { $0.isHidden = true }
        status.isHidden = false
        status.attributedStringValue = NSAttributedString(string: message,
            attributes: [.font: NSFont.systemFont(ofSize: 12), .foregroundColor: OpenAllTheme.muted])
    }

    @objc private func copyResult() {
        guard let outputData else { setStatus("请先生成图片"); return }
        let outputFormat = ImageOutputFormat(rawValue: format.indexOfSelectedItem) ?? .png
        let item = NSPasteboardItem()
        item.setData(outputData, forType: NSPasteboard.PasteboardType(outputFormat.type.identifier))
        NSPasteboard.general.clearContents()
        if NSPasteboard.general.writeObjects([item]) { setStatus("图片已复制 · \(outputFormat.title)") }
        else { setStatus("复制失败") }
    }

    @objc private func saveResult() {
        guard let outputData else { setStatus("请先生成图片"); return }
        let outputFormat = ImageOutputFormat(rawValue: format.indexOfSelectedItem) ?? .png
        let chooser = NSSavePanel()
        chooser.allowedContentTypes = [outputFormat.type]
        chooser.nameFieldStringValue = (sourceURL?.deletingPathExtension().lastPathComponent ?? "OpenAll-image") + "." + outputFormat.fileExtension
        guard chooser.runModal() == .OK, let url = chooser.url else { return }
        do {
            try outputData.write(to: url, options: .atomic)
            setStatus("已保存 · \(url.lastPathComponent)")
        } catch { setStatus("保存失败：\(error.localizedDescription)") }
    }
}
