import Foundation

struct ParsedLog {
    let raw: String
    let fields: [String: String]
    let position: Int
}

enum LogTimeline {
    // 摘要只带有限的故障类别和追踪标识，避免把日志正文、凭证或用户输入复制到标题中。
    static func summaryKind(_ message: String) -> String {
        let value = String(message.prefix(400)).lowercased()
        if ["超时", "timeout", "timed out"].contains(where: value.contains) {
            return ["数据库", "database", "sql", "mysql", "postgres"].contains(where: value.contains) ? "数据库超时" : "请求超时"
        }
        if ["权限不足", "permission denied", "access denied", "forbidden"].contains(where: value.contains) { return "访问被拒绝" }
        if ["连接被拒绝", "connection refused", "econnrefused"].contains(where: value.contains) { return "连接被拒绝" }
        if ["服务不可用", "service unavailable"].contains(where: value.contains) { return "服务不可用" }
        return ""
    }

    static func requestLabel(_ fields: [String: String]) -> String {
        for key in ["requestId", "request_id", "traceId", "trace_id", "trace.id"] {
            guard let value = fields[key], value.count <= 64,
                  value.range(of: #"^[a-zA-Z0-9_.-]+$"#, options: .regularExpression) != nil else { continue }
            return "请求 " + String(value.prefix(32)) + (value.count > 32 ? "…" : "")
        }
        return ""
    }

    static func parse(_ input: String) -> [ParsedLog] {
        let regex = try! NSRegularExpression(pattern: #"([A-Za-z_][\w.-]*)=(?:"([^"]*)"|([^\s,]+))"#)
        return input.components(separatedBy: .newlines).prefix(10_000).enumerated().compactMap { index, raw in
            guard !raw.trimmingCharacters(in: .whitespaces).isEmpty else { return nil }
            var fields: [String: String] = [:]
            if let data = raw.data(using: .utf8),
               let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
                for (key, value) in object {
                    if let nested = value as? [String: Any] {
                        for (subkey, subvalue) in nested { fields["\(key).\(subkey)"] = String(describing: subvalue) }
                    } else { fields[key] = String(describing: value) }
                }
            } else {
                for match in regex.matches(in: raw, range: NSRange(raw.startIndex..<raw.endIndex, in: raw)) {
                    guard let keyRange = Range(match.range(at: 1), in: raw) else { continue }
                    let valueIndex = match.range(at: 2).location == NSNotFound ? 3 : 2
                    guard let valueRange = Range(match.range(at: valueIndex), in: raw) else { continue }
                    fields[String(raw[keyRange])] = String(raw[valueRange])
                }
                if let time = raw.range(of: #"\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?"#,
                                         options: .regularExpression) {
                    fields["时间"] = String(raw[time])
                }
            }
            return ParsedLog(raw: raw, fields: fields, position: index)
        }
    }

    static func fieldCoverage(_ records: [ParsedLog]) -> [(name: String, count: Int, sample: String)] {
        var values: [String: (count: Int, sample: String)] = [:]
        for record in records {
            for (key, value) in record.fields where !value.isEmpty {
                let current = values[key] ?? (0, value)
                values[key] = (current.count + 1, current.sample)
            }
        }
        return values.map { ($0.key, $0.value.count, $0.value.sample) }.sorted {
            $0.count == $1.count ? $0.name.localizedStandardCompare($1.name) == .orderedAscending : $0.count > $1.count
        }
    }

    static func addingField(_ records: [ParsedLog], rule: String) throws -> [ParsedLog] {
        let clean = rule.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { return records }
        guard let equal = clean.firstIndex(of: "=") else {
            throw BackendIssue(message: "手动规则格式：字段名=正则表达式，使用第 1 个捕获组")
        }
        let name = String(clean[..<equal]).trimmingCharacters(in: .whitespaces)
        let pattern = String(clean[clean.index(after: equal)...])
        guard !name.isEmpty, !pattern.isEmpty,
              let regex = try? NSRegularExpression(pattern: pattern),
              regex.numberOfCaptureGroups >= 1 else {
            throw BackendIssue(message: "手动规则需要字段名和含捕获组的有效正则表达式")
        }
        return records.map { record in
            var fields = record.fields
            let range = NSRange(record.raw.startIndex..<record.raw.endIndex, in: record.raw)
            if let match = regex.firstMatch(in: record.raw, range: range),
               let capture = Range(match.range(at: 1), in: record.raw) {
                fields[name] = String(record.raw[capture])
            }
            return ParsedLog(raw: record.raw, fields: fields, position: record.position)
        }
    }

    static func render(_ records: [ParsedLog], groupField: String, timeField: String) -> String {
        guard !records.isEmpty else { return "没有可解析的日志行" }
        let groups = Dictionary(grouping: records) { $0.fields[groupField] ?? "（无 \(groupField)）" }
        return groups.keys.sorted { left, right in
            let a = groups[left]?.count ?? 0, b = groups[right]?.count ?? 0
            return a == b ? left < right : a > b
        }.map { key in
            let ordered = (groups[key] ?? []).sorted {
                let a = timestamp($0.fields[timeField] ?? "")
                let b = timestamp($1.fields[timeField] ?? "")
                if let a, let b, a != b { return a < b }
                return $0.position < $1.position
            }
            return "▸ \(key) · \(ordered.count) 条\n" +
                ordered.map { "  \($0.fields[timeField] ?? "#\($0.position + 1)")  \($0.raw)" }
                    .joined(separator: "\n")
        }.joined(separator: "\n\n")
    }

    static func timestamp(_ value: String) -> Date? {
        if let date = TimeResults.parseTimestamp(value) { return date }
        let iso = ISO8601DateFormatter()
        iso.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = iso.date(from: value) { return date }
        iso.formatOptions = [.withInternetDateTime]
        if let date = iso.date(from: value) { return date }
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = TimeZone(secondsFromGMT: 8 * 3600)
        formatter.dateFormat = "yyyy-MM-dd HH:mm:ss"
        return formatter.date(from: value)
    }
}

struct SQLRestoreResult {
    let sql: String
    let replacementRanges: [NSRange]
    var replaced: Int { replacementRanges.count }
    let unresolved: Int
    let unused: Int
}

enum SQLParameterRestorer {
    static func restore(sql: String, parameterText: String) -> SQLRestoreResult {
        let raw = parameterText.replacingOccurrences(of: #"(?i)^\s*parameters:\s*"#,
                                                       with: "", options: .regularExpression)
            .trimmingCharacters(in: .whitespacesAndNewlines)
        let (positional, named) = parameters(raw)
        let chars = Array(sql)
        var output = ""
        var index = 0
        var parameterIndex = 0
        var replacementRanges: [NSRange] = []
        var unchangedStart = 0, outputOffset = 0
        func appendReplacement(_ literal: String, consuming end: Int) {
            // 只扫描相邻替换之间的原文，按 NSTextView 使用的 UTF-16 坐标记下实参。
            for character in chars[unchangedStart..<index] { outputOffset += character.utf16.count }
            let length = literal.utf16.count
            replacementRanges.append(NSRange(location: outputOffset, length: length))
            output += literal
            outputOffset += length
            unchangedStart = end
        }
        var usedPositions = Set<Int>(), usedNames = Set<String>()
        var unresolved = 0
        var state = 0, blockDepth = 0
        var dollarQuote: [Character] = []
        while index < chars.count {
            let char = chars[index], next = index + 1 < chars.count ? chars[index + 1] : "\0"
            if state == 1 {
                output.append(char)
                if char.isNewline { state = 0 }
            } else if state == 2 {
                output.append(char)
                if char == "/" && next == "*" { output.append(next); index += 1; blockDepth += 1 }
                else if char == "*" && next == "/" {
                    output.append(next); index += 1; blockDepth -= 1
                    if blockDepth == 0 { state = 0 }
                }
            } else if state == 6 {
                if char == "$", chars[index...].starts(with: dollarQuote) {
                    output.append(contentsOf: dollarQuote); index += dollarQuote.count - 1; state = 0
                } else { output.append(char) }
            } else if state >= 3 {
                output.append(char)
                let closing: Character = state == 3 ? "'" : state == 4 ? "\"" : Character(UnicodeScalar(96)!)
                if char == "\\", index + 1 < chars.count { output.append(next); index += 1 }
                else if char == closing {
                    if next == closing { output.append(next); index += 1 }
                    else { state = 0 }
                }
            } else if char == "-" && next == "-" {
                output += "--"; index += 1; state = 1
            } else if char == "#" {
                output.append(char); state = 1
            } else if char == "/" && next == "*" {
                output += "/*"; index += 1; state = 2; blockDepth = 1
            } else if char == "$", next == "$" || next.isLetter || next == "_" {
                var end = index + 1
                while end < chars.count && (chars[end].isLetter || chars[end].isNumber || chars[end] == "_") { end += 1 }
                if end < chars.count, chars[end] == "$" {
                    dollarQuote = Array(chars[index...end]); output.append(contentsOf: dollarQuote); index = end; state = 6
                } else { output.append(char) }
            } else if char == "'" || char == "\"" || char.unicodeScalars.first?.value == 96 {
                output.append(char); state = char == "'" ? 3 : char == "\"" ? 4 : 5
            } else if char == "?" {
                if positional.indices.contains(parameterIndex) {
                    appendReplacement(positional[parameterIndex], consuming: index + 1); usedPositions.insert(parameterIndex)
                } else { output.append(char); unresolved += 1 }
                parameterIndex += 1
            } else if char == ":" && (index == 0 || chars[index - 1] != ":") &&
                        next != ":" && next != "=" && (next.isLetter || next == "_") {
                var end = index + 1
                while end < chars.count && (chars[end].isLetter || chars[end].isNumber || chars[end] == "_") { end += 1 }
                let key = String(chars[(index + 1)..<end])
                if let value = named[key] { appendReplacement(value, consuming: end); usedNames.insert(key) }
                else { output += ":\(key)"; unresolved += 1 }
                index = end - 1
            } else if char == "$" && next.isNumber {
                var end = index + 1
                while end < chars.count && chars[end].isNumber { end += 1 }
                let number = Int(String(chars[(index + 1)..<end])) ?? 0
                if positional.indices.contains(number - 1) {
                    appendReplacement(positional[number - 1], consuming: end); usedPositions.insert(number - 1)
                } else { output += String(chars[index..<end]); unresolved += 1 }
                index = end - 1
            } else { output.append(char) }
            index += 1
        }
        return SQLRestoreResult(sql: output, replacementRanges: replacementRanges, unresolved: unresolved,
                                unused: positional.count - usedPositions.count + named.count - usedNames.count)
    }

    private static func parameters(_ text: String) -> ([String], [String: String]) {
        if let data = text.data(using: .utf8),
           let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] {
            return ([], object.mapValues { $0 is NSNull ? "NULL" : sqlLiteral(String(describing: $0), type: nil) })
        }
        var fragments: [String] = []
        var current = "", depth = 0, quote: Character?
        for char in text {
            if char == "'" || char == "\"" {
                if quote == char { quote = nil }
                else if quote == nil { quote = char }
            }
            if quote == nil {
                if char == "(" { depth += 1 }
                if char == ")" { depth = max(0, depth - 1) }
                if char == "," && depth == 0 {
                    fragments.append(current); current = ""; continue
                }
            }
            current.append(char)
        }
        fragments.append(current)
        var positional: [String] = [], named: [String: String] = [:]
        for fragment in fragments {
            let item = fragment.trimmingCharacters(in: .whitespacesAndNewlines)
            if item.isEmpty { continue }
            if let equal = item.firstIndex(of: "=") {
                let key = item[..<equal].trimmingCharacters(in: .whitespaces)
                let value = item[item.index(after: equal)...].trimmingCharacters(in: .whitespaces)
                named[key] = sqlLiteral(value, type: nil)
            } else {
                let start = item.lastIndex(of: "(")
                let type = start.flatMap {
                    item.hasSuffix(")") ? String(item[item.index(after: $0)..<item.index(before: item.endIndex)]) : nil
                }
                let value = start.map { String(item[..<$0]) } ?? item
                positional.append(sqlLiteral(value.trimmingCharacters(in: .whitespaces), type: type))
            }
        }
        return (positional, named)
    }

    private static func sqlLiteral(_ raw: String, type: String?) -> String {
        let value = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        if value.lowercased() == "null" { return "NULL" }
        if ["true", "false"].contains(value.lowercased()) { return value.uppercased() }
        let numericType = type?.lowercased().range(of: #"int|long|short|double|float|decimal|bigdecimal|number"#,
                                                     options: .regularExpression) != nil
        if numericType || (type == nil && Double(value) != nil) { return value }
        let plain = value.hasPrefix("'") && value.hasSuffix("'") && value.count >= 2
            ? String(value.dropFirst().dropLast()) : value
        return "'\(plain.replacingOccurrences(of: "'", with: "''"))'"
    }
}
