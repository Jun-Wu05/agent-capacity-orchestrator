# P0-00 Codex Desktop 原生自动化能力与缺口分析

- 对应 Issue：#6
- 结果：`TODO`（最终填写 `ACO_NEEDED_FULL` / `ACO_NEEDED_COMPANION` / `NATIVE_SUFFICIENT`）

## 1. 环境

```text
Windows 版本：11
Windows build：10.0.26100.8875
Codex Desktop 版本：
Node.js：v24.11.1
Git：2.52.0.windows.1
PowerShell：10.0.26100.8875
实验时间：
```

## 2. Desktop 自动化入口盘点

```text
是否存在 Automations / Scheduled Tasks：是 / 否 / 未找到
入口位置：
是否可设置未来执行时间：
是否可选择 project：
是否可选择已有 thread/session：
是否有运行历史：
是否有失败原因：
是否有本地通知：
```

## 3. 测试 Repo

```text
测试 Repo：C:\aco-prototype\desktop-native-test
```

建议只使用专门测试仓库，不使用真实项目。

## 4. 定时执行实验

### 4.1 Desktop 保持打开

任务：创建 `AUTOMATION_MARKER_OPEN.txt`

```text
计划执行时间：
实际执行时间：
是否成功：
是否创建新 thread：
是否沿用已有 thread：
是否有通知：
备注：
```

### 4.2 Desktop 关闭

任务：创建 `AUTOMATION_MARKER_CLOSED.txt`

```text
计划执行时间：
Desktop 是否完全退出：
是否成功：
是否在重新打开 Desktop 后补执行：
是否有通知/历史：
备注：
```

### 4.3 Windows 锁屏

任务：创建 `AUTOMATION_MARKER_LOCKED.txt`

```text
计划执行时间：
是否成功：
解锁后状态：
备注：
```

## 5. Windows 重启恢复实验

```text
重启前任务是否仍可见：
重启后任务是否仍存在：
是否自动执行：
如果错过计划时间，是否补执行：
是否要求手动打开 Codex Desktop：
备注：
```

## 6. Existing Thread Continuation 实验

先在一个已有 thread 中完成任务前半段，再尝试通过自动化继续。

```text
是否能直接绑定已有 thread：
如果不能，是否只能创建新任务/thread：
是否保留原对话上下文：
是否识别已有 repo 修改：
是否能正确继续原目标：
备注：
```

## 7. Capacity / Quota 行为

如果当前没有真实额度耗尽，可先记录 UI 和原生自动化能观察到的行为。

```text
Desktop 是否展示 quota / reset 信息：
展示位置：
自动化是否能以 quota 恢复作为条件：
是否只能基于固定时间：
到点但 quota 未恢复时行为：
是否自动重试：
是否有失败原因：
真实 quota exhaustion 是否已验证：是 / 否
```

## 8. Runtime 连续性

| 设置 | 原任务 | 自动化执行时 | 是否保持 | 备注 |
|---|---|---|---|---|
| model | | | | |
| reasoning | | | | |
| sandbox | | | | |
| approval | | | | |
| project/cwd | | | | |

## 9. Git / Workspace 行为

```text
是否继续使用原 repo：
是否识别已有 staged 修改：
是否识别已有 unstaged 修改：
是否识别已有 untracked 文件：
是否会创建独立 worktree：
是否有 Git 状态保护机制：
是否存在覆盖用户现场的风险：
```

## 10. 外部调用入口

检查是否存在可供 ACO 使用的稳定入口。

```text
CLI：有 / 无 / 未验证
URI scheme：有 / 无 / 未发现
本地 IPC/API：有 / 无 / 未发现
Shell command：有 / 无 / 未发现
其他：
```

## 11. Gap Matrix

| 能力 | Desktop 原生支持 | 稳定性 | ACO 是否仍需要 | 备注 |
|---|---|---|---|---|
| 定时启动 | | | | |
| 继续已有 thread | | | | |
| Capacity-aware | | | | |
| quota 未恢复自动等待 | | | | |
| 重启后保留 | | | | |
| App 关闭时执行 | | | | |
| 锁屏时执行 | | | | |
| Git 状态保护 | | | | |
| Runtime 保持 | | | | |
| 失败解释 | | | | |
| 外部调用入口 | | | | |

## 12. 结论

最终三选一：

```text
ACO_NEEDED_FULL
ACO_NEEDED_COMPANION
NATIVE_SUFFICIENT
```

### 理由

- 
- 
- 

### ACO 最值得补的缺口

1. 
2. 
3. 

## 13. 对 PRD / TDD 的影响

```text
Desktop-first 是否成立：
CLI 是否仍为 MVP 必需依赖：
是否需要完整 daemon：
是否需要 Capacity Provider：
是否需要 Task Snapshot：
是否需要 worktree/checkpoint：
MVP 最小闭环建议：
```

## 14. 脱敏证据

只贴最小必要截图描述、字段、时间和行为；不要提交完整私密对话、token 或账号信息。

- 
