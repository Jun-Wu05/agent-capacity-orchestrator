# P0-00 Codex Desktop 原生自动化能力与缺口分析

- 对应 Issue：#6
- 结果：`PARTIAL`（静态取证完成；section 4–6 定时执行实验尚未运行）
- 暂定结论：`ACO_NEEDED_COMPANION`

## 1. 环境

```text
Windows 版本：11
Windows build：10.0.26200.0（2026-10-16 复核）
Codex Desktop 版本：26.901.51231（UI 盘点时）；App build 26.1007.71326（config 中）
Desktop 自带 CLI：codex-cli 0.162.0-alpha.17.2（%LOCALAPPDATA%\OpenAI\Codex\bin\<hash>\codex.exe）
sandbox-bin CLI：codex-cli 0.162.0-alpha.2（%USERPROFILE%\.codex\.sandbox-bin\codex.exe）
Node.js：v24.11.1
Git：2.52.0.windows.1
PowerShell：7.6.6
实验时间：2026/09/08（UI 盘点）+ 2026/10/16（本地数据静态取证）
```

## 2. Desktop 自动化入口盘点

```text
是否存在 Automations / Scheduled Tasks：是——数据模型已存在；桌面版 UI 未找到入口，Web 端可见
feature flag：in_app_local_automation = stable / true（来自 codex features list）
存储：%USERPROFILE%\.codex\sqlite\codex-dev.db（app-server DB，Desktop 持有写锁，可 copy 读）
  automations 表（当前 0 行）：id/name/prompt/status/next_run_at/last_run_at/cwds/rrule/
    model/reasoning_effort/created_at/updated_at/target_type/project_id/kind/
    target_thread_id/execution_environment/local_environment_config_path/
    plugin_template_id/notification_policy/account_id/user_id/installation_id/
    legacy_automation_id/auto_archive/next_run_nominal_at
  automation_runs 表（当前 0 行）：thread_id/automation_id/status/read_at/thread_title/
    source_cwd/inbox_title/inbox_summary/created_at/updated_at/
    archived_user_message/archived_assistant_message/archived_reason
  inbox_items 表（当前 0 行）：id/title/description/thread_id/read_at/created_at
是否可设置未来执行时间：是（rrule = iCal RRULE；next_run_at/next_run_nominal_at）
是否可选择 project：是（cwds / project_id）
是否可选择已有 thread/session：是（target_type / target_thread_id）
是否可指定 model / reasoning：是（model / reasoning_effort）
是否有运行历史：是（automation_runs）
是否有失败原因：弱（status + archived_reason；无专门错误字段）
是否有本地通知：notification_policy 字段存在；inbox_items 存在；Windows Toast 未验证
```

## 3. 测试 Repo

```text
测试 Repo：<工作区>\_aco-sandbox\automation-test（尚未创建，待 section 4–6 使用）
```

## 4. 定时执行实验

> **未执行**。需在 UI 创建 automation 后观察 `automations` / `automation_runs` 表变化。

### 4.1 Desktop 保持打开

```text
计划执行时间：待填
实际执行时间：待填
是否成功：待填
是否创建新 thread：待填
是否沿用已有 thread：待填
是否有通知：待填
备注：target_thread_id 字段可指定已有 thread，但行为需实测
```

### 4.2 Desktop 关闭

```text
计划执行时间：待填
Desktop 是否完全退出：待填
是否成功：待填
是否在重新打开 Desktop 后补执行：待填
是否有通知/历史：待填
备注：CLI 存在共享后台 app-server daemon（feature daemon_auto_start=stable/true）；
      automation 可能由 daemon 独立运行，不依赖窗口进程——这是本节最关键的验证点
```

### 4.3 Windows 锁屏

```text
计划执行时间：待填
是否成功：待填
解锁后状态：待填
备注：待填
```

## 5. Windows 重启恢复实验

```text
重启前任务是否仍可见：预期是（SQLite 持久化），待验证
重启后任务是否仍存在：待填
是否自动执行：待填
如果错过计划时间，是否补执行：线索——next_run_at 与 next_run_nominal_at 并存，疑似区分名义/实际时间；待验证
是否要求手动打开 Codex Desktop：待填
备注：feature daemon_auto_start=true 暗示 daemon 随启动，待验证
```

