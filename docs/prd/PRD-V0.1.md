# Agent Capacity Orchestrator V0.1 产品需求文档（PRD）

- 文档状态：V0.1 草案
- 产品阶段：MVP
- 首发平台：Windows
- 首发 Agent：Codex
- 日期：2026-09-07

---

## 1. 产品背景

Coding Agent 正在逐步进入长时间、复杂的软件开发任务，但订阅型 Agent 往往存在滚动额度、会话额度、周期额度或峰谷时段等限制。

当前真实使用中，一个常见问题是：用户已经在 Codex 中执行了较长时间的任务，任务尚未完成，但因为额度耗尽被迫中断。额度若数小时后恢复，用户通常需要重新回到电脑前，找到原项目和原 Session，再手工继续任务。

这个问题并不是传统定时任务可以直接解决的，因为“时间到了”不等于“Agent 当前真的可以执行”，而且 Coding Agent 恢复时还需要保留项目状态、Session、模型配置、Git 修改和任务上下文。

Agent Capacity Orchestrator（以下简称 ACO）用于解决这一问题。

V0.1 聚焦最小、最真实的单 Agent 场景：

> 用户在 Windows 的 Git 项目中使用 Codex 开发；当 Codex 因额度耗尽而中断后，用户显式将当前任务交给 ACO。ACO 保存可恢复状态、等待额度恢复，并在满足安全条件后自动让同一个 Codex 继续原任务。

---

## 2. 产品定位

### 2.1 一句话定位

ACO 是一个面向 Coding Agent 的本地 Capacity-aware 任务恢复工具，在 Agent 因额度限制中断后，负责安全等待、恢复检查和无人值守续跑。

### 2.2 V0.1 不是什​​么

V0.1 明确不是：

- 多 Agent Router；
- Codex 与 ZCODE 之间的自动任务切换工具；
- 通用 Cron 定时器；
- 云端 Agent 托管平台；
- 进程级 checkpoint / VM snapshot 系统；
- 自动 push、开 PR 或 merge 的 DevOps 平台。

### 2.3 产品长期方向

V0.1 先证明“同 Agent 额度恢复后自动继续”这一闭环。

后续可扩展：

- 自动检测额度耗尽；
- ZCODE Adapter；
- peak / off-peak Eligibility；
- 飞书、微信等远程通知与确认；
- MCP；
- Agent Skill；
- Web Dashboard；
- 更多 Coding Agent Adapter。

跨 Agent 接力不是近期默认路线，除非后续重新进行产品决策。

---

## 3. MVP 核心目标

### 3.1 核心目标

V0.1 必须证明：

> 一个真实 Codex 任务在额度中断后，可以被 ACO 安全接管，并在额度恢复后自动继续同一任务，最终完成测试、本地提交和中文状态反馈。

### 3.2 成功定义

MVP 不以“代码功能已经实现”为完成标准，而以真实端到端闭环连续跑通为完成标准。

成功必须覆盖：

1. 正确绑定 Git 项目；
2. 正确绑定 Codex Session；
3. 保存 Task Snapshot；
4. 固化 Git checkpoint；
5. 创建 isolated worktree；
6. daemon 重启后任务不丢；
7. reset 后重新验证真实 Capacity；
8. Preflight 全通过后自动恢复；
9. 优先恢复原 Session；
10. Session 失败时可以安全 fallback；
11. 保持原模型和关键 runtime；
12. 继续完成原任务；
13. 运行测试；
14. 生成正常最终本地 commit；
15. 给出中文通知和可解释状态。

---

## 4. 目标用户

### 4.1 核心用户

首发目标用户是：

- 使用 Codex CLI 进行真实代码开发；
- 经常执行 30 分钟以上的长任务；
- 使用 Git 管理项目；
- 遇到过 Codex 额度耗尽导致工作被中断；
- 希望额度恢复后无需守在电脑前手工继续；
- 能接受本地 CLI 工具和后台 daemon。

### 4.2 非首发用户

V0.1 暂不重点支持：

- 完全不使用 Git 的用户；
- 只使用 Web 版 Agent 的用户；
- 需要跨 Agent 自动调度的团队；
- 需要云端 7×24 小时运行的用户；
- 需要企业级权限、审计、多用户协作的组织。

