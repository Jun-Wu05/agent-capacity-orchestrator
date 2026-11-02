# P0-03 Codex Capacity / Quota Exhaustion 验证结果

- 对应 Issue：#3
- 结果：`PASS`（额度结构、耗尽标识、恢复时间、多账号类型均已验证）

## 1. 环境

```text
Windows 版本：11
Windows Build：10.0.26200.0
Codex CLI 版本：codex-cli 0.162.0-alpha.17.2（Desktop 内置）
Node.js 版本：v24.11.1
Git 版本：2.52.0.windows.1
PowerShell 版本：7.6.6
实验时间：2026/10/16（静态取证）+ 2026/10/21（真实耗尽记录分析）
真实耗尽样本：全库 1864 条 rate_limits 记录中，7 个文件出现过耗尽状态（9 条 premium 记录），
              codex→premium 切换 8 次，premium→codex 恢复 4 次（切换集中在其中 5 个文件）
```

## 2. 正常运行状态

```text
命令：Desktop 内 Session 正常运行时
退出码：0
stdout 特征：--json 模式下输出 JSONL 事件流
Session JSONL 中 token_count 事件：包含 rate_limits 字段（见第 5 节）
rate_limits/usage 字段：rate_limits.primary.used_percent = 43.0（已观察到样本）
reset timestamp：rate_limits.primary.resets_at（Unix 秒级时间戳，例 1791889905）
                 rate_limits.secondary.resets_at（周级窗口）
```

## 3. 接近额度限制状态（已实测）

```text
命令/场景：Desktop 会话持续工作，额度从 0% 递增到 100%
Session 新增事件：event_msg/token_count 正常追加，rate_limits.limit_id 保持 "codex"
rate_limits 字段变化：primary.used_percent 逐步上升（实测采样 0→3→6→8→10→17→19→21→25→27→30→33→39→44→49→52→53→56→57→60→63→72→75→76→80→85→89→92→96→99→100）
  primary.window_minutes 恒为 300（5 小时窗口）
  secondary.used_percent 缓慢上升（周窗口），window_minutes 恒为 10080
reset timestamp：primary.resets_at 在窗口滚动前保持不变；窗口滚动后整体后移
备注：全量扫描 54 个含 rate_limits 的 session，rate_limit_reached_type 非 null 的事件数 = 0
      → 该字段在耗尽时**也不会**被填充，不能用它判断
```

## 4. Quota Exhausted 状态（已实测：8 次耗尽 / 4 次恢复）

```text
是否真实额度耗尽：是（本机 2026-09-28 ~ 2026-10-21 的真实记录）
触发条件：primary.used_percent 达到 100 后，紧接着的下一次 token_count 事件

**唯一可靠的耗尽标识：limit_id 从 "codex" 变成 "premium"，同时 primary / secondary 变成 null。**

耗尽时的完整记录：
{
  "limit_id": "premium",
  "limit_name": null,
  "primary": null,
  "secondary": null,
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
  "individual_limit": null,
  "spend_control_reached": null,
  "plan_type": "plus",
  "rate_limit_reached_type": null      ← 仍然是 null，不可用
}

Desktop UI 同时显示：
  "Codex 和工作使用额度已用完 / 你的速率限制将于 19:22 重置。"

恢复时：limit_id 变回 "codex"，primary.used_percent 回到 0，primary.resets_at 后移到新的窗口
```

### 关键实测数据：reset 时间与真实恢复时间

| 耗尽时刻 | 耗尽前记录的 resets_at（5h 窗口） | 文件里第一次看到恢复 | resets_at 早于观察 |
|---|---|---|---|
| 09-28 14:47 | 09-28 19:04 | 09-28 20:29 | 1h25m |
| 09-28 20:54 | 09-29 01:29 | 09-29 08:44 | 7h15m（跨夜） |
| 10-20 10:35 | 10-20 12:30 | 10-20 13:45 | 1h15m |
| 10-20 17:25 | 10-20 19:33 | 10-20 20:22 | 49m |

