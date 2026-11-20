# 第三方依赖与许可

本文件说明主要离线资源与依赖的位置，不改变任何第三方许可证。项目自有代码尚未指定开源许可证。

| 组件 | 用途 | 许可文件／依赖记录 |
| --- | --- | --- |
| CodeMirror 6、Lezer 等编辑器依赖 | 文本对比、JSON 编辑与语法处理 | [macOS 编辑器许可](macos/Resources/ComparisonEditor-LICENSE.txt)、[Windows 编辑器许可](windows/assets/editor-ComparisonEditor-LICENSE.txt)、[源码锁文件](macos/comparison-editor/package-lock.json) |
| Mermaid | Markdown 图表渲染 | [macOS](macos/Resources/Mermaid-LICENSE)、[Windows](windows/assets/Mermaid-LICENSE) |
| marked | Windows Markdown 渲染 | [MIT 许可](windows/assets/marked-LICENSE.txt) |
| YAML | Windows YAML 解析与整理 | [ISC 许可](windows/assets/editor-YAML-LICENSE.txt) |
| Noto Sans SC | Windows 中文字体 | [SIL Open Font License](windows/assets/fonts/OFL.txt) |
| 中国行政区划离线数据 | 身份证测试号的地区选择 | [数据来源与更新时间](windows/data/administrative-regions/README.md)、[CC0 许可](windows/data/administrative-regions/LICENSE)、[补充说明](macos/Resources/IDRegions-LICENSE.txt) |
| Electron 与其他 npm 依赖 | Windows 运行时、macOS 金价组件、图像、拼音、数据处理 | [依赖清单](windows/package.json)、[锁文件](windows/package-lock.json)；发行包保留所安装依赖的许可文件 |

内置站点图标用于识别对应服务。上游名称、商标和许可声明保留原文。

金价模型源自金价桌台 v1.4.0；窗口与运行环境归 OpenAll 管理。macOS 使用系统 JavaScriptCore、SQLite 和 WebKit，Windows 复用 OpenAll 自己的 Electron。数据来源及使用口径见 [金价说明](shared/gold-core/README.md)。
