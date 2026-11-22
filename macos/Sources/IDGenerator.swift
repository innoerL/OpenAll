import AppKit

struct IDRegion: Decodable {
    let name: String
    let code: String
    let cityLevel: Bool?
}

struct IDCity: Decodable {
    let name: String
    let code: String
    let regions: [IDRegion]
    let grouping: Bool?
}

struct IDProvince: Decodable {
    let name: String
    let code: String
    let cities: [IDCity]
    var regions: [IDRegion] { cities.flatMap(\.regions) }
}

struct IDRegionData: Decodable {
    let version: String
    let amendmentsThrough: String
    let provinces: [IDProvince]
}

enum ChineseIDGenerator {
    // 与 Windows 使用同一份地区 JSON；正式应用只读取包内资源，不读取用户目录。
    static let regionData: IDRegionData? = {
        guard let url = Bundle.main.url(forResource: "id-regions", withExtension: "json"),
              let data = try? Data(contentsOf: url),
              let decoded = try? JSONDecoder().decode(IDRegionData.self, from: data),
              !decoded.provinces.isEmpty else { return nil }
        let regions = decoded.provinces.flatMap(\.regions)
        guard regions.allSatisfy({ $0.code.utf8.count == 6 && $0.code.utf8.allSatisfy({ (48...57).contains($0) }) }),
              Set(regions.map(\.code)).count == regions.count else { return nil }
        return decoded
    }()
    static var provinces: [IDProvince] { regionData?.provinces ?? [] }

    struct Birthday: Equatable {
        let year: Int
        let month: Int
        let day: Int
        let clamped: Bool
        var text: String { String(format: "%04d-%02d-%02d", year, month, day) }
    }

    static func birthdayFromAge(_ age: Int, referenceDate: Date = Date(), timeZone: TimeZone = .current) -> Birthday? {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = timeZone
        let today = calendar.dateComponents([.year, .month, .day], from: referenceDate)
        guard let currentYear = today.year, let month = today.month, let day = today.day,
              age >= 0, age <= currentYear - 1900 else { return nil }
        let year = currentYear - age
        guard let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
              let days = calendar.range(of: .day, in: .month, for: date) else { return nil }
        let targetDay = min(day, days.count)
        return Birthday(year: year, month: month, day: targetDay, clamped: targetDay != day)
    }