4 次恢复都发生在 resets_at **之后**，没有一次早于它。
但 rollout 只在有请求时才写记录，"第一次看到恢复"其实是"恢复后用户第一次再用"，
所以上表的差值主要是用户空闲时间（跨夜那次最明显），**不能**说明 resets_at 不准。

能确定的：
- 实测没有一次在 resets_at 之前恢复 → resets_at 可以作为"最早可能恢复时间"。
- Desktop UI 显示的重置时间（19:22）与 resets_at（19:22:45）一致。
不能确定的：
- 到了 resets_at 是否**立刻**可用（需要在 resets_at 后几分钟内主动发一次请求才能验证）。

→ ACO 的设计：resets_at 之前不尝试；到点后发探测，失败则按退避重试。
→ 判断"现在是否已恢复"不能只读历史文件（最后一条可能是很久前的 premium），需要一次真实请求。

### 判断额度耗尽的正确方式（优先级）

```text
1. rate_limits.limit_id == "premium" 且 primary == null   → 已耗尽（唯一可靠，实测 8/8 次耗尽均如此）
2. rate_limits.primary.used_percent >= 100                → 即将/已耗尽（作为预警）
3. Desktop UI 文案                                        → 辅助，不可程序化读取
不可用：rate_limit_reached_type（恒为 null）、exit code、--json stdout
```

**补充（2026-10-28，queue 轮次真实耗尽，见 P0-01 §7.4e）**：本轮 `task_complete` 带有

```text
"last_agent_message": null,
"error": { "codex_error_info": "usage_limit_exceeded",
           "message": "You've hit your usage limit. … try again at 12:23 PM." }
```

同时 `rate_limits` 仍是 `limit_id="premium"` + `primary=null`，判据 1 继续成立。
→ `task_complete.error.codex_error_info == "usage_limit_exceeded"` 可作为**本轮因额度失败**的直接信号，与判据 1 互为印证。
→ ACO 不能把"出现 task_complete"当成成功；必须先检查 `error`。
→ message 里的 "try again at 12:23 PM" 只有本地时间、没有日期和时区，只作展示，不作 next_check_at 来源。

**CLI 侧耗尽实测（2026-11-02，`codex exec resume`）**：

```text
exit=1
stdout: {"type":"turn.failed","error":{"message":"You've hit your usage limit. … try again at 2:22 PM."}}
```

- `turn.failed` 只有纯文本 message，没有结构化错误码，**不能**靠解析它判耗尽。
- 同一时刻 rollout 里仍然写着 `task_complete.error.codex_error_info="usage_limit_exceeded"`，
  且 `token_count.rate_limits` 为 `limit_id="premium", primary=null`。
- → 结论不变：判据仍读 rollout，不解析 CLI stdout / exit code。

## 5. Capacity 来源对比

| 来源 | 是否可用 | 是否结构化 | 是否包含 reset | 稳定性观察 | 建议 Confidence |
|---|---|---|---|---|---|
| Session JSONL token_count.rate_limits | 是 | 是 | 是（resets_at Unix 时间戳） | 高（从 200 个 Session 中稳定出现） | `OBSERVED`（从已写入文件读取） |
| rate_limits.primary.resets_at | 是 | 是 | 是（秒级 Unix） | 高 | `EXACT`（当字段存在时） |
| rate_limits.secondary.resets_at | 是 | 是 | 是（周级窗口） | 高 | `EXACT` |
| --json 事件流 rate_limits | **否** | — | — | 已实测：`exec --json` 只给 `turn.completed.usage`，无 rate_limits | — |
| rate_limits.limit_id（codex / premium） | 是 | 是 | — | 高（8/8 次耗尽一致） | 耗尽判定主依据 |
| CLI exit code / stderr（quota 耗尽时）| 是（2026-11-02 实测，见下） | 否（纯文本） | 否 | exit=1 + `turn.failed` | `OBSERVED` |
| Desktop UI 展示 | 是（"额度已用完，将于 19:22 重置"） | 否 | 是，与 resets_at 一致 | — | 仅供人看 |

### rate_limits 字段结构（脱敏样本）

