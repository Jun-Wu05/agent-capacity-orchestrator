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
由本工具自动生成并持久化的“任务工作断点”。它不是一次性文件，而是 Task 的持久状态。系统在关键事件发生时自动更新 Snapshot，例如捕获任务、恢复执行、关键文件状态变化、测试完成、额度再次中断、任务完成等。它保存足够的信息，使平台原生 Session 无法恢复或恢复失败时，仍能继续同一个 Task。具体 schema、版本与恢复语义仍需专门设计。

### Capacity
Agent 在平台限制下执行任务的能力状态，例如滚动额度窗口、额度恢复时间、峰时/谷时条件等。

### Eligibility
某个 Agent-bound Task 当前是否允许执行。它由该任务绑定 Agent 的 Capacity 状态与任务调度策略共同决定。

### Capacity Confidence
Capacity 观测结果的可信度：`EXACT`、`OBSERVED`、`ESTIMATED`、`UNKNOWN`。

### Task Isolation（任务隔离）
让无人值守任务在隔离的工作环境中执行，避免与用户当前 checkout 冲突。MVP 的首选方向是中途接管时创建本地临时 checkpoint commit，再迁移到 isolated worktree。

### Checkpoint Commit
为了保证中途接管与二次恢复的稳定性，系统可以创建本地临时 checkpoint commit。运行过程中允许存在多个内部 checkpoint；任务最终成功时，应整理为一个正常的最终提交，避免把内部恢复提交长期暴露在用户 Git 历史中。

### Start Policy
当 Task 已满足执行条件时，决定是否自动开始执行的策略。候选模式：`AUTO`、`MANUAL`，后续增加通过通知/控制渠道确认的 `ASK`。MVP 默认 `AUTO`。

### Preflight Check
`start_policy=AUTO` 不代表强行执行。任务真正恢复前必须完成安全与一致性校验，例如：Session 是否可用、worktree 是否存在、checkpoint 是否一致、模型/运行时配置是否仍可用、Capacity 是否真的恢复。只有全部通过才启动；失败时进入阻塞状态并给出明确原因。

### Local Notification（本地通知）
由当前 Windows 设备本地展示的任务状态提醒，例如系统 Toast、托盘/桌面通知或终端提示。MVP 只要求本地提醒任务已恢复、完成或失败；飞书、微信等远程渠道不在第一版实现。

### 中文展示层
所有面向用户的文档、CLI 状态、错误原因、解释信息和通知文案默认使用中文。内部状态码、接口名、类型名、CLI 参数和配置键可使用英文，以保持机器可读性、生态兼容性与跨平台开发一致性。

## MVP 已确定边界

- 只做同 Agent 继续，不做 Codex ↔ ZCODE 自动任务切换。
- 第一刀可以只支持 Codex。
- MVP 接管方式先做：额度耗尽后由用户显式执行类似 `resume-later` 的 handoff；后续再做自动检测与自动接管。
- 优先使用平台原生 Resume Session，Resume Task 作为持久化兜底。
- Task Snapshot 自动生成，用户不需要手工维护。
- Task Snapshot 作为持久状态，在关键事件自动 checkpoint，而不是只在接管时生成一次。
- Task Snapshot 的字段、版本、恢复语义需要作为独立设计主题。
- Windows-first。
- 从第一版开始做 Task Isolation。
- 中途接管首选：本地临时 checkpoint commit + isolated worktree。
- 运行过程允许多个本地 checkpoint commit；最终成功时整理成一个正常最终 commit。
- 默认不复制 `.gitignore` 命中的 ignored 文件；未来通过明确 allowlist 支持必要资源。
- 从第一版开始建模 Capacity Confidence。
- MVP 不做 AI scoring 和跨 Agent 自动选择。
- 无人值守执行可以本地修改文件、运行测试并创建本地 commit；默认不自动 push / merge。
- 恢复任务时应保持原模型与关键运行时设置；如果原配置不可继续，应暂停并明确提示，不静默切换。
- `start_policy=AUTO` 为 MVP 默认值；如果电脑在 nominal reset 时间关机，则下次启动后重新判断 Eligibility，再依据 start policy 行动。
- AUTO 恢复前必须通过 Preflight Check；未通过则阻塞，不强行执行。
- CLI `status` / `explain` 等用户可见信息默认中文，并明确展示当前状态、阻塞原因、恢复时间、Confidence 与下一步动作。
- MVP 提供本地通知；飞书、微信等外部通知/控制渠道只预留接口。

## 仍待设计的问题

- Codex Session 的发现、识别与准确绑定方式。
- Task Snapshot 的完整 schema、checkpoint 触发点、版本兼容与恢复校验机制。
- checkpoint commit 如何处理 staged、unstaged、untracked 文件，以及内部提交最终 squash 的具体规则。
- ignored 文件 allowlist 的配置方式与安全边界。
- isolated worktree 的生命周期、路径、清理和异常恢复规则。
- 无人值守执行的文件系统权限边界，以及与 Agent 自身 sandbox/approval 设置的关系。
- CLI / daemon 生命周期、安装与分发方式。
- Windows 本地通知的具体实现方式。
- 飞书、微信等 Notification Adapter / Control Adapter 的扩展接口。
- 模型、reasoning、sandbox、approval 等运行时设置如何捕获、存储和恢复。