---

## 5. 核心用户场景

### 场景 S1：Codex 额度耗尽后自动继续

用户在 Git 项目中使用 Codex 完成一个重构任务。

Codex 工作一段时间后额度耗尽，任务未完成。

用户执行：

```bash
aco resume-later
```

ACO：

- 找到当前 Git 项目；
- 识别对应 Codex Session；
- 捕获当前工作状态；
- 创建 Task Snapshot；
- 创建 checkpoint；
- 创建 isolated worktree；
- 记录 Capacity 和 reset 时间；
- 进入后台等待。

额度恢复后：

- daemon 重新检查真实 Capacity；
- 执行 Preflight；
- 自动恢复原 Codex Session；
- 继续原任务；
- 测试通过后生成最终本地 commit；
- Windows 提示用户任务已完成。

### 场景 S2：电脑在 reset 时间关机

任务预计 21:30 恢复，但电脑 21:00 已关机。

23:00 重新开机后，daemon：

- 从 SQLite / Snapshot 读取未完成任务；
- 发现预计 reset 时间已过去；
- 不直接假设额度已恢复；
- 重新读取 Capacity；
- 满足 Eligibility 后继续 AUTO 流程。

### 场景 S3：原 Session 无法恢复

额度恢复后，原 Codex Session 丢失、损坏或无法 resume。

ACO：

- 记录 Resume Session 失败原因；
- 检查 Task Snapshot 是否足够完整；
- 若安全，则创建新 Codex Session 并执行 Resume Task；
- 若无法安全恢复，则进入 `BLOCKED`，禁止猜测执行。

### 场景 S4：恢复条件不安全

额度已经恢复，但模型不可用、worktree 被删除、checkpoint 不一致或权限不满足。

ACO 不执行任务，并向用户显示中文阻塞原因。

---

## 6. 核心产品原则

### P1. Task-first

Task 是持久化核心，Session 是可选恢复手段。

Session 能恢复时优先使用；Session 不能恢复时，Task Snapshot 提供 fallback。

### P2. Same-agent only

V0.1 Task 一旦绑定 Codex，就只能由 Codex 执行。

不得自动切换到 ZCODE、Claude 或其他 Agent。

### P3. Time is not Eligibility

达到预计 reset 时间不等于允许执行。

真正恢复前必须重新读取 Capacity，并计算 Eligibility。

### P4. AUTO 也必须安全

`start_policy=AUTO` 只是无需用户再次点击，不代表绕过安全检查。

所有 AUTO 恢复都必须先执行 Preflight Check。

### P5. No silent fallback

不得静默：

- 切换模型；
- 放宽 sandbox；
- 改变 approval policy；
- 访问工作区外额外路径；
- 改用其他 Agent。

### P6. Durable state

Daemon 不是状态真相。

SQLite / Task Snapshot 才是权威状态来源。

### P7. 中文用户体验

文档、CLI 输出、错误、解释、Windows 通知默认中文。

内部协议、状态码、类型名和配置键使用英文。

---

## 7. 产品范围

### 7.1 V0.1 必须支持

- Windows-first；
- Git repository only；
- Codex only；
- `aco resume-later` 显式接管；
- Codex Session 发现与绑定；
- Task Snapshot 自动生成；
- Snapshot 持续 checkpoint；
- Snapshot schema version；
- Snapshot migration；
- Capacity 建模；
- Capacity Confidence；
- Eligibility 判断；
- 本地 checkpoint commit；
- isolated Git worktree；
- daemon 后台恢复；
- 默认 `start_policy=AUTO`；
- Preflight Check；
- Resume Session；
- Resume Task fallback；
- runtime 保持；
- 最多 3 次 transient retry；
- 本地文件修改；
- 本地测试；
- 本地最终 commit；
- checkpoint 整理；
- Windows 本地中文通知；
- 中文 `status` / `explain`；
- 安装、升级、卸载的基础能力。

### 7.2 V0.1 明确不支持

- ZCODE；
- Claude；
- 跨 Agent handoff；
- 自动 AI routing；
- 非 Git 项目；
- 自动 push；
- 自动开 PR；
- 自动 merge；
- Web Dashboard；
- MCP；
- 飞书 / 微信实际集成；
- Agent Skill 作为核心运行时；
- 进程级断点恢复；
- 任意系统级文件访问；
- 自动复制所有 ignored 文件。

