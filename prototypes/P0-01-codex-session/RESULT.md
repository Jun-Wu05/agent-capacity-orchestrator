# P0-01 Codex Session Discovery 验证结果

- 对应 Issue：#1
- 结果：`PASS`（发现规则已验证；resume 路径受写锁限制，机制已定位）

## 1. 环境

```text
Windows 版本：11
Windows Build：10.0.26200.0
Codex CLI 版本：codex-cli 0.162.0-alpha.17.2（Desktop 内置）
Codex Desktop：已安装（26.901.51231）
Node.js 版本：v24.11.1
Git 版本：2.52.0.windows.1
PowerShell 版本：7.6.6
实验时间：2026/10/16（静态取证）
```

## 2. 测试仓库

```text
Repo A：D:\<repo-A>（仅有 cwd，git_branch=master，git_origin_url 存在）
Repo B：待补充（需创建第二个 Session 验证歧义场景）
```

> 所有路径已脱敏为相对描述。

## 3. Session 文件位置

实际观察到的 Codex Session 根目录：

```text
%USERPROFILE%\.codex\sessions\YYYY\MM\DD\
  rollout-<timestamp>-<UUID>.jsonl
```

文件命名格式：`rollout-{ISO8601}-{UUID v7}.jsonl`（UUID v7 含时间戳，可按创建时间排序）

Session 索引文件：`%USERPROFILE%\.codex\session_index.jsonl`（132 条，只含 id / thread_name / updated_at）

app-server 线程目录（权威状态，Desktop 持锁）：
- `%USERPROFILE%\.codex\sqlite\state_5.sqlite`（Desktop 打开时为 0 字节占位，数据在 WAL；Desktop 关闭后可直接读）
- `%USERPROFILE%\.codex\sqlite\codex-dev.db`（可 copy 后只读）中的 `local_thread_catalog`

## 4. Session UUID

Repo A 最近 Session：

```text
UUID：01a13411-xxxx-xxxx-xxxx-xxxxxxxxxxxx
UUID 来源：session JSONL 第一行 session_meta.payload.session_id（= payload.id）
rollout 文件名也含完整 UUID
```

Repo B：

```text
UUID：待填（需创建第二个 repo 的 Session 后记录）
```

## 5. 字段观察

| 信息 | 是否存在 | 字段/来源 | 示例（脱敏） | 可信度 |
|---|---|---|---|---|
| Session UUID | 是 | session_meta.payload.session_id | `01a13411-…` | 高 |
| cwd | 是 | session_meta.payload.cwd；turn_context.cwd；local_thread_catalog.cwd | `D:\<repo-A>` | 高 |
| Git repo path | 间接 | session_meta.payload.git.commit_hash + git.branch；local_thread_catalog.git_branch | branch=master, commit=<sha> | 中（branch 非唯一） |
| Git origin URL | 是 | session_meta.payload.git（字段存在，已脱敏） | `<redacted>` | 高（当有 remote 时） |
| model | 是 | session_meta.payload.model_provider；turn_context.model | openai / gpt-6.1-sol | 高 |
| reasoning | 是 | turn_context.effort；config.toml model_reasoning_effort | medium | 高 |
| sandbox | 是 | turn_context.sandbox_policy（JSON） | workspace-write + writable_roots | 高（复杂结构） |
| approval | 是 | turn_context.approval_policy | on-request / never | 高 |
| created_at | 是 | session_meta.payload.timestamp；rollout 文件名含时间戳 | 2026-10-13T15:02:22 | 高 |
| updated_at | 是 | session_index.jsonl.updated_at；local_thread_catalog.source_updated_at | ISO8601 | 高 |
| originator | 是 | session_meta.payload.originator | Codex Desktop | 高 |
| source | 是 | session_meta.payload.source | vscode（Desktop 内嵌 editor 模式） | 中（非 CLI） |

## 6. Repo → Session 绑定实验

### 尝试的绑定规则

