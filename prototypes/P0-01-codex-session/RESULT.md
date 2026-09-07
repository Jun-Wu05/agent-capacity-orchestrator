# P0-01 Codex Session Discovery 验证结果

- 对应 Issue：#1
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

## 7. 关键脱敏片段

只贴与字段结构相关的最小 JSON/JSONL 片段；不要提交完整 Session 内容或凭证。

```json
{}
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

- Session Discovery：
- Repo 绑定算法：
- Task Snapshot schema：
- Runtime capture：
- 需要新增的 fallback：

## 10. 其他发现

- 
