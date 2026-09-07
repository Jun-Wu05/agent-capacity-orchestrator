# Agent Capacity Orchestrator V0.1 MVP Spec

## 1. 目标

V0.1 只证明一个核心能力：

> 在 Windows 的 Git 项目中，当 Codex 因额度耗尽而中断后，用户显式把当前任务交给 ACO；ACO 持久化任务状态、等待额度恢复，并在满足安全条件后自动恢复同一个 Codex 任务，最终完成测试、本地提交与中文通知。

V0.1 不是多 Agent Router，不做 Codex → ZCODE 或 ZCODE → Codex 接力。

## 2. 首发范围

### 支持

- Windows-first
- Git repository only
- Codex only
- 用户在额度耗尽后显式执行 `aco resume-later`
- 捕获并绑定准确的 Codex Session
- 自动生成并持续更新 Task Snapshot
- Capacity / Eligibility 状态建模
- Capacity Confidence：`EXACT` / `OBSERVED` / `ESTIMATED` / `UNKNOWN`
- 本地临时 checkpoint commit
- isolated Git worktree
- daemon 后台等待与恢复
- `start_policy=AUTO` 默认
- AUTO 前执行 Preflight Check
- 优先 Resume Session
- Session 恢复失败时尝试 Resume Task fallback
- 保持原模型与关键 runtime 配置
- transient error 最多自动重试 3 次
- 本地修改、测试、本地 commit
- 成功后整理内部 checkpoint commits
- Windows 中文本地通知
- CLI 状态和 explain 信息默认中文
- SQLite / Snapshot 持久化，不因 daemon 重启或产品升级丢任务

### 不支持

- 跨 Agent 切换或路由
- ZCODE Adapter（V0.1 后）
- 非 Git 项目
- 自动 push / PR / merge
- 默认访问任务工作区外任意文件
- AI scoring
- Web Dashboard
- 飞书 / 微信 / 企业微信 / Telegram 实际通知
- 进程级、指令级或内存级断点续跑
- 自动复制所有 ignored 文件

## 3. 核心用户流程

```text
用户正常在 Codex 中开发
        ↓
Codex 额度耗尽
        ↓
用户在项目中执行 aco resume-later
        ↓
识别当前 Git 项目与 Codex Session
        ↓
生成 Task + Task Snapshot
        ↓
捕获 runtime / Git / Capacity 状态
        ↓
创建本地 checkpoint commit
        ↓
创建 isolated worktree
        ↓
任务进入 WAITING_CAPACITY
        ↓
daemon 持久等待
        ↓
达到或超过 reset 时间
        ↓
重新读取真实 Capacity
        ↓
Eligibility = true
        ↓
执行 Preflight Check
        ↓
全部通过
        ↓
恢复原 Codex Session
        ↓
若 Session Resume 失败，则检查是否允许 Resume Task fallback
        ↓
继续任务
        ↓
关键事件更新 Snapshot / checkpoint
        ↓
运行测试
        ↓
生成正常最终本地 commit
        ↓
整理内部 checkpoint commits
        ↓
状态 COMPLETED
        ↓
Windows 中文通知
```

## 4. Task 状态模型（初版）

内部状态码使用英文，用户展示使用中文。

建议最小状态集：

- `CAPTURING`：正在捕获任务
- `WAITING_CAPACITY`：等待额度恢复
- `READY`：满足执行条件，等待启动策略处理
- `PREFLIGHT`：正在进行恢复前检查
- `RESUMING_SESSION`：正在恢复原 Session
- `RESUMING_TASK`：正在使用 Task Snapshot fallback
- `RUNNING`：任务执行中
- `TESTING`：正在运行测试
- `FINALIZING`：正在整理 commit / Snapshot / worktree
- `COMPLETED`：成功完成
- `BLOCKED`：需要人工处理
- `FAILED`：任务失败且自动重试已结束
- `CANCELLED`：用户取消

状态迁移必须持久化；daemon 自身不保存唯一真相。

## 5. Task Snapshot

Task Snapshot 是 Task 的持久状态，而非一次性备份文件。

### 设计原则

- 自动生成，不要求用户手工维护。
- 必须包含 `schema_version`。
- ACO 升级时需要 Snapshot migration，不能丢失等待任务。
- 在关键事件自动 checkpoint，不要求高频逐秒写入。
- Session 可恢复时，Snapshot 仍用于恢复前校验。
- Session 不可恢复时，Snapshot 是 Resume Task 的主要输入。

### 建议字段分组

具体 schema 在实现前单独定稿，但至少需要覆盖：

- Task identity：task id、创建时间、当前状态
- Agent binding：agent 类型、adapter 版本
- Project：原 repo、worktree、branch
- Session：session id、是否可恢复、最后验证时间
- Objective：任务目标 / continuation 信息
- Git checkpoint：base commit、checkpoint commit、dirty/untracked 摘要
- Runtime：model、reasoning、sandbox、approval 等可恢复设置
- Capacity：额度状态、reset 时间、confidence、最后观测时间
- Execution：start policy、重试状态、权限策略
- Progress：最近 checkpoint、测试状态、最后阶段
- Notification：最近通知状态（非业务真相）

## 6. Capacity 与 Eligibility

V0.1 只针对当前 Task 绑定的 Codex 判断，不做 Agent 选择。

Capacity 结果应区分：

- `EXACT`：结构化、可信的 reset/额度信息
- `OBSERVED`：从 CLI、日志或错误信息直接观测
- `ESTIMATED`：根据历史推算
- `UNKNOWN`：无法判断

