# OpenAll Windows

基于 macOS **0.25.6（75）** 移植，保留搜索布局、独立工具窗口、底部剪贴板通栏、大卡片与彩色类型栏。Windows 版使用 Electron；系统快捷键采用 Ctrl，文件访问、选区读取、粘贴和 OCR 使用 Windows 本机接口。

## 功能

0.25.9：自定义背景色同步应用于标题栏、侧栏及 JSON / 文本对比内容区；窗口按钮按 Windows 习惯放在右上角，支持最小化、最大化 / 还原和关闭；修复外观往返切换时剪贴板搜索输入配色。

0.25.8：文本对比增强新增、删除和修改行底色，精确标出行内字符、空格和缺失位置。左右编辑区可独立自然排序（如 item2 在 item10 前），支持撤销；大文本使用后台排序，继续编辑时取消旧结果。

0.25.7：身份证测试号支持省 → 市 → 区县三级联动、完整离线地区目录，以及输入年龄后按今天月日反推生日。年龄换算使用设备本地日期：年份减去年龄、月日保持今天；平年遇到 2 月 29 日取 2 月 28 日，结果可手动修改。详细数据范围与更新来源见 [地区数据说明](data/administrative-regions/README.md)。

- 搜索：应用、拼音与首字母、纠错、精确模式、文件 / 文档 / 图片 / 后缀限定词、计算与日期、Chrome 书签和历史、置顶与隐藏、网址和功能别名、常用片段。
- 剪贴板：文本、图片、HTML、文件、收藏和标签、全文预览、两卡比较、图片文字识别、跨工具粘贴；输入框和卡片按各自焦点处理删除键。
- JSON：同一区域编辑与格式化、行号、嵌套折叠、查找、自然排序、转义、压缩；删除折叠内容时首次只展开，第二次才删除。大数字与键顺序保留。
- 文本对比：左右原位编辑、精确行内差异、独立自然排序、差异跳转、同步滚动、搜索、后台计算和视口渲染。
- 其他工具：内嵌有道翻译、Markdown / Mermaid、Unicode、身份证测试号、Shell 与 Java 手册、图片裁剪旋转与格式转换、时间单位 / Cron / ASCII、配置对比、执行计划、日志时间线、SQL 参数还原、YAML / Properties / SQL 格式化、复制堆栈与选中内容操作。
- 设置：快捷键与双击修饰键、搜索索引、剪贴板保留与排除、别名和片段、权限、诊断、主题颜色、HTTPS 更新源。

## 云端构建与验证

GitHub Actions 使用 `windows-2022`，主分支代码变更或手动运行后依次执行：

1. 锁文件安装、语法检查与纯逻辑测试。
2. 编辑器功能及大内容压力、真实跨窗口焦点粘贴、辅助工具页面回归。
3. Windows 原生键盘输入、选区、剪贴板及 OCR 验证。
4. 构建 x64 NSIS 安装器，在隔离目录安装后运行完整工具回归，并截取所有页面与设置分类。
5. 检查卸载、生成 SHA-256，保存通过检查的安装包与报告。

当前交付版 0.25.9 已通过 [Windows 完整验收](https://github.com/innoerL/OpenAll/actions/workflows/windows.yml)：安装包内 114 项检查、38 张截图，包含主题往返、剪贴板输入可读性及右侧窗口按钮；6.56 MB JSON、8 万行对比和 5.27 MB 自然排序压力测试通过。详细数据见 [cloud-verification.json](docs/cloud-verification.json)。

不自动发布 GitHub Release。每轮验证结论与已知边界记录在 [parity-status.json](docs/parity-status.json)；未通过的构建不会上传交付安装包。

## 本地命令

```sh
npm ci
npm run check
npm test
npm start
npm run dist -- --publish never
```

Windows 安装包回归：`pwsh ./scripts/installer-smoke.ps1`。测试使用独立数据目录和合成内容；原生自测只操作临时窗口并恢复原剪贴板。

### 重建编辑器资产

JSON 编辑器源文件为 `src/editor-core-view.mjs`，格式化与搜索核心为 `src/editor-core.js`；文本对比编辑器复用 `../macos/comparison-editor/src.js`。CodeMirror 与 esbuild 使用 Mac 编辑器的现有锁文件，YAML 使用 Windows 锁文件，不另增一套依赖版本。

以下命令在统一仓库根目录执行：

```sh
npm --prefix windows ci
npm --prefix macos/comparison-editor ci --ignore-scripts
npm --prefix windows run build:editors
npm --prefix windows run build:editors -- --check
```

默认重建 `assets/editor-json.js`、`assets/editor-core.js` 与 `assets/editor-comparison.js`；`--check` 仅在内存中生成并逐字节比较，不修改文件，发现差异时返回失败。两份锁定依赖均需先安装；仅运行现有应用时使用仓库已提交的资产。

## 平台边界

- 中文界面附带 Noto Sans SC（OFL 许可），避免英文系统字体缺失；英文、显示缩放及系统应用图标由系统提供。Cmd 对应 Ctrl，访达对应资源管理器。
- 跨应用自动粘贴受 Windows 完整性级别限制，无法向更高权限的应用注入按键。
- OCR 使用已安装的 Windows 识别语言；缺少语言包时在设置中提示安装。
- 有道翻译依赖网络和网站可用性；失败时提供重试、复制原文和浏览器打开。
- 文件搜索优先使用 Windows 已建立的系统索引，并保留用户目录扫描；支持 OneDrive 等 KnownFolders 重定向。系统索引不可用时明确回退，不宣称覆盖未索引磁盘。Chrome 历史访问失败不会阻塞其他搜索。
- 安装器尚未代码签名。更新源默认空；配置可信 HTTPS 清单后才下载，安装前核对 SHA-256。首次安装没有历史安装器，不能执行回退。

macOS 基线校验值见 [macos-baseline.json](docs/macos-baseline.json)。