---

## 8. 功能需求

## FR-001：任务接管

用户在 Codex 因额度耗尽后，应能在当前 Git 项目执行：

```bash
aco resume-later
```

系统必须：

- 验证当前目录属于 Git repository；
- 验证 Codex CLI 可用；
- 识别当前项目对应 Session；
- 若存在多个候选 Session 且无法确定，不得猜测；
- 创建唯一 Task ID；
- 开始捕获 Task Snapshot。

失败时必须显示中文原因。

---

## FR-002：Codex Session 绑定

ACO 必须能够为 Task 保存准确的 Codex Session 标识。

不得仅依赖 `--last` 作为长期恢复依据。

Task 至少保存：

- Session ID；
- Session 与项目的绑定信息；
- 最近验证时间；
- Session 是否当前可恢复。

---

## FR-003：Task Snapshot

Task Snapshot 必须自动生成，不要求用户手工编辑。

Snapshot 至少需要覆盖以下领域：

- identity；
- agent；
- project；
- session；
- objective；
- git；
- runtime；
- capacity；
- execution policy；
- progress；
- retry；
- timestamps。

Snapshot 必须包含：

```text
schema_version
```

并允许产品升级后 migration。

Snapshot 在关键事件自动更新，而不是只在第一次接管时写一次。

---

## FR-004：Checkpoint Commit

接管时系统需要捕获：

- staged 修改；
- unstaged 修改；
- untracked 文件。

ACO 应通过本地 checkpoint commit 固化当前可恢复状态。

内部 checkpoint：

- 可以在运行过程中产生多个；
- 不 push；
- 任务成功后不得以大量内部提交形式长期暴露给用户；
- 最终应整理为正常用户提交。

---

## FR-005：Isolated Worktree

ACO 后台无人值守执行必须发生在 isolated Git worktree 中。

要求：

- 原 checkout 不作为后台主要写入环境；
- worktree 与 Task 一一关联；
- Task Snapshot 保存 worktree 路径与 branch；
- worktree 状态必须可检查；
- 异常情况下不得自动删除无法解释的用户修改。

V0.1 默认不复制 ignored 文件。

---

## FR-006：Capacity 获取

ACO 必须通过 Codex Adapter 获取当前 Task 对应 Agent 的 Capacity。

结果至少包括：

- 当前是否可执行；
- reset 时间（若可获得）；
- 最后观测时间；
- Capacity Confidence。

Confidence 枚举：

```text
EXACT
OBSERVED
ESTIMATED
UNKNOWN
```

不得把 `ESTIMATED` 作为精确事实展示。

---

## FR-007：Eligibility

Eligibility 判断只针对 Task 当前绑定的 Codex。

V0.1 不做 Agent 选择。

AUTO 恢复需要：

```text
Capacity available
AND Task policy allows
AND Preflight passes
```

达到 reset 时间本身不能直接触发执行。

---

## FR-008：Daemon

Daemon 是本地后台调度器。

要求：

- daemon 自身无状态；
- daemon 启动后扫描未完成 Task；
- daemon 崩溃不得造成 Task 丢失；
- Windows 重启后能够继续调度；
- ACO 升级后能够读取旧 Task；
- 如果预计 reset 时间已过去，则重新检查 Capacity，而不是认为任务失效。

---

## FR-009：Start Policy

V0.1 支持至少：

```text
AUTO
MANUAL
```

默认：

```text
AUTO
```

未来预留：

```text
ASK
```

`ASK` 不属于 V0.1 实现范围。

---

## FR-010：Preflight Check

AUTO 启动前必须执行 Preflight。

至少检查：

- Snapshot 可读；
- schema migration 成功；
- Git repo 存在；
- worktree 存在；
- Git checkpoint 一致；
- Codex CLI 可用；
- Session 可恢复或 Task fallback 可用；
- 原 model 可用；
- 关键 runtime 可恢复；
- Capacity 当前可执行；
- 权限允许本次任务执行。

任何关键检查失败：

```text
BLOCKED
```

并给出中文原因。

---

## FR-011：Resume Session

Preflight 通过后，ACO 优先使用保存的 Session ID 恢复原 Codex Session。