AUTO 不能仅因为“时间到了”就启动，必须重新检查 Capacity。

## 7. Preflight Check

AUTO 恢复必须满足全部必要检查：

- Task / Snapshot schema 可读取且 migration 成功
- 原 Git repo 仍存在
- isolated worktree 存在且状态可解释
- checkpoint 与预期一致
- Codex CLI 可执行
- 保存的 Session 可验证，或 Task Resume fallback 条件满足
- 原 model / runtime 仍可使用
- Capacity 当前真的允许执行
- 权限策略允许本次无人值守操作

任一关键项失败：进入 `BLOCKED`，禁止猜测、强制切换模型或强行执行。

## 8. Runtime 恢复

恢复时优先保持原任务的关键设置，包括：

- model
- reasoning effort（若可观测/可设置）
- sandbox
- approval policy
- cwd / project context
- 其他会影响无人值守行为的关键 overrides

如果原设置已不可用，应阻塞并用中文说明原因，不静默换模型或放宽权限。

## 9. 错误与重试

### 可重试错误

如临时网络错误、短暂 Agent 启动失败等。

- 最多 3 次
- 建议退避：1 分钟 → 5 分钟 → 15 分钟

### 不可自动重试

例如：

- Git 冲突或 checkpoint 不一致
- Session 与项目无法确定绑定
- 原模型不可用
- 权限不足
- Snapshot 损坏且无法 migration
- workspace 缺失

进入 `BLOCKED`，等待用户处理。

## 10. Git 与隔离

- V0.1 只支持 Git repository。
- `resume-later` 接管时捕获 staged、unstaged、untracked 状态。
- 使用本地 checkpoint commit 固化可恢复锚点。
- 后台继续执行发生在 isolated worktree。
- 默认不复制 ignored 文件。
- 未来通过显式 allowlist 支持 `.env.test` 等必要 ignored 资源。
- 成功完成后整理内部 checkpoint，最终应向用户呈现一个正常的最终 commit。

## 11. 权限边界

默认无人值守权限目标：

- task worktree：允许读写、删除、运行测试、创建本地 commit
- 原 repo：尽量只读 / 用于验证
- 项目之外：默认拒绝或不主动访问
- 不自动 push / merge

实际实现必须与 Codex 自身 sandbox / approval 配置结合，ACO 不应绕过 Agent 的安全限制。

## 12. CLI（V0.1）

命令名最终发布前可调整，MVP 至少需要：

```bash
aco resume-later
aco status
aco tasks
aco explain <task-id>
aco cancel <task-id>
aco daemon status
```

用户输出默认中文；内部 key / status code 保持英文。

## 13. Daemon

- daemon 本身无状态。
- SQLite / Task Snapshot 是持久化真相。
- daemon 被杀死、Windows 重启、升级后重新启动，都必须重新扫描未完成 Task。
- 如果 reset 时间已过去，重新检查 Capacity 与 Eligibility，而不是把任务视为“错过”。

## 14. 本地通知

V0.1 只实现 Windows 本地通知，至少覆盖：

- Task 已被接管并进入等待
- 额度恢复并开始自动恢复
- Task 完成
- Task 失败
- Task 被阻塞，需要人工处理

飞书、微信、企业微信等只预留 Notification Adapter / Control Adapter 接口，不在 V0.1 实现。

## 15. 分发形态

核心产品与 Agent Skill 分层：

### 核心程序

目标安装体验：

```bash
npx agent-capacity-orchestrator install
```

安装 CLI、daemon、SQLite 初始化和 Windows 集成。

### 可选 Agent Skill

未来可支持类似：

```bash
npx skills add Jun-Wu05/agent-capacity-orchestrator
```

Skill 负责告诉 Agent 何时以及如何调用 `aco`；Skill 不承担 daemon、数据库和后台调度本体。

## 16. V0.1 MVP 验收标准

只有以下真实闭环在 Windows 上连续跑通，才算 MVP 成立：

1. 使用真实 Git 测试项目。
2. Codex 已存在一个真实 Session。
3. 任务已经产生未完成修改。
4. 真实或可控方式触发额度耗尽。
5. 用户执行 `aco resume-later`。
6. 系统准确绑定当前 Git 项目与 Codex Session。
7. 自动生成带版本号的 Task Snapshot。
8. 创建本地 checkpoint。
9. 创建 isolated worktree。
10. 保存原模型与关键 runtime 设置。
11. Task 进入等待状态。
12. daemon 重启后 Task 不丢失。
13. reset 时间达到后重新检查真实 Capacity。
14. Preflight Check 全部通过。
15. 自动恢复保存的 Codex Session。
16. Session 恢复失败时，能够按规则尝试 Task Resume fallback；无法安全恢复则 BLOCKED。
17. 恢复后不静默切换模型 / 权限。
18. Codex 继续完成原任务，而不是新建无关任务。
19. 运行测试。
20. 产生一个正常的最终本地 commit。
21. 内部 checkpoint 被正确整理。
22. Windows 给出中文完成/失败/阻塞通知。
23. `aco status` / `aco explain` 能用中文准确解释最终状态。

## 17. V0.1 后的优先迭代

按当前产品方向，后续候选顺序为：

1. 自动检测 quota exhaustion，减少手动 `resume-later`。
2. ZCODE Adapter。
3. ZCODE peak / off-peak Eligibility。
4. `ASK` start policy + 远程通知/控制渠道。
5. MCP Server。
6. Agent Skill。
7. Web Dashboard。
8. 更多 Agent Adapter。

跨 Agent task handoff 不属于近期默认路线，除非以后重新进行产品决策。
