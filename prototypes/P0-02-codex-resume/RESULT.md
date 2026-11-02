# P0-02 Codex Resume Session / Runtime 验证结果

- 对应 Issue：#2
- 结果：`PASS`（Q1/Q2 PASS；runtime 覆盖与无效 UUID 特征已于 2026-10-27 补测，见 §0.1）

## 0.1 补测（2026-10-27，`run-override-test.ps1`，codex-cli 0.164.0-alpha.11.1）

| 测试 | 结果 |
|---|---|
| T1 受信任目录下 resume 不存在的 UUID | exit=1，`thread/resume failed: no rollout found for thread id <UUID> (code -32600)` |
| T2a resume 后写仓库外目录（不补 writable_roots） | 被沙箱拒绝：`Set-Content` 抛错，agent 回复 FAILED |
| T2b 加 `-c "sandbox_workspace_write.writable_roots=['<dir>']"` | 生效：turn_context 里出现该目录，写入成功 |

结合 P0-01 §7.4，`exec resume` 的 runtime 恢复能力定型：

- model / effort / sandbox_mode / writable_roots：可用 `-m` / `-c` 恢复。
- approval_policy：exec 模式恒为 `never`，无法恢复 → 接管前必须显式告知用户。
- Resume Task fallback 触发特征：输出含 `no rollout found`；必须与 `already has an active writer`（会话被占用，不得 fallback）区分开。
- §6 中"Desktop 创建的会话能否被 CLI resume"已由 P0-01 §7.3 实测为 PASS。
- 环境注意：在受限 agent 沙箱内调用 codex.exe 会报 `failed to initialize in-process app-server client: 拒绝访问`，本类测试需在沙箱外运行。

## 0.2 补测：trust 检查规则（2026-11-02，`run-trust-test.ps1`，codex-cli 0.166.0-alpha.5.1）

方法：在不同 cwd 下 `exec resume <全零 UUID>`。trust 检查早于 Session 查找，报 `no rollout found` 即表示已通过 trust，不消耗模型额度。
每次实验都先备份 `config.toml`，结束时还原并校验哈希一致。

| 用例 | cwd | 是否 git 仓库 | config 中的 trusted 条目 | 结果 |
|---|---|---|---|---|
| A | `untrusted/repo` | 是 | 无 | **通过**（no rollout found） |
| B1 | `trusted-parent/repo` | 是 | 父目录 | 通过 |
| B2 | `trusted-parent/wt/task-1` | 是（git worktree） | 父目录 | 通过 |
| B0 | `trusted-parent` | 否 | 自身 | **TRUST_ERROR** |
| C0 | `plain-parent/sub` | 否 | 无 | TRUST_ERROR |
| C1 | `plain-parent/sub` | 否 | 父目录 | TRUST_ERROR |
| C2 | `plain-parent` | 否 | 自身 | TRUST_ERROR |

结论：
- 当前版本中，`exec` 的这一检查**实际判断的是"cwd 是否在 git 仓库内"**，与 `[projects]` 条目无关：
  git 仓库或 git worktree 内无需任何 trusted 条目即可通过；非 git 目录即使本身被列为 trusted 也会失败。
  错误文案中的 "trusted directory" 具有误导性。
- 对比 §6 中 10-16 的 trust 错误：当时测试目录 `C:\aco-prototype\resume-test` 本身可能不是 git 仓库（未核实）。
- 对 ACO：worktree 必然在 git 内，**不需要修改用户的 config.toml**（grill Q7 的前提消失）。
  仍需在 Preflight 中检查"cwd 在 git 仓库内"，并且**禁止**用 `--skip-git-repo-check` 绕过。
- 未验证：`[projects]` trust_level 是否影响 git 仓库内的其他行为（如项目级 `.codex/` 配置是否加载）。

## 0. 实测结论（2026/10/16，`run-resume-test.ps1`）

| 问题 | 结论 | 证据 |
|---|---|---|
| Q1 `exec resume <UUID>` 能否后台非交互恢复 | **PASS** | exit=0，`thread.started` 的 thread_id 与原会话一致 |
| Q2 在另一个目录 resume，agent 在哪里工作 | **跟随启动目录** | `b.txt` 落在 `wt-b`；agent 打印 cwd=`wt-b`；会话最后一轮 `turn_context.cwd`=`wt-b` |
| Q3 exit=0 是否代表任务真的完成 | **否** | 见下 |
| Q4 `exec --json` 事件流是否带 rate_limits | **否** | 只有 `turn.completed.usage`；rate_limits 只写在 rollout 文件 |

