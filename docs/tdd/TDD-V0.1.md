# Agent Capacity Orchestrator V0.1 技术设计文档（TDD）

- 文档状态：V0.1 草案
- 对应 PRD：`docs/prd/PRD-V0.1.md`
- 对应 MVP Spec：`docs/mvp/MVP-SPEC.md`
- 首发平台：Windows
- 首发 Agent：Codex
- 日期：2026-09-07

---

## 1. 文档目的

本 TDD 用于把 PRD 中已经确定的产品行为，转化为可实现、可测试、可拆 Ticket 的工程设计。

V0.1 的目标不是做一个通用多 Agent 平台，而是先完整实现：

> Codex 任务在额度耗尽后，由用户执行 `aco resume-later` 交给 ACO；ACO 保存可恢复状态、等待额度恢复、执行 Preflight，并在条件满足后自动继续同一个 Codex 任务。

本设计明确：

- Task 是持久化核心；
- Session 是优先恢复手段，不是唯一依赖；
- daemon 无状态；
- SQLite + Task Snapshot 是持久化真相；
- 中途接管采用 checkpoint commit + isolated worktree；
- 用户可见信息默认中文；
- V0.1 不做跨 Agent 路由。

---

## 2. 设计约束

### 2.1 产品约束

V0.1：

- Windows-first；
- Git repository only；
- Codex only；
- `start_policy=AUTO` 默认；
- 不自动 push / PR / merge；
- 不静默切换模型、Agent 或放宽权限；
- 本地通知；
- 瞬时错误最多自动重试 3 次。

### 2.2 Codex 现实约束

Codex 当前 CLI 支持通过 Session UUID 恢复历史会话，因此 ACO 必须保存准确 UUID，而不是依赖 `--last`。

实现时不得假设：

- Session picker 一定能列出所有可恢复 Session；
- 本地 rollout JSONL 一定包含可靠 `rate_limits`；
- `resume` 行为在所有版本都绝对一致；
- Codex 本地文件格式永远稳定。

因此所有 Codex 私有/半私有数据读取必须封装在 Adapter 层，并允许后续替换。

---

## 3. 总体架构

```text
┌─────────────────────────────┐
│          用户 / Agent        │
└──────────────┬──────────────┘
               │ CLI
               ▼
┌─────────────────────────────┐
│          ACO CLI            │
│ resume-later / status / ... │
└──────────────┬──────────────┘
               │
               ▼
┌─────────────────────────────┐
│      Application Layer      │
│ TaskService                 │
│ ResumeService               │
│ EligibilityService          │
│ PreflightService            │
└──────────────┬──────────────┘
               │
     ┌─────────┼─────────┐
     ▼         ▼         ▼
┌──────────┐ ┌────────┐ ┌─────────────┐
│ Domain   │ │Codex   │ │Git/Workspace│
│ Model    │ │Adapter │ │Service      │
└────┬─────┘ └───┬────┘ └──────┬──────┘
     │           │             │
     └──────┬────┴──────┬──────┘
            ▼           ▼
      ┌──────────┐  ┌──────────┐
      │ SQLite   │  │ Snapshot │
      │ Store    │  │ Store    │
      └──────────┘  └──────────┘
            ▲
            │
┌───────────┴─────────────────┐
│           Daemon            │
│ 扫描未完成 Task / 触发恢复    │
└─────────────────────────────┘
```

### 3.1 分层原则

- `domain`：纯领域模型，不依赖 Windows、Codex、本地路径。
- `application`：编排 Task 生命周期。
- `adapters`：Codex、通知、未来 ZCODE 等外部系统适配。
- `infra`：SQLite、Git、文件系统、Windows daemon/service。
- `cli`：只负责参数解析、调用 Application Service、中文展示。

---

## 4. 建议目录结构

