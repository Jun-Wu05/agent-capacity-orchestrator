# Issue tracker：GitHub

本仓库的 issues 与 specs 以 GitHub issues 形式存放。所有操作使用 `gh` CLI。

## 约定

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，用 `jq` 过滤评论，并同时获取 labels。
- **列出 issues**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，配合适当的 `--label` 与 `--state` 过滤。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加 / 移除 labels**：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- **关闭**：`gh issue close <number> --comment "..."`

从 `git remote -v` 推断仓库；在 clone 内运行时 `gh` 会自动识别。

## Pull requests 作为 triage 入口

**PRs as a request surface: no.** _（如果本仓库把外部 PR 当作功能请求，改为 `yes`；`/triage` 会读取此标志。）_

设为 `yes` 时，PR 与 issues 使用同一套 labels 和状态，对应的 `gh pr` 命令为：

- **读取 PR**：`gh pr view <number> --comments`，diff 用 `gh pr diff <number>`。
- **列出待 triage 的外部 PR**：`gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，只保留 `authorAssociation` 为 `CONTRIBUTOR`、`FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的（去掉 `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论 / 打标签 / 关闭**：`gh pr comment`、`gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issues 与 PR 共用一个编号空间，单写 `#42` 可能是二者之一：先用 `gh pr view 42` 解析，失败再用 `gh issue view 42`。

## 当某个 skill 说"发布到 issue tracker"

创建一个 GitHub issue。

## 当某个 skill 说"获取相关 ticket"

运行 `gh issue view <number> --comments`。

## Wayfinding 操作

供 `/wayfinder` 使用。**map** 是一个单独的 issue，其 **child** issues 即各个 ticket。

- **Map**：一个带 `wayfinder:map` 标签的 issue，正文包含 Notes / Decisions-so-far / Fog。`gh issue create --label wayfinder:map`。
- **Child ticket**：通过 GitHub sub-issue 关联到 map 的 issue（用 `gh api` 调用 sub-issues 端点）。未启用 sub-issues 时，把 child 加入 map 正文的 task list，并在 child 正文顶部写 `Part of #<map>`。Labels：`wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。认领后 assign 给推进它的开发者。
- **Blocking**：使用 GitHub **原生 issue dependencies**，这是 UI 可见的规范表示。添加边：`gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`，其中 `<blocker-db-id>` 是 blocker 的数字 **database id**（`gh api repos/<owner>/<repo>/issues/<n> --jq .id`，_不是_ `#number` 或 `node_id`）。GitHub 通过 `issue_dependencies_summary.blocked_by` 报告仍未关闭的 blocker（即实时闸门）。不支持 dependencies 时，退回到在 child 正文顶部写 `Blocked by: #<n>, #<n>`。所有 blocker 关闭后 ticket 即解除阻塞。
- **Frontier 查询**：列出 map 的 open children（`gh issue list --state open`，限定在 map 的 sub-issues / task list 内），去掉有未关闭 blocker（`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中有 open issue）或已有 assignee 的；按 map 顺序取第一个。
- **认领**：`gh issue edit <n> --add-assignee @me`，作为本会话的第一次写操作。
- **解决**：`gh issue comment <n> --body "<answer>"`，然后 `gh issue close <n>`，再把上下文指针（要点 + 链接）追加到 map 的 Decisions-so-far。

## 本仓库现有 issues

### 已关闭（原型验证，2026-11-02）

- #1 P0-01 Codex Session Discovery（PASS）
- #2 P0-02 Codex Resume / Runtime（PASS）
- #3 P0-03 Codex Capacity / Quota（完成）
- #4 P0-04 Windows Integration（PASS）
- #5 P0-05 Git Checkpoint / Worktree（PASS）
- #6 P0-00 Codex Desktop 原生自动化能力与缺口分析（完成）
- #7 / #8：拆票脚本中断重跑产生的重复票，内容在 #9 / #10

### 进行中：MVP 实现地图（#9，`wayfinder:map`）

- Phase 1（Domain + Persistence）：
  - #10 Task 领域模型与 TaskStateMachine
  - #11 Task Snapshot schema v1 定稿（设计）
  - #12 Snapshot 存储与原子写入（blocked by #11、#13）
  - #13 SQLite schema 与 TaskRepository
  - #14 Snapshot migration 框架（blocked by #12）
  - #15 Event log 与状态写入顺序（blocked by #12、#13）
- Phase 2（Git Isolation）：
  - #16 repo 检测与脏状态捕获
  - #17 Checkpoint commit 无损迁移（blocked by #16）
  - #18 Isolated worktree 创建（blocked by #17）
  - #19 Finalize 流程（blocked by #18）
- Spike（Phase 3 / Codex Adapter 前置，ADR 0003 补测）：
  - #20 会话被持锁时 `exec resume` 报错原文
  - #21 关闭 / 切走 Desktop 对话能否释放写锁
  - #22 后台 `exec resume` 期间用户在 Desktop 打开同一对话
  - #23 Desktop 执行一轮期间是否必然持锁
  - #24 CLI 运行中途耗尽额度的表现

各 Prototype 的验证结果写在 `prototypes/<P0-xx>/RESULT.md`。