**Q2 → ADR-0002（checkpoint + isolated worktree）可以直接配合原生 resume：**
在 ACO worktree 目录下启动 `codex exec resume <UUID> -m <model> "<prompt>" --json`，会话上下文保留，工作目录切到 worktree。
不需要 `-C`，也不需要退回 Resume Task。git worktree 也直接通过了 git 仓库检查，不用写 `config.toml [projects]`。

**Q3 exit=0 但没干活（复现确认，非偶发）：**
agent 发出 `Set-Content a.txt` 命令后，进程 exit=0、`turn.completed` 正常、agent 回复 `DONE`，但命令实际失败：

```text
rollout 记录：status:"failed", exit_code:-1, aggregated_output:"", source:"unified_exec_startup"
rollout 里同时出现：ERROR codex_core::session: failed to record rollout items: thread <UUID> not found
exec --json stdout 里只有 item.started，没有对应的 item.completed（失败信息完全不在 stdout）
```

复现实验（`_aco-sandbox` 下 4 个全新目录、共 6 次 `codex exec`）：
- 3 次出现该现象，全部是**某个目录的第一次 exec**；失败时 `thread ... not found` 必为 True，成功时必为 False。
- 同一目录第二次跑就正常；但不是每个目录的第一次都失败（3 次首发里 2 次失败、1 次成功）。

推断：与新会话首次落盘时的竞态有关（会话记录还没写入就被自己的执行结果回写，"thread not found"）。未定位到确切机制，也未向 OpenAI 确认。

→ 对 ACO 的硬性要求：
  1. 不能用 exit code、也不能只看 agent 回复判断完成。
  2. `--json` stdout 不足以判断成败——必须读该会话 rollout，检查 `CommandExecution.status` 与错误行。
  3. 必须有结果核验（git diff / 预期产物 / 测试命令），并配重试策略。
  4. 首次 resume/exec 的失败率不可忽略，ACO 的 Preflight 与重试要把它计入。

另：本机 CLI 在会话中途被 Desktop 自动更新过（0.162.0-alpha.17.2 → 0.163.0-alpha.10.2，且旧 hash 目录已删除）。
→ ACO 不能把 CLI 路径写成常量，每次运行都要重新按 `%LOCALAPPDATA%\OpenAI\Codex\bin\*\codex.exe` 解析，并记录实际使用的版本。

**Q4 额度的实时来源：**
`--json` 事件流不含 rate_limits。会话 rollout 文件（`~/.codex/sessions/.../rollout-*-<UUID>.jsonl`）的 `token_count` 事件里有，
本次每个 turn 都写了。ACO 应在 exec 运行时/结束后读该会话的 rollout 文件，而不是解析 stdout。
这次的值还说明额度结构随账号变化：`plan_type:"free"`、`primary.window_minutes:43200`（30 天）、`secondary:null`，
与之前 Desktop 会话里的 `plus` / 300 分钟 + 10080 分钟两档完全不同——Capacity Provider 不能写死窗口。

## 1. 环境

```text
Windows 版本：11
Windows Build：10.0.26200.0
Codex CLI 版本：codex-cli 0.162.0-alpha.17.2（Desktop 内置；会话中途被自动更新到 0.163.0-alpha.10.2）
Node.js 版本：v24.11.1
Git 版本：2.52.0.windows.1
PowerShell 版本：7.6.6
测试时间：2026/10/16（静态取证 + run-resume-test.ps1 初次运行）
```

## 1.1 新增发现：config.toml 的全局默认模型在 CLI 下不可用（阻塞级）

> **订正（2026-11-02）**：本节是 10-16～10-23（CLI 0.164.x）时的状态，不是长期事实。
> CLI 已自动升级到 0.166.0-alpha.5.1，`codex debug models` 现在返回 10 个模型（8 个可见）：
> gpt-6.1-sol、gpt-6-astra、gpt-6.1-terra、gpt-6-sol、gpt-6-luna、gpt-5.6-sol、gpt-5.6-terra、gpt-5.6-luna（另有 gpt-reserve、codex-auto-review 为 hide）。
> 当前 `config.toml` 默认 `model = "gpt-6-sol"`，在 CLI 下可用。
> 模型目录本地缓存：`%USERPROFILE%\.codex\models_cache.json`（字段 `fetched_at / etag / client_version / identity / models`，由 CLI 联网刷新）。
> 仍然成立的结论：模型目录随 CLI 版本 / 账号变化，**ACO 必须在 `resume-later` 时和恢复前各预检一次**（grill Q3 决定），不可用时由用户明确选择替代，不得静默切换；调用 CLI 时仍应显式传 `-m`。