恢复时需要保持：

- 项目上下文；
- worktree；
- 原任务目标；
- 原模型与关键 runtime 配置。

ACO 不承诺进程级断点续跑。

---

## FR-012：Resume Task fallback

如果 Resume Session 失败，系统应：

1. 记录 Session Resume 失败原因；
2. 重新验证 Snapshot 完整性；
3. 判断 Task Resume 是否安全；
4. 若安全，创建新的 Codex Session；
5. 将任务目标、Git 状态、checkpoint、进度与 runtime 作为恢复上下文；
6. 继续同一个 Task；
7. 若不安全，进入 `BLOCKED`。

不得因为 Session 恢复失败就重新开始一个无关任务。

---

## FR-013：Runtime 保持

Task 需要捕获并恢复关键 runtime 配置。

至少考虑：

- model；
- reasoning effort；
- sandbox；
- approval policy；
- cwd；
- 关键 config overrides。

如果原配置不可用：

- 不静默替换；
- Task 进入 `BLOCKED`；
- 中文解释具体差异。

---

## FR-014：错误分类与重试

系统需要区分：

```text
RetryableError
NonRetryableError
```

可重试错误最多自动重试 3 次。

建议退避：

```text
1 分钟
5 分钟
15 分钟
```

不可重试错误例如：

- Git 冲突；
- Session 无法确定；
- 模型不可用；
- 权限错误；
- Snapshot 损坏；
- worktree 丢失。

这类问题直接进入 `BLOCKED`。

---

## FR-015：任务执行

无人值守恢复后，ACO 允许 Codex 在 Task worktree 内：

- 读文件；
- 修改文件；
- 删除项目内文件；
- 执行任务需要的本地命令；
- 运行测试；
- 创建本地 commit。

V0.1 默认禁止：

- 自动 push；
- 自动 merge；
- 扩大到项目外任意写权限。

ACO 不得绕过 Codex 本身的 sandbox / approval 安全限制。

---

## FR-016：测试

Task 完成前应执行项目定义的测试命令。

测试结果至少保存：

- command；
- exit code；
- 成功 / 失败；
- 执行时间；
- 最近一次结果摘要。

测试失败时，不得直接标记 Task `COMPLETED`。

---

## FR-017：最终提交

Task 成功完成后：

- 整理内部 checkpoint commits；
- 输出一个正常的最终本地 commit；
- 不自动 push；
- 保存最终 commit SHA；
- Task 状态变为 `COMPLETED`。

---

## FR-018：本地通知

Windows 本地通知至少覆盖：

- Task 已接管；
- Task 正在等待额度；
- 额度恢复并开始恢复任务；
- Task 完成；
- Task 失败；
- Task 阻塞。

用户可见文案默认中文。

---

## FR-019：CLI

V0.1 至少提供：

```bash
aco resume-later
aco status
aco tasks
aco explain <task-id>
aco cancel <task-id>
aco daemon status
```

### `aco status`

默认显示当前最相关任务或任务概览。

至少包含：

- 项目；
- Agent；
- 状态；
- Capacity；
- reset；
- Confidence；
- start policy；
- 下一步。

### `aco explain <task-id>`

必须解释：

- 为什么当前没有执行；
- 当前阻塞条件；
- 下一个系统动作；
- 是否会自动执行。

用户不应该只看到一个无法解释的 `WAITING`。

---

## FR-020：安装与分发

目标核心安装体验：

```bash
npx agent-capacity-orchestrator install
```

安装过程负责：

- CLI；
- daemon；
- SQLite 初始化；
- Windows 后台启动集成；
- Codex Adapter 检测；
- 本地配置目录。

安装后主要使用：

```bash
aco ...
```

未来可另外提供：

```bash
npx skills add Jun-Wu05/agent-capacity-orchestrator
```

Skill 只作为 Agent 自然语言交互层，不承担核心后台运行。

---

## 9. Task 状态模型

建议内部最小状态：

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

### 用户中文映射示例

