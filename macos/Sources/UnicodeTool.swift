import AppKit

struct UnicodeIssue: Error {
    let position: Int
    let message: String
}

enum UnicodeCodec {
    static func encode(_ text: String) -> String {
        var result = ""
        for scalar in text.unicodeScalars {
            let value = scalar.value
            switch value {
            case 0x5C: result += "\\\\"
            case 0x0A: result += "\\n"
            case 0x0D: result += "\\r"
            case 0x09: result += "\\t"
            case 0x08: result += "\\b"
            case 0x0C: result += "\\f"
            case 0x20...0x7E: result.append(String(scalar))
            case 0...0xFFFF: result += String(format: "\\u%04X", value)
            default:
                let code = value - 0x10000
                result += String(format: "\\u%04X\\u%04X", 0xD800 + (code >> 10), 0xDC00 + (code & 0x3FF))
            }
        }
        return result
    }

    static func decode(_ text: String) throws -> String {
        let chars = Array(text.unicodeScalars)
        var index = 0
        var result = ""
        func hex(_ value: Unicode.Scalar) -> UInt32? {
            switch value.value {
            case 48...57: return value.value - 48
            case 65...70: return value.value - 55
            case 97...102: return value.value - 87
            default: return nil
            }
        }
        func fourDigits() throws -> UInt32 {
            var value: UInt32 = 0
            for _ in 0..<4 {
                guard index < chars.count, let digit = hex(chars[index]) else {
                    throw UnicodeIssue(position: index + 1, message: "\\u 后需要四位十六进制数字")
                }
                value = value * 16 + digit
                index += 1
            }
            return value
        }
        while index < chars.count {
            let scalar = chars[index]
            guard scalar == "\\" else {
                result.append(String(scalar))
                index += 1
                continue
            }
            let slashPosition = index + 1
            index += 1
            guard index < chars.count else { throw UnicodeIssue(position: slashPosition, message: "反斜杠后缺少转义字符") }
            let code = chars[index]
            index += 1
            switch code {
            case "u":
                let value: UInt32
                if index < chars.count, chars[index] == "{" {
                    index += 1
                    let begin = index
                    var parsed: UInt32 = 0
                    while index < chars.count, let digit = hex(chars[index]), index - begin < 6 {
                        parsed = parsed * 16 + digit
                        index += 1
                    }
                    guard index > begin, index < chars.count, chars[index] == "}" else {
                        throw UnicodeIssue(position: slashPosition, message: "\\u{...} 需要 1–6 位十六进制数字和右花括号")
                    }
                    index += 1
                    value = parsed
                } else {
                    value = try fourDigits()
                }
                var scalarValue = value
                if (0xD800...0xDBFF).contains(value) {
                    guard index + 1 < chars.count, chars[index] == "\\", chars[index + 1] == "u" else {
                        throw UnicodeIssue(position: slashPosition, message: "高位代理项后缺少低位代理项")
                    }
                    index += 2
                    let low = try fourDigits()
                    guard (0xDC00...0xDFFF).contains(low) else {
                        throw UnicodeIssue(position: slashPosition, message: "低位代理项无效")
                    }
                    scalarValue = 0x10000 + (value - 0xD800) * 0x400 + (low - 0xDC00)
                }
                guard !(0xDC00...0xDFFF).contains(scalarValue),
                      let decoded = Unicode.Scalar(scalarValue) else {
                    throw UnicodeIssue(position: slashPosition, message: "Unicode 码点无效")
                }
                result.append(String(decoded))
            case "n": result.append("\n")
            case "r": result.append("\r")
            case "t": result.append("\t")
            case "b": result.append("\u{8}")
            case "f": result.append("\u{C}")
            case "\\": result.append("\\")
            case "\"": result.append("\"")
            case "/": result.append("/")
            default: result += "\\" + String(code)
            }
        }
        return result
    }
}

final class UnicodeToolWindow: NSObject, NSTextViewDelegate {
    private var window: NSWindow?
    private var input: NSTextView!
    private var output: NSTextView!
    private var selectedDirection = 0
    private var directionButtons: [NSButton] = []
    private var status: NSTextField!
    private var panes: [ToolPane] = []
    private var resultActions: [NSButton] = []
    private var converted = false