## 6. Existing Thread Continuation 实验

```text
是否能直接绑定已有 thread：数据模型支持（target_thread_id），未实测
如果不能，是否只能创建新任务/thread：待填
是否保留原对话上下文：待填
是否识别已有 repo 修改：待填
是否能正确继续原目标：待填
备注：CLI 另有独立通道——`codex queue --thread <UUID> --message <TEXT>`，
      向已有 session 排队消息（queue_1.sqlite.queued_items），可绕过 UI
```

## 7. Capacity / Quota 行为

先把两件事分开：**额度数据拿不拿得到**，和**调度器会不会按额度决定何时跑**。

```text
[A] 额度数据是否可得
Desktop 是否展示 quota / reset 信息：是。Session JSONL 的 token_count 事件含 rate_limits
CLI 是否能吐额度数据：是，但不在 stdout。CLI 运行时把 token_count（含 rate_limits）写进该会话的 rollout 文件；
  `--json` stdout 只有 turn.completed.usage（已实测，见 P0-02 §0）
  样本：{"limit_id":"codex","primary":{"used_percent":43.0,"window_minutes":300,"resets_at":1791889905},
        "secondary":{"used_percent":7.0,"window_minutes":10080,"resets_at":1792476705},"plan_type":"plus"}
CLI 是否有专门的 quota/usage 查询子命令：否（codex --help 无相关子命令）；
  也就是说只能在跑 turn 时顺带拿到，或读历史 session JSONL 取最后已知值

[B] 调度器是否按额度决策
Desktop automations 是否有 capacity/quota 字段：否。全部字段只有 rrule + next_run_at + next_run_nominal_at 等时间字段
CLI 是否有调度器：否（无任何定时/等待类子命令）
自动化是否能以 quota 恢复作为条件：否——调度器根本不读 rate_limits
是否只能基于固定时间：是（就当前数据模型而言）
到点但 quota 未恢复时行为：未验证；automations 无 retry / wait 字段
真实 quota exhaustion 是否已验证：否
```

**结论：额度数据可得（CLI 与自己读 JSONL 都行），但 Desktop 与 CLI 都没有"按额度决定何时触发"的能力。
ACO 要补的是 [B]，不是 [A]。**


## 8. Runtime 连续性

| 设置 | 原任务 | 自动化执行时 | 是否保持 | 备注 |
|---|---|---|---|---|
| model | session_meta.model | automations.model | 可指定 | 未实测继承行为 |
| reasoning | turn_context.effort | automations.reasoning_effort | 可指定 | 未实测 |
| sandbox | turn_context.sandbox_policy | 表中无字段 | 未知 | 可能取全局 config |
| approval | turn_context.approval_policy | 表中无字段 | 未知 | 可能取全局 config |
| project/cwd | session_meta.cwd | automations.cwds | 可指定 | 未实测 |

## 9. Git / Workspace 行为

```text
是否继续使用原 repo：cwds 字段可指定，未实测
是否识别已有 staged/unstaged/untracked 修改：未验证
是否会创建独立 worktree：有线索——CLI --worktree 选项（"Run the session in a new managed Git worktree"）；
                          global state 有 electron-managed-worktree-archives；
                          %USERPROFILE%\.codex\worktrees 目录存在；
                          automations.execution_environment 是否对应此能力待验证
是否有 Git 状态保护机制：未发现 checkpoint / 冲突处理相关字段
是否存在覆盖用户现场的风险：未验证
```

## 10. 外部调用入口

