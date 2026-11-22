import Foundation
import CoreFoundation

struct BackendIssue: Error {
    let message: String
}

struct ConfigField: Equatable {
    let value: String
    let type: String
}

enum ConfigDiff {
    static func isSensitive(_ path: String) -> Bool {
        path.range(of: #"pass(word|wd)?|secret|token|credential|authorization|api.?key|private.?key|私钥|密码"#,
                   options: [.regularExpression, .caseInsensitive]) != nil
    }

    static func parse(_ input: String) throws -> [String: ConfigField] {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw BackendIssue(message: "请输入配置内容") }
        if text.hasPrefix("{") || text.hasPrefix("[") {
            guard let data = text.data(using: .utf8),
                  let value = try? JSONSerialization.jsonObject(with: data) else {
                throw BackendIssue(message: "JSON 格式无效")
            }
            var fields: [String: ConfigField] = [:]
            flatten(value, path: "$", into: &fields)
            return fields
        }
        let lines = text.components(separatedBy: .newlines)
        let significant = lines.map { $0.trimmingCharacters(in: .whitespaces) }
            .filter { !$0.isEmpty && !$0.hasPrefix("#") && !$0.hasPrefix("!") }
        let properties = significant.allSatisfy { line in
            guard let equal = line.firstIndex(of: "=") else { return false }
            return line.firstIndex(of: ":").map { equal < $0 } ?? true
        }
        return try properties ? parseProperties(lines) : parseYAML(lines)
    }

    static func compare(_ left: [String: ConfigField], _ right: [String: ConfigField],
                        revealSecrets: Bool) -> (text: String, changed: Int) {
        let keys = Set(left.keys).union(right.keys).sorted {
            $0.localizedStandardCompare($1) == .orderedAscending
        }
        var rows: [String] = []
        for key in keys {
            let a = left[key], b = right[key]
            if a == b { continue }
            let sensitive = !revealSecrets && isSensitive(key)
            let before = a.map { sensitive ? "••••" : $0.value } ?? "∅"
            let after = b.map { sensitive ? "••••" : $0.value } ?? "∅"
            if a == nil { rows.append("+ \(key) = \(after)  [\(b!.type)]") }
            else if b == nil { rows.append("− \(key) = \(before)  [\(a!.type)]") }
            else { rows.append("~ \(key)\n    \(before) [\(a!.type)] → \(after) [\(b!.type)]") }
        }
        return (rows.isEmpty ? "两份配置没有差异" : rows.joined(separator: "\n\n"), rows.count)
    }

    private static func flatten(_ value: Any, path: String, into fields: inout [String: ConfigField]) {
        if let object = value as? [String: Any] {
            if object.isEmpty { fields[path] = ConfigField(value: "{}", type: "object") }
            for (key, child) in object { flatten(child, path: path == "$" ? key : "\(path).\(key)", into: &fields) }
        } else if let array = value as? [Any] {
            if array.isEmpty { fields[path] = ConfigField(value: "[]", type: "array") }
            for (index, child) in array.enumerated() { flatten(child, path: "\(path)[\(index)]", into: &fields) }
        } else if value is NSNull {
            fields[path] = ConfigField(value: "null", type: "null")
        } else if let number = value as? NSNumber {
            let type = CFGetTypeID(number) == CFBooleanGetTypeID() ? "boolean" : "number"
            fields[path] = ConfigField(value: number.stringValue, type: type)
        } else {
            fields[path] = ConfigField(value: String(describing: value), type: "string")
        }
    }

    private static func parseProperties(_ lines: [String]) throws -> [String: ConfigField] {
        var fields: [String: ConfigField] = [:]
        for (index, raw) in lines.enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") || line.hasPrefix("!") { continue }
            guard let delimiter = line.firstIndex(where: { $0 == "=" || $0 == ":" }) else {
                throw BackendIssue(message: "第 \(index + 1) 行缺少 = 或 :")
            }
            let key = String(line[..<delimiter]).trimmingCharacters(in: .whitespaces)
            guard !key.isEmpty else { throw BackendIssue(message: "第 \(index + 1) 行的键为空") }
            fields[key] = ConfigField(value: String(line[line.index(after: delimiter)...])
                .trimmingCharacters(in: .whitespaces), type: "string")
        }
        return fields
    }

    private static func parseYAML(_ lines: [String]) throws -> [String: ConfigField] {
        var fields: [String: ConfigField] = [:]
        var parents: [(indent: Int, path: String)] = []
        var indices: [String: Int] = [:]
        for (index, raw) in lines.enumerated() {
            let line = raw.trimmingCharacters(in: .whitespaces)
            if line.isEmpty || line.hasPrefix("#") || line == "---" { continue }
            guard !raw.contains("\t") else { throw BackendIssue(message: "第 \(index + 1) 行使用了 Tab") }
            let indent = raw.prefix(while: { $0 == " " }).count
            while let last = parents.last, last.indent >= indent { parents.removeLast() }
            let prefix = parents.last?.path ?? ""
            if line.hasPrefix("- ") {
                guard !prefix.isEmpty else { throw BackendIssue(message: "第 \(index + 1) 行的列表没有所属键") }
                let next = indices[prefix, default: 0]
                indices[prefix] = next + 1
                let path = "\(prefix)[\(next)]"
                let body = String(line.dropFirst(2)).trimmingCharacters(in: .whitespaces)
                if body.isEmpty { parents.append((indent, path)); continue }
                if let pair = yamlPair(body) {
                    parents.append((indent, path))
                    let child = "\(path).\(pair.0)"
                    if pair.1.isEmpty { parents.append((indent + 1, child)) }
                    else { fields[child] = yamlScalar(pair.1) }
                } else { fields[path] = yamlScalar(body) }
                continue
            }
            guard let pair = yamlPair(line) else {
                throw BackendIssue(message: "第 \(index + 1) 行不是可识别的 YAML 键值")
            }
            let path = prefix.isEmpty ? pair.0 : "\(prefix).\(pair.0)"
            if pair.1.isEmpty { parents.append((indent, path)) }
            else if pair.1 == "|" || pair.1 == ">" {
                throw BackendIssue(message: "第 \(index + 1) 行使用了暂不支持的多行 YAML 值")
            } else { fields[path] = yamlScalar(pair.1) }
        }
        return fields
    }

    private static func yamlPair(_ line: String) -> (String, String)? {
        guard let colon = line.firstIndex(of: ":"),
              line.index(after: colon) == line.endIndex || line[line.index(after: colon)].isWhitespace else { return nil }
        let key = String(line[..<colon]).trimmingCharacters(in: .whitespaces)
        guard !key.isEmpty else { return nil }
        return (key, String(line[line.index(after: colon)...]).trimmingCharacters(in: .whitespaces))
    }

    private static func yamlScalar(_ raw: String) -> ConfigField {
        var value = raw
        if let comment = value.range(of: " #") {
            value = String(value[..<comment.lowerBound]).trimmingCharacters(in: .whitespaces)
        }
        if value.count >= 2 && ((value.first == "\"" && value.last == "\"") ||
                                (value.first == "'" && value.last == "'")) {
            return ConfigField(value: String(value.dropFirst().dropLast()), type: "string")
        }
        if value == "null" || value == "~" { return ConfigField(value: "null", type: "null") }
        if ["true", "false"].contains(value.lowercased()) { return ConfigField(value: value.lowercased(), type: "boolean") }
        if Double(value) != nil { return ConfigField(value: value, type: "number") }
        return ConfigField(value: value, type: "string")
    }
}

