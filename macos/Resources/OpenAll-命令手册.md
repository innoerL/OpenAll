# Shell 与 Java 服务器常用命令手册

`alias` 是 Shell 的命令别名。以下 Linux 服务命令以 systemd 为例；macOS 本机没有 `systemctl`、`journalctl`。把 `my-java.service` 换成实际服务名。涉及停止、重启和删除的命令先确认环境与目标。

## Shell 常用命令

| 用途 | 命令 | 说明 |
| --- | --- | --- |
| 当前目录 | `pwd` | 显示工作目录 |
| 列文件 | `ls -lah` | 含隐藏文件及易读体积 |
| 切目录 | `cd /path/to/dir` | 进入目录 |
| 查文件名 | `find . -name '*.log'` | 递归查找日志 |
| 查文本 | `grep -Rni 'ERROR' ./logs` | 显示文件和行号 |
| 看末尾日志 | `tail -n 100 app.log` | 末尾 100 行 |
| 跟随日志 | `tail -F app.log` | 日志轮转后继续跟随 |
| 看空间 | `df -h` | 文件系统剩余空间 |
| 看目录大小 | `du -sh ./logs` | 汇总目录体积 |
| 看进程 | `ps aux | grep '[j]ava'` | 避免匹配 grep 自身 |
| 看端口 | `ss -ltnp` | Linux 监听端口与进程 |
| 远程登录 | `ssh user@host` | 登录服务器 |
| 上传文件 | `scp app.jar user@host:/opt/app/` | 复制到远端 |
| 解压 | `tar -xzf archive.tar.gz` | 解压 gzip tar 包 |
| 查看别名 | `alias` | 列出当前 Shell 的别名 |
| 取消别名 | `unalias name` | 删除当前会话中的别名 |

## Java 服务排查

| 用途 | 命令 | 说明 |
| --- | --- | --- |
| Java 版本 | `java -version` | 确认运行时版本 |
| 列 JVM 进程 | `jps -lv` | JDK 工具，列 PID 和启动参数 |
| 看进程启动行 | `ps -ef | grep '[j]ava'` | 无 JDK 工具时可用 |
| 服务状态 | `systemctl status my-java.service` | systemd 服务状态 |
| 最近日志 | `journalctl -u my-java.service -n 200 --no-pager` | 最近 200 行 |
| 实时日志 | `journalctl -u my-java.service -f` | 跟随输出 |
| 指定时间日志 | `journalctl -u my-java.service --since '1 hour ago'` | 最近一小时 |
| 看 JVM 命令 | `jcmd <PID> help` | 列出当前 JVM 支持的诊断命令 |
| 线程转储 | `jcmd <PID> Thread.print` | 排查死锁或卡顿 |
| 堆概况 | `jcmd <PID> GC.heap_info` | 查看堆信息 |
| 看端口 | `ss -ltnp | grep ':8080'` | 核对监听端口 |
| HTTP 健康检查 | `curl -fsS http://127.0.0.1:8080/actuator/health` | 路径按服务实际配置修改 |
| 重启服务 | `sudo systemctl restart my-java.service` | 会中断服务，先确认环境 |

## 可复制的 alias 示例

放入服务器用户的 `~/.bashrc` 或 `~/.zshrc`，并将服务名改为实际名称；重开 Shell 后生效。

```sh
alias jstatus='systemctl status my-java.service'
alias jlogs='journalctl -u my-java.service -n 200 --no-pager'
alias jfollow='journalctl -u my-java.service -f'
alias jps='jps -lv'
alias ports='ss -ltnp'
```

`alias` 适合固定命令前缀。需要参数、流程判断或跨环境执行时，使用 Shell 函数更合适：

```sh
jlogsince() {
  journalctl -u my-java.service --since "$1" --no-pager
}
# 示例：jlogsince '1 hour ago'
```

## 参考资料

- [GNU Bash：Aliases](https://www.gnu.org/software/bash/manual/html_node/Aliases.html)
- [Oracle JDK：诊断工具与命令](https://docs.oracle.com/javase/9/tools/troubleshooting-tools-and-commands.htm)
- [systemctl 手册](https://man7.org/linux/man-pages/man1/systemctl.1.html)
- [journalctl 手册](https://man7.org/linux/man-pages/man1/journalctl.1.html)
