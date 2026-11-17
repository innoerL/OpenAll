import Foundation

@main
enum FileSearchQualifierChecks {
    static func main() throws {
        require(FileSearchRequest.parse("文件  合同") == FileSearchRequest(term: "合同", filter: .all), "所有文件定语")
        require(FileSearchRequest.parse("文档\t合同") == FileSearchRequest(term: "合同", filter: .documents), "文档定语和空白分隔")
        require(FileSearchRequest.parse("图片 截图") == FileSearchRequest(term: "截图", filter: .images), "图片定语")
        require(FileSearchRequest.parse("JSON 配置") == FileSearchRequest(term: "配置", filter: .fileExtension("json")), "后缀不区分大小写")
        require(FileSearchRequest.parse(".customext 预算")?.filter == .fileExtension("customext"), "任意后缀可显式加点")
        require(FileSearchRequest.parse("tar.gz 备份")?.filter == .fileExtension("tar.gz"), "复合后缀")
        for text in ["json", "markdown", "translate hello", "calc 2 + 2", "普通 查询", "应用 终端", "sql format", "SQL 执行计划", "sql restore", "config diff", "log timeline"] {
            require(FileSearchRequest.parse(text) == nil, "保留现有入口：\(text)")
        }
        require(FileSearchRequest.parse("swift 工作台", preservingCommands: ["swift 工作台"]) == nil, "保留完整的自定义功能别名")
        require(FileSearchRequest.parse("json 配置", preservingCommands: ["json 配置"])?.filter == .fileExtension("json"), "json 参数优先执行明确的文件语法")
        require(FileSearchRequest.parse("文档")?.term == "", "空定语保留提示状态")
        require(FileSearchFilter.documents.matchesName("报告.PDF") && FileSearchFilter.documents.matchesName("计划.xmind"), "文档格式")
        require(!FileSearchFilter.documents.matchesName("报告.pdf.zip"), "只匹配实际后缀")
        require(FileSearchFilter.images.matchesName("截图.HEIC") && !FileSearchFilter.images.matchesName("截图.heic.txt"), "图片格式")
        let fakePackage = URL(fileURLWithPath: "/tmp/报告.pages")
        require(FileSearchFilter.documents.matches(fakePackage, isDirectory: true, isPackage: true), "允许文档包")
        require(!FileSearchFilter.documents.matches(fakePackage, isDirectory: true, isPackage: false), "排除同名普通文件夹")
        let predicate = FileSearchFilter.documents.spotlightPredicate(term: "合同")
        require(predicate.evaluate(with: ["kMDItemFSName": "合同.PDF", "kMDItemContentType": "com.adobe.pdf"]), "Spotlight 同时匹配关键词和文档后缀")
        require(!predicate.evaluate(with: ["kMDItemFSName": "合同.png", "kMDItemContentType": "public.png"]), "Spotlight 在收集额度之前排除其他类型")
        require(!predicate.evaluate(with: ["kMDItemFSName": "合同.pdf", "kMDItemContentType": "public.folder"]), "Spotlight 排除普通目录")
        try checkLocalIndex()
        print("文件搜索定语检查通过")
    }

    private static func checkLocalIndex() throws {
        let manager = FileManager.default
        let root = manager.temporaryDirectory.appendingPathComponent("openall-file-qualifiers-" + UUID().uuidString)
        try manager.createDirectory(at: root, withIntermediateDirectories: true)
        defer { try? manager.removeItem(at: root) }
        let term = "openall-test-" + UUID().uuidString.lowercased()
        // 超过结果上限的无关类型排在前面，确认后缀过滤发生在截取 120 项之前。
        for index in 0..<180 {
            try Data().write(to: root.appendingPathComponent("\(term)-a-\(index).bin"))
        }
        for suffix in ["PDF", "docx", "xmind", "PNG", "JSON", "customext"] {
            try Data().write(to: root.appendingPathComponent("\(term)-z.\(suffix)"))
        }
        try manager.createDirectory(at: root.appendingPathComponent("\(term)-folder.pdf"), withIntermediateDirectories: false)
        let index = FileSearchIndex(searchRoots: [root])
        index.setEnabled(true)
        defer { index.setEnabled(false) }
        require(wait { !index.isIndexing && index.indexedCount == 187 }, "临时文件索引完成")
        index.search(term, filter: .all)
        require(wait { index.results.count == 120 }, "所有类型搜索保留原有结果上限")
        index.search(term, filter: .images)
        require(wait { index.results.count == 1 && index.results.first?.pathExtension == "PNG" }, "同词切换图片类型刷新缓存")
        index.search(term, filter: .documents)
        require(wait { index.results.count == 3 && Set(index.results.map { $0.pathExtension.lowercased() }) == ["pdf", "docx", "xmind"] }, "文档过滤先于结果数量限制，且不包含假后缀目录")
        index.search(term, filter: .fileExtension("json"))
        require(wait { index.results.count == 1 && index.results.first?.pathExtension == "JSON" }, "同词切换单一后缀")
        index.search(term, filter: .fileExtension("customext"))
        require(wait { index.results.count == 1 && index.results.first?.pathExtension == "customext" }, "任意显式后缀")
        index.search(term, filter: .all)
        require(wait { index.results.count == 120 }, "回到所有类型不沿用旧后缀")
    }

    private static func wait(_ condition: () -> Bool) -> Bool {
        let deadline = Date().addingTimeInterval(8)
        while !condition(), Date() < deadline { RunLoop.current.run(until: Date().addingTimeInterval(0.02)) }
        return condition()
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }
}
