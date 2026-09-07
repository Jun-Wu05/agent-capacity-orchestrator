# 领域上下文

本文件只记录稳定的领域语言，不是 PRD，也不是实现计划。

## 核心术语

### Agent
用户为某个任务选择的 Coding Agent 平台或运行时，例如 Codex、ZCODE。

### Agent-bound Task（绑定 Agent 的任务）
一个持久化的工作单元，并绑定到一个指定 Agent。MVP 中，Task 的整个生命周期都由同一个 Agent 执行；跨 Agent 接力不在范围内。

### Resume Task
当绑定的 Agent 再次满足执行条件后，根据持久化的任务状态和工作区状态继续原任务。Resume Task 不要求原终端进程一直存活。

### Resume Session
使用平台原生的 Session 身份或恢复能力，继续之前完全相同的 Agent 会话。可靠时优先使用 Resume Session，但 Task 的可恢复性不能依赖 Session 一定可恢复。

### Task Snapshot
由本工具自动生成并持久化的“任务工作断点”。它保存足够的信息，使平台原生 Session 无法恢复或恢复失败时，仍能继续同一个 Task。可能包含：Agent Session 引用、项目与 worktree、任务目标、Git 状态、checkpoint/progress、执行策略、模型与运行时设置、最近一次 Capacity 状态等。具体字段和恢复语义仍需专门设计。

### Capacity
Agent 在平台限制下执行任务的能力状态，例如滚动额度窗口、额度恢复时间、峰时/谷时条件等。

### Eligibility
某个 Agent-bound Task 当前是否允许执行。它由该任务绑定 Agent 的 Capacity 状态与任务调度策略共同决定。

### Capacity Confidence
Capacity 观测结果的可信度：`EXACT`、`OBSERVED`、`ESTIMATED`、`UNKNOWN`。

### Task Isolation（任务隔离）
让无人值守任务在隔离的工作环境中执行，避免与用户当前 checkout 冲突。MVP 的首选方向是中途接管时创建本地临时 checkpoint commit，再迁移到 isolated worktree。

### Start Policy
当 Task 已满足执行条件时，决定是否自动开始执行的策略。候选模式：`AUTO`、`MANUAL`，后续增加通过通知/控制渠道确认的 `ASK`。MVP 默认 `AUTO`。

### Local Notification（本地通知）
由当前 Windows 设备本地展示的任务状态提醒，例如系统 Toast、托盘/桌面通知或终端提示。MVP 只要求本地提醒任务已恢复、完成或失败；飞书、微信等远程渠道不在第一版实现。

## MVP 已确定边界

- 只做同 Agent 继续，不做 Codex ↔ ZCODE 自动任务切换。
- 第一刀可以只支持 Codex。
- MVP 接管方式先做：额度耗尽后由用户显式执行类似 `resume-later` 的 handoff；后续再做自动检测与自动接管。
- 优先使用平台原生 Resume Session，Resume Task 作为持久化兜底。
- Task Snapshot 自动生成，用户不需要手工维护。
- Task Snapshot 的字段、版本、恢复语义需要作为独立设计主题。
- Windows-first。
- 从第一版开始做 Task Isolation。
- 中途接管首选：本地临时 checkpoint commit + isolated worktree。
- 从第一版开始建模 Capacity Confidence。
- MVP 不做 AI scoring 和跨 Agent 自动选择。
- 无人值守执行可以本地修改文件、运行测试并创建本地 commit；默认不自动 push / merge。
- 恢复任务时应保持原模型与关键运行时设置；如果原配置不可继续，应暂停并明确提示，不静默切换。
- `start_policy=AUTO` 为 MVP 默认值；如果电脑在 nominal reset 时间关机，则下次启动后重新判断 Eligibility，再依据 start policy 行动。
- MVP 提供本地通知；飞书、微信等外部通知/控制渠道只预留接口。

## 仍待设计的问题

- Codex Session 的发现、识别与准确绑定方式。
- Task Snapshot 的完整 schema、checkpoint 触发点、版本兼容与恢复校验机制。
- checkpoint commit 如何处理 staged、unstaged、untracked、ignored 文件，以及最终是否 squash。
- isolated worktree 的生命周期、路径、清理和异常恢复规则。
- 无人值守执行的文件系统权限边界，以及与 Agent 自身 sandbox/approval 设置的关系。
- CLI / daemon 生命周期、安装与分发方式。
- Windows 本地通知的具体实现方式。
- 飞书、微信等 Notification Adapter / Control Adapter 的扩展接口。
- 模型、reasoning、sandbox、approval 等运行时设置如何捕获、存储和恢复。