```text
主要规则：local_thread_catalog.cwd == git rev-parse --show-toplevel
  （cwd 精确匹配 repo 根目录路径）
备用规则：session_meta.payload.cwd 同上
补充校验：git_branch + git origin URL 交叉验证
```

### 结果

```text
是否可以确定性关联：否（cwd → repo 唯一，但 repo → Session 一对多）
是否需要依赖最近修改时间：是；但 PRD FR-001 要求候选不唯一时不得猜测，因此"取最新"只能作为提示，需用户确认或额外信号
是否出现歧义：是——同一 repo 有多个 Session；多 repo 并行场景未实测
```

多 repo 歧义场景（待补充）：

```text
当前 cwd 下恰好有多个 open Session，且用户在不同 terminal tab 切换时，
绑定规则需要结合 cwd + 最近活跃时间。
多 repo 并行（Repo A / Repo B 同时有 open Session）尚未实测。
```

## 7. Codex Desktop ↔ CLI Session 互操作实验（P0-01A，已实测）

测试方法：`run-desktop-interop-test.ps1`。在 Desktop 里让会话记住一个随机暗号（暗号文件放在仓库外，
防止靠读文件作弊），再从该仓库拉出的 worktree 里执行 `codex exec resume <UUID> -m <model>` 问它暗号，
用"能否答出暗号"判断上下文是否延续。

### 7.1 CLI 能否发现 Desktop 创建的 Session：可以

```text
方法：遍历 ~/.codex/sessions/**/rollout-*.jsonl，读第一行 session_meta.payload
判据：cwd == 测试仓库 且 source 是字符串（排除子 agent）
结果：命中，session_id / originator=Codex Desktop / source=vscode 均可正确读出
      同时能读出该会话使用的模型与已有轮数
结论：PASS
```

**注意一个坑**：本机 80 个 rollout 文件里只有 2 个是 Desktop 主会话，其余都是子 agent 文件，
它们的 session_meta 里 session_id 指向父会话而非自身。必须用 `source 是字符串` 过滤，否则会把子 agent 当成用户会话。

### 7.2 CLI 能否 resume Desktop 创建的 Session：Desktop 开着时**不能**

```text
首次实测（Desktop 运行中）：exit=1，会话未被修改
错误日志：
  ERROR codex_core::session::session: failed to initialize thread persistence:
        thread-store conflict: thread <UUID> already has an active writer
  Error: thread/resume: thread/resume failed: thread <UUID> already has an active writer (code -32600)
```

**互斥机制已定位**：`~/.codex/thread-writer-locks/<session_id>.lock`
- 文件存在**且被独占用**（`FileShare.None` 打不开）→ 有进程正在写这个会话（实测与报错一致）
- 文件不存在，或存在但可独占打开 → 无人占用（已用两天前的老会话交叉验证）
- 锁文件是 0 字节，内容无信息，只能靠文件存在性 + 独占性判断

→ **ACO 的 resumeSession 必须先做这道预检**，否则会拿到一个 exit=1、看似"resume 失败"的假故障。
→ 也说明 ACO 无法在 Desktop 正开着该会话时接管——只能等 Desktop 完全退出，或改用
  `codex queue --thread <UUID> --message <TEXT>` 那条通道。

Desktop 完全退出后能否 resume 成功：**可以，已实测 PASS**（见 7.3）。

### 7.3 重测：Desktop 完全退出后，resume 成功

```text
前置：完全退出 Desktop（托盘退出），确认无 codex 进程；锁文件已释放
命令：在 worktree 目录下 codex exec resume <UUID> -m gpt-6-luna --json "<问暗号的 prompt>"
结果：exit=0
      agent 回答 = 正确暗号（暗号文件放在仓库外，且本轮执行的命令数为 0，排除读文件作弊）
      会话轮数 1 -> 2（CLI 那一轮写进了 Desktop 建的原会话）
      新一轮 cwd = worktree 目录
      新一轮 model = gpt-6-luna
结论：PASS
```

