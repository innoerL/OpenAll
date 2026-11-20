# OpenAll 金价工具

从金价桌台 **v1.4.0** 整合。OpenAll 搜索框输入“金价”“金价桌台”或 `gold`，回车打开。无需单独安装金价桌台。

保留国际现货黄金和中国内地周大福足金饰品牌价、近一年曲线、昨日及七日前变化、USD / EUR / CNY 每克换算、合并图表、七日展望、实际预测验证、宏观因素、国际事件、财经日历与来源链接。浮窗保留明暗主题、置顶、最小化、左右贴边收起、悬停展开及位置记忆。

报价按北京时间每天 10:00 调度，启动、唤醒和恢复联网时补拉；失败的品种独立每 30 分钟重试。官网和备用来源、数据口径、历史采样、预测规则沿用原实现。预测可信度仍为**待校准**，不会因接入 OpenAll 而改变。

## 使用与数据

- 第一次打开工具后开始后台调度；关闭金价窗口保留后台取价，再搜索“金价”可恢复。退出 OpenAll 时同时停止金价组件。未曾打开金价时不会启动它的后台进程。
- macOS 保存在 `~/Library/Application Support/OpenAll/gold/quotes.sqlite`；Windows 保存在 OpenAll 自己的用户数据目录下 `gold-desk/quotes.sqlite`。
- 第一次创建 OpenAll 金价库时，若同一用户的 `GoldDesk/quotes.sqlite` 存在，则通过 SQLite 一致性备份导入报价、历史、预测记录、任务状态与偏好。备份包含 WAL，原数据库只读、不删除、不改写。宿主已有金价库时不覆盖。
- 两个应用以后各自管理自己的数据与取价任务。测试模式使用独立目录和合成行情，不访问旧金价库，也不连接行情服务。
- 程序退出或电脑关机期间没有取价进程；重新打开工具后补拉。数据源不可用时保留此前有效数据并显示状态。

## 目录与复用

`app/host.cjs` 导出 `createGoldTool()`，供 Windows 主进程和 macOS 内置组件共用；后台快照在窗口关闭后仍生成，确保正式展望按原规则保存。

`app/main.cjs` 仅为 macOS 辅助组件入口，管理单实例恢复、父进程存活与退出。Windows 不加载该入口，不会覆盖宿主名称、数据目录或全局主题。

`store.cjs`、`scheduler.cjs`、`sources.cjs`、`outlook.cjs`、`currency.cjs` 等沿用原算法。`ctf-official.cjs` 保留隔离浏览器读取官网，新增随宿主退出中止的能力。IPC 统一使用 `openall-gold:` 前缀，限定工具主窗口或对应贴边条调用。

macOS 随应用内置校验过的 Electron 45.4.1，Universal 构建包含 Intel / Apple Silicon 两个运行组件；Windows 复用 OpenAll 已有 Electron。数据接口为运行时自带的 `node:sqlite`，不引入第三方 SQLite 驱动。

## 验证

在仓库根目录运行：

```sh
node --test shared/gold-desk/test/*.test.cjs
npm --prefix windows run test:gold
```

macOS 构建后执行原生搜索与内置组件专项：

```sh
OPENALL_PREVIEW_ROOT="$PWD/macos/.build/gold-preview" \
OPENALL_PREVIEW_OUTPUT="$PWD/macos/.build/gold-screens" \
OPENALL_GOLD_CHECK=1 \
macos/.build/OpenAll.app/Contents/MacOS/OpenAll --design-snapshot
```

测试覆盖时段补拉、断网重连、独立重试、交易日、来源一致性、币种、预测与验证、浮窗，以及旧库 WAL 一致性迁移。GUI 专项使用离线样例验证入口、曲线、预测页、币种、主题、置顶、最小化、贴边、关闭重开与 IPC 隔离。网络来源实时可用性不能由离线回归保证。

原有回测入口保留在 `scripts/evaluate-forecast.cjs`，必须显式提供自己的数据库路径及 development / holdout 样本边界。行情数据没有打入源码或安装包。
