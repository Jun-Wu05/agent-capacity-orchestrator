# ADR 0003：MVP 续跑通道只用 `codex exec resume` + Isolated Worktree，`codex queue` 推迟到 V0.2

- 状态：已接受
- 日期：2026-11-02
- 相关：ADR 0001（Task 为核心）、ADR 0002（checkpoint + worktree 隔离）
- 证据：`prototypes/P0-01-codex-session/RESULT.md` §7.3–7.4h、`prototypes/P0-02-codex-resume/RESULT.md` §0.1–0.2、`prototypes/P0-03-codex-capacity/RESULT.md` §4

## 背景

Codex 提供两种向已有 Session 追加一轮的方式，原型实测（codex-cli 0.164～0.166）结论如下：

| | `codex exec resume <UUID>` | `codex queue --thread <UUID>` |
|---|---|---|
| 执行者 | CLI 自己 | Codex Desktop 的 app-server |
| 执行目录 | 子进程 cwd，可设为 ACO worktree | 会话原 cwd（用户 checkout） |
| 会话被 Desktop 加载（持写锁）时 | exit 1：`already has an active writer` | 立即执行；执行中投递会排在当前轮之后 |
| 会话未加载 / Desktop 退出时 | 可执行（只看锁，不看 Desktop 是否运行） | 只入队；用户打开对话时自动执行，或停在输入框 |
| approval | 恒为 `never`（`-c` 无效） | 沿用会话设置，例如 `on-request`，会弹框等人 |
| 无人值守遇提权 | 自动拒绝，沙箱内继续 | 挂起直到有人点击 |
| model / effort / sandbox / writable_roots | 可用 `-m` / `-c` 覆盖 | 沿用会话；`--approve-for-me` 在已加载会话上不生效 |

用户执行 `aco resume-later` 时通常刚在 Desktop 中撞上额度上限，所以"会话被 Desktop 持锁"是常态。queue 在这种情况下最顺手，但会**直接改用户 checkout**，违反 ADR 0002；而且无人值守时会卡在审批框上。

## 决策

### 1. 通道

MVP 只用 `codex exec resume` + isolated worktree。不使用 `codex queue`，也不向 `queue_1.sqlite` 写任何数据。queue 留到 V0.2 再评估：届时需先验证 `queue -C/--worktree` 在已加载会话上是否生效，并解决审批挂起的识别问题。

### 2. 会话被占用

- 不主动探测 `thread-writer-locks/*.lock`，不打开、不独占 Codex 的锁文件。
- 直接执行 `exec resume`。若报 `already has an active writer`，CLI 不会产生任何副作用；Task 进入 `WAITING_SESSION`，并发送中文通知："会话被 Codex Desktop 占用，请完全退出 Desktop"。
- `WAITING_SESSION` 期间按退避间隔重试，**不设自动转 Resume Task 的超时**。用户可手动执行 `aco resume <task> --as-task` 强制走 Resume Task。
- `no rollout found`（Session 不存在）不属于占用情况，仍按 ADR 0001 走 Resume Task 兜底。

### 3. approval 降级

`exec resume` 下 approval 恒为 `never`，含义是"所有提权请求自动拒绝，沙箱照常生效"，权限是**收窄**而不是放宽。处理方式：

- `resume-later` 时用中文明确告知："后台续跑无法弹审批，需要提权的操作会被拒绝"，并写入 Snapshot。只告知，不额外要求确认。
- 一轮中出现被拒的提权请求后，即使 agent 声称完成，也降为 `BLOCKED`（需审查），不作为可重试错误。

### 4. 模型预检

- `resume-later` 时预检原模型是否在当前 CLI 模型目录中（`codex debug models`）。不可用时由用户当场明确选择替代模型，替代模型写入 Snapshot 并标注为"用户指定"。
- 恢复前 Preflight 再检一次，仍不可用则 `BLOCKED_CONFIGURATION`。
- ACO 永不自动映射或替换模型。调用 CLI 时始终显式传 `-m`。

### 5. 残留 queue 消息

`exec resume` 会把该会话中残留的 queue 消息一并带入本轮执行，且该轮 approval=never。处理方式：

- Preflight 以**只读**方式查询 `~/.codex/queue_1.sqlite` 中该会话的残留。有残留则 `BLOCKED`，提示用户在 Desktop 中打开该对话处理。
- 查询失败（文件缺失、schema 变化）按"无法确认"处理，进入 `BLOCKED`，不放行。
- ACO 不删除这些行。

### 6. 完成判定

- 出现 `task_complete` 不等于成功：先检查 `task_complete.error`。`codex_error_info="usage_limit_exceeded"` 时回到 `WAITING_CAPACITY`。
- 续跑 prompt 要求 agent 在最后一行输出 `ACO-STATUS: DONE | BLOCKED: <原因> | CONTINUE`：
  - `DONE` → 进入 Finalize（仍受第 3 条"提权被拒则降级"约束）；
  - `BLOCKED` → `BLOCKED` 并通知；
  - `CONTINUE` 或缺失 → 再跑一轮。
- 续跑轮数上限可配置，默认 3（不含首轮），超过记为 `BLOCKED`（多轮未完成）。该计数器与"瞬时错误重试 3 次"相互独立。
- 判定依据读 rollout，不解析 CLI stdout 或 exit code（额度耗尽时 exit=1，`turn.failed` 只有纯文本）。

### 7. trust

实测发现，`exec` 的"trusted directory"检查实际判断的是 cwd 是否在 git 仓库内，与 `config.toml [projects]` 无关。worktree 必然在 git 内，因此：

- ACO **不修改**用户的 `config.toml`；
- Preflight 检查 cwd 在 git 仓库内；
- 禁止使用 `--skip-git-repo-check`。

## 取舍与后果

### 正面

- 无人值守修改全部发生在 worktree 中，ADR 0002 的隔离不被打破。
- 不会因审批框而无限挂起；权限只会收窄。
- ACO 不写 Codex 的任何私有状态（锁、队列库、config.toml），与 Codex 版本的耦合最小。

### 代价

- 会话被 Desktop 持锁时需要用户介入（退出 Desktop），"全自动"体验打折。这是 MVP 接受的主要代价。
- 后台续跑中，需要提权的步骤只能失败并停下，任务可能以 `BLOCKED` 结束，需要用户接手。
- 依赖 rollout 格式（`task_complete.error`、`turn_context`、`rate_limits`），需要 fixture 测试覆盖格式漂移。

## 实现前仍需补测（spike，不阻塞本决策）

1. 当前 CLI 版本下，会话被持锁时 `exec resume` 的报错原文（预期为 `already has an active writer`）。
2. 会话在 Desktop 中打开后，"关闭对话 / 切走"能否释放锁（目前只能要求完全退出 Desktop）。
3. ACO 运行 `exec resume` 期间，用户在 Desktop 打开同一对话会发生什么。若出现双写，回到本 ADR 重新讨论。
4. Desktop 执行一轮期间是否必然持锁（若存在无锁窗口，第 2 条判据有并发风险）。
5. CLI 运行中途耗尽额度时的表现。
