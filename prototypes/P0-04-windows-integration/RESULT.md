# P0-04 Windows 本地通知 / Daemon 启动验证结果

- 对应 Issue：#4
- 结果：`PASS`（通知、非管理员注册登录任务、真实登录自动触发均已验证，见 §8）

## 1. 环境

```text
Windows 版本：Windows 10 Pro 25H2，CurrentBuild 26200.9457（注册表 ProductName 如此显示；26200 属 Windows 11 系列内核）
Node.js 版本：v24.11.1
PowerShell 版本：pwsh 7.6.6；Windows PowerShell 5.1 存在，但启动时报"组策略阻止了这个程序"
是否管理员运行：否（普通域用户）
实验时间：2026-10-23 17:00–17:40（+08:00）；登录触发核查 2026-10-26 09:06–09:12；真实重启验证 2026-11-02 09:24
```

**执行环境说明（避免误读）**：实验由 DSH 会话中的 agent 执行。该会话的文件沙箱只允许写工作区和 `%TEMP%\dsh-*`，并禁止子进程开命名管道、禁止 `&` 直接调用部分系统程序。凡是在沙箱内失败、放宽权限后成功的项，下文都已标明；这些失败**不代表普通用户没有权限**，只代表 agent 会话受限。

## 2. Windows 本地通知

### 候选实现 A：SnoreToast（node-notifier 自带的 vendor 可执行文件）

```text
方案/库：node-notifier@10 → vendor/snoreToast/snoretoast-x64.exe
安装命令：npm install node-notifier@10 --cache <工作区内目录>
         （沙箱内默认 npm 缓存目录不可写，需 --cache 指到可写位置；正常用户环境无此问题）
测试命令：snoretoast-x64.exe -t "ACO 测试 A：SnoreToast" -m "任务「修复登录页」已恢复执行 ✅ 中文显示测试" -appID ACO.P004.Test -silent
         （用 Process.Start 直接调用，不经 node-notifier 封装）
结果：exit=3（TimedOut），耗时约 9 秒，即通知已弹出并在默认时长后自动消失
是否成功显示中文：参数含中文与 emoji，调用成功；用户未单独回报目视截图
是否需要管理员权限：否
依赖：snoretoast-x64.exe（约 2.5 MB，随 node-notifier 安装）
问题：
  - node-notifier 的 WindowsToaster 封装通过命名管道回传点击结果；沙箱禁止命名管道，封装路径未测通。
    普通用户环境应可用，但未在沙箱外验证。
  - 未注册 AppUserModelID 快捷方式时，通知来源名的显示需在正式版确认。
```

SnoreToast 退出码（摘自 node-notifier 源码注释）：`-1` Failed、`0` Success、`1` Hidden、`2` Dismissed、`3` TimedOut、`4` ButtonPressed、`5` TextEntered。

### 候选实现 B：PowerShell + WinRT ToastNotificationManager

```text
方案：[Windows.UI.Notifications.ToastNotificationManager, ContentType = WindowsRuntime]
结果：
  - pwsh 7：找不到类型（.NET 5+ 不再内置 WinRT 投影），不可用。
  - PowerShell 5.1：启动即报"组策略阻止了这个程序"，无法测试。
结论：企业机器上不能假设 powershell.exe 5.1 可用，不作为 V0.1 方案。
旁证：pwsh 7 可加载 System.Windows.Forms.NotifyIcon（气泡通知），可作最后兜底，未实际弹出。
```

### 推荐结论

```text
V0.1 推荐方案：直接调用 SnoreToast 可执行文件（随包分发或取自 node-notifier vendor），不依赖 PowerShell。
原因：
  - 无需管理员、无需 PowerShell、中文参数可用；
  - 只依赖进程启动，不依赖命名管道（企业/沙箱环境更稳）；
  - 退出码可区分"已显示/被关闭/失败"。
  - 如需点击回调，再评估 node-notifier 封装或 SnoreToast 的 -pipeName 参数。
```

## 3. Daemon 自启动方式

### Windows Task Scheduler（登录触发）

```text
是否成功：注册成功；手动触发成功；真实重启后登录自动触发成功（见 §8）
是否需要管理员权限：否（沙箱内被拒，放宽权限后以普通用户成功）
注册方式：schtasks /Create /TN ACO-P004-Probe-OnLogon /XML task-onlogon.xml /F
  任务属性：LogonTrigger（当前用户）、InteractiveToken、RunLevel=LeastPrivilege、
           MultipleInstancesPolicy=IgnoreNew、ExecutionTimeLimit=PT0S、
           DisallowStartIfOnBatteries=false、StopIfGoingOnBatteries=false
  查询结果：Logon Mode = Interactive only，Schedule Type = At logon time
登录后是否启动：是。2026-11-02 开机 08:41:21，登录 08:58:10（sihost），任务 08:58:14 触发，
              探针 08:58:27 写入 argv=["schtasks-onlogon"]，Last Result=0
重启后是否恢复：是（同一次验证，属真实关机→开机→登录）
手动触发：schtasks /Run 后探针写入 argv=["schtasks-onlogon"]，cwd 为 XML 中的 WorkingDirectory，Last Result=0
重复启动表现：间隔约 5 秒再次 /Run，又起了一个新实例。第一个实例已立即退出，
             所以 IgnoreNew 能否挡住并发实例，这次没测到。单实例必须由 daemon 自己的锁保证（TDD §13.2）
卸载/清理难度：低，schtasks /Delete /TN <name> /F
问题：
  - 用 /TR 传命令行失败：两层引号遇到"带空格路径 + 中文路径"必然解析出错。
    改用 /XML，Command / Arguments / WorkingDirectory 分字段写入，彻底避开转义。
  - XML 需以 UTF-16 保存（与声明 encoding="UTF-16" 一致）。
  - 探针立即退出，未观察 node.exe 是否弹出控制台窗口；常驻 daemon 很可能会，需隐藏窗口方案（见 §7）。
```