```text
config.toml 全局默认：model = "gpt-6.1-sol"
CLI `login status`：Logged in using ChatGPT
CLI `debug models` 返回的可用模型（共 5 个，可见的 3 个）：
  gpt-6-luna / gpt-5.6-luna / gpt-5.6-terra（另有 gpt-reserve、codex-auto-review 为 hidden）
  —— 其中没有 gpt-6.1-sol

实测（run-resume-test.ps1 第一次运行）：
  `codex exec ...`（未加 -m，沿用 config 默认）→ exit 1，turn.failed：
    {"type":"error","status":400,"error":{"type":"invalid_request_error",
     "message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}
  `codex exec resume ...`（同样未加 -m）→ 同一条 400 错误
  另外伴随两条非致命告警：
    - config.toml 的 `disable_response_storage` 被忽略（unrecognized setting）
    - `Model metadata for 'gpt-6.1-sol' not found. Defaulting to fallback metadata`

影响范围：不是 resume 特有的问题——任何不带 -m 的 CLI 调用都会撞上它。
  这也解释了为什么第一次 `exec resume <全零 UUID>` 报的是 trust 错误而非模型错误：
  那次在走到模型调用之前就先失败了。

对 ACO 的含义（直接命中 AGENTS.md 护栏「恢复时应尽量保持原模型与运行时设置；若不可用，不应静默切换」）：
  - ACO 调用 CLI 时必须显式传 `-m <cli-model>`，不能依赖 config.toml 默认值。
  - Desktop 侧记录的模型名（turn_context.model = gpt-6.1-sol）不能直接回传给 CLI。
  - 需要一张模型映射或"可用性探测"：Task Snapshot 里记录用户真实使用的模型，
    resume 前先用 `-m` 探测其可用性；不可用则应进入 BLOCKED 并告知用户，而不是静默换模型。
```

## 2. 测试 Session

```text
测试仓库：D:\<repo-A>（脱敏）
Session UUID：01a13411-xxxx-xxxx-xxxx-xxxxxxxxxxxx（脱敏）
原始 cwd：D:\<repo-A>
原始 model：gpt-6.1-sol（来自 turn_context.model）
原始 reasoning：medium（来自 turn_context.effort；config.toml model_reasoning_effort=medium）
原始 sandbox：workspace-write（来自 turn_context.sandbox_policy.type；附带 writable_roots 列表）
原始 approval：on-request（来自 turn_context.approval_policy）
```

## 3. 基础 Resume 测试

### 非交互模式（exec resume）

执行命令：

```powershell
codex exec resume <UUID> "<continuation prompt>"
```

结果：

```text
命令语法：已验证。codex exec resume [OPTIONS] [SESSION_ID] [PROMPT]
受信任目录外运行 → exit 1，错误："Not inside a trusted directory and --skip-git-repo-check was not specified."
无效 UUID（全零）且 cwd 不在 trusted 列表 → exit 1（报 trust 错误，早于 Session 查找）
真实 UUID 在 git 仓库/worktree 下的 resume：PASS（见 §0）
--json 标志：存在，输出 JSONL 事件（可被 ACO 解析）
`exec resume` 可用的 runtime 相关参数（来自 --help，已核对）：只有 -m、-c、--worktree、--skip-git-repo-check、--json、-o
`exec resume` 没有 -s / -a / -C / --add-dir / --approve-for-me；这些只属于 `codex exec`（新会话）
```

### 交互式 TUI 模式

```powershell
codex resume <UUID>
```

```text
在非终端环境（脚本/重定向）→ "stdin is not a terminal"，exit 1
交互式 resume：需要真实终端（TTY），ACO 后台执行通道不可直接使用 TUI 模式
```

**结论：ACO 必须使用 `codex exec resume`（非交互）+ `--json` 作为后台恢复通道。**

## 4. Runtime 能力表

