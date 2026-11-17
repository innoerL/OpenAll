import AppKit
import CryptoKit

struct UpdateManifest: Codable {
    let version: String
    let downloadURL: URL
    let sha256: String
}

final class UpdateManager {
    private(set) var available: UpdateManifest?
    var onStatus: ((String) -> Void)?
    private let fm = FileManager.default
    private var backupDirectory: URL {
        fm.homeDirectoryForCurrentUser.appendingPathComponent("Library/Application Support/OpenAll/Backups")
    }

    func check(feed: String) {
        guard let url = URL(string: feed), url.scheme?.lowercased() == "https" else {
            onStatus?("请先填写 HTTPS 更新清单地址")
            return
        }
        onStatus?("正在检查更新…")
        URLSession.shared.dataTask(with: url) { [weak self] data, response, error in
            guard let self else { return }
            let result: String
            var candidate: UpdateManifest?
            if let error { result = "检查失败：\(error.localizedDescription)" }
            else if (response as? HTTPURLResponse)?.statusCode != 200 { result = "检查失败：更新服务器未返回成功状态" }
            else if let data, data.count < 1_000_000,
                    let manifest = try? JSONDecoder().decode(UpdateManifest.self, from: data),
                    manifest.downloadURL.scheme?.lowercased() == "https",
                    manifest.sha256.count == 64 {
                let current = Bundle.main.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String ?? "0"
                if manifest.version.compare(current, options: .numeric) == .orderedDescending {
                    candidate = manifest
                    result = "发现新版本 \(manifest.version)；可下载并安装"
                } else {
                    result = "已是最新版本（\(current)）"
                }
            } else { result = "更新清单格式无效" }
            DispatchQueue.main.async { self.available = candidate; self.onStatus?(result) }
        }.resume()
    }

    func installAvailable() {
        guard let manifest = available else { onStatus?("请先检查更新"); return }
        guard let currentTeam = teamIdentifier(at: Bundle.main.bundleURL), !currentTeam.isEmpty else {
            onStatus?("当前版本为临时签名；正式签名后才能启用自动更新")
            return
        }
        onStatus?("正在下载 \(manifest.version)…")
        URLSession.shared.downloadTask(with: manifest.downloadURL) { [weak self] url, _, error in
            guard let self else { return }
            let message: String
            if let error { message = "下载失败：\(error.localizedDescription)" }
            else if let url {
                do { try self.stageAndInstall(archive: url, manifest: manifest, expectedTeam: currentTeam); return }
                catch { message = "更新失败：\(error.localizedDescription)" }
            } else { message = "下载失败：未收到安装包" }
            DispatchQueue.main.async { self.onStatus?(message) }
        }.resume()
    }

    func rollback() {
        let current = Bundle.main.bundleURL
        let backups = ((try? fm.contentsOfDirectory(at: backupDirectory, includingPropertiesForKeys: nil)) ?? [])
            .filter { $0.lastPathComponent.hasPrefix("OpenAll-previous-") && $0.pathExtension == "app" }
            .sorted { $0.lastPathComponent > $1.lastPathComponent }
        guard let previous = backups.first else { onStatus?("没有可恢复的旧版本"); return }
        guard let team = teamIdentifier(at: current), team == teamIdentifier(at: previous) else {
            onStatus?("旧版本签名与当前版本不一致，无法自动恢复")
            return
        }
        guard run("/usr/bin/codesign", ["--verify", "--deep", "--strict", previous.path]).0 == 0 else {
            onStatus?("旧版本签名校验失败，无法恢复")
            return
        }
        do {
            try launchSwap(current: current, replacement: previous, backupPrefix: "OpenAll-replaced-")
        } catch { onStatus?("恢复失败：\(error.localizedDescription)") }
    }