```text
src/
├── cli/
│   ├── commands/
│   ├── presenters/
│   └── index.ts
├── application/
│   ├── task-service.ts
│   ├── resume-service.ts
│   ├── eligibility-service.ts
│   ├── preflight-service.ts
│   └── notification-service.ts
├── domain/
│   ├── task.ts
│   ├── task-state.ts
│   ├── snapshot.ts
│   ├── capacity.ts
│   ├── eligibility.ts
│   ├── runtime-config.ts
│   └── errors.ts
├── adapters/
│   └── codex/
│       ├── codex-adapter.ts
│       ├── session-provider.ts
│       ├── capacity-provider.ts
│       ├── runtime-provider.ts
│       └── process-runner.ts
├── infra/
│   ├── persistence/
│   │   ├── sqlite.ts
│   │   ├── task-repository.ts
│   │   └── snapshot-repository.ts
│   ├── git/
│   │   ├── git-service.ts
│   │   ├── checkpoint-service.ts
│   │   └── worktree-service.ts
│   ├── daemon/
│   │   ├── daemon.ts
│   │   ├── lock.ts
│   │   └── scheduler-loop.ts
│   ├── notifications/
│   │   └── windows-toast.ts
│   └── platform/
│       └── windows.ts
└── shared/
    ├── clock.ts
    ├── logger.ts
    └── result.ts
```

测试：

```text
tests/
├── unit/
├── integration/
├── fixtures/
│   ├── codex-sessions/
│   ├── git-repos/
│   └── snapshots/
└── e2e/
```

---

## 5. 核心领域模型

### 5.1 Task

```ts
interface Task {
  id: string
  agent: "codex"
  state: TaskState
  projectRoot: string
  worktreePath?: string
  branchName?: string
  sessionId?: string
  snapshotVersion: number
  startPolicy: "AUTO" | "MANUAL"
  retryCount: number
  createdAt: string
  updatedAt: string
}
```

Task 不保存全部 Snapshot 内容，只保存索引与当前关键状态。

### 5.2 TaskState

V0.1 状态：

```text
CAPTURING
WAITING_CAPACITY
READY
PREFLIGHT
RESUMING_SESSION
RESUMING_TASK
RUNNING
TESTING
FINALIZING
COMPLETED
BLOCKED
FAILED
CANCELLED
```

### 5.3 状态迁移规则

```text
CAPTURING
  ├─ success → WAITING_CAPACITY
  └─ error   → BLOCKED

WAITING_CAPACITY
  ├─ eligible → READY
  ├─ cancel   → CANCELLED
  └─ fatal    → BLOCKED

READY
  ├─ AUTO → PREFLIGHT
  └─ MANUAL → READY

PREFLIGHT
  ├─ pass → RESUMING_SESSION
  └─ fail → BLOCKED

RESUMING_SESSION
  ├─ success → RUNNING
  ├─ safe fallback → RESUMING_TASK
  └─ unsafe → BLOCKED

RESUMING_TASK
  ├─ success → RUNNING
  └─ fail → BLOCKED

RUNNING
  ├─ tests needed → TESTING
  ├─ quota exhausted → WAITING_CAPACITY
  ├─ transient error → retry / FAILED
  └─ fatal error → BLOCKED

TESTING
  ├─ pass → FINALIZING
  ├─ fail but agent can fix → RUNNING
  └─ unrecoverable → BLOCKED

FINALIZING
  ├─ success → COMPLETED
  └─ error → BLOCKED
```

所有状态迁移必须通过统一 `TaskStateMachine` 完成，禁止业务代码直接随意 update `state`。

---

## 6. Task Snapshot v1 设计

### 6.1 目标

Snapshot 必须回答：

> 如果当前 Codex Session 无法继续，ACO 是否仍有足够信息安全地恢复“这件工作”？

### 6.2 存储方式

建议：

- SQLite 保存可检索字段和当前状态；
- Snapshot 以结构化 JSON 保存完整恢复信息；
- SQLite 保存 Snapshot path/hash/version；
- Snapshot 文件与数据库更新采用“先写临时文件 → fsync/close → 原子 rename → DB transaction”方式避免半写状态。

默认位置：

```text
%LOCALAPPDATA%\AgentCapacityOrchestrator\
├── aco.db
├── tasks\
│   └── <task-id>\
│       ├── snapshot.json
│       ├── snapshot.previous.json
│       └── logs\
└── worktrees\
```

### 6.3 Snapshot Schema v1

