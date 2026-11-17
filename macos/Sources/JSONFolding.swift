import Foundation

/// 所有字符偏移都使用 UTF-16；end 指向闭括号之后，行号从 1 开始。
struct JSONFoldRegion: Hashable {
    let start: Int
    let end: Int
    let startLine: Int
    let endLine: Int

    var range: NSRange { NSRange(location: start, length: end - start) }
    var contentRange: NSRange { NSRange(location: start + 1, length: end - start - 2) }
    var placeholder: String { " … \(endLine - startLine) 行 " }
}

struct JSONFoldVisibleRegion {
    let region: JSONFoldRegion
    let lineIndex: Int
    let openingOffset: Int
    let isCollapsed: Bool
}

private struct JSONFoldSegment {
    let projected: NSRange
    let source: NSRange
    let isPlaceholder: Bool
}

/// 折叠只改变显示文本；通过选区映射仍可复制完整 JSON。
struct JSONFoldProjection {
    let text: String
    let lineNumbers: [Int]
    let lineStarts: [Int]
    let visibleRegions: [JSONFoldVisibleRegion]
    private let segments: [JSONFoldSegment]
    private let sourceLength: Int
    private let projectedLength: Int

    fileprivate init(text: String, sourceLength: Int, sourceLineStarts: [Int],
                     segments: [JSONFoldSegment], regions: [JSONFoldRegion], collapsed: Set<Int>) {
        self.text = text
        self.sourceLength = sourceLength
        let visibleLength = (text as NSString).length
        self.projectedLength = visibleLength
        self.segments = segments
        let starts = collapsed.isEmpty ? sourceLineStarts : JSONFoldDocument.lineStarts(in: Array(text.utf16))
        self.lineStarts = starts
        self.lineNumbers = collapsed.isEmpty ? Array(1...starts.count) : starts.map { offset in
            let original = Self.sourceOffset(offset, ending: false, segments: segments, sourceLength: sourceLength)
            return Self.lineIndex(containing: original, starts: sourceLineStarts) + 1
        }
        self.visibleRegions = regions.compactMap { region in
            if let segment = Self.segment(containingSource: region.start, segments: segments), segment.isPlaceholder {
                return nil
            }
            let offset = Self.projectedOffset(region.start, segments: segments, projectedLength: visibleLength)
            return JSONFoldVisibleRegion(region: region, lineIndex: Self.lineIndex(containing: offset, starts: starts),
                                         openingOffset: offset, isCollapsed: collapsed.contains(region.start))
        }
    }

    /// 选中省略标记的任何部分，都会包含它代表的完整内容。
    func sourceRange(for projectedRange: NSRange) -> NSRange {
        guard projectedRange.location != NSNotFound else { return NSRange(location: sourceLength, length: 0) }
        let start = min(projectedLength, max(0, projectedRange.location))
        let length = min(max(0, projectedRange.length), projectedLength - start)
        let sourceStart = Self.sourceOffset(start, ending: false, segments: segments, sourceLength: sourceLength)
        if length == 0 { return NSRange(location: sourceStart, length: 0) }
        let sourceEnd = Self.sourceOffset(start + length, ending: true, segments: segments, sourceLength: sourceLength)
        return NSRange(location: sourceStart, length: max(0, sourceEnd - sourceStart))
    }

    func projectedOffset(forSourceOffset offset: Int) -> Int {
        Self.projectedOffset(min(sourceLength, max(0, offset)), segments: segments, projectedLength: projectedLength)
    }

    private static func sourceOffset(_ offset: Int, ending: Bool,
                                     segments: [JSONFoldSegment], sourceLength: Int) -> Int {
        // 选区终点落在分段边界时，优先使用上一段，避免吸入下一段隐藏内容。
        var low = 0
        var high = segments.count
        while low < high {
            let middle = (low + high) / 2
            let end = NSMaxRange(segments[middle].projected)
            if end < offset || (!ending && end == offset) { low = middle + 1 } else { high = middle }
        }
        guard low < segments.count else { return sourceLength }
        let segment = segments[low]
        let distance = offset - segment.projected.location
        if distance <= 0 { return segment.source.location }
        if distance >= segment.projected.length { return NSMaxRange(segment.source) }
        if segment.isPlaceholder { return ending ? NSMaxRange(segment.source) : segment.source.location }
        return segment.source.location + distance
    }

