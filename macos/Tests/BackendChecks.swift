import Foundation

@main struct BackendChecks {
    static func main() throws {
        let left = try ConfigDiff.parse("server:\n  port: 8080\n  apiKey: old\nfeature:\n  enabled: true")
        let right = try ConfigDiff.parse("server:\n  port: 9090\n  apiKey: new\nfeature:\n  enabled: false")
        let diff = ConfigDiff.compare(left, right, revealSecrets: false)
        precondition(diff.changed == 3 && diff.text.contains("••••") && !diff.text.contains("old"))
        let json = try ConfigDiff.parse("{\"items\":[{\"id\":1}]}")
        let properties = try ConfigDiff.parse("db.url=jdbc:mysql://localhost\npassword=abc")
        precondition(json["items[0].id"]?.value == "1")
        precondition(properties["db.url"]?.value == "jdbc:mysql://localhost")
        precondition(ExplainReader.parse("[{\"Plan\":{\"Node Type\":\"Seq Scan\",\"Relation Name\":\"users\",\"Plan Rows\":10}}]")?.lines.first?.contains("⚠") == true)
        precondition(ExplainReader.parse("{\"query_block\":{\"table\":{\"table_name\":\"users\",\"access_type\":\"ALL\",\"rows_examined_per_scan\":20}}}")?.lines.first?.contains("⚠") == true)
        let mysql = "id\tselect_type\ttable\ttype\tkey\trows\tExtra\n1\tSIMPLE\tusers\tALL\tNULL\t200\tUsing where"
        precondition(ExplainReader.parse(mysql)?.lines.first == "⚠ users · ALL · 估算 200 行 · Using where")
        precondition(ExplainReader.parse("-> Table scan on users (cost=3 rows=20)")?.engine == "MySQL · TREE")
        let raw = """
            {"time":"2026-11-03T13:00:00+08:00","requestId":"a","message":"开始"}
            {"time":"2026-11-03T13:00:01+08:00","requestId":"a","message":"结束"}
            {"time":"2026-11-03T13:01:00+08:00","requestId":"b","message":"开始"}
            """
        let logs = LogTimeline.parse(raw)
        precondition(logs.count == 3 && LogTimeline.fieldCoverage(logs).contains { $0.name == "requestId" && $0.count == 3 })
        precondition(LogTimeline.render(logs, groupField: "requestId", timeField: "time").contains("a · 2 条"))
        let extracted = try LogTimeline.addingField(LogTimeline.parse("trace=abc event=ok"), rule: "traceId=trace=(\\w+)")
        precondition(extracted.first?.fields["traceId"] == "abc")
        let restored = SQLParameterRestorer.restore(sql: "SELECT '?' AS q, * FROM t WHERE id=? AND name=? -- ?",
                                                    parameterText: "Parameters: 42(Integer), O'Neil(String)")
        precondition(restored.sql.contains("id=42 AND name='O''Neil'") && restored.replaced == 2 && restored.unresolved == 0)
        let named = SQLParameterRestorer.restore(sql: "SELECT :name::text, $1, :missing", parameterText: "name=Alice, 7")
        precondition(named.sql.contains("'Alice'::text") && named.unresolved == 1)
        let partial = SQLParameterRestorer.restore(sql: "select $2, $2, :missing", parameterText: "first, second")
        precondition(partial.replaced == 2 && partial.unresolved == 1 && partial.unused == 1)
        print("配置、计划、日志与 SQL 参数检查通过")
    }
}