| 设置 | 可从 Session 读取 | Resume 默认继承 | 可显式 override | override 命令/方式 | 行为说明 |
|---|---|---|---|---|---|
| model | 是（turn_context.model） | 未实测 | 是（`-m` / `-c model=...`） | `codex exec resume <uuid> -m gpt-6.1-sol` | config.toml 全局默认 |
| reasoning | 是（turn_context.effort） | 未实测 | 是（`-c model_reasoning_effort=...`） | `-c model_reasoning_effort=medium` | 与 model 配合 |
| sandbox | 是（turn_context.sandbox_policy JSON） | 未实测 | 推测可以（未实测） | `-c sandbox_mode="workspace-write"` | exec resume 无 `-s`；只能走 `-c` 覆盖 config 键 |
| approval | 是（turn_context.approval_policy） | 未实测 | 推测可以（未实测） | `-c approval_policy="on-request"` | exec resume 无 `-a` / `--approve-for-me` |
| cwd | 是（turn_context.cwd） | **否，跟随启动目录** | 是 | 在目标目录启动进程 | 已实测：在 wt-b 启动 → turn_context.cwd=wt-b，文件写入 wt-b |

## 5. Session 不存在/无效 UUID 测试

执行：

```powershell
codex exec resume 00000000-0000-0000-0000-000000000000
```

结果：

```text
退出码：1
stderr/stdout：Not inside a trusted directory and --skip-git-repo-check was not specified.
```

**注意：** trust 检查先于 Session 查找执行；在受信任目录下，无效 UUID 的具体报错形式未测到。ACO 的 Preflight 需要先在受信任目录下验证，再处理 Session 查找失败的情况。

## 6. 结论

```text
PARTIAL
```

### 可以作为正式实现依据的事实

- `codex exec resume <UUID> "<prompt>" --json` 是 ACO 后台执行的首选命令形式；`--json` 输出 JSONL 事件，可被 ACO 解析状态。
- exec resume 只能用 `-m` 和 `-c <key=value>` 显式指定 runtime；没有 `-s` / `-a` / `-C`。
- TUI 模式（`codex resume`）不可用于后台自动化。
- `codex exec resume` 在 cwd 不在 trusted 列表时直接 exit 1；ACO worktree 所在目录必须加入 `config.toml [projects]` trusted。

### 不能依赖的假设

- 不能假设 runtime 设置在 exec resume 时自动继承——需实测（特别是 sandbox policy 中的 writable_roots 细节）。
- 不能假设 `-c sandbox_mode=...` / `-c approval_policy=...` 在 resume 时生效（Session 可能沿用自己记录的 policy）——需实测。
- ~~Desktop 创建的会话能否被 CLI resume 仍未测（本次只测了 CLI 自建会话）。~~ 已由 P0-01 §7.3 实测为 PASS。

## 7. 对 TDD 的影响

- `resumeSession()`：`codex exec resume <UUID> <continuation_prompt> -m <model> -c model_reasoning_effort=<effort> --json`，子进程 cwd 设为 ACO worktree（已实测生效）。~~sandbox/approval 用 `-c` 覆盖是否生效仍未测。~~ 2026-11-02 已测（见 §0.1、P0-01 §7.4）：sandbox 可用 `-c` 覆盖，approval 不能（恒为 `never`）。
- 完成判定：不信 exit code；结束后读该会话 rollout，检查 `CommandExecution.status=failed` 与 `thread ... not found` 错误行，再做结果核验（diff / 测试）。
- Runtime capture：从 session JSONL 最后一条 `turn_context` 事件提取 model/effort/sandbox_policy/approval_policy。
- Runtime restore：通过 `-m`、`-c` 显式传入；若原配置不可用，进入 BLOCKED（不静默切换）。
- Resume Task（`codex exec -C <worktree>` 新会话 + Snapshot）仍保留，但只作为 Session 不可恢复时的退路，不再是 worktree 隔离的必要条件。
- Preflight：每次运行重新解析 CLI 路径并记录版本（Desktop 会自动更新 CLI，旧路径会被删）；模型预检（`codex debug models`）。
- Resume Task fallback 触发条件：exec resume exit 非零 + stderr 含 Session 不存在特征（需实测确认具体字符串）。
- worktree 信任：已实测，git worktree 直接通过，不用写 `config.toml [projects]`。

## 8. 其他发现

- `codex queue --thread <UUID> --message <TEXT>` 是另一条"继续已有 session"的通道：向正在等待的交互式 session 排队消息（queue_1.sqlite），不启动新进程。适合 Desktop 保持打开时的任务续跑。
- `--worktree` 标志（"Run the session in a new managed Git worktree"）由 Codex 原生管理 worktree，ACO 可评估复用，避免自行实现 worktree 生命周期。
- `--dangerously-bypass-approvals-and-sandbox` 绝对不能用于 ACO（PRD P5：No silent fallback）。
- `-o / --output-last-message <FILE>` 可将 agent 最后一条消息写入文件，便于 ACO 解析完成状态。
