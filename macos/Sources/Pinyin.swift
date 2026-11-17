import Foundation

enum PinyinMatcher {
    private static let cache = NSCache<NSString, NSString>()

    private static func transliteration(_ value: String) -> (String, String) {
        if let saved = cache.object(forKey: value as NSString) as String?,
           let separator = saved.firstIndex(of: "|") {
            return (String(saved[..<separator]), String(saved[saved.index(after: separator)...]))
        }
        let text = NSMutableString(string: value)
        CFStringTransform(text, nil, kCFStringTransformToLatin, false)
        CFStringTransform(text, nil, kCFStringTransformStripCombiningMarks, false)
        let words = (text as String).lowercased().split(whereSeparator: { !$0.isLetter && !$0.isNumber })
        let full = words.joined()
        let initials = words.compactMap(\.first).map(String.init).joined()
        cache.setObject("\(full)|\(initials)" as NSString, forKey: value as NSString)
        return (full, initials)
    }

    static func prepare(_ values: [String]) {
        for value in values where value.unicodeScalars.contains(where: { $0.value >= 0x3400 && $0.value <= 0x9FFF }) {
            _ = transliteration(value)
        }
    }

    static func folded(_ value: String) -> String {
        transliteration(value).0
    }

    static func initials(_ value: String) -> String {
        transliteration(value).1
    }

    static func matches(_ value: String, query: String, enabled: Bool) -> Bool {
        if value.localizedCaseInsensitiveContains(query) { return true }
        guard enabled, query.unicodeScalars.allSatisfy({ $0.isASCII }),
              query.rangeOfCharacter(from: .letters) != nil,
              value.unicodeScalars.contains(where: { $0.value >= 0x3400 && $0.value <= 0x9FFF }) else { return false }
        let needle = query.lowercased().filter { $0.isLetter || $0.isNumber }
        guard !needle.isEmpty else { return false }
        let (full, firstLetters) = transliteration(value)
        return full.contains(needle) || firstLetters.contains(needle)
    }
}
