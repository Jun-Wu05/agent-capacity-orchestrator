# P0-01 Codex Session Discovery 验证结果

- 对应 Issue：#1
- 结果：`TODO`（填写 `PASS` / `PARTIAL` / `FAIL`）

## 1. 环境

```text
Windows 版本：Windows 11
Windows Build：10.0.26100.8875
Codex CLI 版本：待安装
Codex Desktop：已安装
Node.js 版本：v24.11.1
Git 版本：2.52.0.windows.1
PowerShell 版本：10.0.26100.8875
实验时间：
```

## 2. 测试仓库

```text
Repo A：
Repo B：
```

> 可以写脱敏后的绝对路径，例如 `C:\Users\<user>\Desktop\aco-test-a`。

## 3. Session 文件位置

实际观察到的 Codex Session 根目录：

```text

```

新建 Repo A Session 后新增/更新的文件：

```text

```

新建 Repo B Session 后新增/更新的文件：

```text

```

## 4. Session UUID

Repo A：

```text
UUID：
UUID 来源字段/文件：
```

Repo B：

```text
UUID：
UUID 来源字段/文件：
```

## 5. 字段观察

| 信息 | 是否存在 | 字段/来源 | 示例（脱敏） | 可信度 |
|---|---|---|---|---|
| Session UUID | | | | |
| cwd | | | | |
| Git repo path | | | | |
| model | | | | |
| reasoning | | | | |
| sandbox | | | | |
| approval | | | | |
| created_at | | | | |
| updated_at | | | | |

## 6. Repo → Session 绑定实验

请同时存在 Repo A / Repo B 两个 Session 后验证。

### 尝试的绑定规则

```text
例如：session.cwd == git rev-parse --show-toplevel
```

### 结果

```text
是否可以确定性关联：是 / 否
是否需要依赖最近修改时间：是 / 否
是否出现歧义：是 / 否
```

如有歧义，描述场景：

```text

```

## 7. Codex Desktop ↔ CLI Session 互操作实验（P0-01A）

目的：验证用户在 Codex Desktop 中创建的真实任务，是否可以被 ACO 后台通过 Codex CLI 精确发现并恢复。

### 7.1 Desktop 创建 Session

```text
Desktop 打开的测试 repo：
Desktop Session 创建时间：
Desktop 中执行的可识别小任务：
Desktop Session 是否能在本地 Session store 中找到：是 / 否 / 不确定
对应 UUID（如可获得）：
```

### 7.2 CLI 是否能发现 Desktop Session

安装 Codex CLI 后填写：

```text
CLI 是否能发现该 Desktop Session：是 / 否 / 不确定
是否能确定它和 Desktop Session 是同一个 Session：
判断依据：UUID / cwd / conversation / 其他
```

### 7.3 CLI 是否能 Resume Desktop Session

尝试：

```powershell
codex resume <Desktop-Session-UUID>
```

记录：

```text
命令是否成功：
是否恢复原聊天上下文：
cwd 是否仍是原 repo：
Desktop 已完成的文件修改是否被正确识别：
model/runtime 是否一致：
错误信息（如有）：
```

### 7.4 互操作结论

```text
Desktop → CLI Session 可发现：PASS / PARTIAL / FAIL
Desktop → CLI UUID resume：PASS / PARTIAL / FAIL
是否足以支持“Desktop 作为任务来源、CLI 作为后台恢复通道”：是 / 否 / 需要更多验证
```

## 8. 关键脱敏片段

只贴与字段结构相关的最小 JSON/JSONL 片段；不要提交完整 Session 内容或凭证。

```json
{}
```

## 9. 结论

```text
PASS / PARTIAL / FAIL
```

### 可以作为正式实现依据的事实

- 
- 

### 不能依赖的假设

- 
- 

## 10. 对 TDD 的影响

- Session Discovery：
- Repo 绑定算法：
- Task Snapshot schema：
- Runtime capture：
- Desktop 是否纳入 V0.1 任务来源：
- 需要新增的 fallback：

## 11. 其他发现

- 
