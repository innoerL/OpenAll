import Foundation

// 文件搜索测试自行创建临时目录，不使用真实主目录。
enum DesignPreview {
    static let home = FileManager.default.temporaryDirectory
}