**A-7 也通过**：重新打开 Desktop 后，那个对话里直接多出了 CLI 追加的一轮（问题 + 正确回答），
不需要刷新或重启。→ ACO 在后台跑完后，用户能在 Desktop 里直接看到结果。

### 7.4 运行时设置：resume 会静默改变 approval_policy（重要）

对比同一会话的两轮 `turn_context`：

| 设置 | Desktop 那轮 | CLI resume 那轮 | 是否被改 |
|---|---|---|---|
| model | gpt-6-luna | gpt-6-luna | 否（显式 `-m` 传的） |
| effort | medium | medium | 否 |
| sandbox | workspace-write（含 writable_roots） | workspace-write（无 writable_roots） | 部分（writable_roots 丢失） |
| **approval_policy** | **on-request** | **never** | **是，静默变为 never** |

实测 `-c` 覆盖能力：

```text
-c model_reasoning_effort="high"   → 生效（turn_context.effort 变为 high）
-c sandbox_mode="read-only"        → 生效（turn_context.sandbox_policy.type 变为 read-only）
-c approval_policy="on-request"    → 不生效，一直是 never
-c approval_policy="on-failure"    → 不生效，一直是 never
-c approval_policy="untrusted"     → exit=1，报 "approval_policy = "untrusted" is no longer supported"
全新 exec（非 resume）同样恒为 never
```

结论：**`codex exec` 模式本身就不支持交互式审批，approval_policy 恒为 `never`。**
这不是 resume 的 bug，而是非交互模式的固有行为。

→ 对 ACO 的直接影响（命中 AGENTS.md 护栏"恢复时不应静默切换运行时设置"）：
  - Desktop 里 `approval_policy=on-request` 的会话，一旦交给 CLI 后台续跑，审批能力就消失了，
    且无法用 `-c` 恢复。ACO 必须在接管前把这件事显式告知用户，不能静默降级。
  - 反过来，`never` 反而符合"无人值守"的需求（不会卡在等审批）——但这属于安全性下降，必须让用户知情并确认。
  - sandbox 的 `writable_roots` 不会带过去；ACO 若需要额外可写目录，必须自己用 `-c` 或配置补上。
  - effort / sandbox_mode 可以正常用 `-c` 恢复。

### 7.4b 更正：在 Desktop 里切走对话不会释放写锁

实测：用户已切到别的对话，但 Desktop 仍持有"记住暗号"会话的锁，`exec resume` 照样 exit=1 `already has an active writer`。
当时 Desktop 同时持有 3 个会话的锁（本次运行期间打开过的对话）。
→ `exec resume` 路线要求**完全退出 Desktop**。辅助脚本：`check-locks.ps1`（列出哪些会话被占用）。

### 7.4c `codex queue`：Desktop 占用时也能送进去并执行（已实测）

```text
前置：Desktop 运行中，目标会话锁 = 被持有（exec resume 在此状态下失败）
命令：codex queue --thread <UUID> --message "<问暗号，要求以 QUEUE-OK 开头回答>"
结果：exit=0，约 10s 返回 "Queued message <msg-id> for thread <UUID>."
      随后会话文件里新增一轮：user 消息 + 回复 "QUEUE-OK <正确暗号>"，task_complete
      轮数 2 -> 3
执行者：推测是 Desktop 的常驻进程 `codex.exe app-server`（持锁方本身），queue 只是把消息交给它
```

新一轮的 `turn_context`：model=gpt-6-luna，approval=never，cwd=worktree ——与**上一轮**（CLI resume 那轮）完全相同。
→ queue 似乎沿用会话最后一轮的运行时设置，本次无法判断它能否保住 Desktop 原来的 `on-request`（需另开一个只有 Desktop 轮次的会话再测）。

queue 自带的参数里有 `-s/--sandbox`、`-C/--cd`、`--worktree`、`--add-dir`、`--approve-for-me`
（"通过自动审查处理审批请求"，介于 on-request 与 never 之间），这些在 `exec resume` 里都没有。