struct ExplainReport {
    let engine: String
    let lines: [String]
    let warning: String?
}

enum ExplainReader {
    static func parse(_ input: String) -> ExplainReport? {
        let text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { return nil }
        if let data = text.data(using: .utf8),
           let json = try? JSONSerialization.jsonObject(with: data) {
            let first = (json as? [Any])?.first ?? json
            if let root = first as? [String: Any], let plan = root["Plan"] as? [String: Any] {
                var lines: [String] = []
                postgres(plan, depth: 0, into: &lines)
                return ExplainReport(engine: "PostgreSQL · JSON", lines: lines, warning: nil)
            }
            if let root = first as? [String: Any], let block = root["query_block"] as? [String: Any] {
                var lines: [String] = []
                mysql(block, depth: 0, into: &lines)
                return ExplainReport(engine: "MySQL · JSON", lines: lines, warning: nil)
            }
        }
        let rows = text.components(separatedBy: .newlines).filter { !$0.trimmingCharacters(in: .whitespaces).isEmpty }
        if rows.contains(where: { $0.contains("cost=") && $0.contains("rows=") }) {
            let mysqlTree = rows.contains {
                $0.contains("->") && ($0.localizedCaseInsensitiveContains("table scan") ||
                                      $0.localizedCaseInsensitiveContains("index lookup") ||
                                      $0.contains("actual time="))
            }
            return ExplainReport(engine: mysqlTree ? "MySQL · TREE" : "PostgreSQL · 文本",
                                 lines: rows.map { mark($0) }, warning: nil)
        }
        if let headerIndex = rows.firstIndex(where: {
            let line = $0.lowercased()
            return line.contains("select_type") && line.contains("table") && line.contains("rows")
        }) {
            let header = columns(rows[headerIndex])
            let data = rows.dropFirst(headerIndex + 1).map(columns)
                .filter { $0.count == header.count && !$0.allSatisfy { $0.isEmpty } }
            let nameIndex = header.firstIndex(where: { $0.lowercased() == "table" })
            let accessIndex = header.firstIndex(where: { $0.lowercased() == "type" })
            let rowsIndex = header.firstIndex(where: { $0.lowercased() == "rows" })
            let keyIndex = header.firstIndex(where: { $0.lowercased() == "key" })
            let extraIndex = header.firstIndex(where: { $0.lowercased() == "extra" })
            let lines = data.map { row -> String in
                let name = nameIndex.map { row[$0] } ?? "表"
                let access = accessIndex.map { row[$0] } ?? "未知访问方式"
                var value = (access == "ALL" ? "⚠ " : "• ") + name + " · \(access)"
                if let keyIndex, !row[keyIndex].isEmpty && row[keyIndex] != "NULL" { value += " · 索引 \(row[keyIndex])" }
                if let rowsIndex { value += " · 估算 \(row[rowsIndex]) 行" }
                if let extraIndex, !row[extraIndex].isEmpty { value += " · \(row[extraIndex])" }
                return value
            }
            return ExplainReport(engine: "MySQL · 表格",
                                 lines: lines.isEmpty ? rows.map(mark) : lines, warning: nil)
        }
        return nil
    }

