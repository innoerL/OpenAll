# OpenAll macOS

此目录包含 OpenAll **0.26.0（78）** 的 macOS 源码和离线资源，最低运行系统为 **macOS 13**。默认构建同时包含 Intel `x86_64` 与 Apple Silicon `arm64`。

## 构建前置条件

- macOS，以及提供 `swiftc`、macOS SDK、`lipo` 和 `codesign` 的 Xcode 或 Command Line Tools。当前开发使用 Swift 6 系列，未单独验证更低版本编译器。
- 系统自带的 `zsh`、`sips`，以及 `python3`。
- 重建文本对比编辑器时需要 Node.js 18 或更新版本与 npm；直接构建应用使用仓库中已经打包的离线 JavaScript，无需安装 Node.js 依赖。

项目使用 AppKit、WebKit、Carbon、ApplicationServices、Vision、ImageIO、UniformTypeIdentifiers 和系统 SQLite。没有 CocoaPods 或 SwiftPM。金价工具使用随应用内置的 Electron 45.4.1；首次构建会从官方发行地址下载对应架构 ZIP 并校验固定 SHA-256。通用包包含两个架构的组件，因此体积比之前的纯原生版本增大。

## 构建应用

在仓库根目录执行：

```sh
zsh macos/scripts/build.sh
```

产物为 `macos/.build/OpenAll.app`，包含本地临时签名。该命令不会生成 ZIP、上传产物或进行 Apple 公证。`main.swift`、图标集、编译缓存与可执行文件都在 `.build/` 中生成，不修改 `Sources/` 或 `Resources/`。

开发时可仅编译宿主架构：

```sh
OPENALL_REVIEW=1 zsh macos/scripts/build.sh
```

`OPENALL_REVIEW=1` 使用 `-Onone`；`OPENALL_STRESS=1` 使用宿主架构的 `-O` 优化构建。未设置这两个变量时，使用 `-O` 生成 Universal 应用。

## 重建文本对比编辑器

```sh
npm --prefix macos/comparison-editor ci --ignore-scripts
npm --prefix macos/comparison-editor run build
```

版本锁定在 `comparison-editor/package-lock.json`。输出 `Resources/comparison-editor.js`，随后重新执行应用构建即可。运行时不需要访问 npm 或 CDN。金价的行情、历史和新闻按原功能联网获取。

## 验证

```sh
zsh macos/scripts/test.sh
```

此入口只覆盖纯模型：计算器、身份证三级地区与年龄规则、Markdown 渲染、JSON 折叠、后台开发工具模型、文件搜索定语及临时目录索引。测试使用临时文件，不读取真实剪贴板或用户主目录，也不启动应用窗口。

现有 `FeatureChecks.swift` 的 Markdown 模型与窗口代码位于同一生产文件。脚本从 `Sources/MarkdownTool.swift` 提取实际 `MarkdownRenderer` 定义到 `.build/tests/` 再编译；不维护另一份模型实现。用于完成界面类型检查的 `Tests/Support/ThemeStub.swift` 不验证真实主题显示。

真实窗口与 WebKit 验收需要图形登录会话，必须另外执行，不能以纯模型检查代替。例如构建应用后运行剪贴板外观专项：

```sh
OPENALL_PREVIEW_ROOT="$PWD/macos/.build/preview-data" \
OPENALL_PREVIEW_OUTPUT="$PWD/macos/.build/preview-screens" \
OPENALL_APPEARANCE_CHECK=1 \
macos/.build/OpenAll.app/Contents/MacOS/OpenAll --design-snapshot
```

可将专项变量换为 `OPENALL_COMPARISON_CHECK=1`（文本对比与身份证窗口）、`OPENALL_PERFORMANCE_CHECK=1`（JSON 与文本对比压力检查）、`OPENALL_SEARCH_LATENCY_CHECK=1`（搜索响应）；不设置专项变量则执行完整设计验收入口。始终保留 `--design-snapshot` 和隔离的 `OPENALL_PREVIEW_ROOT`。压力检查应先使用 `OPENALL_STRESS=1` 构建，`OPENALL_STRESS_ROUNDS` 控制 1–10 轮。

## 签名与公证发布

`scripts/release.sh` 要求本机钥匙串中具备 Developer ID Application 证书与 `notarytool` 公证配置。设置以下环境变量后运行：

```sh
DEVELOPER_ID_APPLICATION="Developer ID Application: 证书名称" \
NOTARY_PROFILE="公证配置名称" \
DOWNLOAD_URL="https://example.com/OpenAll.zip" \
zsh macos/scripts/release.sh
```

脚本会执行 Universal 构建、正式签名、提交 Apple 公证、装订票据与系统校验，输出 `.build/release/OpenAll.zip` 和 `manifest.json`。下载地址必须换成实际 HTTPS 发布地址；脚本不会替你上传文件。证书、钥匙串凭据及个人发布配置不应提交到仓库。

## 目录与资源

- `Sources/`：34 个 Swift 生产源文件；入口是 `QuickLaunch.swift`。
- `Resources/`：对比与 Markdown 离线网页、地区数据、应用图标源文件、搜索站点图标和[命令手册](Resources/OpenAll-命令手册.md)。
- `comparison-editor/`：CodeMirror 编辑器源码及锁文件。
- `Tests/`：模型回归入口和隔离测试支撑代码。
- `scripts/`：构建、图标生成、模型验证与公证发布脚本。

第三方许可随应用一起复制：`Resources/ComparisonEditor-LICENSE.txt`、`Resources/Mermaid-LICENSE`、`Resources/IDRegions-LICENSE.txt`。地区资源包含 31 个省级地区、341 个城市分组、2,851 个末级选项，2025 基础数据补充到 2026 年 6 月行政区划。请保留这些文件及既有署名。Mermaid 使用仓库中附带的发行文件，当前没有单独的 Mermaid 源码构建流程。

## 金价组件

源码位于 [shared/gold-desk](../shared/gold-desk/README.md)，无需另装 Node.js 或金价桌台。可通过 `OPENALL_ELECTRON_CACHE` 指向已有官方 ZIP 的缓存目录；缓存仍会核对固定摘要。`OPENALL_GOLD_CHECK=1` 配合 `--design-snapshot` 验证搜索路由和真实窗口，使用自动生成的隔离样例目录。