    static func candidateRegions(for options: Options) -> [IDRegion]? {
        guard [options.provinceIndex, options.cityIndex, options.regionIndex].compactMap({ $0 }).allSatisfy({ $0 >= 0 }) else { return nil }
        guard options.provinceIndex != nil || (options.cityIndex == nil && options.regionIndex == nil) else { return nil }
        let selected: [IDProvince]
        if let index = options.provinceIndex {
            guard provinces.indices.contains(index) else { return nil }
            selected = [provinces[index]]
        } else { selected = provinces }
        let regions = selected.flatMap { province -> [IDRegion] in
            let candidates: [IDRegion]
            if let city = options.cityIndex {
                guard province.cities.indices.contains(city) else { return [] }
                candidates = province.cities[city].regions
            } else { candidates = province.regions }
            if let region = options.regionIndex {
                return candidates.indices.contains(region) ? [candidates[region]] : []
            }
            return candidates
        }
        return regions.isEmpty ? nil : regions
    }
    static let weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2]
    static let checks = Array("10X98765432")
    private static let allBirthdays: [(Int, Int, Int)] = {
        let calendar = Calendar(identifier: .gregorian)
        var dates: [(Int, Int, Int)] = []
        for year in 1960...2005 {
            for month in 1...12 {
                guard let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
                      let range = calendar.range(of: .day, in: .month, for: date) else { continue }
                for day in range { dates.append((year, month, day)) }
            }
        }
        return dates
    }()

    struct Options {
        var provinceIndex: Int? = nil
        var cityIndex: Int? = nil
        var regionIndex: Int? = nil
        var year: Int? = nil
        var month: Int? = nil
        var day: Int? = nil
        var gender: String? = nil
        var count = 1
    }

    static func generate() -> String { generate(Options())?.first ?? "" }

    static func generate(_ options: Options) -> [String]? {
        guard (1...500).contains(options.count) else { return nil }
        guard let regions = candidateRegions(for: options) else { return nil }
        guard options.year.map({ (1900...2100).contains($0) }) ?? true,
              options.month.map({ (1...12).contains($0) }) ?? true,
              options.day.map({ (1...31).contains($0) }) ?? true else { return nil }
        let birthdays: [(Int, Int, Int)]
        if let year = options.year, !(1960...2005).contains(year) {
            let calendar = Calendar(identifier: .gregorian)
            var dates: [(Int, Int, Int)] = []
            for month in options.month.map({ [$0] }) ?? Array(1...12) {
                guard let date = calendar.date(from: DateComponents(year: year, month: month, day: 1)),
                      let range = calendar.range(of: .day, in: .month, for: date) else { continue }
                for day in options.day.map({ [$0] }) ?? Array(range) where range.contains(day) {
                    dates.append((year, month, day))
                }
            }
            birthdays = dates
        } else {
            birthdays = allBirthdays.filter { date in
                (options.year == nil || options.year == date.0)
                    && (options.month == nil || options.month == date.1)
                    && (options.day == nil || options.day == date.2)
            }
        }
        guard !birthdays.isEmpty else { return nil }
        var generated: [String] = []
        var seen = Set<String>()
        var attempts = 0
        while generated.count < options.count && attempts < 100_000 {
            attempts += 1
            let region = regions.randomElement()!
            let birthday = birthdays.randomElement()!
            let sequence: Int
            switch options.gender {
            case "男": sequence = Int.random(in: 0...499) * 2 + 1
            case "女": sequence = Int.random(in: 0...499) * 2
            default: sequence = Int.random(in: 1...999)
            }
            let prefix = region.code + String(format: "%04d%02d%02d%03d", birthday.0, birthday.1, birthday.2, sequence)
            let sum = zip(prefix.compactMap(\.wholeNumberValue), weights).reduce(0) { $0 + $1.0 * $1.1 }
            let number = prefix + String(checks[sum % 11])
            if seen.insert(number).inserted { generated.append(number) }
        }
        return generated.count == options.count ? generated : nil
    }
    static func verifyModel() -> Bool {
        let all = provinces.flatMap(\.regions)
        guard provinces.count == 31, provinces.reduce(0, { $0 + $1.cities.count }) == 341,
              all.count == 2851, Set(all.map(\.code)).count == 2851,
              all.contains(where: { $0.code == "653132" && $0.name == "岑岭县" }),
              all.contains(where: { $0.code == "659013" && $0.name == "草湖市" }) else { return false }
        for (p, province) in provinces.enumerated() {
            for (c, city) in province.cities.enumerated() {
                guard candidateRegions(for: .init(provinceIndex: p, cityIndex: c))?.map(\.code) == city.regions.map(\.code) else { return false }
                for (r, region) in city.regions.enumerated() {
                    guard candidateRegions(for: .init(provinceIndex: p, cityIndex: c, regionIndex: r))?.map(\.code) == [region.code] else { return false }
                }
            }
        }
        guard Set(all.filter({ $0.cityLevel == true }).map(\.code)) == Set(["441900", "442000", "460400", "620200"]),
              candidateRegions(for: .init(cityIndex: 0)) == nil,
              candidateRegions(for: .init(provinceIndex: -1)) == nil,
              candidateRegions(for: .init(provinceIndex: 0, cityIndex: 999)) == nil else { return false }
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(secondsFromGMT: 0)!
        let leap = calendar.date(from: DateComponents(year: 2024, month: 2, day: 29, hour: 12))!
        guard birthdayFromAge(1, referenceDate: leap, timeZone: calendar.timeZone) == Birthday(year: 2023, month: 2, day: 28, clamped: true),
              birthdayFromAge(4, referenceDate: leap, timeZone: calendar.timeZone) == Birthday(year: 2020, month: 2, day: 29, clamped: false),
              birthdayFromAge(0, referenceDate: leap, timeZone: calendar.timeZone) == Birthday(year: 2024, month: 2, day: 29, clamped: false),
              birthdayFromAge(-1, referenceDate: leap) == nil,
              birthdayFromAge(125, referenceDate: leap) == nil else { return false }
        let boundary = calendar.date(from: DateComponents(year: 2026, month: 1, day: 1, hour: 1))!
        guard birthdayFromAge(25, referenceDate: boundary, timeZone: TimeZone(secondsFromGMT: -8 * 3600)!)?.text == "2000-12-31",
              birthdayFromAge(25, referenceDate: boundary, timeZone: TimeZone(secondsFromGMT: 8 * 3600)!)?.text == "2001-01-01" else { return false }
        guard let female = generate(.init(provinceIndex: 0, cityIndex: 0, regionIndex: 0, year: 2000, month: 2, day: 29, gender: "女", count: 500)),
              female.count == 500, Set(female).count == 500,
              female.allSatisfy({ $0.hasPrefix("11010120000229") && (Int(String($0.dropFirst(16).prefix(1))) ?? 1) % 2 == 0 }),
              generate(.init(year: 2001, month: 2, day: 29)) == nil else { return false }
        for number in female {
            let sum = zip(number.prefix(17).compactMap(\.wholeNumberValue), weights).reduce(0) { $0 + $1.0 * $1.1 }
            guard number.last == checks[sum % 11] else { return false }
        }
        return true
    }

}

