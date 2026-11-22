# 0.27.9 发布验证

金价桌台沿用 0.27.8 的窗口和行情页。两个平台均由提交 `5d5a2be` 构建。七日展望在 345 像素窄窗显示日期、每日参考价及情景区间。点选某天可读方向概率与样本依据，也可用键盘展开、收起和切换。

| 平台 | 已验证 |
| --- | --- |
| macOS | 构建包含 Intel 和 Apple Silicon 两种架构。原生金价窗口通过 37 项检查，后台行情组件通过 48 项测试。[macOS 构建及验收](https://github.com/innoerL/OpenAll/actions/runs/45007468554) |
| Windows x64 | 金价窗口通过 62 项检查；安装、启动、173 项安装后检查与卸载均通过。[Windows 构建及验收](https://github.com/innoerL/OpenAll/actions/runs/45007468558) |

两端检查了报价刷新时保留展开日期、休市和历史样本不足、旧报价日期、相同可见金额的图形对齐，以及系统滚动条占用宽度后长金额仍在各列内。视觉检查使用离线样例。安装包的 SHA-256 已与构建产物核对。[安装包和校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.9)

## 0.27.8 历史验证

macOS 与 Windows 使用提交 `33ec0e1`。差异导航与查找导航分别计数。配置、执行计划、日志与 SQL 还原在明细前展示分析所得结论。前三种支持定位对应记录。时间单位和 ASCII 精确匹配在表格上方给出结果。剪贴板仅调整八类类型栏的深浅主题配色，继续使用原有的大卡片和底部通栏。

| 平台 | 已验证 |
| --- | --- |
| macOS | Universal 双架构、签名完整性、原生设置、剪贴板、开发工具表头/数值对齐、结果定位、JSON 折叠和大文本回归均通过。金价原生界面验收 29 项，共保存 94 张截图。[macOS 构建及验收](https://github.com/innoerL/OpenAll/actions/runs/44986667469) |
| Windows x64 | 安装、启动和卸载通过，安装后检查 168 项。编辑器功能与压力验收 23 项，跨窗口与键盘交互 12 项。辅助工具覆盖 12 个页面和 3 个转换模式，金价界面验收 47 项。共保存 82 张截图。[Windows 构建及验收](https://github.com/innoerL/OpenAll/actions/runs/44986667464) |

安装包与发布附件均已核对 SHA-256。macOS 采用临时签名，尚未公证。Windows 安装包尚未代码签名。[下载与校验](https://github.com/innoerL/OpenAll/releases/tag/v0.27.8)

## 0.27.7 历史验证

macOS 和 Windows 均使用提交 `bafc556`。本版调整启动搜索、剪贴板、九个设置分页、编辑工具、开发工具和金价桌台。验收采用隔离数据。自定义主题覆盖深浅往返，以及强调色接近背景色的情况。

| 平台 | 已验证 |
| --- | --- |
| macOS | Intel 与 Apple Silicon 通用包通过签名与完整性检查。云端保存 94 张截图，本机另逐页检查九个设置分页及四个子状态。原生文本对比通过 68 项交互检查、左右栏粘贴和大文本压力测试。约 5.1 MB、5,000 个折叠节点的 JSON 一次清空，撤销可恢复原文与折叠状态。[构建与界面截图](https://github.com/innoerL/OpenAll/actions/runs/44982338261) |
| Windows x64 | 安装、启动及卸载通过。安装后验收包含 167 项检查，云端保存 80 张截图。编辑器另行验证折叠计数、左右栏粘贴、自然排序和大文本。图片导出、命令手册无结果状态与过期结果处理均有交互回归。[安装与界面截图](https://github.com/innoerL/OpenAll/actions/runs/44982338247) |

本地安装包与发布附件的 SHA-256 一致。macOS 采用临时签名且尚未公证，Windows 安装包尚未代码签名。[下载与校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.7)

## 0.27.6 历史验证

macOS 和 Windows 使用同一提交 `a0455e2`。当日周大福实采牌价放在表头；未来七个自然日分别使用两个品种的近期涨跌估算。七行数字和区间按同一日期对齐。升级实测使用隔离的 SQLite 副本，确认当天已有的七条 3.0.0 预测与新发行的七条 4.0.0 预测可共存，旧预测的发行时间及内容保留。

| 平台 | 已验证 |
| --- | --- |
| macOS | Intel 与 Apple Silicon 通用包、临时签名、48 项共享模型检查。Node 与 JavaScriptCore 的 3,753 个快照字段一致。金价原生窗口通过 29 项检查，覆盖表头实价、逐行金额、345 点窄窗、键盘展开与收起。[构建与实际截图](https://github.com/innoerL/OpenAll/actions/runs/44976375971) |
| Windows x64 | 在 Windows Server 2022 完成安装、启动和卸载。安装后 167 项检查通过，另有 47 项金价专项检查，涵盖数据缺失、旧版固定价展示、币种工具栏和窄窗布局。[安装与界面回归](https://github.com/innoerL/OpenAll/actions/runs/44976375966) |

时间截断回测覆盖 69 个历史基准日，各期限的绝对误差与样本数见[逐日模型评估](ctf-horizon-evaluation.md)。本地安装包、构建产物和发布附件的 SHA-256 已核对。macOS 临时签名未公证，Windows 安装包尚未代码签名。[安装包和校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.6)

## 0.27.5 历史验证

本次更新覆盖 17 个工具页面与独立预览入口。macOS 与 Windows 安装包由同一提交 `85c618a` 构建，已核对本地文件、构建产物及发布附件的 SHA-256。

| 平台 | 已验证 |
| --- | --- |
| macOS | Universal 应用通过 Intel 与 Apple Silicon 架构检查及临时签名检查。实际工具窗口检查覆盖命令手册筛选、格式整理、开发者转换器、图片处理和独立预览。金价通过 26 项检查。也回归了设置焦点、剪贴板输入和大 JSON 编辑。[构建与窗口截图](https://github.com/innoerL/OpenAll/actions/runs/44914991680) |
| Windows x64 | 在 Windows Server 2022 安装、启动和卸载。安装后报告记录 162 项检查与 46 张截图，涵盖手册资源与筛选、独立预览复制、格式整理和图片编码。另在 Electron 工具测试中检查窄窗、主题和键盘操作。金价专项通过 37 项检查。[安装与界面回归](https://github.com/innoerL/OpenAll/actions/runs/44914991670) |

macOS 使用临时签名，尚未公证。Windows 安装包尚未代码签名。[安装包和校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.5)

## 0.27.4 历史验证

启动搜索的选中行显示实际回车动作。剪贴板分别显示记录或匹配数、选中数和当前焦点可用的快捷键。本地安装包来自同一提交 `16c0b00`，SHA-256 已与各自的云端产物和发布文件核对。

| 平台 | 已验证 |
| --- | --- |
| macOS | 原生窗口验证搜索框尺寸、连续输入、选中行的复制动作、无匹配提示。剪贴板覆盖输入法编辑、搜索与卡片间的键盘切换、底栏计数可见区域、多选和删除保护。[云端构建与窗口检查](https://github.com/innoerL/OpenAll/actions/runs/44912128483) |
| Windows x64 | 安装后验证搜索、剪贴板筛选计数、卡片焦点与多选删除。另在隔离的 Electron 窗口验证深浅主题，以及 400、640 和 1,280 像素宽的卡片栏。[云端安装与回归](https://github.com/innoerL/OpenAll/actions/runs/44912128731) |

macOS 构建支持 Intel 和 Apple Silicon，采用临时签名，尚未公证。Windows 安装器尚未代码签名。[安装包和校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.4)

## 0.27.3 历史验证

本次调整通用设置中的快捷键、JSON 工具栏与搜索栏、文本对比的栏头与搜索。macOS 和 Windows 安装包均由提交 `b115a72` 构建。

| 平台 | 已验证 |
| --- | --- |
| macOS | 云构建完成 Intel 和 Apple Silicon 双架构、签名完整性、设置焦点、JSON 搜索与大文本检查。本地原生窗口通过文本对比的 68 项交互检查，840 点宽度下实测 ⌘F 查找、Enter 跨栏跳转与 Esc 返回编辑。[云端记录](https://github.com/innoerL/OpenAll/actions/runs/44910395707) |
| Windows x64 | 云端完成编辑器交互、大文本、跨窗口粘贴以及安装、启动和卸载检查。另用 Electron 验证深浅主题与 480 像素窄窗显示。[云端记录](https://github.com/innoerL/OpenAll/actions/runs/44910395660) |

两个本地安装包的 SHA-256 与各自的云构建及发布资产一致。macOS 使用临时签名，尚未公证。Windows 安装器尚未代码签名。[下载与校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.3)

## 0.27.2 macOS 历史验证

设置侧栏使用真实的鼠标、Tab、Shift-Tab 和空格事件进行回归。测试覆盖打开设置、键盘遍历、从「外观」点击「通用」及直接重开「诊断」。各路径分别检查当前页面、第一响应者及键盘焦点提示，另保存了鼠标切换后的窗口截图。macOS 通用包通过双架构、签名完整性和大文本回归检查。[构建记录](https://github.com/innoerL/OpenAll/actions/runs/44909116413)

安装包的 SHA-256 与该次云端构建一致。macOS 安装包使用临时签名，尚未公证。[安装包和校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.2)

## 0.27.1 历史验证

设置导航即时选中，背景色与强调色分别显示名称和对勾。卡片使用实色，按钮保留按下反馈。两个平台基于同一提交 `656b164` 构建。

| 平台 | 已验证 |
| --- | --- |
| macOS | 原生窗口从含旧版材质偏好的隔离资料启动，通过深浅色背景、唯一选中色样、导航和剪贴板焦点检查。通用安装包包含 Intel 与 Apple Silicon 架构，通过签名完整性检查。[云端记录](https://github.com/innoerL/OpenAll/actions/runs/44906509461) |
| Windows x64 | 安装器完成安装、启动、全页面截图及卸载。旧配置保留自定义配色，设置、JSON、文本对比与剪贴板多窗口回归通过。[云端记录](https://github.com/innoerL/OpenAll/actions/runs/44906509425) |

本地安装包已与各自云构建的 SHA-256 核对。macOS 使用临时签名且尚未公证，Windows 安装器尚未代码签名。[下载与校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.1)

## 0.27.0 历史验证

本次增加可选毛玻璃卡片、深色面板指针光晕、设置导航过渡与按钮波纹。

| 平台 | 已验证的安装包与界面 |
| --- | --- |
| macOS | Intel 与 Apple Silicon 通用构建通过签名完整性检查。从云端 ZIP 解压启动后，实测设置的毛玻璃开关、卡片底纹与剪贴板搜索焦点。JSON 大文本与金价窗口回归通过。[构建与检查记录](https://github.com/innoerL/OpenAll/actions/runs/44903264375) |
| Windows x64 | 发布的安装包来自提交 `3d534d5`，安装、启动、卸载通过。[安装包构建记录](https://github.com/innoerL/OpenAll/actions/runs/44903033219)。后续提交仅更新验收脚本，设置、JSON、文本对比与剪贴板另通过画面检测。[补充外观检查](https://github.com/innoerL/OpenAll/actions/runs/44904929228) |

两个本地安装包的 SHA-256 均与各自的云构建记录一致。macOS 使用临时签名，尚未公证。Windows 安装器尚未代码签名。[下载与校验文件](https://github.com/innoerL/OpenAll/releases/tag/v0.27.0)

## 0.26.2 历史验证

本次调整金价参考估计并增加到期价格误差、区间覆盖率和样本量。周大福使用固定开发段选择的保守基准；方向概率与点价分开说明。原有已发行预测不会被新版替换。

| 平台 | 验证提交 | 云端结果 |
| --- | --- | --- |
| macOS | `6e577205a68446145b1fab6dccf541e190933afd` | [通用构建、金价与 JSON 原生窗口回归通过](https://github.com/innoerL/OpenAll/actions/runs/44899774338) |
| Windows | `6e577205a68446145b1fab6dccf541e190933afd` | [完整回归、实际安装与卸载通过](https://github.com/innoerL/OpenAll/actions/runs/44899774301) |

后续验证文档提交不改变安装包内容。

### 已验证

- 金价共享模型与外观 42 项通过。新增覆盖：时间截断、过期基准的实际预测跨度、当日报价特征、历史未就绪时暂估、同日最早发行版本保留、准时与迟到统计分离、价格误差及缺失值单位口径。
- 固定评估中，生产 CTF 默认模型与冻结的 persistence 在开发 321 对、留出 178 对上，点价、区间及方向概率逐值一致。结果与局限见 [预测评估记录](forecast-evaluation.md)。
- macOS 原生后台：JavaScriptCore 与 Node 快照 3,753 个字段一致；fixture 内存隔离与只读 WAL 迁移通过。原生窗口 26 项通过，包含外观、币种、曲线、展望、贴边及关闭重开。
- Windows 金价集成 36 项通过，新增验证方向概率文案、无样本不显示零误差、保守基准说明、MAPE/覆盖率/样本量、迟到分离与暂估状态。合成统计仅注入页面内存，恢复后宿主数据不变。
- 两平台既有编辑器、大文本、折叠删除及内部剪贴板回归通过；Windows 安装包完成实际安装、运行与卸载。详细记录见 [Mac 金价验证](gold-macos-verification.json) 和 [Windows 验证](../windows/docs/cloud-verification.json)。
- macOS Universal 同时包含 Intel／Apple Silicon；本地签名完整性通过，无独立金价应用或 Electron 运行时。两端本地安装包的 SHA-256 均与 Actions 产物一致。

### 预测效果与边界

58 个固定留出次日样本中，平均绝对误差由 13.682 降至 11.052 元／克，但配对改善的 95% 时间块 bootstrap 区间为 [-0.436, 5.349]，跨过零，不能证明未来稳定改善。此次采用历史日线代理，不能当作当时 10:00 实盘可得数据的回放。

没有使用 11/21 已知实际价格调参；不声称这一单次预测更准。保守点价沿用基准，不保证价格保持不变。方向概率仍未完成实盘校准，国际现货点价仍使用原历史情景方法。

本轮 GUI 与安装验证均使用隔离目录及合成数据。历史评估只读取一致性数据库副本，不改写用户原库。历史发行保留另在副本中核实，升级前后已存档记录逐行一致。外部行情接口的后续实时可用性不由这些离线测试保证。

### 安装包

安装包及 SHA-256 文件见 [v0.26.2 Release](https://github.com/innoerL/OpenAll/releases/tag/v0.26.2)。macOS ZIP 约 5.6 MB，使用系统 AppKit、WebKit、JavaScriptCore 与 SQLite；Windows 复用 OpenAll 的 Electron。

macOS 为临时签名且未经过 Apple 公证；Windows 安装器未代码签名。使用方式和数据迁移见 [金价说明](../shared/gold-core/README.md)。