```json
{
  "limit_id": "codex",
  "limit_name": null,
  "primary": {
    "used_percent": 43.0,
    "window_minutes": 300,
    "resets_at": 1791889905
  },
  "secondary": {
    "used_percent": 7.0,
    "window_minutes": 10080,
    "resets_at": 1792476705
  },
  "credits": { "has_credits": false, "unlimited": false, "balance": "0" },
  "individual_limit": null,
  "spend_control_reached": null,
  "plan_type": "plus",
  "rate_limit_reached_type": null
}
```

**注（已实测修正）：** `rate_limit_reached_type` 在耗尽时**仍为 null**（全库 1864 条 rate_limits 记录中非 null 数量为 0）。
原假设"耗尽时该字段会被填充"已被推翻，判断耗尽必须看 `limit_id`（见第 4 节）。

**注（2026/10/16 实测）：窗口结构会变，不能写死。**

同一个 CLI 会话（`codex exec` 新建）rollout 里记录的是完全不同的结构：

```json
{"limit_id":"codex","primary":{"used_percent":0.0,"window_minutes":43200,"resets_at":1794735699},
 "secondary":null,"credits":{"has_credits":false,"unlimited":false,"balance":null},
 "plan_type":"free","rate_limit_reached_type":null}
```

对照：Desktop 会话为 `plan_type:"plus"`，`primary.window_minutes:300` + `secondary.window_minutes:10080`。
两处都读到 `rate_limits`，但档位、窗口长度、`secondary` 是否存在都不同。
（本次 CLI 会话报 `plan_type:"free"` 的原因未确认——CLI 与 Desktop 的账号/额度解析路径可能不同，待查。）

→ Capacity Provider 必须按字段实际内容解析，不能假设存在 `secondary`、不能假设窗口是 300 分钟、不能假设 `plan_type` 固定为 plus。

## 6. 推荐 Source 优先级

```text
1. 目标会话自己的 rollout 文件（~/.codex/sessions/.../rollout-*-<UUID>.jsonl）里的 token_count 事件
   —— 最新鲜且能拿到实时值；`exec --json` 的 stdout 不含 rate_limits（已实测）
2. 该文件里最后一条 token_count（即"最后已知状态"）
3. primary.resets_at 作为下次检查时间基准
fallback：ESTIMATED（基于 window_minutes + 上次 resets_at 推算）
```

## 7. Quota Exhaustion 可识别规则

```text
可以稳定识别：是（8 次真实耗尽，8/8 一致）
唯一可靠条件：
  - rate_limits.limit_id == "premium" AND rate_limits.primary == null   → 已耗尽
  - rate_limits.limit_id == "codex"  AND rate_limits.primary != null    → 正常
（已实测：全库 1864 条 rate_limits 记录只出现过这两种组合——`codex|primary 有值` 1855 条、`premium|primary=null` 9 条，无第三种）

辅助预警：
  - primary.used_percent >= 100（100 只在耗尽前最后一次记录中出现；耗尽后 primary 变 null 就看不到了）

已排除的判据（实测无效）：
  - rate_limit_reached_type 非 null —— 耗尽时依然是 null
  - exit code / --json stdout —— 不含 rate_limits
  - 特定 stderr 字符串 —— 未观察到

误判风险：
  - 记录只在有请求时写入；文件里最后一条是 premium 不代表"现在"仍耗尽（可能已恢复但没用过）
  - 不同 plan_type 的窗口长度不同（已见 300/10080 与 43200），不能按固定窗口推算
  - "premium" 这个枚举值没有官方文档，属实测观察，可能随版本变化
```

## 8. 结论

```text
PASS
```

### 可以作为正式实现依据的事实

