import Foundation

@main
enum JSONFoldingChecks {
    static func main() {
        let source = #"""
        {
          "title": "😀 [] {} \\\"",
          "data": {
            "items": [
              {"key": 1},
              {"key": 2}
            ],
            "tail": true
          },
          "last": 0
        }
        """#
        require((try? JSONSerialization.jsonObject(with: Data(source.utf8))) != nil, "测试原文必须为有效 JSON")
        var document = JSONFoldDocument(source: source)
        require(document.regions.count == 3, "字符串中的括号与单行容器不能产生折叠区域")
        let root = document.regions[0]
        let data = document.regions[1]
        let items = document.regions[2]
        require(root.startLine == 1 && root.endLine == 11, "根节点行号")
        require(data.startLine == 3 && data.endLine == 9, "对象行号")
        require(items.startLine == 4 && items.endLine == 7, "数组行号")
        require(document.projection().text == source, "初始显示必须逐字保留原文")
        require(document.projection().lineNumbers == Array(1...11), "展开状态行号")

        document.toggle(start: items.start)
        let projection = document.projection()
        require(projection.lineNumbers == [1, 2, 3, 4, 8, 9, 10, 11], "折叠后的行号必须保留原文位置")
        require(projection.text.contains("\"items\": [ … 3 行 ],"), "保留开闭括号和尾部逗号")
        require(projection.visibleRegions.count == 3, "折叠节点仍可见且可展开")
        require(projection.visibleRegions.last?.isCollapsed == true, "折叠状态")
        let text = projection.text as NSString
        let marker = text.range(of: items.placeholder)
        require(projection.sourceRange(for: marker) == items.contentRange, "省略标记映射到全部隐藏内容")
        require(projection.sourceRange(for: NSRange(location: marker.location + 1, length: 1)) == items.contentRange,
                "仅选择省略号也复制完整隐藏内容")
        require(projection.sourceRange(for: NSRange(location: 0, length: text.length)) ==
                NSRange(location: 0, length: (source as NSString).length), "全选复制不能丢失隐藏内容")
        require(projection.sourceRange(for: NSRange(location: marker.location - 1, length: 1)) ==
                NSRange(location: items.start, length: 1), "止于省略标记前的选择不能吸入隐藏内容")
        require(projection.sourceRange(for: NSRange(location: NSMaxRange(marker), length: 1)) ==
                NSRange(location: items.end - 1, length: 1), "省略标记之后的选择不能吸入隐藏内容")
        require(projection.projectedOffset(forSourceOffset: items.start + 4) == marker.location,
                "隐藏内容中的原文偏移映射到省略标记")
        let visibleEmoji = text.range(of: "😀")
        require(projection.sourceRange(for: visibleEmoji) == (source as NSString).range(of: "😀"), "表情使用 UTF-16 偏移")
        let visibleLast = text.range(of: "\"last\"")
        require(projection.sourceRange(for: visibleLast) == (source as NSString).range(of: "\"last\""), "折叠后的后续选区映射")

        document.toggle(start: data.start)
        require(document.projection().lineNumbers == [1, 2, 3, 10, 11], "外层折叠行号")
        require(document.projection().visibleRegions.count == 2, "父节点折叠后隐藏子节点按钮")
        document.toggle(start: data.start)
        require(document.projection().text == projection.text, "父节点展开必须保留子节点折叠状态")
        document.collapseAll()
        require(document.projection().text == "{ … 10 行 }", "全部折叠")
        require(document.projection().visibleRegions.count == 1, "全部折叠后仅根节点可见")
        document.expandAll()
        require(document.projection().text == source, "全部展开可无损恢复原文")
        document.toggle(start: Int.max)
        require(document.collapsed.isEmpty, "不存在的节点不能被折叠")
        document.collapseAll()
        document.reset(source: "[\n  1,\n  2\n]")
        require(document.collapsed.isEmpty && document.regions.count == 1, "新结果必须重置折叠状态")

        require(JSONFoldDocument(source: "{\"empty\": {}, \"items\": []}").regions.isEmpty, "空容器与单行结果无折叠按钮")
        require(JSONFoldDocument(source: "{\n]").regions.isEmpty, "不匹配括号不能折叠")
        require(JSONFoldDocument(source: "{\n  []").regions.isEmpty, "未闭合容器不能折叠")
        require(JSONFoldDocument(source: "{\n  \"text: []\n}").regions.isEmpty, "未闭合字符串不能折叠")
        let empty = JSONFoldDocument(source: "").projection()
        require(empty.lineNumbers == [1] && empty.sourceRange(for: NSRange(location: 0, length: 0)).length == 0,
                "空结果保留第一行且选区安全")
        let crlf = JSONFoldDocument(source: "{\r\n  \"a\": [\r\n    1\r\n  ]\r\n}\r\n")
        require(crlf.regions[1].startLine == 2 && crlf.regions[1].endLine == 4, "CRLF 只计一次换行")
        require(crlf.projection().lineNumbers == Array(1...6), "尾部空行也有行号")
        require(crlf.lineCount == 6, "文档行数与 CRLF 标尺保持一致")
        require(JSONFoldDocument(source: "").lineCount == 0, "空文档页脚显示零行")
        require(JSONFoldDocument(source: String(repeating: "[", count: 10000) + "\n0\n" + String(repeating: "]", count: 10000)).regions.isEmpty,
                "超深输入不得生成无界折叠栈")

        var siblings = JSONFoldDocument(source: "[\n  {\n    \"emoji\": \"😀\"\n  },\n  {\n    \"text\": \"后续\"\n  }\n]")
        for region in siblings.regions.dropFirst() { siblings.toggle(start: region.start) }
        let siblingProjection = siblings.projection()
        require(siblingProjection.text == "[\n  { … 2 行 },\n  { … 2 行 }\n]", "多个同级节点独立折叠")
        require(siblingProjection.lineNumbers == [1, 2, 5, 8], "多个折叠区后的行号映射")
        let projectedSource = siblingProjection.text as NSString
        for index in 0..<projectedSource.length {
            let range = NSRange(location: index, length: 1)
            let original = siblingProjection.sourceRange(for: range)
            let character = projectedSource.substring(with: range)
            if original.length == 1 {
                require((siblings.source as NSString).substring(with: original) == character, "可见字符的 UTF-16 映射必须逐字一致")
            } else {
                require(siblings.regions.dropFirst().contains(where: { $0.contentRange == original }), "只有折叠提示可以映射到完整隐藏内容")
            }
        }
        var editable = JSONFoldDocument(source: source)
        editable.toggle(start: items.start)
        let title = (source as NSString).range(of: "😀")
        require(editable.replaceCharacters(in: title, with: "中文😎\n新增"), "折叠前修改可见文字")
        let expected = (source as NSString).replacingCharacters(in: title, with: "中文😎\n新增")
        let shift = ("中文😎\n新增" as NSString).length - title.length
        require(editable.source == expected && editable.collapsed == [items.start + shift], "折叠区随 UTF-16 编辑平移")
        require(editable.regions.first(where: { $0.start == items.start + shift })?.startLine == items.startLine + 1,
                "折叠区随新增行平移行号")
        require(editable.projection().text.contains("[ … 3 行 ]"), "暂时不完整的 JSON 仍保留未触及的折叠区")
        let last = (editable.source as NSString).range(of: "\"last\": 0")
        require(editable.replaceCharacters(in: last, with: "\"last\": 123"), "折叠后修改可见文字")
        require(editable.collapsed == [items.start + shift] && editable.source.contains("\"last\": 123"), "折叠之后编辑不移动前面的节点")
        editable.replaceSourcePreservingFolds(source)
        require(editable.source == source, "多处差异恢复完整原文")
        editable.toggle(start: items.start)
        editable.replaceSourcePreservingFolds(source.replacingOccurrences(of: "😀", with: "😎"))
        require(editable.collapsed == [items.start] && editable.source.contains("😎"), "同高代理项的表情替换不得拆分 UTF-16")
        let inner = (editable.source as NSString).range(of: "\"key\": 1")
        require(editable.replaceCharacters(in: inner, with: "\"key\": 3") && editable.collapsed.isEmpty,
                "被真正改动的折叠区域展开")
        require(!editable.replaceCharacters(in: NSRange(location: Int.max, length: 1), with: ""), "越界编辑拒绝执行")
        print("JSON 折叠模型检查通过")
    }

    private static func require(_ condition: @autoclosure () -> Bool, _ message: String) {
        precondition(condition(), message)
    }
}