    private func stageAndInstall(archive: URL, manifest: UpdateManifest, expectedTeam: String) throws {
        let size = try archive.resourceValues(forKeys: [.fileSizeKey]).fileSize ?? 0
        guard size > 0 && size <= 250_000_000 else { throw UpdateError.invalidSize }
        let data = try Data(contentsOf: archive, options: .mappedIfSafe)
        let digest = SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
        guard digest.caseInsensitiveCompare(manifest.sha256) == .orderedSame else { throw UpdateError.invalidHash }
        let temp = fm.temporaryDirectory.appendingPathComponent("OpenAll-Update-\(UUID().uuidString)")
        try fm.createDirectory(at: temp, withIntermediateDirectories: true)
        defer { try? fm.removeItem(at: temp) }
        guard run("/usr/bin/ditto", ["-x", "-k", archive.path, temp.path]).0 == 0 else { throw UpdateError.unpackFailed }
        let app = temp.appendingPathComponent("OpenAll.app")
        guard let bundle = Bundle(url: app), bundle.bundleIdentifier == Bundle.main.bundleIdentifier,
              let version = bundle.object(forInfoDictionaryKey: "CFBundleShortVersionString") as? String,
              version == manifest.version else { throw UpdateError.invalidBundle }
        guard run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app.path]).0 == 0,
              run("/usr/sbin/spctl", ["--assess", "--type", "execute", app.path]).0 == 0,
              teamIdentifier(at: app) == expectedTeam else { throw UpdateError.invalidSignature }
        let current = Bundle.main.bundleURL
        let pending = current.deletingLastPathComponent().appendingPathComponent("OpenAll-pending.app")
        if fm.fileExists(atPath: pending.path) { try fm.removeItem(at: pending) }
        try fm.copyItem(at: app, to: pending)
        try launchSwap(current: current, replacement: pending, backupPrefix: "OpenAll-previous-")
    }

    private func teamIdentifier(at app: URL) -> String? {
        let (status, output) = run("/usr/bin/codesign", ["-dv", "--verbose=4", app.path])
        guard status == 0 else { return nil }
        return output.split(separator: "\n").first { $0.hasPrefix("TeamIdentifier=") }
            .map { String($0.dropFirst("TeamIdentifier=".count)) }.flatMap { $0 == "not set" ? nil : $0 }
    }

    private func run(_ executable: String, _ arguments: [String]) -> (Int32, String) {
        let process = Process()
        process.executableURL = URL(fileURLWithPath: executable)
        process.arguments = arguments
        let pipe = Pipe()
        process.standardOutput = pipe
        process.standardError = pipe
        do { try process.run() } catch { return (-1, error.localizedDescription) }
        process.waitUntilExit()
        return (process.terminationStatus, String(data: pipe.fileHandleForReading.readDataToEndOfFile(), encoding: .utf8) ?? "")
    }

    private func launchSwap(current: URL, replacement: URL, backupPrefix: String) throws {
        let parent = current.deletingLastPathComponent()
        guard fm.isWritableFile(atPath: parent.path) else { throw UpdateError.notWritable }
        let stamp = ISO8601DateFormatter().string(from: Date()).replacingOccurrences(of: ":", with: "-")
        try fm.createDirectory(at: backupDirectory, withIntermediateDirectories: true)
        let backup = backupDirectory.appendingPathComponent(backupPrefix + stamp + "-" + String(UUID().uuidString.prefix(8)) + ".app")
        let script = fm.temporaryDirectory.appendingPathComponent("OpenAll-swap-\(UUID().uuidString).zsh")
        let body = """
        #!/bin/zsh
        current=$1
        replacement=$2
        backup=$3
        oldpid=$4
        for i in {1..100}; do
          kill -0 "$oldpid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$oldpid" 2>/dev/null; then exit 21; fi
        mv "$current" "$backup" || exit 22
        if mv "$replacement" "$current"; then
          /usr/bin/open "$current"
        else
          mv "$backup" "$current"
          /usr/bin/open "$current"
          exit 23
        fi
        """
        try body.write(to: script, atomically: true, encoding: .utf8)
        let helper = Process()
        helper.executableURL = URL(fileURLWithPath: "/bin/zsh")
        helper.arguments = [script.path, current.path, replacement.path, backup.path, String(ProcessInfo.processInfo.processIdentifier)]
        try helper.run()
        DispatchQueue.main.async { NSApp.terminate(nil) }
    }

    enum UpdateError: LocalizedError {
        case invalidSize, invalidHash, unpackFailed, invalidBundle, invalidSignature, notWritable
        var errorDescription: String? {
            switch self {
            case .invalidSize: return "安装包大小无效或超过 250 MB"
            case .invalidHash: return "安装包校验和不匹配"
            case .unpackFailed: return "无法解压安装包"
            case .invalidBundle: return "安装包不是匹配的 OpenAll 版本"
            case .invalidSignature: return "开发者签名或 macOS 公证校验失败"
            case .notWritable: return "应用目录不可写；请将 OpenAll 放在用户可写的应用目录"
            }
        }
    }
}