```text
CLI：有——`codex exec resume <UUID> [PROMPT]`（非交互，--json 输出 JSONL）；
         `codex queue --thread <UUID> --message <TEXT>`；
         `codex agents`（浏览 app-server sessions）；
         `codex app-server`（experimental）
URI scheme：未发现
本地 IPC/API：有线索——`--remote ws://...`；`codex app-server` experimental
其他：直接写 codex-dev.db automations 表技术可行，但属私有格式，不作为 ACO 依赖
```

## 11. Gap Matrix

| 能力 | Desktop 原生支持 | 稳定性 | ACO 是否仍需要 | 备注 |
|---|---|---|---|---|
| 定时启动 | 是（rrule） | 未实测 | 否（若 daemon 可靠） | |
| 继续已有 thread | 数据模型支持 | 未实测 | 视实测 | target_thread_id |
| **Capacity-aware 调度** | **否** | — | **是（核心）** | 额度数据本身可得，但调度器不读它（见 §7） |
| **quota 未恢复等待/重试** | **否** | — | **是** | automations 无 retry/wait 字段 |
| 重启后保留 | 很可能 | 未实测 | 视实测 | SQLite 持久化 |
| App 关闭时执行 | 未知 | 未实测 | 视实测 | daemon 线索 |
| 锁屏时执行 | 未知 | 未实测 | 视实测 | |
| Git 状态保护 | 未发现 | — | **是** | |
| Runtime 保持（sandbox/approval） | 弱 | — | **是** | |
| 失败中文解释 | **否** | — | **是** | |
| 外部调用入口 | CLI 存在 | alpha | — | |

## 12. 结论

```text
ACO_NEEDED_COMPANION（暂定）
```

### 理由

- Desktop 原生自动化已有"定时 + 绑定已有 thread + 指定 model/cwd"的完整数据模型，
  ACO 无需重新发明定时器和会话恢复通道。
- **Desktop 的调度器缺 Capacity 维度**：只能按时间触发，无法表达"等额度恢复再跑"。
  注意区分——额度数据是拿得到的（会话 rollout 文件里的 token_count 事件），
  缺的是"读额度 → 判断 Eligibility → 决定何时触发"这一层调度逻辑（见 §7）。
- Git 现场保护（checkpoint + isolated worktree）、Preflight、中文 explain 均未见原生对应。

### ACO 最值得补的缺口

1. Capacity-aware Eligibility：读 rate_limits → 判断何时可以触发。
2. 恢复前 Preflight 与 Git 现场保护（checkpoint commit + worktree 隔离）。
3. 可解释状态（为什么还没跑、当前 Confidence、下一步）。

## 13. 对 PRD / TDD 的影响

```text
Desktop-first 是否成立：待定。若 section 4.2 证明 daemon 在 App 关闭时可自主执行，
  则 ACO 可定位为"Capacity 守门人"，把触发权通过 automation 或 exec resume 交还 Desktop。
CLI 是否仍为 MVP 必需依赖：是。Desktop 已内置 CLI（0.162.0-alpha.17.2），无需单独安装；
  在 worktree 目录下启动 `codex exec resume <UUID> -m <model> "<continuation prompt>" --json` 是首选执行通道（已实测：会话上下文保留、工作目录跟随启动目录，见 P0-02 §0）。
是否需要完整 daemon：是（CLI 与 Desktop 都没有 Capacity 轮询与 Eligibility 判断）
是否需要 Capacity Provider：是
是否需要 Task Snapshot：是
是否需要 worktree/checkpoint：是；应评估复用原生 --worktree，避免重复实现
MVP 最小闭环建议：ACO daemon 读 rate_limits → Eligibility → Preflight →
  在 ACO worktree 目录下启动 `codex exec resume <UUID> "<continuation>" --json`
```

## 14. 脱敏证据

- `codex features list` 关键行：`in_app_local_automation  stable  true`；`daemon_auto_start  stable  true`；`goals  stable  true`。
- `codex-dev.db` 的 `automations`、`automation_runs`、`inbox_items` 均为 0 行（本机未创建过 automation）。
- `rate_limits` 样本（来自 session JSONL，见 P0-03）：`{"limit_id":"codex","primary":{"used_percent":43.0,"window_minutes":300,"resets_at":1791889905},"secondary":{"used_percent":7.0,"window_minutes":10080,"resets_at":1792476705},"plan_type":"plus","rate_limit_reached_type":null}`。
- 未提交账号 ID、prompt 正文或完整会话内容。