Desktop 界面里能看到 queue 插入的这一轮：**已确认**（用户打开对话即见）。

### 7.4d Desktop 完全退出时的 `codex queue`：只入队，不执行（已实测）

```text
前置：Desktop 完全退出，无 app-server 进程（只剩系统服务 codex-windows-sandbox-service），目标会话锁空闲
命令：codex queue --thread <UUID> --message "<问暗号，以 QUEUE-OFFLINE 开头回答>"
结果：exit=0，约 10s，输出 \"Queued message <msg-id> for thread <UUID>.\"（与成功执行时完全相同）
      未拉起任何进程；观察 90s，会话文件 0 变化（轮数仍为 3）
```

**排队存储已定位**：`~/.codex/queue_1.sqlite`
- 表 `queued_items(id, thread_id, payload_json, queue_order, created_at_ms, updated_at_ms)`：未消费的消息
- 表 `queued_thread_revisions(revision, thread_id)`：每个会话的排队版本号
- 之前 Desktop 运行时 queue 的那条消息已不在表里 → **行存在 = 待执行，行消失 = 已被 app-server 取走**

→ queue 的 exit=0 只代表\"已入队\"，**不代表已执行**。ACO 必须：
  1. 投递前检查是否有 `codex.exe ... app-server` 进程；没有就走 `exec resume` 通道，或明确记为\"等待 Desktop 启动\"；
  2. 投递后以 rollout 里出现新的 `task_complete` 为完成判据，可辅以 `queued_items` 中该 id 是否消失；
  3. 不得把\"Queued message\"当成任务已恢复。

重新打开 Desktop 后（用户实测）：积压的消息**不会自动执行**，而是出现在该对话的输入框里，
需要用户手动点击发送。会话里没有新增轮次。

→ 结论：Desktop 未运行时投递的 queue 消息，本质上变成了\"给用户的草稿\"，不是后台任务。
→ ACO 规则：
  - **Desktop 未运行时禁止用 queue 做自动恢复**，只能走 `exec resume` + worktree；
  - 若误投，需要清理 `queued_items` 中对应行（或提示用户丢弃输入框里的草稿），
    否则用户下次打开会看到一条莫名其妙的待发送消息，且可能与 exec resume 重复执行；
  - 反过来，这个行为可以有意利用：作为\"Desktop 关着时，把续跑指令预置给用户，打开即可一键继续\"的半自动方案（非 MVP）。

尚未验证（已由 7.4e–7.4g 补测完毕）：
- ~~Desktop 运行中但会话正在执行一轮时，queue 是排队还是同样进入输入框~~（7.4g：排队，当前轮结束后自动执行）；
- ~~会话正在跑一轮时 queue 的行为（排队 / 拒绝）~~（同上）；
- ~~运行时设置是从哪里继承的~~（7.4e）、~~`--approve-for-me` 的实际效果~~（7.4g：已加载会话上不生效）；
- queue 不返回 agent 回复，ACO 需读 rollout 判断完成与结果。

### 7.4e Desktop 运行中、但目标会话未加载时的 queue（2026-10-27/28 实测）

```text
会话：01a17bf0-…，纯 Desktop 会话（仅 1 轮"记住暗号"，approval=on-request），CLI 从未 resume 过
前置：Desktop 运行中（app-server 进程存在），但该会话不在 Desktop 当前加载中
      → thread-writer-locks 下没有该会话的锁文件（其他打开过的会话锁均被占用）
投递：10-28 09:43 codex queue --thread <UUID> --message "[ACO-Q1] …"（脚本 run-queue-probe.ps1）
      exit=0，输出 "Queued message <id> for thread <UUID>."
结果：约 40 分钟内未执行：rollout 行数不变，queued_items 行一直在
用户在 Desktop 里点开该对话 → 消息自动发出执行（不是停在输入框）
      task_started.turn_attribution.turn_trigger = "queue"
      执行后 queued_items 行消失，锁文件仍不存在
```

