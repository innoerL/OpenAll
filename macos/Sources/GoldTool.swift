import AppKit
import Darwin

final class GoldToolController {
    private var processes: [Process] = []
    private var stopping = false

    func show() {
        do {
            let helper = try helperBundle()
            guard let executable = helper.executableURL else { throw componentError("金价组件缺少可执行文件，请重新安装 OpenAll。") }
            let environment = ProcessInfo.processInfo.environment
            let dataDirectory: URL
            if let override = environment["OPENALL_GOLD_DATA_DIR"], !override.isEmpty {
                guard override.hasPrefix("/") else { throw componentError("金价数据目录必须使用绝对路径。") }
                dataDirectory = URL(fileURLWithPath: override, isDirectory: true)
            } else {
                dataDirectory = DesignPreview.home.appendingPathComponent("Library/Application Support/OpenAll/gold", isDirectory: true)
            }
            try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
            let process = Process()
            process.executableURL = executable
            process.currentDirectoryURL = helper.resourceURL?.appendingPathComponent("app", isDirectory: true)
            process.arguments = ["--user-data-dir=\(dataDirectory.path)", "--openall-parent-pid=\(ProcessInfo.processInfo.processIdentifier)"]
            var helperEnvironment = environment
            helperEnvironment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
            process.environment = helperEnvironment
            process.terminationHandler = { [weak self] finished in
                DispatchQueue.main.async {
                    guard let self else { return }
                    self.processes.removeAll { $0 === finished }
                    if !self.stopping && finished.terminationStatus != 0 {
                        self.present(self.componentError("金价组件未能正常运行，请重新打开金价；如果仍失败，请重新安装 OpenAll。"))
                    }
                }
            }
            // 重复启动由组件的单实例锁唤回原窗口，包含已最小化或贴边收起的状态。
            processes.append(process)
            do { try process.run() }
            catch {
                processes.removeAll { $0 === process }
                throw error
            }
        } catch { present(error) }
    }

    func stop() {
        stopping = true
        for process in processes where process.isRunning { process.terminate() }
        processes.removeAll()
    }

    @MainActor func verifyForDesign() async throws {
        let helper = try helperBundle()
        guard let executable = helper.executableURL else { throw componentError("金价组件缺少可执行文件。") }
        let dataDirectory = DesignPreview.home.appendingPathComponent("Library/Application Support/OpenAll/gold-check-\(UUID().uuidString)", isDirectory: true)
        try FileManager.default.createDirectory(at: dataDirectory, withIntermediateDirectories: true)
        let process = Process()
        process.executableURL = executable
        process.currentDirectoryURL = helper.resourceURL?.appendingPathComponent("app", isDirectory: true)
        process.arguments = ["--user-data-dir=\(dataDirectory.path)", "--openall-parent-pid=\(ProcessInfo.processInfo.processIdentifier)", "--openall-gold-check"]
        var environment = ProcessInfo.processInfo.environment
        environment.removeValue(forKey: "ELECTRON_RUN_AS_NODE")
        environment["OPENALL_GOLD_FIXTURE"] = "1"
        environment["OPENALL_GOLD_DATA_DIR"] = dataDirectory.path
        environment["OPENALL_GOLD_CHECK_OUTPUT"] = DesignPreview.output.appendingPathComponent("gold", isDirectory: true).path
        process.environment = environment
        processes.append(process)
        defer { processes.removeAll { $0 === process } }
        try process.run()
        // 异步等待保留 AppKit 事件循环；验收异常时及时结束组件，避免 CI 悬挂。
        let deadline = ProcessInfo.processInfo.systemUptime + 60
        do {
            while process.isRunning {
                if ProcessInfo.processInfo.systemUptime >= deadline { throw componentError("金价界面验收超时。") }
                try await Task.sleep(nanoseconds: 100_000_000)
            }
        } catch {
            if process.isRunning { process.terminate() }
            throw error
        }
        guard process.terminationStatus == 0 else { throw componentError("金价界面验收失败，退出码 \(process.terminationStatus)。") }
    }

    private func helperBundle() throws -> Bundle {
        // 检测硬件而非当前进程，保证 Rosetta 下也优先使用原生组件。
        var arm64: Int32 = 0
        var size = MemoryLayout<Int32>.size
        let nativeArm = sysctlbyname("hw.optional.arm64", &arm64, &size, nil, 0) == 0 && arm64 == 1
        let architectures = nativeArm ? ["arm64", "x64"] : ["x64"]
        for architecture in architectures {
            let url = Bundle.main.bundleURL.appendingPathComponent("Contents/Helpers/OpenAllGold-\(architecture).app", isDirectory: true)
            if let bundle = Bundle(url: url), let executable = bundle.executableURL,
               FileManager.default.isExecutableFile(atPath: executable.path) { return bundle }
        }
        throw componentError("未找到适合这台 Mac 的内置金价组件，请重新安装完整的 OpenAll。")
    }

    private func componentError(_ description: String) -> NSError {
        NSError(domain: "OpenAllGold", code: 1, userInfo: [NSLocalizedDescriptionKey: description])
    }

    private func present(_ error: Error) {
        let alert = NSAlert(error: error)
        alert.messageText = "无法打开金价"
        alert.runModal()
    }
}