private final class IDNumberTextView: NSTextView {
    var didCopyRow: ((Int) -> Void)?

    override func draw(_ dirtyRect: NSRect) {
        NSGraphicsContext.saveGraphicsState()
        super.draw(dirtyRect)
        NSGraphicsContext.restoreGraphicsState()
        let rows = string.components(separatedBy: "\n")
        for (index, value) in rows.enumerated() where !value.isEmpty {
            let rect = NSRect(x: min(bounds.width, visibleRect.maxX) - 76, y: textContainerInset.height + 12 + CGFloat(index) * 26, width: 48, height: 23)
            guard rect.intersects(dirtyRect) else { continue }
            ("\(index + 1)" as NSString).draw(in: NSRect(x: 12, y: rect.minY, width: 24, height: 23), withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 12, weight: .regular), .foregroundColor: OpenAllTheme.muted])
            ("复制" as NSString).draw(in: rect, withAttributes: [.font: NSFont.systemFont(ofSize: 12, weight: .medium),
                                                              .foregroundColor: OpenAllTheme.accentText])
        }
    }
    override func mouseDown(with event: NSEvent) {
        let point = convert(event.locationInWindow, from: nil)
        let index = Int(floor((point.y - textContainerInset.height - 12) / 26))
        let rows = string.components(separatedBy: "\n")
        if point.x >= min(bounds.width, visibleRect.maxX) - 76, point.x <= min(bounds.width, visibleRect.maxX) - 76 + 48, rows.indices.contains(index), !rows[index].isEmpty {
            NSPasteboard.general.clearContents()
            NSPasteboard.general.setString(rows[index], forType: .string)
            let offset = rows.prefix(index).reduce(0) { $0 + $1.utf16.count + 1 }
            setSelectedRange(NSRange(location: offset, length: rows[index].utf16.count))
            didCopyRow?(index + 1)
            return
        }
        super.mouseDown(with: event)
    }
}

final class IDGeneratorWindow: NSObject, NSTextFieldDelegate {
    private var window: NSWindow?
    private var province: NSPopUpButton!
    private var city: NSPopUpButton!
    private var region: NSPopUpButton!
    private var gender: NSPopUpButton!
    private var age: NSTextField!
    private var year: NSTextField!
    private var month: NSTextField!
    private var day: NSTextField!
    private var count: NSTextField!
    private var result: NSTextView!
    private var resultLabel: NSTextField!
    private var status: NSTextField!

    func show() {
        if window == nil { build() }
        WindowChrome.present(window)
        WindowChrome.activate()
    }