```json
{
  "schema_version": 1,
  "task": {
    "id": "task_xxx",
    "state": "WAITING_CAPACITY",
    "created_at": "...",
    "updated_at": "..."
  },
  "agent": {
    "type": "codex",
    "adapter_version": "0.1.0"
  },
  "project": {
    "root": "D:\\repo",
    "worktree": "D:\\...",
    "branch": "aco/task_xxx"
  },
  "session": {
    "id": "uuid",
    "source": "local-session",
    "last_verified_at": "...",
    "resumable": true
  },
  "objective": {
    "summary": "...",
    "continuation_prompt": "..."
  },
  "git": {
    "base_commit": "...",
    "checkpoint_commit": "...",
    "head_commit": "...",
    "dirty_summary": {},
    "untracked_files": []
  },
  "runtime": {
    "model": "...",
    "reasoning_effort": "...",
    "sandbox": "...",
    "approval_policy": "...",
    "cwd": "..."
  },
  "capacity": {
    "available": false,
    "reset_at": "...",
    "confidence": "OBSERVED",
    "observed_at": "...",
    "source": "..."
  },
  "execution": {
    "start_policy": "AUTO",
    "retry_count": 0,
    "permissions_profile": "workspace-safe"
  },
  "progress": {
    "last_checkpoint_type": "CAPTURED",
    "last_checkpoint_at": "...",
    "last_test_status": "UNKNOWN",
    "summary": "..."
  }
}
```

### 6.4 Snapshot 更新触发点

至少：

- `TASK_CAPTURED`
- `CHECKPOINT_CREATED`
- `WORKTREE_CREATED`
- `CAPACITY_OBSERVED`
- `PREFLIGHT_STARTED`
- `SESSION_RESUMED`
- `TASK_FALLBACK_STARTED`
- `RUN_STARTED`
- `QUOTA_INTERRUPTED`
- `TEST_COMPLETED`
- `FINAL_COMMIT_CREATED`
- `TASK_COMPLETED`
- `TASK_BLOCKED`
- `TASK_FAILED`

### 6.5 Migration

所有读取入口：

```text
read snapshot
→ inspect schema_version
→ run sequential migrations
→ validate current schema
→ only then use
```

禁止：

- 跳版本迁移；
- migration 失败后继续运行任务；
- 升级后直接删除旧 Snapshot。

---

## 7. SQLite 设计

### 7.1 原则

SQLite 保存：

- Task 索引；
- 当前状态；
- 调度时间；
- Snapshot 元数据；
- Retry；
- Event Log；
- daemon lease / operational metadata。

完整恢复上下文仍以 Snapshot 为主。

### 7.2 建议表

#### tasks

```sql
CREATE TABLE tasks (
  id TEXT PRIMARY KEY,
  agent TEXT NOT NULL,
  state TEXT NOT NULL,
  project_root TEXT NOT NULL,
  worktree_path TEXT,
  branch_name TEXT,
  session_id TEXT,
  start_policy TEXT NOT NULL,
  retry_count INTEGER NOT NULL DEFAULT 0,
  next_check_at TEXT,
  snapshot_path TEXT NOT NULL,
  snapshot_version INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

#### task_events

```sql
CREATE TABLE task_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  payload_json TEXT,
  created_at TEXT NOT NULL,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

#### schema_migrations

```sql
CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);
```

### 7.3 SQLite 模式

建议：

```text
journal_mode = WAL
foreign_keys = ON
busy_timeout = 5000
```

所有 Task 状态变化：

```text
DB transaction
+ event append
+ snapshot write
```

必须由 Application Service 统一控制顺序。

---

## 8. Codex Adapter

### 8.1 统一接口

```ts
interface AgentAdapter {
  detect(): Promise<AgentInfo>
  discoverSessions(projectRoot: string): Promise<AgentSession[]>
  inspectSession(sessionId: string): Promise<AgentSession>
  getRuntime(sessionId: string): Promise<RuntimeConfig>
  getCapacity(sessionId?: string): Promise<CapacityObservation>
  resumeSession(input: ResumeSessionInput): Promise<AgentRun>
  resumeTask(input: ResumeTaskInput): Promise<AgentRun>
  classifyError(error: unknown): AgentError
}
```

V0.1 只有 `CodexAdapter`。

### 8.2 Session Discovery

优先顺序：

