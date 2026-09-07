# ADR 0001：以 Task 为持久化核心，Session 仅作为可选恢复手段

- 状态：已接受
- 日期：2026-09-07

## 背景

不同 Coding Agent 对 Session 的持久化与恢复能力不同。Codex 当前支持原生 Session 恢复，但未来其他 Agent（如 ZCODE）未必提供同等能力，且 Session 机制可能随平台版本变化。

如果产品把“任务是否可恢复”完全绑定到平台 Session，那么跨平台扩展、版本兼容和异常恢复都会非常脆弱。

## 决策

系统以 `Task` 作为持久化与恢复的核心抽象。

- 任务必须绑定一个 Agent，MVP 不允许跨 Agent 接力。
- 平台原生 `Resume Session` 在可靠时优先使用。
- `Task Snapshot` 作为持久化兜底，保证 Session 不可用或恢复失败时仍有机会继续任务。
- Task 的可恢复性不得依赖原终端进程继续存活。
- 恢复后的工作连续性以工作区状态、Git 状态、Snapshot 与运行时配置为准，而不是承诺进程级断点续跑。

## 影响

### 正面

- 降低对单一 Agent Session 格式的耦合。
- 为 ZCODE、Claude 等后续 Adapter 留出统一扩展边界。
- 支持 Session 丢失、损坏或不可恢复时的 fallback。

### 代价

- 需要设计并维护 Task Snapshot schema。
- 需要为任务进度、工作区、运行时配置和恢复校验建立额外状态模型。