**结论 1：queue 立即执行的条件是"Desktop 已加载该会话"，不是"Desktop 在运行"。**

| Desktop 状态 | 会话锁 | queue 表现 |
|---|---|---|
| 运行中，会话已加载 | 被持有 | 立即执行（7.4c） |
| 运行中，会话未加载 | 无锁文件 | 只入队；用户打开该对话时**自动执行** |
| 完全退出 | 空闲 / 无 | 只入队；重开后进入输入框，需手动发送（7.4d） |

→ ACO 选通道的判据从"有无 app-server 进程"改为"目标会话锁是否被持有"：
  - 锁被持有 → `codex queue`；
  - 锁不存在 / 空闲 → `exec resume` + worktree（不受 Desktop 是否运行影响）。
  - "运行中但未加载"状态下误投 queue 的风险更大：用户日后点开对话时会自动执行一条过期指令，
    可能与 exec resume 重复执行。投递前必须检查锁；误投必须清理 queued_items。

**结论 2：queue 轮次沿用会话自身的 thread_settings，Desktop 原设置能保住。**

```text
新轮次 thread_settings_applied / turn_context：
  model=gpt-6-luna  effort=medium  approval_policy=on-request  approvals_reviewer=auto_review
  sandbox=workspace-write，permission_profile 写权限 = 会话 cwd + tmp
  cwd = 会话原 cwd
```

- 与 7.4c 对比：7.4c 那次沿用的是 CLI resume 留下的 `never`；本次是纯 Desktop 会话，沿用 `on-request`。
  → queue 继承的是"会话最后一轮的设置"，不会像 exec 那样强制降为 `never`。
- `approvals_reviewer=auto_review` 来自 Desktop 当前配置（不是 queue 参数带的），
  审批请求由自动审查处理而不是弹给用户。ACO 需把这一点告知用户。
- writable_roots：Desktop 首轮的 `visualizations\…` 目录没有出现在 queue 轮次的写权限里（权限按当前配置重建）。

**结论 3：queue 轮次的额度耗尽形态（真实样本，补充 P0-03）。**

```text
token_count.rate_limits: limit_id="premium", primary=null, secondary=null,
                         credits.has_credits=false, balance="0", rate_limit_reached_type=null
task_complete: last_agent_message=null,
               error.codex_error_info="usage_limit_exceeded",
               error.message="You've hit your usage limit. … try again at 12:23 PM."
耗时：4.5s，没有 agent_message
```

→ `task_complete` 出现不等于成功：必须检查 `task_complete.error`。
   `codex_error_info="usage_limit_exceeded"` 是比 limit_id 更直接的耗尽信号（limit_id 判据仍然成立）。

### 7.4f 已加载且空闲的纯 Desktop 会话 + queue（2026-10-30 实测）

```text
会话：01a18a4d-…，用户在 Desktop 新开（model=gpt-6-sol，approval=on-request），刚完成一轮，锁 = HELD
投递：08:58:58 queue exit=0 → 08:59:02(+4s) task_started，turn_trigger="queue"
新轮次：model=gpt-6-sol approval=on-request approvals_reviewer=user cwd=会话原 cwd
执行：在仓库内写 aco-queue-test.txt 成功，task_complete 无 error，last_agent_message="QUEUE-LOADED"
```

- 锁被持有 + 会话空闲 → 约 4 秒内执行，确认 7.4e 结论 1。
- `approvals_reviewer` 这次是 `user`（7.4e 是 `auto_review`）：它取自会话/Desktop 当时的设置，ACO 不能假设固定值，需读 thread_settings 告知用户。
- 附带观察：Desktop 的 gpt-6-sol 不在 CLI 模型目录里（P0-02 §1.1）；queue 不受此限制，因为执行者是 Desktop 的 app-server。

