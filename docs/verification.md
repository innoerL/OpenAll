# 0.26.1 发布验证

金价改为 OpenAll 内置工具，背景及强调色实时跟随宿主，曲线与涨跌保留独立语义颜色。JSON 全选删除直接清空折叠内容，局部删除仍先展开，支持撤销恢复正文及原折叠状态。

| 平台 | 验证提交 | 云端结果 |
| --- | --- | --- |
| macOS | `7f1fee9acbac6247daa4513edb29d52794f95c77` | [通用构建、金价与 JSON 原生窗口回归通过](https://github.com/innoerL/OpenAll/actions/runs/44729212731) |
| Windows | `877c34a29be968bd198641fa1f43efe7a0ee1c79` | [完整回归、实际安装与卸载通过](https://github.com/innoerL/OpenAll/actions/runs/44711290725) |

后一个 macOS 修复只改变原生文本布局与 macOS 工作流，Windows 源码和资源与上述验证提交一致。后续验证文档提交不改变安装包内容。

## 已验证

- 金价共享模型与外观 26 项：调度、重试、断网重连、币种、预测、只读 WAL 迁移及现有库优先；32 组背景／强调色组合中，语义文字及两种曲线保持对比度。
- macOS 原生后台：JavaScriptCore 与 Node 快照 3,639 个字段一致，fixture 强制内存隔离。原生窗口 26 项通过，包含外观即时刷新、查看状态保留、旧位置转换、桥接隔离、贴边及最小化恢复。
- macOS JSON：折叠编辑、搜索、内部剪贴板、混合撤销历史、全选 Backspace／Delete、根折叠及局部删除规则通过；后台旧结果不会覆盖清空后的文档。
- Windows：工具检查 144 项、编辑器 21 项、跨窗集成 9 项、金价 30 项通过；实际安装包再次通过安装、运行与卸载检查。详细结果见 [Windows 验证记录](../windows/docs/cloud-verification.json)。
- macOS Universal 包同时包含 Intel／Apple Silicon，签名完整性通过；归档已确认不包含独立金价应用或 Electron 运行时。两端安装包 SHA-256 与 Actions 产物一致。

## 大文件清空实测

| 环境 | 文档场景 | 全选清空 | 撤销／重做 |
| --- | --- | --- | --- |
| macOS 云端优化构建 | 5,100,002 字节，5,000 个折叠节点 | 2.95 ms | 撤销 0.91 s，重做 1.08 ms；未展开隐藏正文 |
| macOS 云端优化构建 | 仅一个节点折叠，可见投影仍约 5 MB | 直接清空 | 撤销 60.6 ms，提前恢复大文本布局 |
| Windows 原生 Electron | 5,026,001 字节 | 3.10 ms，仅渲染 1 行 | 撤销正文保真、重做清空通过 |

这些时间对应本次测试机器和样例，不能表示任意大小文档的固定耗时。大文本限制、后台计算及过期结果取消继续保留。

## 联网核验

2026-11-20 使用独立临时库验证 macOS 原生后台：报价、历史、汇率及市场背景共 6 项任务全部完成。国际金价 301 个历史点、周大福 314 个历史点；当天周大福来源为官方商城。CNY／EUR 汇率各 263 条，国际事件 5 条，FOMC／BLS／EIA 日历全部可用。没有读取用户正式数据，外部接口后续可用性仍随网络与服务变化。

## 安装包与边界

安装包及校验文件见 [v0.26.1 Release](https://github.com/innoerL/OpenAll/releases/tag/v0.26.1)。macOS ZIP 约 5.6 MB，使用系统 AppKit、WebKit、JavaScriptCore 与 SQLite；Windows 复用 OpenAll 的 Electron。

价格口径和预测算法沿用金价桌台 v1.4.0，预测可信度仍待校准。macOS 为临时签名且未经过 Apple 公证；Windows 安装器未代码签名。使用方式和数据迁移见 [金价说明](../shared/gold-core/README.md)。