| 内部状态 | 中文展示 |
| --- | --- |
| CAPTURING | 正在接管任务 |
| WAITING_CAPACITY | 等待额度恢复 |
| READY | 已满足执行条件 |
| PREFLIGHT | 正在执行恢复前检查 |
| RESUMING_SESSION | 正在恢复原会话 |
| RESUMING_TASK | 正在从任务断点恢复 |
| RUNNING | 正在执行任务 |
| TESTING | 正在运行测试 |
| FINALIZING | 正在整理任务结果 |
| COMPLETED | 已完成 |
| BLOCKED | 已阻塞，需要人工处理 |
| FAILED | 执行失败 |
| CANCELLED | 已取消 |

每一次状态迁移必须持久化。

---

## 10. Task Snapshot 产品要求

Task Snapshot 是 V0.1 最重要的持久状态之一。

### 10.1 原则

- 自动生成；
- 自动更新；
- 用户默认不需要编辑；
- 可读、可迁移、可验证；
- 与 Session 解耦；
- 可以支持未来 Adapter 扩展。

### 10.2 建议信息域

#### Identity

- schema_version
- task_id
- created_at
- updated_at
- status

#### Agent

- agent_type
- adapter_version

#### Project

- repository_path
- original_branch
- worktree_path
- task_branch

#### Session

- session_id
- resumable
- last_verified_at

#### Objective

- task_summary
- continuation_context

#### Git

- base_commit
- checkpoint_commit
- final_commit
- staged_summary
- unstaged_summary
- untracked_manifest

#### Runtime

- model
- reasoning_effort
- sandbox
- approval_policy
- config_overrides

#### Capacity

- state
- reset_at
- confidence
- observed_at

#### Execution

- start_policy
- permissions
- retry_count
- next_retry_at

#### Progress

- last_checkpoint
- last_action
- test_command
- test_status

### 10.3 版本兼容

Snapshot 从第一版起必须版本化。

升级 ACO 时：

- 自动识别旧 schema；
- 可迁移则升级；
- 不可迁移则 `BLOCKED`；
- 禁止静默丢弃等待任务。

---

## 11. 权限模型

### 11.1 默认权限范围

Task worktree：

- 读：允许；
- 写：允许；
- 删除：允许；
- 测试：允许；
- local commit：允许。

原 repository checkout：

- 默认用于读取与校验；
- 避免作为后台主要写入环境。

项目外：

- 默认不主动访问；
- 不因为 daemon 无人值守而自动扩大权限。

### 11.2 ignored 文件

V0.1 默认不复制 ignored 文件。

未来可设计 allowlist，例如：

```yaml
workspace:
  include_ignored:
    - .env.test
```

敏感文件必须显式处理，不能自动全量复制。

---

## 12. 可解释性要求

ACO 的重要产品能力不是只有“自动运行”，还必须解释“为什么现在没有运行”。

### 12.1 WAITING 示例

```text
任务 #001

当前状态：等待额度恢复
Agent：Codex
预计恢复时间：21:30
额度可信度：精确
启动策略：自动

下一步：
额度恢复后重新检查真实额度；
通过恢复前检查后自动继续原任务。
```

### 12.2 BLOCKED 示例

```text
任务 #001

当前状态：已阻塞
原因：原任务使用的模型当前不可用

系统没有自动切换模型。
请修改任务运行配置后重新执行。
```

---

## 13. 本地数据与目录

具体路径由技术设计确定，但产品要求：

- 用户可以知道 ACO 数据保存在哪里；
- Task Snapshot 和 SQLite 不应写入用户项目源码目录作为业务依赖；
- 删除 / 卸载 ACO 时不得默认删除仍未完成 Task；
- 日志和持久状态需要有明确清理策略；
- 敏感信息不得无必要写入 Snapshot。

---

## 14. 非功能需求

### NFR-001：可靠性

Daemon 重启、Windows 重启、ACO 升级不能造成等待任务丢失。

### NFR-002：幂等性

同一 Task 的恢复动作需要防止重复启动。

例如 daemon 重启两次，不得同时启动两个 Codex 进程执行同一 Task。

### NFR-003：安全性

默认不扩大 Agent 原有权限，不绕过 sandbox，不自动 push / merge。

### NFR-004：可恢复性

任何 Task 状态变化都必须有持久化结果，关键步骤失败后能够解释当前处于哪个阶段。

### NFR-005：可升级性

Snapshot / SQLite schema 必须版本化。

### NFR-006：可扩展性

