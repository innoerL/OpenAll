# 0.26.2 发布验证

本次调整金价参考估计并增加到期价格误差、区间覆盖率和样本量。周大福使用固定开发段选择的保守基准；方向概率与点价分开说明。原有已发行预测不会被新版替换。

| 平台 | 验证提交 | 云端结果 |
| --- | --- | --- |
| macOS | `6e577205a68446145b1fab6dccf541e190933afd` | [通用构建、金价与 JSON 原生窗口回归通过](https://github.com/innoerL/OpenAll/actions/runs/44899774338) |
| Windows | `6e577205a68446145b1fab6dccf541e190933afd` | [完整回归、实际安装与卸载通过](https://github.com/innoerL/OpenAll/actions/runs/44899774301) |

后续验证文档提交不改变安装包内容。

## 已验证

- 金价共享模型与外观 42 项通过。新增覆盖：时间截断、过期基准的实际预测跨度、当日报价特征、历史未就绪时暂估、同日最早发行版本保留、准时与迟到统计分离、价格误差及缺失值单位口径。
- 固定评估中，生产 CTF 默认模型与冻结的 persistence 在开发 321 对、留出 178 对上，点价、区间及方向概率逐值一致。结果与局限见 [预测评估记录](forecast-evaluation.md)。
- macOS 原生后台：JavaScriptCore 与 Node 快照 3,753 个字段一致；fixture 内存隔离与只读 WAL 迁移通过。原生窗口 26 项通过，包含外观、币种、曲线、展望、贴边及关闭重开。
- Windows 金价集成 36 项通过，新增验证方向概率文案、无样本不显示零误差、保守基准说明、MAPE/覆盖率/样本量、迟到分离与暂估状态。合成统计仅注入页面内存，恢复后宿主数据不变。
- 两平台既有编辑器、大文本、折叠删除及内部剪贴板回归通过；Windows 安装包完成实际安装、运行与卸载。详细记录见 [Mac 金价验证](gold-macos-verification.json) 和 [Windows 验证](../windows/docs/cloud-verification.json)。
- macOS Universal 同时包含 Intel／Apple Silicon；本地签名完整性通过，无独立金价应用或 Electron 运行时。两端本地安装包的 SHA-256 均与 Actions 产物一致。

## 预测效果与边界

58 个固定留出次日样本中，平均绝对误差由 13.682 降至 11.052 元／克，但配对改善的 95% 时间块 bootstrap 区间为 [-0.436, 5.349]，跨过零，不能证明未来稳定改善。此次采用历史日线代理，不能当作当时 10:00 实盘可得数据的回放。

没有使用 11/21 已知实际价格调参；不声称这一单次预测更准。保守点价沿用基准，不保证价格保持不变。方向概率仍未完成实盘校准，国际现货点价仍使用原历史情景方法。

本轮 GUI 与安装验证均使用隔离目录及合成数据。历史评估只读取一致性数据库副本，不改写用户原库。历史发行保留另在副本中核实，升级前后已存档记录逐行一致。外部行情接口的后续实时可用性不由这些离线测试保证。

## 安装包

安装包及 SHA-256 文件见 [v0.26.2 Release](https://github.com/innoerL/OpenAll/releases/tag/v0.26.2)。macOS ZIP 约 5.6 MB，使用系统 AppKit、WebKit、JavaScriptCore 与 SQLite；Windows 复用 OpenAll 的 Electron。

macOS 为临时签名且未经过 Apple 公证；Windows 安装器未代码签名。使用方式和数据迁移见 [金价说明](../shared/gold-core/README.md)。