    private static func segment(containingSource offset: Int, segments: [JSONFoldSegment]) -> JSONFoldSegment? {
        var low = 0
        var high = segments.count
        while low < high {
            let middle = (low + high) / 2
            if NSMaxRange(segments[middle].source) <= offset { low = middle + 1 } else { high = middle }
        }
        return low < segments.count ? segments[low] : nil
    }

    private static func projectedOffset(_ offset: Int, segments: [JSONFoldSegment], projectedLength: Int) -> Int {
        guard let segment = segment(containingSource: offset, segments: segments) else { return projectedLength }
        if segment.isPlaceholder { return segment.projected.location }
        return segment.projected.location + offset - segment.source.location
    }

    private static func lineIndex(containing offset: Int, starts: [Int]) -> Int {
        var low = 0
        var high = starts.count
        while low < high {
            let middle = (low + high) / 2
            if starts[middle] <= offset { low = middle + 1 } else { high = middle }
        }
        return max(0, low - 1)
    }
}

struct JSONFoldDocument {
    private(set) var source: String
    private(set) var regions: [JSONFoldRegion]
    private(set) var collapsed: Set<Int> = []
    private var sourceLineStarts: [Int]
    var lineCount: Int { source.isEmpty ? 0 : sourceLineStarts.count }

    init(source: String, scanRegions: Bool = true) {
        self.source = source
        let units = Array(source.utf16)
        self.sourceLineStarts = Self.lineStarts(in: units)
        self.regions = scanRegions ? Self.regions(in: units) : []
    }

    mutating func reset(source: String) {
        self = Self(source: source)
    }

    /// 编辑完整正文，并平移未被修改的折叠区域；暂时不完整的 JSON 也保留这些安全区域。
    @discardableResult
    mutating func replaceCharacters(in range: NSRange, with replacement: String) -> Bool {
        let original = source as NSString
        guard range.location != NSNotFound, range.location >= 0, range.length >= 0,
              range.location <= original.length, range.length <= original.length - range.location else { return false }
        let delta = (replacement as NSString).length - range.length
        let retained = regions.filter { region in
            guard collapsed.contains(region.start) else { return false }
            if range.length == 0 { return range.location <= region.start || range.location >= region.end }
            return NSIntersectionRange(region.range, range).length == 0
        }
        let updated = original.replacingCharacters(in: range, with: replacement)
        self = Self(source: updated)
        let updatedLength = (updated as NSString).length
        let parsed = Set(regions)
        for region in retained {
            let shift = NSMaxRange(range) <= region.start ? delta : 0
            let start = region.start + shift, end = region.end + shift
            guard start >= 0, end <= updatedLength, end > start else { continue }
            let moved = JSONFoldRegion(start: start, end: end,
                startLine: sourceLineStarts.partitionIndex(after: start),
                endLine: sourceLineStarts.partitionIndex(after: end - 1))
            if !parsed.contains(moved) { regions.append(moved) }
            collapsed.insert(start)
        }
        regions.sort { $0.start < $1.start }
        return true
    }

    /// 撤销、重做或输入法提交后，按真实的文本差异恢复未受影响的折叠状态。
    mutating func replaceSourcePreservingFolds(_ value: String) {
        guard value != source else { return }
        let before = Array(source.utf16), after = Array(value.utf16)
        var prefix = 0, suffix = 0
        while prefix < min(before.count, after.count), before[prefix] == after[prefix] { prefix += 1 }
        if prefix > 0, (0xD800...0xDBFF).contains(before[prefix - 1]) { prefix -= 1 }
        while suffix < min(before.count, after.count) - prefix,
              before[before.count - suffix - 1] == after[after.count - suffix - 1] { suffix += 1 }
        if suffix > 0, (0xDC00...0xDFFF).contains(before[before.count - suffix]) { suffix -= 1 }
        let replacement = (value as NSString).substring(with: NSRange(location: prefix, length: after.count - prefix - suffix))
        replaceCharacters(in: NSRange(location: prefix, length: before.count - prefix - suffix), with: replacement)
    }