核心领域不得写死只有 Codex；Codex 是 V0.1 Adapter，而不是整个领域模型本身。

### NFR-007：可观察性

至少提供：

- Task 状态；
- 最后状态变化时间；
- Capacity；
- 重试次数；
- 失败原因；
- 最近执行动作。

### NFR-008：中文体验

所有普通用户操作无需阅读英文错误码即可理解当前任务状态。

---

## 15. 异常场景

V0.1 至少需要正确处理：

1. 当前目录不是 Git repository；
2. 未检测到 Codex CLI；
3. 找不到对应 Session；
4. 找到多个 Session 无法确定；
5. Git 工作区无法 checkpoint；
6. untracked 文件无法处理；
7. worktree 创建失败；
8. ignored 依赖缺失导致测试失败；
9. daemon 被强制结束；
10. Windows 在 reset 前关机；
11. reset 时间已过但额度仍未恢复；
12. Session resume 失败；
13. Task Snapshot migration 失败；
14. 原模型不可用；
15. sandbox / approval 不满足；
16. Codex 启动网络错误；
17. 连续 3 次 retry 都失败；
18. 用户主动取消 Task；
19. worktree 被用户手工删除；
20. 最终测试失败；
21. 最终 commit 失败；
22. 同一个 Task 被 daemon 重复调度。

异常不能以静默失败结束。

---

## 16. CLI 用户体验要求

### 16.1 接管

```bash
aco resume-later
```

理想输出：

```text
正在接管当前 Codex 任务…

✓ 已识别 Git 项目
✓ 已绑定 Codex Session
✓ 已保存任务断点
✓ 已创建隔离工作区
✓ 已记录当前额度状态

任务 ID：task-001
当前状态：等待额度恢复
启动策略：自动

额度恢复后，系统会重新检查执行条件并自动继续任务。
```

### 16.2 查询

```bash
aco status
```

输出必须优先回答：

- 现在是什么状态；
- 为什么；
- 下一步是什么；
- 是否需要用户操作。

---

## 17. 通知需求

V0.1 只实现 Windows 本地通知。

通知优先级建议：

### 必须通知

- `BLOCKED`
- `FAILED`
- `COMPLETED`

### 应通知

- 开始自动恢复
- Task 已接管

### 可不通知

- 每一次内部 checkpoint
- 每一次普通 Capacity 检查

未来 Notification Adapter 应支持飞书、企业微信、Telegram 等，而不改变 Task Core。

---

## 18. 安装体验

### 18.1 目标体验

用户无需 clone repository。

```bash
npx agent-capacity-orchestrator install
```

安装完成后：

```bash
aco status
```

可直接使用。

### 18.2 安装检查

安装器至少检测：

- Windows 版本；
- Node 环境；
- Git；
- Codex CLI；
- 本地数据目录写权限；
- daemon 是否安装成功。

### 18.3 可选 Skill

未来：

```bash
npx skills add Jun-Wu05/agent-capacity-orchestrator
```

让 Agent 能理解：

- “额度恢复后继续”；
- “这个任务晚点自动恢复”；
- “帮我看任务什么时候继续”。

Skill 最终调用 ACO CLI / MCP，不拥有持久状态。

---

## 19. MVP 验收标准

### AC-001：真实任务接管

给定一个已产生代码修改的真实 Codex Session，在额度中断后执行 `aco resume-later`，系统必须生成可恢复 Task。

### AC-002：持久化

Daemon 停止并重启后，Task 状态、Session、Snapshot、Capacity 信息仍存在。

### AC-003：自动恢复

额度恢复后无需用户重新执行命令，Task 能进入 Preflight 并自动尝试恢复。

### AC-004：同 Session 优先

原 Session 可用时，必须优先恢复原 Session。

### AC-005：Task fallback

原 Session 不可用，但 Snapshot 满足安全恢复条件时，可以创建新 Session 继续同一 Task。

### AC-006：运行时一致

恢复不得静默更改模型、sandbox、approval 等关键设置。

### AC-007：隔离

后台无人值守修改发生在 isolated worktree，而不是用户当前 checkout。

### AC-008：测试

任务完成前必须执行配置的测试；测试失败不得标记 COMPLETED。

### AC-009：Git 结果