1. 读取 Codex 可稳定识别的本地 Session 元数据；
2. 根据 `cwd/project root + 最近活动时间 + session UUID` 过滤；
3. 若只有一个高可信候选，自动绑定；
4. 多个候选无法唯一确定时，CLI 要求用户选择；
5. 最终保存 Session UUID。

禁止长期依赖：

```text
codex resume --last
```

作为 Task 绑定方式。

### 8.3 Session 校验

保存 Session 后，需要记录：

- id；
- project/cwd；
- source path（如果可得）；
- last activity；
- model/runtime metadata（如果可得）；
- last verified time。

Preflight 时重新验证。

### 8.4 Resume Session

执行目标：

```text
codex resume <SESSION_ID>
```

自动化实现不应只依赖“进程退出码 0”判断确实恢复成功。

还需要至少一项二次验证：

- resumed thread/session id 与预期一致；
- 新产生 session/event 与目标 UUID 一致；
- 或 Adapter 解析出明确的 resume success signal。

如果无法验证，按安全失败处理。

### 8.5 Resume Task Fallback

当 Session 无法安全 resume：

```text
new Codex execution
+ isolated worktree
+ Task Snapshot continuation prompt
+ explicit runtime
```

Continuation prompt 至少包含：

- 原任务目标；
- 当前 Git 状态；
- checkpoint commit；
- 已完成/未完成摘要；
- 要求先检查工作区和测试；
- 禁止重复已完成工作；
- 禁止扩大权限。

---

## 9. Capacity Provider

### 9.1 设计目标

Capacity Provider 不能等同于“读取某个 JSONL 字段”。

需要多来源观测：

```text
Structured source
→ local session telemetry
→ CLI error/status
→ known reset timestamp
→ fallback estimate
```

### 9.2 Observation

```ts
interface CapacityObservation {
  available: boolean | null
  resetAt?: string
  confidence: "EXACT" | "OBSERVED" | "ESTIMATED" | "UNKNOWN"
  source: string
  observedAt: string
  rawRef?: string
}
```

### 9.3 Source 优先级

建议：

1. 官方/结构化明确 reset 信号 → `EXACT`
2. Codex 错误/本地 telemetry 直接包含 reset → `OBSERVED`
3. 基于最后一次真实 reset + 已知窗口推算 → `ESTIMATED`
4. 无足够信息 → `UNKNOWN`

### 9.4 调度原则

`next_check_at` 只是降低轮询成本，不是执行授权。

达到 `next_check_at`：

```text
重新读取 Capacity
→ recompute Eligibility
→ true 才能进入 READY
```

---

## 10. Eligibility Engine

V0.1 不做 Agent scoring。

```ts
eligible =
  task.agent === "codex"
  && capacity.available === true
  && task.state === "WAITING_CAPACITY"
  && startPolicyAllows(task)
```

`AUTO` 仅决定是否自动从 `READY` 进入 `PREFLIGHT`。

---

## 11. Preflight Check

### 11.1 必检项目

按顺序：

1. Snapshot 可读取并完成 migration；
2. Task state 合法；
3. Git repo 存在；
4. worktree 存在且属于目标 repo；
5. checkpoint commit 存在；
6. worktree HEAD / branch 可解释；
7. Codex CLI 可执行；
8. Session 可验证，或 fallback 条件满足；
9. 原 runtime 配置仍可用；
10. Capacity 当前 available；
11. 权限策略允许；
12. 当前 Task 没有另一个 active run。

### 11.2 结果

```ts
interface PreflightResult {
  passed: boolean
  checks: PreflightCheckResult[]
  blockingReason?: BlockReason
}
```

用户展示必须中文。

---

## 12. Git Checkpoint 与 Worktree 算法

### 12.1 接管前检查

`aco resume-later`：

```text
git rev-parse --show-toplevel
→ git status --porcelain=v2
→ capture staged / unstaged / untracked
```

非 Git repo：立即停止。

### 12.2 Checkpoint Commit

中途接管需要保留用户现场。

推荐策略：

```text
1. 记录原 HEAD
2. 记录 index / working tree 状态
3. 将需要恢复的 tracked + untracked 内容纳入临时 checkpoint
4. 创建内部 branch
5. 创建 checkpoint commit
6. 确认 commit 可重建用户现场
7. 再创建 isolated worktree
```

