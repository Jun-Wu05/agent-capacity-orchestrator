# Agent 开发说明

本仓库目前处于 PRD 前的设计探索阶段。

## 强制工作流

1. 对非平凡的产品或架构决策，先进行 `grill-with-docs` 风格的访谈，不要直接进入实现。
2. 将稳定的领域术语维护在 `CONTEXT.md`。
3. 只有同时满足“难以逆转、缺少上下文会令人意外、存在真实取舍”时才创建 ADR。
4. 除非产品决策被明确重新讨论，否则不要把 MVP 扩展成跨 Agent 路由器。
5. 优先拆成小而可测试的增量；保持 Windows-first，但不要把核心领域模型硬编码成 Windows-only。
6. 仓库内说明性文档统一使用中文；代码标识符、接口名、CLI 参数、配置键优先使用英文。

## 当前 MVP 护栏

- 一个 Task 在整个生命周期内绑定一个 Agent。
- Capacity / Eligibility 调度是核心问题。
- Codex 与 ZCODE 之间的任务转移不属于 MVP。
- 第一刀可以只支持 Codex。
- 优先使用平台原生 Resume Session，但 Task 的可恢复性不能依赖 Session 一定可恢复。
- Task Snapshot 作为编排器自己的持久化工作断点，需要单独设计字段和恢复语义。
- MVP 接管入口先采用额度耗尽后的显式 handoff，后续再做自动检测。
- 任务隔离从第一版开始做。
- 中途接管的首选方案是本地临时 checkpoint commit + isolated worktree。
- 恢复时应尽量保持原模型与运行时设置；若不可用，不应静默切换。
- Task Snapshot 自动生成，用户无需手工维护。
- 默认 `start_policy=AUTO`。
- 无人值守默认权限止于本地修改、测试、本地 commit；除非后续策略明确授权，不自动 push / merge。
- MVP 提供本地通知；飞书、微信等外部通知与控制只预留扩展接口。
- MVP 不使用 AI scoring 或跨 Agent 自动路由。