    mutating func toggle(start: Int) {
        guard regions.contains(where: { $0.start == start }) else { return }
        if collapsed.contains(start) { collapsed.remove(start) } else { collapsed.insert(start) }
    }

    mutating func expandAll() { collapsed.removeAll() }
    mutating func expand(starts: Set<Int>) { collapsed.subtract(starts) }
    mutating func collapseAll() { collapsed = Set(regions.map(\.start)) }

    func projection() -> JSONFoldProjection {
        let original = source as NSString
        if collapsed.isEmpty {
            let full = NSRange(location: 0, length: original.length)
            return JSONFoldProjection(text: source, sourceLength: original.length, sourceLineStarts: sourceLineStarts,
                segments: original.length == 0 ? [] : [JSONFoldSegment(projected: full, source: full, isPlaceholder: false)],
                regions: regions, collapsed: [])
        }
        let rendered = NSMutableString(capacity: original.length)
        var segments: [JSONFoldSegment] = []
        var cursor = 0

        func append(_ range: NSRange, replacement: String? = nil) {
            guard range.length > 0 else { return }
            let text = replacement ?? original.substring(with: range)
            let projected = NSRange(location: rendered.length, length: (text as NSString).length)
            rendered.append(text)
            segments.append(JSONFoldSegment(projected: projected, source: range, isPlaceholder: replacement != nil))
        }

        for region in regions where collapsed.contains(region.start) {
            let content = region.contentRange
            // 外层折叠已覆盖的子区域保留状态，但不会重复替换。
            guard content.location >= cursor else { continue }
            append(NSRange(location: cursor, length: content.location - cursor))
            append(content, replacement: region.placeholder)
            cursor = NSMaxRange(content)
        }
        append(NSRange(location: cursor, length: original.length - cursor))
        return JSONFoldProjection(text: rendered as String, sourceLength: original.length,
                                  sourceLineStarts: sourceLineStarts, segments: segments,
                                  regions: regions, collapsed: collapsed)
    }

    fileprivate static func lineStarts(in units: [UInt16]) -> [Int] {
        var starts = [0]
        for index in units.indices {
            let unit = units[index]
            if unit == 10 || unit == 0x2028 || unit == 0x2029 {
                starts.append(index + 1)
            } else if unit == 13, index + 1 == units.count || units[index + 1] != 10 {
                starts.append(index + 1)
            }
        }
        return starts
    }

    private static func regions(in units: [UInt16]) -> [JSONFoldRegion] {
        var stack: [(opening: UInt16, offset: Int, line: Int)] = []
        var found: [JSONFoldRegion] = []
        var line = 1
        var insideString = false
        var escaped = false
        for index in units.indices {
            let unit = units[index]
            if unit == 10 || unit == 0x2028 || unit == 0x2029 ||
                (unit == 13 && (index + 1 == units.count || units[index + 1] != 10)) { line += 1 }
            if insideString {
                if escaped { escaped = false }
                else if unit == 92 { escaped = true }
                else if unit == 34 { insideString = false }
                continue
            }
            if unit == 34 { insideString = true; continue }
            if unit == 123 || unit == 91 {
                guard stack.count < 128 else { return [] }
                stack.append((unit, index, line)); continue
            }
            if unit == 125 || unit == 93 {
                guard let opening = stack.popLast(),
                      (opening.opening == 123 && unit == 125) || (opening.opening == 91 && unit == 93) else { return [] }
                if opening.line < line {
                    found.append(JSONFoldRegion(start: opening.offset, end: index + 1,
                                                startLine: opening.line, endLine: line))
                }
            }
        }
        guard stack.isEmpty, !insideString else { return [] }
        return found.sorted { $0.start < $1.start }
    }
}

private extension Array where Element == Int {
    /// 返回包含该 UTF-16 偏移的行号（从 1 开始）。
    func partitionIndex(after offset: Int) -> Int {
        var low = 0, high = count
        while low < high {
            let middle = (low + high) / 2
            if self[middle] <= offset { low = middle + 1 } else { high = middle }
        }
        return Swift.max(1, low)
    }
}