    func show(_ initial: String = "", decode: Bool? = nil) {
        if window == nil { build() }
        if let decode { selectedDirection = decode ? 1 : 0 }
        if !initial.isEmpty {
            input.string = initial
            if decode == nil { selectedDirection = initial.contains("\\u") ? 1 : 0 }
        }
        updateDirectionButtons()
        update()
        WindowChrome.present(window)
        WindowChrome.activate()
        window?.makeFirstResponder(input)
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 800, height: 380),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        WindowChrome.apply(w, title: "文本 ↔ Unicode 转义")
        w.minSize = NSSize(width: 720, height: 380)
        w.center()
        let root = NSView(frame: w.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.autoresizingMask = [.width, .height]
        w.contentView = root
        for (index, title) in ["编码 → Unicode", "解码 → 文本"].enumerated() {
            let mode = NSButton(title: title, target: self, action: #selector(changeDirection(_:)))
            mode.tag = index
            mode.frame = NSRect(x: 24 + CGFloat(index) * 144, y: 295, width: 140, height: 28)
            mode.autoresizingMask = [.minYMargin]
            WindowChrome.styleToolMode(mode, active: index == 0)
            root.addSubview(mode)
            directionButtons.append(mode)
        }
        let split = QuietSplitView(frame: NSRect(x: 20, y: 58, width: 760, height: 225))
        split.isVertical = true
        split.dividerStyle = .thin
        split.autoresizingMask = [.width, .height]
        split.wantsLayer = true
        split.layer?.cornerRadius = 10
        split.layer?.borderWidth = 0.5
        split.layer?.borderColor = OpenAllTheme.rule.cgColor
        split.layer?.backgroundColor = OpenAllTheme.sidebar.cgColor
        split.layer?.masksToBounds = true
        root.addSubview(split)
        input = makePane(title: "输入", width: 378, editable: true, split: split)
        input.delegate = self
        input.string = "你好，OpenAll 👋"
        output = makePane(title: "结果", width: 378, editable: false, split: split)
        split.adjustSubviews()
        status = NSTextField(labelWithString: "")
        status.font = .systemFont(ofSize: 12)
        status.textColor = OpenAllTheme.muted
        status.frame = NSRect(x: 24, y: 20, width: 590, height: 22)
        status.autoresizingMask = [.maxYMargin, .width]
        root.addSubview(status)
        WindowChrome.installControls(on: w)
        window = w
        update()
    }

    private func makePane(title: String, width: CGFloat, editable: Bool, split: NSSplitView) -> NSTextView {
        let scroll = editor(frame: NSRect(x: 0, y: 0, width: width, height: 201), editable: editable)
        scroll.autoresizingMask = [.width, .height]
        scroll.layer?.cornerRadius = 0
        scroll.layer?.borderWidth = 0
        var actions: [NSButton] = []
        if !editable {
            let fill = NSButton(title: "填回输入", target: self, action: #selector(swapContents))
            fill.frame.size.width = 78
            fill.toolTip = "将转换结果放入输入区并切换方向"
            WindowChrome.styleOutputAction(fill)
            fill.contentTintColor = OpenAllTheme.muted
            let copy = NSButton(title: "复制结果", target: self, action: #selector(copyResult))
            copy.frame.size.width = 82
            WindowChrome.styleOutputAction(copy)
            actions = [fill, copy]
            resultActions = actions
        }
        let pane = ToolPane(title: title, content: scroll, actions: actions, size: NSSize(width: width, height: 225))
        panes.append(pane)
        split.addSubview(pane)
        return scroll.documentView as! NSTextView
    }

    private func editor(frame: NSRect, editable: Bool) -> NSScrollView {
        let scroll = NSScrollView(frame: frame)
        scroll.hasVerticalScroller = true
        scroll.hasHorizontalScroller = false
        scroll.borderType = .noBorder
        let text = NSTextView(frame: scroll.bounds)
        text.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        WindowChrome.styleEditor(scroll, text: text)
        text.isEditable = editable
        text.isSelectable = true
        text.textContainerInset = NSSize(width: 12, height: 12)
        text.isVerticallyResizable = true
        text.isHorizontallyResizable = false
        text.textContainer?.widthTracksTextView = true
        text.textContainer?.lineBreakMode = .byCharWrapping
        text.autoresizingMask = [.width]
        scroll.documentView = text
        return scroll
    }

    func textDidChange(_ notification: Notification) {
        if notification.object as? NSTextView === input { update() }
    }

    private func updateDirectionButtons() {
        for button in directionButtons {
            let active = button.tag == selectedDirection
            WindowChrome.styleToolMode(button, active: active)
            button.setAccessibilityValue(active)
        }
    }

    @objc private func changeDirection(_ sender: NSButton) {
        selectedDirection = sender.tag
        updateDirectionButtons()
        update()
    }
    @objc private func swapContents() {
        guard converted else { return }
        input.string = output.string
        selectedDirection = selectedDirection == 0 ? 1 : 0
        updateDirectionButtons()
        update()
        window?.makeFirstResponder(input)
    }
    @objc private func copyResult() {
        guard converted else { return }
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(output.string, forType: .string)
        status.stringValue = "已复制转换结果"
    }
    private func update() {
        guard input != nil, output != nil else { return }
        let titles = selectedDirection == 0 ? ["原文", "Unicode 转义"] : ["Unicode 转义", "解码文本"]
        for (pane, title) in zip(panes, titles) { pane.setTitle(title) }
        input.setAccessibilityLabel(titles[0])
        output.setAccessibilityLabel(titles[1])
        defer {
            for action in resultActions { action.isEnabled = converted && !output.string.isEmpty }
        }
        if input.string.isEmpty {
            converted = false
            output.string = ""
            status.stringValue = selectedDirection == 0 ? "输入文本后自动编码" : "输入 Unicode 转义后自动解码"
            status.textColor = OpenAllTheme.muted
            return
        }
        if selectedDirection == 0 {
            output.string = UnicodeCodec.encode(input.string)
            converted = true
            status.stringValue = "已将非 ASCII 字符转换为 Unicode 转义"
            status.textColor = OpenAllTheme.muted
        } else {
            do {
                output.string = try UnicodeCodec.decode(input.string)
                converted = true
                status.stringValue = "已还原 Unicode 转义"
                status.textColor = OpenAllTheme.muted
            } catch let issue as UnicodeIssue {
                output.string = ""
                converted = false
                status.stringValue = "第 \(issue.position) 个字符：\(issue.message)"
                status.textColor = .systemOrange
            } catch {
                output.string = ""
                converted = false
                status.stringValue = "转换失败"
                status.textColor = .systemOrange
            }
        }
    }
}
