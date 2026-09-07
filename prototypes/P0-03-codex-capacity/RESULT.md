# P0-03 Codex Capacity / Quota Exhaustion 验证结果

- 对应 Issue：#3
- 结果：`TODO`（填写 `PASS` / `PARTIAL` / `FAIL`）

## 1. 环境

```text
Windows 版本：
Codex CLI 版本：
Node.js 版本：
Git 版本：
PowerShell 版本：
实验时间：
```

## 2. 正常运行状态

```text
命令：
退出码：
stdout 特征：
stderr 特征：
Session 新增事件：
rate_limits/usage 字段：
reset timestamp：
```

## 3. 接近额度限制状态

```text
命令/场景：
退出码：
stdout 特征：
stderr 特征：
Session 新增事件：
rate_limits/usage 字段：
reset timestamp：
```

## 4. Quota Exhausted 状态

```text
是否真实额度耗尽：是 / 否（模拟）
命令/场景：
退出码：
stdout 特征：
stderr 特征：
Session 新增事件：
rate_limits/usage 字段：
reset timestamp：
```

## 5. Capacity 来源对比

| 来源 | 是否可用 | 是否结构化 | 是否包含 reset | 稳定性观察 | 建议 Confidence |
|---|---|---|---|---|---|
| CLI/status | | | | | |
| Session JSONL | | | | | |
| stdout/stderr | | | | | |
| exit code | | | | | |
| 其他 | | | | | |

## 6. 推荐 Source 优先级

```text
1.
2.
3.
fallback：
```

## 7. Quota Exhaustion 可识别规则

```text
可以稳定识别：是 / 否
建议识别条件：
误判风险：
```

## 8. 结论

```text
PASS / PARTIAL / FAIL
```

### 可以作为正式实现依据的事实

- 
- 

### 不能依赖的假设

- 
- 

## 9. 对 TDD 的影响

- CapacityProvider：
- Capacity Confidence：
- next_check_at：
- quota exhaustion 分类：
- 真实额度耗尽仍需补测：是 / 否

## 10. 其他发现

- 