- `rate_limits` 字段稳定出现在 Session JSONL 的 `token_count` 事件中，包含 `primary.used_percent`、`primary.window_minutes`、`primary.resets_at`（Unix 秒）、`secondary.*`、`rate_limit_reached_type`。
- `primary.resets_at` 是 ACO 计算下一次 Capacity 检查时间（`next_check_at`）的主要来源；`secondary.resets_at` 用于周级窗口。
- 读目标会话的 rollout 文件即可拿到 rate_limits（`--json` stdout 不含它，已实测）；运行中每个 turn 都会追加。
- window_minutes / secondary / plan_type 会因账号类型变化（已见 plus 与 free 两种结构），Capacity Provider 不应硬编码数值。
- 耗尽判定：`limit_id == "premium"` 且 `primary == null`；恢复判定：`limit_id` 变回 `"codex"`（8 次耗尽 / 4 次恢复实测）。
- 耗尽时 rollout 里不再有 resets_at（primary 变 null），**ACO 必须在耗尽前就记下最后一条非 null 的 primary.resets_at**。
- 实测没有一次恢复早于 resets_at，可作为"最早可能恢复时间"；Desktop UI 显示的重置时间与之一致。

### 不能依赖的假设

- 不能用 `rate_limit_reached_type` 判断耗尽（实测耗尽时仍为 null）。
- 不能假设 CLI exit code 或特定 stderr 字符串可以区分"额度耗尽"和"其他错误"（2026-11-02 实测：exit=1 且 `turn.failed` 只有纯文本）。
- 不能把 rollout 最后一条记录当成"当前状态"：记录只在有请求时写入，最后一条 premium 可能已经过时。
- 不能假设到了 resets_at 就一定立刻可用（未实测），需要探测 + 退避重试。
- "premium" 是实测观察到的值，无官方文档，需在 Provider 中容忍未知 limit_id（视为 UNKNOWN，不静默当成正常）。
- 不能假设本机 session JSONL 格式在所有 CLI 版本下完全一致（TDD §2.2 已注明）。

## 9. 对 TDD 的影响

- CapacityProvider：读目标会话 rollout 里的 rate_limits（实时值随每个 turn 追加）；备用为 `session_index` 定位后取最后一条 token_count。
- 必须容忍结构变化：`secondary` 可能为 null、窗口长度可变、`plan_type` 不固定（已观测到 plus/free 两种）。
- Capacity Confidence：
  - `resets_at` 字段存在且合理 → `EXACT`；
  - 从 session JSONL 读到（非实时）→ `OBSERVED`；
  - 基于 window_minutes 推算 → `ESTIMATED`；
  - 无法读取任何来源 → `UNKNOWN`。
- next_check_at：耗尽前最后一条非 null 的 `primary.resets_at`（Unix 秒）+ 小量缓冲；若周窗口 `secondary.used_percent` 也接近 100，取两者较晚者。
- 到 next_check_at 后用一次真实请求探测，读新写入的 rate_limits：`limit_id == "codex"` → Eligible；仍是 `premium` → 退避重试。
- quota exhaustion 分类：读 rollout 里最新的 `limit_id`，不用 `rate_limit_reached_type`；网络类错误归 `RetryableError`。
- 仍需补测（不阻塞 P0 结论）：
  - CLI 启动时已耗尽的表现已实测（见 §4）；CLI **运行到一半**才耗尽时的 exit code 和 stderr 仍未测；
  - 到达 resets_at 后几分钟内是否立刻可用（resets_at 当天主动发一次请求即可验证）；
  - 周窗口（secondary）耗尽时的结构是否同样是 premium + null。

## 10. 其他发现

- Session JSONL 事件类型 `event_msg/token_count` 中的 `rate_limits` 字段，与 `credits`（`has_credits`, `unlimited`, `balance`）是分离字段；credits 余额为 0 + has_credits=false，说明当前用 plan（plus）额度，不是按量计费。
- `codex exec resume` 成功运行后，每个 agent turn 结束都会产生 `token_count` 事件——ACO 可在任务运行期间实时监控 Capacity，在 used_percent 接近上限时预判下次中断时机。
- Desktop 的 `codex-dev.db.automations` 表无任何 Capacity/quota 字段，其**调度器**不具备 Capacity-aware 能力（已在 P0-00 §7 记录）。
  注意区分：额度**数据**本身是可得的（本文档主体讲的就是怎么拿），缺的是基于它做**调度判断**的能力。