    private func build() {
        let w = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 660, height: 480),
                         styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
        w.isReleasedWhenClosed = false
        WindowChrome.apply(w, title: "身份证测试号生成器")
        w.minSize = NSSize(width: 660, height: 480)
        w.center()
        let root = NSView(frame: w.contentView!.bounds)
        root.wantsLayer = true
        root.layer?.backgroundColor = OpenAllTheme.canvas.cgColor
        root.appearance = OpenAllTheme.appearance
        w.contentView = root
        for (title, x) in [("省份", CGFloat(24)), ("城市", 234), ("区县", 444)] {
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 12, weight: .medium)
            label.textColor = OpenAllTheme.muted
            label.frame = NSRect(x: x, y: 405, width: 140, height: 18)
            root.addSubview(label)
        }
        province = NSPopUpButton(frame: NSRect(x: 24, y: 374, width: 196, height: 30))
        WindowChrome.stylePopUp(province)
        province.addItem(withTitle: "随机省份")
        for item in ChineseIDGenerator.provinces { province.addItem(withTitle: item.name) }
        province.target = self
        province.action = #selector(provinceChanged)
        root.addSubview(province)
        city = NSPopUpButton(frame: NSRect(x: 234, y: 374, width: 196, height: 30))
        WindowChrome.stylePopUp(city)
        city.target = self
        city.action = #selector(cityChanged)
        root.addSubview(city)
        region = NSPopUpButton(frame: NSRect(x: 444, y: 374, width: 192, height: 30))
        WindowChrome.stylePopUp(region)
        region.target = self
        region.action = #selector(regionChanged)
        root.addSubview(region)
        for button in [province, city, region].compactMap({ $0 }) {
            button.cell?.lineBreakMode = .byTruncatingTail
        }
        provinceChanged()
        for (title, x, width) in [("按年龄推算", CGFloat(24), CGFloat(78)),
                                   ("出生日期 · 可手填", 126, 180),
                                   ("性别", 24, 140), ("生成数量 · 1–500", 186, 168)] {
            let label = NSTextField(labelWithString: title)
            label.font = .systemFont(ofSize: 11, weight: .medium)
            label.textColor = OpenAllTheme.muted
            label.frame = NSRect(x: x, y: title == "性别" || title.hasPrefix("生成数量") ? 274 : 335, width: width, height: 18)
            root.addSubview(label)
        }
        age = numericField("周岁", x: 24, y: 304, width: 70, root: root)
        age.setAccessibilityLabel("年龄")
        let arrow = NSImageView(image: NSImage(systemSymbolName: "arrow.right", accessibilityDescription: "年龄自动回填生日") ?? NSImage())
        arrow.frame = NSRect(x: 100, y: 313, width: 16, height: 14)
        arrow.contentTintColor = OpenAllTheme.muted
        root.addSubview(arrow)
        year = numericField("年", x: 126, y: 304, width: 62, root: root)
        month = numericField("月", x: 194, y: 304, width: 53, root: root)
        day = numericField("日", x: 253, y: 304, width: 53, root: root)
        gender = NSPopUpButton(frame: NSRect(x: 24, y: 244, width: 140, height: 30))
        WindowChrome.stylePopUp(gender)
        gender.addItems(withTitles: ["随机性别", "男", "女"])
        root.addSubview(gender)
        count = numericField("数量", x: 186, y: 244, width: 144, root: root)
        count.stringValue = "5"
        let generate = NSButton(title: "生成测试号", target: self, action: #selector(regenerate))
        generate.frame = NSRect(x: 504, y: 244, width: 132, height: 30)
        WindowChrome.styleAction(generate, primary: true)
        generate.keyEquivalent = "\r"
        root.addSubview(generate)
        let birthdayHint = NSTextField(labelWithString: "按周岁沿用今天的月日，生日留空则随机。")
        birthdayHint.font = .systemFont(ofSize: 12)
        birthdayHint.textColor = OpenAllTheme.muted
        birthdayHint.frame = NSRect(x: 325, y: 310, width: 309, height: 18)
        root.addSubview(birthdayHint)
        resultLabel = NSTextField(labelWithString: "生成结果")
        resultLabel.font = .systemFont(ofSize: 13, weight: .semibold)
        resultLabel.textColor = OpenAllTheme.ink
        resultLabel.frame = NSRect(x: 24, y: 214, width: 160, height: 24)
        root.addSubview(resultLabel)
        let scroll = NSScrollView(frame: NSRect(x: 24, y: 54, width: 612, height: 156))
        scroll.hasVerticalScroller = true
        let numberView = IDNumberTextView(frame: scroll.bounds)
        numberView.didCopyRow = { [weak self] row in
            self?.status.stringValue = "已复制第 \(row) 条测试号"
            self?.status.textColor = OpenAllTheme.ink
        }
        result = numberView
        let paragraph = NSMutableParagraphStyle()
        paragraph.minimumLineHeight = 26
        paragraph.maximumLineHeight = 26
        result.defaultParagraphStyle = paragraph
        result.isRichText = false
        result.font = .monospacedSystemFont(ofSize: 14, weight: .regular)
        result.isEditable = false
        result.isSelectable = true
        result.isVerticallyResizable = true
        result.isHorizontallyResizable = false
        result.autoresizingMask = [.width]
        result.textContainer?.widthTracksTextView = true
        result.textContainerInset = NSSize(width: 44, height: 14)
        WindowChrome.styleEditor(scroll, text: result)
        scroll.documentView = result
        root.addSubview(scroll)
        status = NSTextField(labelWithString: "已收录 2851 个末级地区编码；号码只用于格式校验。")
        status.textColor = .secondaryLabelColor
        status.frame = NSRect(x: 24, y: 16, width: 600, height: 24)
        root.addSubview(status)
        let copy = NSButton(title: "复制全部", target: self, action: #selector(copyNumbers))
        copy.frame = NSRect(x: 532, y: 216, width: 104, height: 28)
        WindowChrome.styleOutputAction(copy)
        root.addSubview(copy)
        for (field, title) in [(province!, "省份"), (city!, "城市"), (region!, "区县"), (gender!, "性别")] { field.setAccessibilityLabel(title) }
        for (field, title) in [(year!, "出生年份"), (month!, "出生月份"), (day!, "出生日期"), (count!, "生成数量")] { field.setAccessibilityLabel(title) }
        for view in root.subviews { view.autoresizingMask = [.minYMargin] }
        scroll.autoresizingMask = [.width, .height]
        copy.autoresizingMask = [.minXMargin, .minYMargin]
        status.autoresizingMask = [.width]
        WindowChrome.installControls(on: w)
        window = w
        regenerate()
    }

    private func numericField(_ placeholder: String, x: CGFloat, y: CGFloat, width: CGFloat, root: NSView) -> NSTextField {
        let field = NSTextField(frame: NSRect(x: x, y: y, width: width, height: 32))
        field.placeholderString = placeholder
        field.font = .systemFont(ofSize: 13)
        WindowChrome.styleInput(field)
        field.delegate = self
        root.addSubview(field)
        return field
    }

    private var selectedProvince: IDProvince? {
        let index = province.indexOfSelectedItem - 1
        return ChineseIDGenerator.provinces.indices.contains(index) ? ChineseIDGenerator.provinces[index] : nil
    }

    private var selectedCity: IDCity? {
        guard let cities = selectedProvince?.cities else { return nil }
        let index = city.indexOfSelectedItem - 1
        return cities.indices.contains(index) ? cities[index] : nil
    }

    private func updateMenu(_ button: NSPopUpButton, placeholder: String, values: [(String, String)], enabled: Bool) {
        button.removeAllItems()
        button.addItem(withTitle: placeholder)
        for (name, code) in values {
            button.addItem(withTitle: name)
            button.lastItem?.toolTip = "\(name) · \(code)"
        }
        button.selectItem(at: 0)
        button.isEnabled = enabled
        updateTooltip(button)
    }

    private func updateTooltip(_ button: NSPopUpButton) {
        button.toolTip = button.selectedItem?.toolTip ?? button.titleOfSelectedItem
    }

    @objc private func provinceChanged() {
        updateMenu(city, placeholder: "随机城市", values: selectedProvince?.cities.map({ ($0.name, $0.code) }) ?? [], enabled: selectedProvince != nil)
        updateMenu(region, placeholder: "随机区县", values: [], enabled: false)
        updateTooltip(province)
    }

    @objc private func cityChanged() {
        updateMenu(region, placeholder: "随机区县", values: selectedCity?.regions.map({ ($0.name, $0.code) }) ?? [], enabled: selectedCity != nil)
        updateTooltip(city)
    }

    @objc private func regionChanged() { updateTooltip(region) }

    private func setStatus(_ text: String, error: Bool = false) {
        status.stringValue = text
        status.textColor = error ? .systemRed : .secondaryLabelColor
    }

    private func markAgeInvalid(_ invalid: Bool) {
        age.layer?.borderColor = (invalid ? NSColor.systemRed : OpenAllTheme.rule).cgColor
        age.setAccessibilityHelp(invalid ? "年龄无效，请修正或清空年龄" : nil)
    }

    private func applyAge(referenceDate: Date = Date()) throws -> ChineseIDGenerator.Birthday? {
        let value = age.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !value.isEmpty else { markAgeInvalid(false); return nil }
        let maximum = Calendar(identifier: .gregorian).component(.year, from: referenceDate) - 1900
        guard value.utf8.allSatisfy({ (48...57).contains($0) }), let years = Int(value),
              let birthday = ChineseIDGenerator.birthdayFromAge(years, referenceDate: referenceDate) else {
            markAgeInvalid(true)
            throw NSError(domain: "IDGeneratorAge", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "年龄需为 0–\(maximum) 的整数；请修正或清空年龄"])
        }
        year.stringValue = String(birthday.year)
        month.stringValue = String(birthday.month)
        day.stringValue = String(birthday.day)
        markAgeInvalid(false)
        return birthday
    }

    func controlTextDidChange(_ notification: Notification) {
        guard let field = notification.object as? NSTextField else { return }
        if field === age {
            do {
                if let birthday = try applyAge() {
                    setStatus("已按 \(Int(age.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)) ?? 0) 岁回填 \(birthday.text)" + (birthday.clamped ? " · 非闰年已取 2 月 28 日" : " · 可直接修改出生日期"))
                } else { setStatus("已清空年龄，保留当前出生日期") }
            } catch { setStatus(error.localizedDescription, error: true) }
        } else if field === year || field === month || field === day {
            age.stringValue = ""
            markAgeInvalid(false)
            setStatus("出生日期已手动修改，年龄联动已清除")
        }
    }

    private func optionalNumber(_ field: NSTextField) -> Int? {
        let clean = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
        return clean.isEmpty ? nil : Int(clean)
    }

    @objc private func regenerate() {
        guard !ChineseIDGenerator.provinces.isEmpty else {
            setStatus("地区数据未加载，请重新安装完整应用包", error: true)
            return
        }
        let birthday: ChineseIDGenerator.Birthday?
        do { birthday = try applyAge() }
        catch { setStatus(error.localizedDescription, error: true); return }
        let fields = [year, month, day, count].compactMap { $0 }
        guard fields.allSatisfy({ field in
            let clean = field.stringValue.trimmingCharacters(in: .whitespacesAndNewlines)
            return clean.isEmpty || (clean.utf8.allSatisfy({ (48...57).contains($0) }) && Int(clean) != nil)
        }) else { status.stringValue = "日期和数量只能填写整数"; status.textColor = .systemRed; return }
        var options = ChineseIDGenerator.Options()
        options.provinceIndex = province.indexOfSelectedItem > 0 ? province.indexOfSelectedItem - 1 : nil
        options.cityIndex = city.indexOfSelectedItem > 0 ? city.indexOfSelectedItem - 1 : nil
        options.regionIndex = region.indexOfSelectedItem > 0 ? region.indexOfSelectedItem - 1 : nil
        options.year = optionalNumber(year)
        options.month = optionalNumber(month)
        options.day = optionalNumber(day)
        options.gender = gender.indexOfSelectedItem > 0 ? gender.titleOfSelectedItem : nil
        options.count = optionalNumber(count) ?? 1
        guard let numbers = ChineseIDGenerator.generate(options) else {
            status.stringValue = "请检查日期和数量；数量需为 1–500，日期需真实存在。"
            status.textColor = .systemRed
            return
        }
        resultLabel.stringValue = "测试号码 · \(numbers.count) 条"
        result.string = numbers.joined(separator: "\n")
        // 仅用字距分隔地区、生日和顺序校验段，选择和复制仍保留完整号码。
        if let storage = result.textStorage {
            storage.beginEditing()
            for index in numbers.indices {
                let offset = index * 19
                for boundary in [5, 13] {
                    storage.addAttribute(.kern, value: 5, range: NSRange(location: offset + boundary, length: 1))
                }
            }
            storage.endEditing()
        }
        status.stringValue = birthday.map { "出生日期 " + $0.text } ?? ""
        status.textColor = .secondaryLabelColor
    }

    // 离屏验收只操作本窗口控件，不写剪贴板、偏好或真实用户数据。
    @MainActor func verifyForDesign() -> Bool {
        guard DesignPreview.enabled, window != nil, ChineseIDGenerator.verifyModel() else { return false }
        let savedProvince = province.indexOfSelectedItem, savedCity = city.indexOfSelectedItem, savedRegion = region.indexOfSelectedItem
        let fields = [age!, year!, month!, day!, count!]
        let savedValues = fields.map(\.stringValue), savedGender = gender.indexOfSelectedItem
        let savedResult = result.string, savedHeading = resultLabel.stringValue, savedStatus = status.stringValue, savedStatusColor = status.textColor
        defer {
            province.selectItem(at: savedProvince); provinceChanged()
            city.selectItem(at: savedCity); cityChanged()
            region.selectItem(at: savedRegion); regionChanged()
            gender.selectItem(at: savedGender)
            for (field, value) in zip(fields, savedValues) { field.stringValue = value }
            resultLabel.stringValue = savedHeading
            result.string = savedResult; status.stringValue = savedStatus; status.textColor = savedStatusColor
            markAgeInvalid(false)
        }
        func changed(_ field: NSTextField, _ text: String) {
            field.stringValue = text
            controlTextDidChange(Notification(name: NSControl.textDidChangeNotification, object: field))
        }
        func birthdayFields() -> [String] { [year.stringValue, month.stringValue, day.stringValue] }
        province.selectItem(at: 0); provinceChanged()
        guard !city.isEnabled, !region.isEnabled, city.numberOfItems == 1, region.numberOfItems == 1 else { return false }
        province.selectItem(at: 1); provinceChanged()
        guard city.isEnabled, !region.isEnabled else { return false }
        city.selectItem(at: 1); cityChanged()
        guard region.isEnabled, let selected = selectedCity,
              let chaoyang = selected.regions.firstIndex(where: { $0.code == "110105" }) else { return false }
        region.selectItem(at: chaoyang + 1)
        age.stringValue = ""; year.stringValue = "2000"; month.stringValue = "2"; day.stringValue = "29"
        count.stringValue = "5"; gender.selectItem(at: 2); regenerate()
        guard result.string.components(separatedBy: "\n").allSatisfy({ $0.hasPrefix("11010520000229") }) else { return false }
        city.selectItem(at: 0); cityChanged()
        guard !region.isEnabled, region.indexOfSelectedItem == 0, region.numberOfItems == 1 else { return false }
        province.selectItem(at: 2); provinceChanged()
        guard city.indexOfSelectedItem == 0, !region.isEnabled else { return false }
        changed(age, "25")
        guard let birthday = ChineseIDGenerator.birthdayFromAge(25),
              birthdayFields() == [String(birthday.year), String(birthday.month), String(birthday.day)] else { return false }
        changed(age, "0"); regenerate()
        guard let today = ChineseIDGenerator.birthdayFromAge(0), birthdayFields() == [String(today.year), String(today.month), String(today.day)] else { return false }
        let retainedBirthday = birthdayFields(), retainedResult = result.string
        let maximum = Calendar(identifier: .gregorian).component(.year, from: Date()) - 1900
        for invalid in ["-1", "2.5", "abc", String(maximum + 1), String(repeating: "9", count: 30)] {
            changed(age, invalid); regenerate()
            guard birthdayFields() == retainedBirthday, result.string == retainedResult,
                  status.stringValue.contains("清空年龄") else { return false }
        }
        changed(age, "")
        guard birthdayFields() == retainedBirthday else { return false }
        for field in [year!, month!, day!] {
            changed(age, "25"); changed(field, field === year ? "2000" : "1")
            guard age.stringValue.isEmpty else { return false }
        }
        age.stringValue = "0"; regenerate()
        guard birthdayFields() == [String(today.year), String(today.month), String(today.day)] else { return false }
        print("身份证地区、年龄与联动检查通过：31 省、341 城市分组、2851 末级地区")
        return true
    }

    @objc private func copyNumbers() {
        NSPasteboard.general.clearContents()
        NSPasteboard.general.setString(result.string, forType: .string)
        status.stringValue = "已复制全部号码"
    }
}
