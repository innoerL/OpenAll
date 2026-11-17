# 0.25.9 发布验证

本次发布将 macOS 与 Windows 放入同一公开仓库。安装包直接使用下列 GitHub Actions 的产物；版本均为 **0.25.9**。

| 平台 | 验证提交 | 云端结果 |
| --- | --- | --- |
| macOS | `b05687df66245ab1fee6fdc9d4ae55d5898780ed` | [构建与模型回归通过](https://github.com/innoerL/OpenAll/actions/runs/44039859242) |
| Windows | `2b017c9a7ec282f960658e0d0df789699d01db91` | [构建与完整回归通过](https://github.com/innoerL/OpenAll/actions/runs/44039291533) |

两次提交之间仅修正了 macOS 工作流的 `lipo` 参数顺序，没有修改应用源码。后续验证报告与首页文档提交不影响上述产物。

## macOS

已验证：离线编辑器重新构建、Swift 与脚本语法、四组纯模型回归、Intel / Apple Silicon 双架构编译、签名完整性及 ZIP 校验。

同一源码在本地另行构建并运行隔离的真实窗口验收：剪贴板外观往返、输入与焦点删除；文本对比 68 项、左右编辑器跨工具粘贴；身份证三级地区与年龄联动，均通过。UI 实际运行架构为 `x86_64`；`arm64` 已编译并检查架构，未在本轮执行真实窗口验收。

本地 8 万行样例结果：加载 211 ms，对比 616 ms，搜索 14 ms，自然排序 1,819 ms；后台响应、撤销、过期任务及超限保护检查通过。耗时来自本次固定样例与测试机器，不代表任意内容或设备的性能保证。本地 UI 验收使用本地构建产物，云端 ZIP 的构建与签名检查由 Actions 完成。

## Windows

已在 `windows-2022` runner 验证：锁定依赖安装、三个离线编辑器重建一致性、语法与逻辑样例、编辑器功能与压力、跨窗口粘贴、内嵌翻译隔离、系统索引和原生接口、安装后运行及卸载。页面、外观和性能明细见 [云端验证记录](../windows/docs/cloud-verification.json) 与 [功能验证状态](../windows/docs/parity-status.json)。

## 下载与边界

安装包与 SHA-256 清单见 [v0.25.9 Release](https://github.com/innoerL/OpenAll/releases/tag/v0.25.9)。Actions 的截图与日志保存在对应运行的 artifacts 中，有保留期限。

macOS 包使用本地签名，尚未经过 Apple 公证；Windows 安装器尚未代码签名。自动粘贴受系统辅助权限或目标应用权限级别影响，OCR 依赖系统语言支持，文件索引范围由操作系统决定。
