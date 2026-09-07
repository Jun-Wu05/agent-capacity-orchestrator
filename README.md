# Agent Capacity Orchestrator

一个 Windows-first 的本地 Coding Agent 调度工具，用于在用户指定的 Agent 恢复额度或进入可执行窗口后，继续该 Agent 自己原本的项目/任务。

> 当前状态：PRD 前 / `grill-with-docs` 设计澄清阶段。

## MVP 方向

MVP **不是跨 Agent 路由器**。

用户先指定某一个 Agent 及其项目/任务，例如 Codex；后续可扩展 ZCODE。调度器只观察该 Agent 自己的额度、恢复时间和可执行条件，并在满足条件后由**同一个 Agent**继续原任务。

### 已确定原则

- 同 Agent 恢复优先；MVP 不做 Codex → ZCODE 或 ZCODE → Codex 的任务切换。
- 第一刀可以只支持 Codex。
- 核心抽象是可持久化的 Task，而不是依赖一个持续存活的终端进程。
- 优先恢复原生 Session；原生 Session 不可恢复时，以 Task Snapshot 作为任务级恢复依据。
- MVP 从“额度耗尽后显式交给调度器”开始，后续再做自动识别与自动接管。
- Windows-first，但核心领域模型避免写死 Windows。
- 从第一版开始做任务隔离。
- 从第一版开始建模 Capacity Confidence：`EXACT` / `OBSERVED` / `ESTIMATED` / `UNKNOWN`。
- MVP 不做 AI scoring，不自动在不同 Agent 之间选择执行者。
- 无人值守任务默认允许本地修改、测试、本地提交；默认不自动 push / merge。
- 默认 `start_policy=AUTO`：满足执行条件后自动恢复；后续支持 `MANUAL` 与通知渠道驱动的 `ASK`。
- MVP 提供本地通知；飞书、微信等外部通知/控制渠道只预留接口，不在第一版实现。

正式 PRD 会在 `grill-with-docs` 访谈完成后再编写。