必须保留原始 staged/unstaged 语义的摘要；V0.1 不要求 worktree 内继续保留 staged 与 unstaged 的视觉区别，只要求文件内容不丢失。

### 12.3 Ignored Files

默认不复制。

如果工作区需要 ignored 文件才能运行：

- V0.1 返回中文提醒；
- 后续版本增加 allowlist；
- 禁止自动复制全部 `.gitignore` 命中内容。

### 12.4 Worktree 路径

建议：

```text
%LOCALAPPDATA%\AgentCapacityOrchestrator\worktrees\<task-id>
```

branch：

```text
aco/task/<task-id>
```

### 12.5 Finalize

任务完成后：

1. 确保测试完成；
2. 创建最终正常 commit；
3. 将内部 checkpoint history 整理为用户可读历史；
4. 更新 Snapshot；
5. 标记 COMPLETED；
6. worktree 不立即物理删除，可进入可清理状态；
7. 后续提供 `aco cleanup`。

V0.1 不自动把最终 commit merge 回用户当前分支。

---

## 13. Daemon 设计

### 13.1 原则

Daemon 不保存 Task 真相。

每次启动：

```text
open DB
→ migrate DB
→ scan unfinished tasks
→ recompute next checks
→ enter loop
```

### 13.2 单实例

Windows V0.1 必须保证同一用户只运行一个 daemon。

方案：

- named mutex 或 lock file + PID validation；
- 获取不到锁则退出；
- stale lock 必须可恢复。

### 13.3 Scheduler Loop

建议：

```text
每 30 秒扫描一次到期 Task
```

但每个 Task 自己使用 `next_check_at`，避免频繁访问 Codex 数据。

Task 到期：

```text
load Task
→ getCapacity
→ persist observation
→ eligibility
→ AUTO ? preflight : READY
```

### 13.4 Windows 重启

安装阶段注册：

- 用户登录后启动 daemon；
- 不要求无人登录状态运行；
- V0.1 不做 Windows Server service-level 复杂权限。

后续可升级为正式 Windows Service。

---

## 14. Run / Retry 模型

每次真正尝试恢复定义为一个 Run。

建议增加表：

```sql
CREATE TABLE task_runs (
  id TEXT PRIMARY KEY,
  task_id TEXT NOT NULL,
  attempt INTEGER NOT NULL,
  mode TEXT NOT NULL,
  started_at TEXT NOT NULL,
  ended_at TEXT,
  result TEXT,
  error_code TEXT,
  FOREIGN KEY(task_id) REFERENCES tasks(id)
);
```

### 14.1 Retry

可重试：

```text
NETWORK_TEMPORARY
PROCESS_START_TEMPORARY
CAPACITY_STALE
```

退避：

```text
1 min
5 min
15 min
```

最多 3 次。

不可重试：

```text
SESSION_AMBIGUOUS
SNAPSHOT_INVALID
GIT_CONFLICT
CHECKPOINT_MISMATCH
MODEL_UNAVAILABLE
PERMISSION_DENIED
WORKTREE_MISSING
```

直接 `BLOCKED`。

---

## 15. Runtime Capture / Restore

### 15.1 需要捕获

如果 Codex 当前可观测：

- model；
- reasoning effort；
- sandbox；
- approval policy；
- cwd；
- relevant config overrides。

### 15.2 恢复规则

优先级：

```text
Task Snapshot runtime
> 用户当前全局默认
```

但 ACO 不允许自行放宽权限。

如果原 runtime 不可恢复：

```text
BLOCKED_CONFIGURATION
```

中文提示用户。

---

## 16. 通知接口

统一接口：

```ts
interface NotificationAdapter {
  notify(event: NotificationEvent): Promise<void>
}
```

V0.1：

```text
WindowsToastAdapter
```

事件：

- `TASK_CAPTURED`
- `TASK_RESUMING`
- `TASK_COMPLETED`
- `TASK_FAILED`
- `TASK_BLOCKED`

以后飞书/微信只增加 Adapter，不修改 Domain。

---

## 17. CLI 设计

### 17.1 `aco resume-later`

步骤：

