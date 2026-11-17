import Foundation

struct OpenAllCommand {
    let id: String
    let title: String
    let keywords: [String]
    let detail: String
    let symbol: String
}

enum CommandCatalog {
    static func all(settings: LaunchSettings) -> [OpenAllCommand] {
        [OpenAllCommand(id: "translate", title: "翻译", keywords: ["翻译", "translate"],
                        detail: "打开有道翻译 · 输入 翻译 内容", symbol: "character.bubble"),
         OpenAllCommand(id: "comparison", title: "文本对比", keywords: ["文本对比", "文本", "wenben", "diff", "文本对比 V2", "文本对比V2", "对比V2", "diff2", "diff v2"],
                        detail: "左右直接编辑，并在原处查看差异", symbol: "rectangle.split.2x1"),
         OpenAllCommand(id: "json", title: "JSON 工具", keywords: ["json", "json格式化"],
                        detail: "校验、键名自然排序与转义", symbol: "curlybraces"),
         OpenAllCommand(id: "unicode", title: "Unicode 转换", keywords: ["unicode", "中文编码"],
                        detail: "中文与 Unicode 转义互转", symbol: "character.cursor.ibeam"),
         OpenAllCommand(id: "markdown", title: "Markdown 编辑器", keywords: ["mark", "markdown"],
                        detail: "编辑并实时预览 Markdown", symbol: "text.book.closed"),
         OpenAllCommand(id: "id", title: "身份证测试号", keywords: ["身份证", "idgen"],
                        detail: "按地区、生日和性别生成测试号", symbol: "person.text.rectangle"),
         OpenAllCommand(id: "manual", title: "Shell 与 Java 命令手册", keywords: ["命令", "shell", "java", "alias", "alas"],
                        detail: "常用命令与服务器别名示例", symbol: "terminal"),
         OpenAllCommand(id: "image", title: "图片处理", keywords: ["图片快处理", "image"],
                        detail: "调整尺寸、压缩、转换格式和移除元数据", symbol: "photo"),
         OpenAllCommand(id: "converter", title: "开发者转换", keywords: ["转换", "时间单位", "cron", "ascii", "converter"],
                        detail: "时间单位、Cron 表达式与 ASCII 码表", symbol: "arrow.left.arrow.right"),
         OpenAllCommand(id: "configDiff", title: "结构化配置对比", keywords: ["配置对比", "配置差异", "config diff"],
                        detail: "比较 JSON、YAML 和 properties 的键路径", symbol: "square.split.2x1"),
         OpenAllCommand(id: "explain", title: "SQL 执行计划", keywords: ["执行计划", "explain", "sql计划"],
                        detail: "阅读 PostgreSQL 与 MySQL 的 EXPLAIN 结果", symbol: "chart.bar.doc.horizontal"),
         OpenAllCommand(id: "logTimeline", title: "日志时间线", keywords: ["日志时间线", "日志聚合", "log timeline"],
                        detail: "识别字段后选择聚合键和时间字段", symbol: "list.bullet.indent"),
         OpenAllCommand(id: "sqlRestore", title: "SQL 参数还原", keywords: ["SQL参数", "参数还原", "sql restore"],
                        detail: "将占位符与参数日志合成调试语句", symbol: "curlybraces.square"),
         OpenAllCommand(id: "configFormat", title: "配置格式化", keywords: ["配置格式整理", "YAML格式化", "Properties格式化"],
                        detail: "YAML 缩进与 Properties 键值排版", symbol: "slider.horizontal.3"),
         OpenAllCommand(id: "sqlFormat", title: "SQL 格式化", keywords: ["SQL格式化", "sql format"],
                        detail: "分句换行、关键字大写", symbol: "cylinder"),
         OpenAllCommand(id: "clipboard", title: "剪贴板历史", keywords: ["剪贴板", "clipboard"],
                        detail: "快捷键 \(shortcutDescription(code: settings.clipboardKeyCode, modifiers: settings.clipboardModifiers, label: settings.clipboardKeyLabel))", symbol: "doc.on.clipboard"),
         OpenAllCommand(id: "stack", title: "复制堆栈", keywords: ["堆栈", "stack"],
                        detail: "快捷键 \(shortcutDescription(code: settings.stackKeyCode, modifiers: settings.stackModifiers, label: settings.stackKeyLabel))", symbol: "square.stack"),
         OpenAllCommand(id: "selection", title: "对选中内容操作", keywords: ["选中", "selection"],
                        detail: "快捷键 \(shortcutDescription(code: settings.selectionKeyCode, modifiers: settings.selectionModifiers, label: settings.selectionKeyLabel))", symbol: "cursorarrow.rays"),
         OpenAllCommand(id: "settings", title: "设置", keywords: ["设置", "settings"],
                        detail: "快捷键、搜索、剪贴板与权限", symbol: "gearshape"),
         OpenAllCommand(id: "permissions", title: "权限与隐私", keywords: ["权限", "permissions"],
                        detail: "查看辅助功能与文件权限状态", symbol: "lock.shield"),
         OpenAllCommand(id: "diagnostics", title: "诊断", keywords: ["诊断", "状态", "diagnostics"],
                        detail: "查看快捷键、索引和剪贴板状态", symbol: "waveform.path.ecg"),
         OpenAllCommand(id: "snippets", title: "常用片段", keywords: ["片段", "模板", "snippets"],
                        detail: "管理可快速粘贴的文本", symbol: "text.badge.plus"),
         OpenAllCommand(id: "linkAliases", title: "网址别名", keywords: ["网址别名", "网站", "link aliases"],
                        detail: "管理常用网站与搜索模板", symbol: "link"),
         OpenAllCommand(id: "commandAliases", title: "功能别名", keywords: ["功能别名", "命令别名"],
                        detail: "自定义内置功能的搜索词", symbol: "command.square")]
    }

