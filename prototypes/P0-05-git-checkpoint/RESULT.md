# P0-05 Git Checkpoint / Worktree 无损迁移验证结果

- 对应 Issue：#5
- 结果：`TODO`（填写 `PASS` / `PARTIAL` / `FAIL`）

## 1. 环境

```text
Windows 版本：
Git 版本：
PowerShell 版本：
实验时间：
测试仓库：
```

> 只在专门测试仓库执行，不要使用重要工作仓库。

## 2. 初始 Git 状态构造

请确认以下场景均已构造：

- [ ] staged 文件
- [ ] unstaged 文件
- [ ] 同一文件同时有 staged + unstaged 修改
- [ ] untracked 文件
- [ ] 删除文件
- [ ] rename
- [ ] ignored 文件

原始 HEAD：

```text

```

原始 `git status --porcelain=v2`：

```text

```

## 3. 迁移前文件清单与 Hash

请至少对需要恢复的 tracked + untracked 文件记录 hash。

| 文件 | 状态 | 迁移前 hash | 备注 |
|---|---|---|---|
| | | | |

ignored 文件：

```text
文件：
是否应该迁移：否
```

## 4. Checkpoint 操作

实际执行的命令/脚本：

```powershell

```

结果：

```text
checkpoint branch：
checkpoint commit：
原 repo HEAD 是否被不可逆改变：
失败/警告：
```

## 5. Isolated Worktree

```text
worktree path：
worktree branch：
worktree HEAD：
```

创建命令/脚本：

```powershell

```

## 6. 迁移后文件清单与 Hash

| 文件 | 迁移后 hash | 与迁移前一致 | 备注 |
|---|---|---|---|
| | | | |

ignored 文件是否被复制：

```text
是 / 否
```

预期：`否`。

## 7. 原 Repo 复核

```text
原 repo git status：
原 repo 用户文件是否被覆盖：
是否出现无法解释的修改：
```

## 8. 特殊场景结果

### staged + unstaged 同一文件

```text
文件内容是否无损：
视觉上的 staged/unstaged 区别是否保留：
备注：V0.1 只要求内容无损。
```

### rename

```text
结果：
```

### 删除文件

```text
结果：
```

### untracked

```text
结果：
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

- checkpoint 算法：
- untracked 处理：
- ignored 处理：
- worktree 创建：
- finalize/squash：
- 异常恢复：

## 11. 其他发现

- 
