import AppKit
// 独立模型检查只需通过界面类型检查，不创建或显示窗口。
enum OpenAllTheme {
    static var muted: NSColor { .secondaryLabelColor }
    static var canvas: NSColor { .windowBackgroundColor }
    static var rule: NSColor { .separatorColor }
    static var appearance: NSAppearance? { nil }
    static var hasCustomization: Bool { false }
    static var ink: NSColor { .textColor }
    static var accent: NSColor { .controlAccentColor }
    static var accentText: NSColor { .controlAccentColor }
    static var surface: NSColor { .controlBackgroundColor }
    static func hex(_ color: NSColor) -> String { "#000000" }
}
enum WindowChrome {
    static func present(_ window: NSWindow?) {}
    static func activate() {}
    static func apply(_ window: NSWindow, title: String) {}
    static func stylePopUp(_ button: NSPopUpButton) {}
    static func styleInput(_ field: NSTextField) {}
    static func styleAction(_ button: NSButton, primary: Bool) {}
    static func styleOutputAction(_ button: NSButton) {}
    static func styleEditor(_ scroll: NSScrollView, text: NSTextView) {}
    static func installControls(on window: NSWindow) {}
}
enum DesignPreview { static let enabled = false }
