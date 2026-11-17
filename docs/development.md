# 开发指南

## 目录

```text
macos/
  Sources/             Swift、AppKit、WKWebView 应用代码
  Resources/           离线编辑器、地区数据、图标和许可
  comparison-editor/   CodeMirror 编辑器源码与依赖锁文件
  Tests/               纯模型回归
  scripts/             构建、图标、测试与打包脚本
windows/
  src/                 Electron 主进程、页面和系统桥接
  assets/              离线编辑器、字体、地区数据和许可
  data/                行政区划来源与更新记录
  test/                逻辑、页面和 Windows 原生回归
  scripts/             检查、安装验收与数据生成
.github/workflows/     两个平台的云端构建
docs/                  使用说明与实际应用截图
```

## macOS

要求 macOS、Xcode Command Line Tools、Python 3；默认目标为 macOS 13 及以上。普通应用构建使用仓库内已有的离线资源，不需要下载前端依赖。

在仓库根目录执行：

```sh
zsh macos/scripts/test.sh
zsh macos/scripts/build.sh
open macos/.build/OpenAll.app
```

默认生成 Intel / Apple Silicon Universal 应用并进行本地签名。开发时可只编译宿主架构：

```sh
OPENALL_REVIEW=1 zsh macos/scripts/build.sh
```

修改 CodeMirror 编辑器后，使用 Node.js 22 重建资源：

```sh
npm --prefix macos/comparison-editor ci --ignore-scripts
npm --prefix macos/comparison-editor run build
```

具体脚本与纯模型覆盖范围见 [macOS README](../macos/README.md)。输入法、系统权限和跨应用交互需要桌面环境验证；模型测试通过不代表这些场景全部通过。

## Windows

要求 Node.js 22。Electron 依赖由锁文件安装；原生接口测试和安装器验收在 Windows 上运行。

```sh
cd windows
npm ci
npm run check
npm test
npm start
```

独立页面和跨窗口回归：

```sh
npx electron test/editor-ui.js
npx electron test/editor-integration.js
npx electron test/appearance-ui.js
```

修改 Windows 编辑器源码后，在仓库根目录安装共用的构建依赖，再重新生成离线资源：

```sh
npm --prefix macos/comparison-editor ci --ignore-scripts
npm --prefix windows run build:editors
```

`npm --prefix windows run build:editors -- --check` 仅比较重建内容与已提交资源，发现差异时返回失败，不写文件。构建依赖沿用 macOS 编辑器的锁文件；运行应用仍使用仓库内的离线资源。

Windows 上构建、实际安装并验收：

```powershell
npm run dist -- --publish never
pwsh ./scripts/installer-smoke.ps1
```

测试使用隔离目录与合成内容。原生 Windows 桥接测试需要可用的桌面会话；Windows Search 与 OCR 的测试前提由云端工作流准备或检查。

## 两端编辑器

文本对比共用相同的行对齐、字符差异和 CodeMirror 逻辑。macOS 通过 WKWebView 调用，Windows 通过 iframe bridge 调用；修改时同步对应的资源文件，并保留各平台桥接代码。

长文本比较和排序在 Worker 中运行，可见行按视口渲染。主题切换只更新样式；编辑、撤销、选区和组合输入状态不能被重建覆盖。涉及剪贴板的改动必须验证回填目标、焦点和删除键。

## GitHub Actions

- [macOS 构建](https://github.com/innoerL/OpenAll/actions/workflows/macos.yml)：重建离线编辑器、Swift 与脚本语法、纯模型回归、Universal 编译、签名完整性和 ZIP 校验。
- [Windows 构建](https://github.com/innoerL/OpenAll/actions/workflows/windows.yml)：逻辑和编辑器回归、跨窗粘贴、主题往返、原生接口、安装包构建、实际安装运行与卸载、页面截图和 SHA-256。

构建产物保存在 Actions artifacts。工作流不会自动创建 Release；发布时选用通过验收的产物，记录对应提交和校验值。公开下载由 [Releases](https://github.com/innoerL/OpenAll/releases) 提供。
