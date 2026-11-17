import Foundation

struct CronExpression {
    let minutes: Set<Int>
    let hours: Set<Int>
    let days: Set<Int>
    let months: Set<Int>
    let weekdays: Set<Int>
    let anyDay: Bool
    let anyWeekday: Bool

    static func parse(_ text: String) -> CronExpression? {
        let fields = text.split(whereSeparator: \.isWhitespace).map(String.init)
        guard fields.count == 5,
              let minutes = values(fields[0], bounds: 0...59),
              let hours = values(fields[1], bounds: 0...23),
              let days = values(fields[2], bounds: 1...31),
              let months = values(fields[3], bounds: 1...12, names: [
                  "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
                  "jul": 7, "aug": 8, "sep": 9, "oct": 10, "nov": 11, "dec": 12]),
              let rawWeekdays = values(fields[4], bounds: 0...7, names: [
                  "sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4,
                  "fri": 5, "sat": 6]) else { return nil }
        return CronExpression(minutes: minutes, hours: hours, days: days, months: months,
                              weekdays: Set(rawWeekdays.map { $0 == 7 ? 0 : $0 }),
                              anyDay: fields[2] == "*", anyWeekday: fields[4] == "*")
    }

    private static func values(_ field: String, bounds: ClosedRange<Int>, names: [String: Int] = [:]) -> Set<Int>? {
        var selected = Set<Int>()
        for segment in field.lowercased().split(separator: ",", omittingEmptySubsequences: false) {
            let pair = segment.split(separator: "/", omittingEmptySubsequences: false)
            guard (1...2).contains(pair.count) else { return nil }
            let step = pair.count == 2 ? Int(pair[1]) : 1
            guard let step, step > 0 else { return nil }
            let start: Int
            let end: Int
            if pair[0] == "*" {
                start = bounds.lowerBound
                end = bounds.upperBound
            } else if pair[0].contains("-") {
                let range = pair[0].split(separator: "-", omittingEmptySubsequences: false)
                guard range.count == 2,
                      let low = names[String(range[0])] ?? Int(range[0]),
                      let high = names[String(range[1])] ?? Int(range[1]) else { return nil }
                start = low
                end = high
            } else {
                guard let number = names[String(pair[0])] ?? Int(pair[0]) else { return nil }
                start = number
                end = pair.count == 2 ? bounds.upperBound : number
            }
            guard bounds.contains(start), bounds.contains(end), start <= end else { return nil }
            for value in stride(from: start, through: end, by: step) { selected.insert(value) }
        }
        return selected.isEmpty ? nil : selected
    }

    func nextOccurrences(after date: Date, count: Int = 5,
                         zone: TimeZone = TimeZone(identifier: "Asia/Shanghai")!) -> [Date] {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = zone
        let start = calendar.startOfDay(for: date)
        var result: [Date] = []
        let sortedHours = hours.sorted()
        let sortedMinutes = minutes.sorted()
        for dayOffset in 0..<(366 * 5 + 2) {
            guard let day = calendar.date(byAdding: .day, value: dayOffset, to: start) else { break }
            let components = calendar.dateComponents([.year, .month, .day, .weekday], from: day)
            guard let year = components.year, let month = components.month,
                  let dayNumber = components.day, let weekday = components.weekday,
                  months.contains(month) else { continue }
            let dayMatch = days.contains(dayNumber)
            let weekdayMatch = weekdays.contains((weekday + 6) % 7)
            let matches = anyDay && anyWeekday ? true : anyDay ? weekdayMatch :
                anyWeekday ? dayMatch : dayMatch || weekdayMatch
            guard matches else { continue }
            for hour in sortedHours {
                for minute in sortedMinutes {
                    var candidateComponents = DateComponents()
                    candidateComponents.year = year
                    candidateComponents.month = month
                    candidateComponents.day = dayNumber
                    candidateComponents.hour = hour
                    candidateComponents.minute = minute
                    candidateComponents.second = 0
                    guard let candidate = calendar.date(from: candidateComponents), candidate > date else { continue }
                    let check = calendar.dateComponents([.year, .month, .day, .hour, .minute], from: candidate)
                    guard check.year == year, check.month == month, check.day == dayNumber,
                          check.hour == hour, check.minute == minute else { continue }
                    result.append(candidate)
                    if result.count == count { return result }
                }
            }
        }
        return result
    }
}

extension CronExpression {
    /// 将已解析的范围转成说明，保留日期与星期之间的“或”关系。
    var summary: String {
        func range(_ values: Set<Int>) -> String {
            let sorted = values.sorted()
            guard let first = sorted.first, let last = sorted.last else { return "" }
            if sorted.count > 2, last - first + 1 == sorted.count { return "\(first)–\(last)" }
            return sorted.map(String.init).joined(separator: "、")
        }
        let weekNames = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]
        let week = weekdays == Set(1...5) ? "周一至周五" : weekdays.sorted().map { weekNames[$0] }.joined(separator: "、")
        let date = "每月 \(range(days)) 日"
        let dayRule = anyDay && anyWeekday ? "每天" : anyDay ? week : anyWeekday ? date : "\(date) 或 \(week)"
        var parts: [String] = []
        if months != Set(1...12) { parts.append("\(range(months)) 月") }
        parts.append(dayRule)
        parts.append(hours.count == 24 ? "全天" : "\(range(hours)) 时")
        let sorted = minutes.sorted()
        if minutes.count == 60 { parts.append("每分钟") }
        else if sorted.count > 2, sorted.first == 0,
                let step = sorted.dropFirst().first, step > 0,
                minutes == Set(stride(from: 0, through: 59, by: step)) { parts.append("每 \(step) 分钟") }
        else { parts.append(minutes == [0] ? "整点执行" : "第 \(range(minutes)) 分钟执行") }
        return parts.joined(separator: " · ")
    }
}