### Startup / 登录启动（启动文件夹、HKCU\...\Run）

```text
是否成功：只验证了写入权限，未验证登录后是否真的拉起
是否需要管理员权限：否（沙箱内被拒，放宽权限后普通用户可写，探针项已立即删除）
登录后是否启动：未测
重复启动表现：无内置防重，完全依赖 daemon 自己的锁
卸载/清理难度：低
问题：没有电池/执行时限等配置项，也没有失败重启；不如 Task Scheduler 可控
```

### Windows Service

```text
是否成功：未测试
是否需要管理员权限：是
复杂度：高（服务会话无法直接弹用户通知，需要额外的用户会话代理）
是否适合 V0.1：否，与 TDD §13.4"不要求无人登录状态运行"一致
```

## 4. 推荐方案

```text
V0.1 daemon 启动方式：Task Scheduler 登录触发任务，用 schtasks /Create /XML /F 注册（普通用户，LeastPrivilege）
单实例锁建议：%LOCALAPPDATA%\aco\daemon.lock，fs.openSync(path,'wx') 独占创建 + 写入 PID；
             获取失败时检查 PID 是否存活，死进程视为 stale lock 回收。
             Task Scheduler 的 IgnoreNew 只作为第二道防线。
安装方式：aco daemon install → 生成 XML（Command 用 process.execPath 绝对路径）→ schtasks /Create /XML /F（幂等）
卸载方式：aco daemon uninstall → schtasks /Delete /TN <name> /F，并清理锁文件
```

## 5. 结论

```text
PASS
- 通知：PASS（SnoreToast 直调，非管理员，中文参数）
- 非管理员注册登录任务 + 手动触发：PASS
- 真实登录时自动触发：PASS（2026-11-02 重启验证，登录后约 4 秒触发，约 17 秒后探针写日志）
```

## 6. 对 TDD 的影响

- NotificationAdapter：`WindowsToastAdapter` 实现为"启动 SnoreToast 进程 + 解析退出码"，不依赖 PowerShell/WinRT，也不依赖命名管道；退出码 `-1` 记为通知失败，但不影响 Task 状态。
- daemon installer：用 `/XML` 注册而非 `/TR`；XML 必须显式设置 `ExecutionTimeLimit=PT0S`（默认 72 小时会杀掉常驻 daemon）和两项电池设置为 `false`（笔记本拔电时默认会停任务）。Command 记录 node 绝对路径，node 升级或移动后任务失效，需要 `aco doctor` 检查。
- daemon lifecycle：登录触发只覆盖"用户登录"，锁屏/解锁不会触发；daemon 意外退出后不会自动拉起，可考虑 `RestartOnFailure`（未测）。
- single-instance：以 daemon 自身锁文件为准，不依赖 Task Scheduler 的实例策略。

## 7. 其他发现

- **控制台窗口**：InteractiveToken 下启动 `node.exe` 预计会显示控制台窗口。常驻 daemon 需要隐藏，候选：`conhost.exe --headless`、小型 GUI 子系统启动器、daemon 自身 detached + windowsHide 重启。未测，留给实现阶段 spike。
- **企业环境限制**：本机 `powershell.exe` 5.1 被组策略阻止；任何安装/运行步骤都不应依赖它。
- **网络**：沙箱内 Windows schannel 的 HTTPS 不可用，Node 自带 TLS 可访问 npm registry。仅影响 agent 在会话内装包，与 ACO 产品无关。
- **判断是否真的注销过**：看 `sihost.exe` / `explorer.exe` 的启动时间，每次登录都会重新创建它们。

## 8. 登录自动触发验证（已完成）

**结果：PASS（2026-11-02）**。真实关机→开机→登录，探针日志出现新记录：

```text
开机        2026-11-02 08:41:21（LastBootUpTime）
登录        08:58:10（sihost.exe 启动时间）
任务触发    08:58:14（schtasks Last Run Time，Last Result=0）
探针写日志  08:58:27  pid=10612 argv=["schtasks-onlogon"] cwd=<XML 中的 WorkingDirectory>
```

- 触发时机：登录后约 4 秒；node 进程实际写日志又晚约 13 秒（登录期间系统繁忙）。
  → daemon 启动后不能假设网络、Codex Desktop 已就绪，首轮调度应容忍依赖未就绪。
- 探针任务 `\ACO-P004-Probe-OnLogon` 已于 2026-11-02 09:25 删除（`schtasks /Delete … /F`，exit=0，再查询报"找不到"）。

原验证步骤（存档）：

当前状态：探针任务 `\ACO-P004-Probe-OnLogon` 保留在系统中，登录时只往日志写一行后立即退出。

- 探针脚本：`_aco-sandbox/windows-integration/daemon-probe/aco-probe-daemon.js`
- 任务 XML：`_aco-sandbox/windows-integration/daemon-probe/task-onlogon.xml`
- 日志：`_aco-sandbox/windows-integration/daemon-probe/daemon-starts.log`

验证步骤：用户下次正常关机→开机（或注销→登录）后，检查日志是否出现登录时间附近的 `argv=["schtasks-onlogon"]` 新记录，并核对 `schtasks /Query /TN ACO-P004-Probe-OnLogon /V` 的 Last Run Time。

- 出现新记录 → 本项改为 PASS，整体结论改为 PASS。
- 没有记录 → 查 TaskScheduler/Operational 事件日志定位原因。

验证后无论结果如何都执行清理：

```text
schtasks /Delete /TN ACO-P004-Probe-OnLogon /F
```