### 7.4g 执行中投递与 `--approve-for-me`（2026-10-30 实测，同一会话 01a18a4d-…）

**执行中投递：排在当前轮之后自动执行，不打断当前轮。**

```text
01:25:48 用户发 "Start-Sleep 90"（turn_trigger=composer）
01:27:32 queue 投递 [ACO-Q4]（投递时 started=3 complete=2，锁 HELD）
01:28:24 sleep 轮正常完成，回复 SLEPT
01:28:25 [ACO-Q4] 开始（turn_trigger=queue），01:28:33 完成，无 error
```

**审批：queue 轮次的审批照常弹给用户；`--approve-for-me` 在已加载会话上不生效。**

| 投递 | 轮次设置 | 仓库外写入（agent 请求 require_escalated） | 结果 |
|---|---|---|---|
| [ACO-Q5] 不带参数 | approval=on-request, reviewer=user | Desktop 弹框，用户点同意（等待约 28s） | 写入成功，APPROVE-BASELINE-OK |
| [ACO-Q6] `--approve-for-me` | **仍是** approval=on-request, reviewer=user | Desktop 照样弹框（Approve / Approve for session / Decline） | 停在弹框，无人点则一直挂起 |

- `--approve-for-me` 的说明是"通过自动审查处理审批"，但会话已被 Desktop 加载时，轮次设置取自会话本身，
  该参数没有被应用（turn_context.approvals_reviewer 仍为 `user`）。推测它只在 queue 自己建会话/起轮次时生效，未验证。
- → 对 ACO 的含义：
  - queue 通道**不会**静默降级审批，这一点比 exec resume（恒为 never）安全；
  - 代价是无人值守时遇到提权请求会**一直挂起**，ACO 必须能识别"等待审批"状态：
    该轮 `task_started` 之后长时间无 `task_complete`，且最后一个 tool call 带 `require_escalated`；
  - 识别到后应通知用户（"任务在等你审批"），而不是当作执行超时重试；
  - 不能依赖 `--approve-for-me` 实现无人值守自动审批。

### 7.4h exec resume 与 queue 混用时的三个新事实（2026-11-02 实测）

会话 01a17bf0-…：锁 = none（Desktop 未加载），但 Desktop app-server 仍在运行；
其 queued_items 里残留一条未消费的 `[ACO-Q2]`。此时执行
`codex exec resume <UUID> … -m gpt-6-luna --json`（cwd = 原仓库，Desktop 运行中）。

```text
exit=1
stdout: {"type":"turn.failed","error":{"message":"You've hit your usage limit. … try again at 2:22 PM."}}
stderr: ERROR codex_models_manager::manager: failed to refresh available models: request timed out
        ERROR rmcp::transport::worker: worker quit with fatal: Transport channel closed …
rollout 侧：同一轮内 task_started(trigger=queue，turn_context: approval=never) → 用户消息 [ACO-Q2]、[ACO-R1] 依次写入
            → task_complete err=usage_limit_exceeded（模型未产出回复）；执行后 queued_items 为空
```

**事实 1：锁空闲的会话，Desktop 运行中也能 exec resume —— 不会报 active writer。**
→ 证据范围：执行前该会话无锁文件，resume 越过了写锁检查，但因额度耗尽没有产出回复。重启后用户是否打开过该对话未核实。
→ ACO 判据是锁，不是"Desktop 是否在运行"。
→ **未验证**：会话在 Desktop 打开过之后，关闭 / 切走对话能否释放锁。§7.5 记录为"切走不释放"，
   因此现阶段通知文案只能要求"完全退出 Desktop"。
→ **未验证**：Desktop 执行轮次期间是否一定持锁。7.4e 的"执行后无锁文件"是事后较晚才检查的，
   不能证明执行期间无锁；若存在无锁执行窗口，"无锁即可 exec resume"有并发风险，需补测。