```text
validate git
→ discover codex session
→ resolve ambiguity
→ capture runtime
→ capture capacity
→ create task
→ create snapshot
→ checkpoint git
→ create worktree
→ WAITING_CAPACITY
```

输出中文。

### 17.2 `aco status [task-id]`

显示：

- 任务；
- Agent；
- 项目；
- 中文状态；
- Capacity；
- reset；
- confidence；
- start policy；
- next action；
- last error。

### 17.3 `aco explain <task-id>`

把内部状态转换成中文因果解释，而不是只打印 JSON。

### 17.4 `aco tasks`

默认显示未完成任务；支持 `--all`。

### 17.5 `aco cancel <task-id>`

只取消未来调度；若有 active run，V0.1 需要先安全终止子进程，再标记 CANCELLED。

---

## 18. 安装与分发

### 18.1 技术栈

V0.1 推荐：

- TypeScript
- Node.js LTS
- npm package
- SQLite
- child_process / spawn
- Git CLI

### 18.2 包结构

一个 npm package：

```text
agent-capacity-orchestrator
```

暴露：

```text
aco
```

### 18.3 安装目标

```bash
npx agent-capacity-orchestrator install
```

安装：

- CLI；
- 本地数据目录；
- SQLite；
- daemon 启动项；
- 环境检测。

### 18.4 Skill

后续在仓库加入：

```text
skills/aco/SKILL.md
```

供：

```bash
npx skills add Jun-Wu05/agent-capacity-orchestrator
```

Skill 只负责教 Agent 调用 ACO，不承载后台能力。

---

## 19. 日志与可观测性

日志目录：

```text
%LOCALAPPDATA%\AgentCapacityOrchestrator\logs
```

建议 JSON Lines：

```json
{
  "timestamp": "...",
  "level": "info",
  "task_id": "task_xxx",
  "event": "CAPACITY_OBSERVED",
  "message": "..."
}
```

日志不得默认记录：

- 完整用户 prompt；
- 完整源码内容；
- token / credentials；
- `.env` 内容。

---

## 20. 安全设计

### 20.1 文件边界

默认：

```text
Task worktree：RW
原 repo：验证 / 最小写入
项目外：deny-by-default
```

### 20.2 子进程

所有 `git` / `codex` 调用：

- 禁止拼接 shell string；
- 使用参数数组 spawn；
- 路径必须规范化；
- 记录 exit code；
- 超时必须可终止。

### 20.3 Secret

Snapshot 不保存：

- auth token；
- API key；
- `.env` 内容；
- Windows credential。

---

## 21. 并发模型

V0.1：

- 一个 Task 同时最多一个 active Run；
- 同一 worktree 同时最多一个 Run；
- daemon 通过 DB + in-process lock 双重防重；
- V0.1 不要求多个 Task 并行跑 Codex；建议先串行执行恢复任务。

原因：

- 降低额度判断复杂度；
- 降低 Codex 多 Session 并发对 Capacity 的影响；
- 简化 MVP 验收。

---

## 22. 测试策略

### 22.1 Unit

至少覆盖：

- TaskStateMachine；
- Snapshot migration；
- Capacity confidence；
- Eligibility；
- Retry classifier；
- 中文 presenter；
- Preflight decision。

### 22.2 Integration

至少覆盖：

- SQLite transaction；
- Snapshot atomic write；
- Git checkpoint；
- worktree create/remove；
- daemon restart；
- Windows lock；
- notification adapter。

### 22.3 Codex Adapter Fixtures

不在单元测试中依赖用户真实 `~/.codex`。

使用脱敏 fixtures：

```text
tests/fixtures/codex-sessions/
```

覆盖：

- 一个匹配 Session；
- 多个候选；
- picker 漏 Session 但 UUID 存在；
- `rate_limits` null；
- rate limit 有 reset；
- Session 损坏。

### 22.4 E2E

真实 Windows + Codex 环境跑 PRD 验收闭环。

E2E 分：

1. simulated-capacity 模式，用于开发快速测试；
2. real-capacity 模式，用于 MVP 最终验收。

模拟模式不得作为最终 MVP 通过证据。

---

## 23. 故障恢复

### 23.1 daemon crash

重启：

```text
DB scan
→ recover unfinished tasks
→ inspect active Run timeout
→ recompute state
```

