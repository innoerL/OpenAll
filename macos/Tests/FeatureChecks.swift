import Foundation

@main struct FeatureChecks {
    static func main() {
        let cases: [(String, Double)] = [
            ("√9", 3), ("cos(0)", 1), ("10%3", 1),
            ("2^3^2", 512), ("7&3", 3), ("5 xor 3", 6),
            ("2+3*4", 14), ("1000000>>>16", 15),
            ("-1>>>1", 2147483647), ("8>>1", 4), ("8<<2", 32)
        ]
        for (expression, expected) in cases {
            guard let actual = ExpressionParser(expression).parse(), abs(actual - expected) < 1e-9 else {
                fatalError("计算错误：\(expression)")
            }
        }
        for _ in 0..<1000 {
            let number = ChineseIDGenerator.generate()
            guard number.count == 18 else { fatalError("长度错误") }
            let body = Array(number.prefix(17)).compactMap(\.wholeNumberValue)
            let sum = zip(body, ChineseIDGenerator.weights).reduce(0) { $0 + $1.0 * $1.1 }
            guard number.last == ChineseIDGenerator.checks[sum % 11] else { fatalError("校验位错误") }
        }
        guard ChineseIDGenerator.verifyModel(),
              let chaoyang = ChineseIDGenerator.provinces.first?.regions.firstIndex(where: { $0.code == "110105" }) else {
            fatalError("完整地区或年龄规则检查失败")
        }
        let selected = ChineseIDGenerator.Options(provinceIndex: 0, regionIndex: chaoyang,
                                                   year: 2000, month: 2, day: 29,
                                                   gender: "女", count: 500)
        guard let selectedNumbers = ChineseIDGenerator.generate(selected), selectedNumbers.count == 500,
              Set(selectedNumbers).count == 500,
              selectedNumbers.allSatisfy({ $0.hasPrefix("11010520000229") &&
                  (Int(String($0.dropFirst(16).prefix(1))) ?? 1) % 2 == 0 }) else {
            fatalError("指定条件或去重错误")
        }
        guard ChineseIDGenerator.generate(.init(year: 2001, month: 2, day: 29)) == nil else {
            fatalError("无效日期应被拒绝")
        }
        let html = MarkdownRenderer.html("# 标题\n\n**加粗** 和 `代码`\n- 列表")
        guard html.contains("<h1>标题</h1>"), html.contains("<strong>加粗</strong>"),
              html.contains("<code>代码</code>"), html.contains("<li>列表</li>") else {
            fatalError("Markdown 渲染错误")
        }
        print("计算器 11 项、身份证完整地区、年龄规则及 2000 个测试号码（含指定条件和去重）、Markdown 渲染均通过")
    }
}