任务成功后用户看到一个正常最终本地 commit，而不是散乱内部 checkpoint 历史。

### AC-010：中文解释

无论 WAITING、BLOCKED、FAILED、COMPLETED，`aco status` / `aco explain` 都能用中文准确说明状态和下一步。

### AC-011：本地通知

COMPLETED / FAILED / BLOCKED 必须有 Windows 本地中文通知。

### AC-012：防重复执行

同一个 Task 在任何时刻最多只有一个有效执行实例。

---

## 20. MVP 演示脚本

正式宣称 V0.1 可用前，必须完成一次真实 Demo：

```text
1. Windows
2. Git 测试项目
3. 打开 Codex Session
4. 执行真实代码任务
5. 产生未完成修改
6. 触发额度耗尽
7. 执行 aco resume-later
8. 生成 Snapshot
9. 生成 checkpoint
10. 创建 isolated worktree
11. 关闭 / 重启 daemon
12. 确认 Task 未丢
13. 等待或模拟 reset
14. 再次验证 Capacity
15. Preflight 通过
16. Resume Session
17. 继续原任务
18. 运行测试
19. 生成最终 commit
20. Windows 中文通知完成
21. aco status 显示已完成
```

同时额外演示一次：

```text
Resume Session 失败
→ Task Resume fallback 或明确 BLOCKED
```

两条都符合预期，才允许将 V0.1 标记为 MVP 完成。

---

## 21. 产品指标

V0.1 主要用于验证产品能力，不追求大规模增长指标。

建议记录以下本地匿名/测试指标定义，但默认不上传数据：

### 核心可靠性指标

- Task capture success rate
- Session binding success rate
- Resume Session success rate
- Resume Task fallback success rate
- Preflight pass rate
- Duplicate execution count
- Task lost after daemon restart count
- Finalization success rate

### MVP 目标

在受控测试环境中：

- Task 丢失：0；
- 重复执行：0；
- 静默模型切换：0；
- 静默扩大权限：0；
- 可解释状态覆盖率：100%；
- 完整 Demo 链路：至少连续通过 3 次。

---

## 22. 后续版本建议

### V0.2

- 自动检测 quota exhaustion；
- 降低 `aco resume-later` 手工步骤；
- 完善 Codex Capacity Provider。

### V0.3

- ZCODE Adapter；
- peak / off-peak Eligibility；
- 不做跨 Agent handoff。

### V0.4

- `ASK` Start Policy；
- 飞书 / 企业微信 / Telegram Notification Adapter；
- 远程确认开始 / 延后 / 取消。

### V0.5

- MCP Server；
- Agent Skill；
- 自然语言管理 Task。

### V1.0 候选

- Web Dashboard；
- 多 Agent 独立任务统一管理；
- 更多 Adapter；
- 更完整的安装、升级、迁移与诊断体系。

---

## 23. 开发前仍需完成的技术设计

PRD 确定“要做什么”，以下内容需要在 TDD / Technical Design 中进一步确定“怎么做”：

1. Codex Session Discovery 算法；
2. Task Snapshot v1 精确 schema；
3. SQLite schema；
4. Task 状态机与事务边界；
5. daemon 单实例与 Task 锁机制；
6. checkpoint commit 的 staged / unstaged / untracked 处理算法；
7. worktree 路径和生命周期；
8. checkpoint squash/finalize 算法；
9. Codex Capacity Provider 数据源；
10. Codex Runtime capture / restore；
11. Resume Session 命令封装；
12. Resume Task continuation prompt / context 构造；
13. Retry 分类；
14. Windows daemon 安装机制；
15. Windows Toast 实现；
16. npm/npx 安装、升级、卸载流程；
17. Snapshot / DB migration 机制；
18. 测试替身与模拟 quota 的测试方案。

---

## 24. 相关文档

- `CONTEXT.md`：领域术语和稳定边界
- `docs/adr/0001-task-first-session-optional.md`：Task-first 决策
- `docs/adr/0002-checkpoint-worktree-isolation.md`：Git 隔离决策
- `docs/mvp/MVP-SPEC.md`：MVP 技术范围与验收闭环

如 PRD 与上述已接受 ADR 冲突，以 ADR 为准；如领域术语发生变化，应先更新 `CONTEXT.md`。