**事实 2：exec resume 会把会话里残留的 queue 消息一起执行掉。**
→ 残留消息先写入、resume prompt 后写入，二者进入同一轮，且该轮 approval=never。本次因额度耗尽，模型两条都没有真正处理。
→ 对 ACO 的含义：切换到 exec 通道前必须**先检查并清理 queued_items 里该会话的残留**，
   否则无人值守时可能先执行一条过期指令，其副作用（改文件 / 提交）会污染本次恢复。
   清理是必须项，不是可选优化。

**事实 3：CLI 侧额度耗尽的表现已实测到（补 P0-03）。**
→ exit=1、`turn.failed` 的 message 是纯文本、没有结构化 code；rollout 里仍有
   `task_complete.error.codex_error_info="usage_limit_exceeded"` 与 `limit_id="premium", primary=null`。
→ 所以 ACO 判耗尽仍应读 rollout，而不是解析 CLI stdout。

### 7.5 互操作结论

```text
Desktop → CLI Session 可发现：PASS
Desktop → CLI Session 可 resume（Desktop 完全退出后）：PASS，上下文完整保留
Desktop 能否看到 CLI 追加的轮次：能，重新打开即可见，无需刷新
写锁限制：~~Desktop 运行期间打开过的会话都不能 exec resume~~ 2026-11-02 订正（见 7.4h）：只有锁被占用的会话不能 exec resume，判据是锁而不是 Desktop 是否在运行（切走对话是否释放锁仍未验证，现阶段需完全退出 Desktop）
codex queue：Desktop 占锁时仍能把消息送进会话并执行 → 首选接续通道候选（待补测，见 7.4c）
运行时设置：model/effort 可保持；sandbox 部分丢失；approval_policy 必然降为 never 且无法恢复
```


## 8. 关键脱敏片段

```json
{
  "type": "session_meta",
  "payload": {
    "session_id": "01a1xxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx",
    "cwd": "D:\\<redacted>",
    "originator": "Codex Desktop",
    "cli_version": "0.162.0-alpha.17.2",
    "source": "vscode",
    "model_provider": "openai",
    "history_mode": "paginated",
    "git": {
      "commit_hash": "<40-char sha>",
      "branch": "master",
      "repository_url": "<redacted>"
    }
  }
}
```

`local_thread_catalog` 关键字段（source_kind=vscode 行）：

```text
host_id: local
thread_id: <UUID>
cwd: D:\<redacted>
git_branch: master
model_provider: openai
source_recency_at: <unix timestamp>
```

## 9. 结论

```text
PASS
```

### 可以作为正式实现依据的事实

- Session UUID 存于 rollout JSONL 第一行 `session_meta.payload.session_id`，与文件名 UUID 一致，可作为长期绑定依据；不得依赖 `--last`。
- 扫描 rollout 第一行即可发现 Desktop 创建的会话（按 cwd 匹配 + `source` 为字符串过滤子 agent），已实测。
- **Desktop 建的会话能被 CLI 在 worktree 里 resume，上下文完整**（靠"暗号"验证，且无文件读取），
  新轮次 cwd = worktree，模型按 `-m` 指定。ADR-0002 的 worktree 隔离可与原生 resume 组合使用。
- **CLI 追加的轮次在 Desktop 里可见**，重新打开对话即可，无需刷新或重启。
- **写锁互斥已实测**：`~/.codex/thread-writer-locks/<session_id>.lock` 存在且被独占 = 有进程在写该会话，
  此时 `exec resume` 必然 exit=1 报 `already has an active writer`。~~ACO 必须先检查这个锁。~~
  （ADR 0003 订正：ACO 不主动探测锁，直接按 CLI 报错分类。）
- **approval_policy 无法恢复到 on-request**：`codex exec` 恒为 `never`，`-c approval_policy=` 被忽略
  （`untrusted` 已不再支持，直接报错）。`-c` 能生效的是 `model_reasoning_effort` 和 `sandbox_mode`。

### 不能依赖的假设