### 23.2 Snapshot/DB 不一致

规则：

- 不自动猜；
- 根据 event log 判断最后已确认状态；
- 如果不能确定，`BLOCKED_STATE_INCONSISTENT`。

### 23.3 Worktree 被手工修改

Preflight 检测到未预期 diff：

```text
BLOCKED_WORKTREE_CHANGED
```

绝不自动覆盖。

### 23.4 Session ID 无效

先判断是否可安全 Task Resume。

可：进入 `RESUMING_TASK`。

不可：`BLOCKED_SESSION_UNAVAILABLE`。

---

## 24. 关键错误码

建议内部稳定错误码：

```text
E_GIT_NOT_REPOSITORY
E_SESSION_NOT_FOUND
E_SESSION_AMBIGUOUS
E_SESSION_RESUME_FAILED
E_CAPACITY_UNKNOWN
E_SNAPSHOT_INVALID
E_SNAPSHOT_MIGRATION_FAILED
E_CHECKPOINT_FAILED
E_WORKTREE_FAILED
E_WORKTREE_CHANGED
E_MODEL_UNAVAILABLE
E_RUNTIME_MISMATCH
E_PERMISSION_DENIED
E_PREFLIGHT_FAILED
E_RETRY_EXHAUSTED
E_STATE_INCONSISTENT
```

CLI 根据错误码输出中文，而不是业务代码里散落中文字符串。

---

## 25. MVP 实现顺序

### Phase 1：Domain + Persistence

- Task model
- State machine
- Snapshot v1
- SQLite schema
- migration
- event log

### Phase 2：Git Isolation

- repo detection
- dirty state capture
- checkpoint commit
- isolated worktree
- finalize

### Phase 3：Codex Adapter

- CLI detection
- Session Discovery
- Session UUID binding
- Runtime capture
- Capacity Provider
- resume session
- resume task fallback

### Phase 4：Scheduler

- daemon
- single-instance lock
- next_check_at
- Eligibility
- Preflight
- retry

### Phase 5：UX

- CLI
- Chinese presenter
- Windows notification
- install / upgrade / uninstall

### Phase 6：E2E

- simulated quota
- daemon restart
- real Codex quota exhaustion
- full MVP acceptance run

---

## 26. Ticket 拆分原则

后续 Ticket 必须：

- 每个 Ticket 只解决一个可测试能力；
- 不跨越多个 Phase 做“大一统实现”；
- 每个 Ticket 有明确验收测试；
- Codex Adapter 与 Domain 解耦；
- 所有 DB/Snapshot migration 单独 Ticket；
- 任何读取 Codex 私有格式的逻辑必须有 fixture 测试。

---

## 27. 开发前仍需验证的技术事实

以下不是产品决策，而是实现前必须通过 prototype 验证的外部事实：

1. Windows 当前 Codex CLI Session 文件实际位置与字段；
2. 如何最稳定地将 Session 与当前 Git repo 精确关联；
3. `codex resume <UUID>` 在目标版本的自动化行为与可验证信号；
4. Codex runtime model/reasoning/sandbox/approval 哪些可从 Session 读取；
5. 哪些 runtime 能在 resume 时显式 override；
6. 当前版本 Capacity 可从哪些可靠来源获取；
7. quota exhaustion 后退出码、stderr、session event 的实际形态；
8. Windows Toast 的 Node 实现选择；
9. Windows 登录启动 daemon 的最稳定方式；
10. checkpoint commit 对 staged/unstaged/untracked 的无损迁移算法。

这些事实应先通过小型 Prototype Ticket 验证，而不是直接写死进核心架构。

---

## 28. MVP Definition of Done

TDD 实现完成不等于 MVP 完成。

最终必须通过：

```text
真实 Windows
+ 真实 Git repo
+ 真实 Codex Session
+ 已有未完成修改
+ quota exhaustion
+ aco resume-later
+ Snapshot
+ checkpoint
+ worktree
+ daemon restart survivability
+ reset 后 Capacity recheck
+ Preflight
+ same Session resume
+ Task fallback 可验证
+ runtime 保持
+ continued task execution
+ tests
+ final local commit
+ 中文 notification/status/explain
```

整条链连续成功，V0.1 才进入可发布状态。