    static func search(_ text: String, settings: LaunchSettings, pinyinEnabled: Bool,
                       aliases: CommandAliasStore? = nil) -> [OpenAllCommand] {
        let query = text.trimmingCharacters(in: .whitespacesAndNewlines)
        let commands = all(settings: settings)
        guard !query.isEmpty else { return commands }
        return commands.filter { command in
            PinyinMatcher.matches(command.title, query: query, enabled: pinyinEnabled)
                || (command.keywords + (aliases?.names(for: command.id) ?? [])).contains(where: {
                    PinyinMatcher.matches($0, query: query, enabled: pinyinEnabled)
                })
                || command.detail.localizedCaseInsensitiveContains(query)
        }
    }
}

final class CommandAliasStore {
    private let file: URL
    private var values: [String: [String]] = [:]

    init(file: URL? = nil) {
        self.file = file ?? DesignPreview.home
            .appendingPathComponent("Library/Application Support/OpenAll/command-aliases.json")
        if let data = try? Data(contentsOf: self.file),
           let saved = try? JSONDecoder().decode([String: [String]].self, from: data) { values = saved }
        // 合并试用版别名，正式入口保留原有 comparison 标识。
        if let trialNames = values.removeValue(forKey: "comparisonV2") {
            var names = values["comparison"] ?? []
            for name in trialNames where !names.contains(where: { $0.localizedCaseInsensitiveCompare(name) == .orderedSame }) {
                names.append(name)
            }
            values["comparison"] = names
        }
    }

    func names(for id: String) -> [String] { values[id] ?? [] }

    func update(id: String, names: [String]) {
        values[id] = names
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(values) { try? data.write(to: file, options: .atomic) }
    }

    func matches(_ command: OpenAllCommand, query: String, pinyinEnabled: Bool) -> Bool {
        let names = [command.title] + command.keywords + self.names(for: command.id)
        return names.contains { PinyinMatcher.matches($0, query: query, enabled: pinyinEnabled) }
    }

    func conflict(for name: String, excluding id: String, commands: [OpenAllCommand]) -> String? {
        commands.first { command in
            command.id != id && ([command.title] + command.keywords + names(for: command.id))
                .contains { $0.localizedCaseInsensitiveCompare(name) == .orderedSame }
        }?.title
    }
}

final class CommandFavorites {
    private let file: URL
    private var ids: Set<String> = []

    init(file: URL? = nil) {
        self.file = file ?? DesignPreview.home
            .appendingPathComponent("Library/Application Support/OpenAll/command-favorites.json")
        if let data = try? Data(contentsOf: self.file),
           let saved = try? JSONDecoder().decode([String].self, from: data) { ids = Set(saved) }
        if ids.remove("comparisonV2") != nil { ids.insert("comparison") }
    }

    func contains(_ id: String) -> Bool { ids.contains(id) }

    func toggle(_ id: String) {
        if ids.contains(id) { ids.remove(id) }
        else { ids.insert(id) }
        try? FileManager.default.createDirectory(at: file.deletingLastPathComponent(), withIntermediateDirectories: true)
        if let data = try? JSONEncoder().encode(ids.sorted()) { try? data.write(to: file, options: .atomic) }
    }
}
