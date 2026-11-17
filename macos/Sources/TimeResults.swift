import Foundation

struct TimeResult {
    let value: String
    let label: String
}

enum TimeResults {
    private static let china = TimeZone(secondsFromGMT: 8 * 3600)!
    private static let west = TimeZone(identifier: "America/Los_Angeles")!
    private static let latest = Date(timeIntervalSince1970: 4_102_444_800)

    static func entries(for query: String, now: Date = Date()) -> [TimeResult] {
        let trimmed = query.trimmingCharacters(in: .whitespacesAndNewlines)
        switch trimmed.lowercased() {
        case "时间", "sj", "time", "时间戳":
            return results(for: now, sourceLabel: nil) + [
                TimeResult(value: format(now, "HH:mm:ss", china), label: "中国时分秒")]
        case "日期", "rq", "date":
            return [TimeResult(value: format(now, "yyyy-MM-dd", china), label: "中国日期"),
                    TimeResult(value: format(now, "yyyy-MM-dd", west), label: "美西日期")]
        default:
            guard let parsed = parseExpression(trimmed) else { return [] }
            return results(for: parsed.date, sourceLabel: parsed.sourceLabel)
        }
    }

    private static func results(for date: Date, sourceLabel: String?) -> [TimeResult] {
        let suffix = sourceLabel.map { " · 输入\($0)" } ?? ""
        return [TimeResult(value: String(Int64(date.timeIntervalSince1970)), label: "Unix 秒时间戳\(suffix)"),
                TimeResult(value: String(Int64((date.timeIntervalSince1970 * 1000).rounded())), label: "Unix 毫秒时间戳\(suffix)"),
                TimeResult(value: format(date, "yyyy-MM-dd HH:mm:ss", china), label: "中国时间 · UTC+8"),
                TimeResult(value: format(date, "yyyy-MM-dd HH:mm:ss", west), label: "美西时间 · 洛杉矶")]
    }

    static func parseTimestamp(_ value: String) -> Date? {
        guard value.count == 10 || value.count == 13,
              value.utf8.allSatisfy({ $0 >= 48 && $0 <= 57 }),
              let number = Int64(value) else { return nil }
        let seconds = value.count == 13 ? Double(number) / 1000 : Double(number)
        let date = Date(timeIntervalSince1970: seconds)
        guard date >= Date(timeIntervalSince1970: 0), date < latest else { return nil }
        return date
    }

    private static func parseExpression(_ text: String) -> (date: Date, sourceLabel: String)? {
        let parts = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !parts.isEmpty else { return nil }
        var base = parts[0]
        var next = 1
        if parts.count > 1, parts[0].count == 10, parts[0].contains("-"),
           parts[1].range(of: #"^\d{2}:\d{2}:\d{2}$"#, options: .regularExpression) != nil {
            base += " " + parts[1]
            next = 2
        }
        var offset = 8
        if next < parts.count,
           parts[next].range(of: #"^[+-]\d{1,2}$"#, options: .regularExpression) != nil,
           let parsedOffset = Int(parts[next]), (-12...14).contains(parsedOffset) {
            offset = parsedOffset
            next += 1
        }
        guard let zone = TimeZone(secondsFromGMT: offset * 3600),
              var date = parseTimestamp(base) ?? parseLocalDate(base, zone: zone) else { return nil }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        for token in parts.dropFirst(next) {
            guard let match = token.range(of: #"^[+-]\d+[hdymsMf]$"#, options: .regularExpression),
                  match == token.startIndex..<token.endIndex,
                  let amount = Int(token.dropFirst().dropLast()), amount <= 100_000 else { return nil }
            let signed = token.first == "-" ? -amount : amount
            let component: Calendar.Component
            switch token.last! {
            case "s": component = .second
            case "f", "M": component = .minute
            case "h": component = .hour
            case "d": component = .day
            case "m": component = .month
            case "y": component = .year
            default: return nil
            }
            guard let shifted = calendar.date(byAdding: component, value: signed, to: date),
                  shifted >= Date(timeIntervalSince1970: 0), shifted < latest else { return nil }
            date = shifted
        }
        return (date, "UTC\(offset >= 0 ? "+" : "")\(offset)")
    }

    private static func parseLocalDate(_ value: String, zone: TimeZone) -> Date? {
        for pattern in ["yyyy-MM-dd HH:mm:ss", "yyyy-MM-dd'T'HH:mm:ss", "yyyy-MM-dd"] {
            let formatter = DateFormatter()
            formatter.locale = Locale(identifier: "en_US_POSIX")
            formatter.calendar = Calendar(identifier: .gregorian)
            formatter.timeZone = zone
            formatter.isLenient = false
            formatter.dateFormat = pattern
            if let date = formatter.date(from: value), formatter.string(from: date) == value,
               date >= Date(timeIntervalSince1970: 0), date < latest { return date }
        }
        return nil
    }

    static func format(_ date: Date, _ pattern: String, _ zone: TimeZone) -> String {
        let formatter = DateFormatter()
        formatter.locale = Locale(identifier: "en_US_POSIX")
        formatter.timeZone = zone
        formatter.dateFormat = pattern
        return formatter.string(from: date)
    }
}