- 不能假设 `session_index.jsonl` 包含所有 Session（仅 132 条，而 sessions 目录有 275 个 JSONL）。
- 不能假设 `state_5.sqlite` 在 Desktop 运行时可直接读（WAL 模式，文件为 0 字节）。
- 不能假设 `--last` 对应的是当前 repo 的最近 Session（全局最近，无 cwd 过滤）。
- 不能假设 Desktop 开着时 CLI 能接管会话——写锁会挡住。
- 不能假设 rollout 文件都是用户会话（80 个文件里只有 2 个是主会话，其余是子 agent）。
- 不能假设 resume 后运行时设置和原来一致：`approval_policy` 必然降为 `never`，sandbox 的 `writable_roots` 会丢失。
- 会话原模型不一定是 `gpt-6.1-sol`（实测出现过 `gpt-6-luna`），应读 `turn_context.model`。
- 多 repo 并行时 cwd 匹配的唯一性仍未实测。

## 10. 对 TDD 的影响

- Session Discovery：优先读 `local_thread_catalog`（app-server DB copy）；次选扫描 `session_index.jsonl`；最后扫描 rollout JSONL 第一行（实测最可靠，且能读模型）。
- **新增：占用预检**。resume 前检查 `~/.codex/thread-writer-locks/<session_id>.lock` 是否被独占；
  被占用时不得视为"resume 失败"，应记为该会话当前不可接管（BLOCKED_OCCUPIED），转入等待或改用 `codex queue`。
- Repo 绑定算法：`cwd == git rev-parse --show-toplevel` 得候选集；候选 >1 时需要消歧（用户选择 / `aco resume-later --session <id>` / 最近一次出现 rate_limit 的 Session），不得静默取最新。
- Task Snapshot schema：需保存 `session_id`（UUID）、`cwd`、`git.commit_hash`、`git.repository_url`、`source_recency_at`、原会话的 model、effort、sandbox_policy、approval_policy。
- Runtime capture：`session_meta` 含 model_provider；`turn_context` 含 model/effort/sandbox/approval——需从 JSONL 最后一条 `turn_context` 事件读取。
- Runtime restore：
  - model：读原会话 model → `codex debug models` 校验 → 可用则 `-m` 沿用；不可用 → BLOCKED。
  - effort / sandbox_mode：用 `-c` 恢复，已实测生效。
  - approval_policy：**无法恢复**。若原会话是 `on-request`，接管即意味着降级为 `never`；
    必须按 AGENTS.md 护栏显式告知用户并取得确认，不得静默降级（这属于 handoff 前的一次性提示，不是每轮询问）。
- Desktop 是否纳入 V0.1 任务来源：**是**，互操作已验证。
- 需要新增的 fallback：state_5.sqlite 不可读时回落到 session JSONL 扫描。

## 11. 其他发现

- 本机 Desktop 创建的主 Session `source = "vscode"`、`originator = "Codex Desktop"`；子 agent Session 的 `source` 是对象 `{subagent: ...}`。推测 `vscode` 是 Desktop 的 source 标识而非 VS Code 扩展（未核实）。Discovery 主要靠"`source` 是否为字符串"过滤子 agent。
- `codex exec resume` 在不受信任目录会在"Session 是否存在"检查之前先报 trust 错误；实测 git worktree 目录直接通过，无需写 `config.toml [projects]`。
- `session_index.jsonl` 的记录数（132）远少于 sessions 目录文件数（275），说明有 Session 没被索引；不能用 `session_index.jsonl` 作为全量 Session 列表。
- worktree 里追加的会话轮次，Desktop 里直接可见——说明 Desktop 是读 rollout 文件渲染的，不依赖内存中的 app-server 状态。
- CLI 版本在会话期间被 Desktop 自动升级过两次（0.162.0-alpha.17.2 → 0.163.0-alpha.10.2 → 0.163.0-alpha.11.2），旧 hash 目录会被删除。ACO 每次运行都要重新解析 CLI 路径并记录版本。
