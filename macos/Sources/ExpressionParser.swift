import Foundation

final class ExpressionParser {
    private let chars: [Character]
    private var index = 0

    init(_ text: String) {
        chars = Array(text.replacingOccurrences(of: "×", with: "*")
            .replacingOccurrences(of: "÷", with: "/")
            .lowercased())
    }

    private func skip() { while index < chars.count && chars[index].isWhitespace { index += 1 } }
    private func eat(_ token: String) -> Bool {
        skip()
        let sequence = Array(token)
        guard index + sequence.count <= chars.count,
              Array(chars[index..<(index + sequence.count)]) == sequence else { return false }
        index += sequence.count
        return true
    }
    private func number() -> Double? {
        skip()
        let start = index
        while index < chars.count && (chars[index].isNumber || chars[index] == ".") { index += 1 }
        guard start < index else { return nil }
        return Double(String(chars[start..<index]))
    }
    private func identifier() -> String? {
        skip()
        let start = index
        while index < chars.count && (chars[index].isLetter || chars[index] == "π") { index += 1 }
        return start < index ? String(chars[start..<index]) : nil
    }
    private func primary() -> Double? {
        if eat("(") { guard let value = bitwiseOr(), eat(")") else { return nil }; return value }
        if let value = number() { return value }
        guard let name = identifier() else { return nil }
        if name == "pi" || name == "π" { return .pi }
        if name == "e" { return M_E }
        guard eat("("), let value = bitwiseOr(), eat(")") else { return nil }
        switch name {
        case "sqrt": return value >= 0 ? Foundation.sqrt(value) : nil
        case "sin": return Foundation.sin(value)
        case "cos": return Foundation.cos(value)
        case "tan": return Foundation.tan(value)
        case "sind": return Foundation.sin(value * .pi / 180)
        case "cosd": return Foundation.cos(value * .pi / 180)
        case "tand": return Foundation.tan(value * .pi / 180)
        case "abs": return Swift.abs(value)
        case "ln": return value > 0 ? Foundation.log(value) : nil
        case "log": return value > 0 ? Foundation.log10(value) : nil
        default: return nil
        }
    }
    private func power() -> Double? {
        guard let base = primary() else { return nil }
        if eat("^") { guard let exponent = unary() else { return nil }; return Foundation.pow(base, exponent) }
        return base
    }
    private func unary() -> Double? {
        if eat("+") { return unary() }
        if eat("-") { return unary().map { -$0 } }
        if eat("√") { guard let value = unary(), value >= 0 else { return nil }; return Foundation.sqrt(value) }
        return power()
    }
    private func term() -> Double? {
        guard var value = unary() else { return nil }
        while true {
            if eat("*") { guard let right = unary() else { return nil }; value *= right }
            else if eat("/") { guard let right = unary(), right != 0 else { return nil }; value /= right }
            else if eat("%") { guard let right = unary(), right != 0 else { return nil }; value.formTruncatingRemainder(dividingBy: right) }
            else { return value }
        }
    }
    private func additive() -> Double? {
        guard var value = term() else { return nil }
        while true {
            if eat("+") { guard let right = term() else { return nil }; value += right }
            else if eat("-") { guard let right = term() else { return nil }; value -= right }
            else { return value }
        }
    }
    private func integer(_ value: Double) -> Int64? {
        guard value.isFinite, value.rounded() == value,
              value >= Double(Int64.min), value < Double(Int64.max) else { return nil }
        return Int64(value)
    }
    private func shift() -> Double? {
        guard var value = additive() else { return nil }
        while true {
            let operation: String
            if eat(">>>") { operation = ">>>" }
            else if eat(">>") { operation = ">>" }
            else if eat("<<") { operation = "<<" }
            else { return value }
            guard let left = integer(value), let amountValue = additive(),
                  let amount = integer(amountValue), (0...31).contains(amount) else { return nil }
            let distance = Int(amount)
            switch operation {
            case ">>>": value = Double(UInt32(truncatingIfNeeded: left) >> distance)
            case ">>": value = Double(Int32(truncatingIfNeeded: left) >> distance)
            default: value = Double(Int32(truncatingIfNeeded: left) &<< distance)
            }
        }
    }
    private func bitwiseAnd() -> Double? {
        guard var value = shift() else { return nil }
        while eat("&") {
            guard let left = integer(value), let rightValue = shift(), let right = integer(rightValue) else { return nil }
            value = Double(left & right)
        }
        return value
    }
    private func bitwiseXor() -> Double? {
        guard var value = bitwiseAnd() else { return nil }
        while eat("xor") {
            guard let left = integer(value), let rightValue = bitwiseAnd(), let right = integer(rightValue) else { return nil }
            value = Double(left ^ right)
        }
        return value
    }
    private func bitwiseOr() -> Double? {
        guard var value = bitwiseXor() else { return nil }
        while eat("|") {
            guard let left = integer(value), let rightValue = bitwiseXor(), let right = integer(rightValue) else { return nil }
            value = Double(left | right)
        }
        return value
    }
    func parse() -> Double? {
        guard let result = bitwiseOr() else { return nil }
        skip()
        return index == chars.count && result.isFinite ? result : nil
    }
}
