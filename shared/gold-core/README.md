# OpenAll 金价工具

搜索“金价”“金价桌台”或 `gold` 即可打开。窗口和后台由 OpenAll 管理，不启动或依赖独立金价桌台应用。

保留金价桌台 v1.4.0 的国际现货、中国内地周大福足金饰品牌价、近一年曲线、昨日及七日前变化、USD / EUR / CNY 每克换算、合并图表、七日展望、实际预测验证、宏观因素、国际事件、财经日历与来源链接。保留置顶、最小化、左右贴边收起、悬停展开及位置记忆。

背景与强调色实时跟随 OpenAll 外观设置。两个品种使用不同的数值、曲线和图例颜色；合并图另用实线与虚线区分。预计涨为红色、预计跌为绿色、预计维持为中性色，并保留文字标识。外观调整不会重载窗口或重置当前品种与曲线查值。

## 数据与调度

- 报价按北京时间每天 10:00 调度，启动、唤醒和恢复联网时补拉；失败的品种独立每 30 分钟重试。历史日线独立加载。
- 第一次打开工具后启动后台；关闭窗口保留取价，退出 OpenAll 后停止。关机期间不执行，重新打开后补拉。
- macOS 使用 `~/Library/Application Support/OpenAll/gold/quotes.sqlite`；Windows 使用 OpenAll 用户数据目录中的 `gold-desk/quotes.sqlite`。延续 0.26.0 的 OpenAll 金价数据。
- OpenAll 金价库不存在时，只读打开同一用户的 `GoldDesk/quotes.sqlite`，通过 SQLite 一致性备份导入，包含 WAL 中未合并的记录。原库不删除、不改写；已有 OpenAll 库不覆盖。
- 国际原始价为美元／金衡盎司，快照按当前币种转换到每克；周大福始终为人民币／克。官网不可用时，两个备用来源需同日同价。
- 正式预测随后台快照生成并落库，可信度仍为**待校准**。网络失败时保留有效报价并显示状态。行情数据不放入源码或安装包。

## 实现

- `shared/gold-core`：共用原取价、调度、换汇、预测、验证模型和测试。
- `shared/gold-ui`：OpenAll 工具界面，通过受限的 `openallGold` 接口读取快照、订阅变化和操作宿主。
- macOS：`GoldService.swift` 用系统 JavaScriptCore 执行模型，系统 SQLite 保存数据，URLSession 请求行情，隔离 WKWebView 读取官网。`GoldTool.swift` / `GoldEdgeDock.swift` 管理 AppKit 窗口和贴边浮条。无外部进程和额外 Electron 运行时。
- Windows：`gold-service.js` / `gold-window.js` 使用 OpenAll 的 Electron 主进程、统一窗口登记与预加载脚本。仅金价窗口能调用对应 IPC，官网读取页面没有宿主权限；外部来源链接须匹配白名单。

## 验证

```sh
node --test shared/gold-core/test/*.test.cjs
zsh macos/scripts/check-gold-native.sh
npm --prefix windows run test:gold
```

macOS 构建后运行隔离样例窗口检查：

```sh
OPENALL_PREVIEW_ROOT="$PWD/macos/.build/gold-preview" \
OPENALL_PREVIEW_OUTPUT="$PWD/macos/.build/gold-screens" \
OPENALL_GOLD_CHECK=1 \
macos/.build/OpenAll.app/Contents/MacOS/OpenAll --design-snapshot
```

模型测试覆盖补拉、重试、来源、换汇、预测与验证；原生回归逐字段比较 JavaScriptCore 与 Node 快照，并验证只读 WAL 迁移及现有库优先。GUI 检查覆盖宿主窗口、曲线、展望、币种、外观即时同步、置顶、最小化、贴边、关闭重开与 IPC 隔离。测试用独立目录和合成行情，不访问用户数据。离线回归不能证明实时接口持续可用。

回测入口为 `scripts/evaluate-forecast.cjs`，必须显式提供数据库路径及 development / holdout 样本边界。