    private static func columns(_ line: String) -> [String] {
        let clean = line.trimmingCharacters(in: .whitespaces)
        if clean.hasPrefix("|") && clean.hasSuffix("|") {
            return clean.dropFirst().dropLast().split(separator: "|", omittingEmptySubsequences: false)
                .map { $0.trimmingCharacters(in: .whitespaces) }
        }
        return clean.components(separatedBy: "\t").map { $0.trimmingCharacters(in: .whitespaces) }
    }

    private static func postgres(_ node: [String: Any], depth: Int, into lines: inout [String]) {
        let kind = node["Node Type"] as? String ?? "未知节点"
        var line = String(repeating: "  ", count: depth) + (kind == "Seq Scan" ? "⚠ " : "• ") + kind
        if let relation = node["Relation Name"] { line += " · \(relation)" }
        if let index = node["Index Name"] { line += " · 索引 \(index)" }
        if let rows = node["Plan Rows"] { line += " · 估算 \(rows) 行" }
        if let rows = node["Actual Rows"] { line += " · 实际 \(rows) 行" }
        if let time = node["Actual Total Time"] { line += " · \(time) ms" }
        lines.append(line)
        for child in node["Plans"] as? [[String: Any]] ?? [] { postgres(child, depth: depth + 1, into: &lines) }
    }

    private static func mysql(_ node: [String: Any], depth: Int, into lines: inout [String]) {
        if let table = node["table"] as? [String: Any] {
            let name = table["table_name"] as? String ?? "表"
            let access = table["access_type"] as? String ?? "未知访问方式"
            var line = String(repeating: "  ", count: depth) + (access == "ALL" ? "⚠ " : "• ") + name + " · \(access)"
            if let key = table["key"] { line += " · 索引 \(key)" }
            if let rows = table["rows_examined_per_scan"] { line += " · 扫描 \(rows) 行" }
            if let rows = table["rows_produced_per_join"] { line += " · 输出 \(rows) 行" }
            lines.append(line)
        }
        if let loop = node["nested_loop"] as? [[String: Any]] {
            lines.append(String(repeating: "  ", count: depth) + "• 嵌套循环")
            for child in loop { mysql(child, depth: depth + 1, into: &lines) }
        }
        for key in ["query_block", "grouping_operation", "ordering_operation", "duplicates_removal",
                    "materialized_from_subquery"] {
            if let child = node[key] as? [String: Any] { mysql(child, depth: depth + 1, into: &lines) }
        }
    }

    private static func mark(_ line: String) -> String {
        if line.contains("Seq Scan") || line.localizedCaseInsensitiveContains("table scan") ||
            line.range(of: #"\sALL\s"#, options: .regularExpression) != nil { return "⚠ " + line }
        return line
    }
}
