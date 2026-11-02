# P0-05 Git Checkpoint / Worktree 无损迁移验证结果

- 对应 Issue：#5
- 结果：`PASS`（不碰用户 HEAD / index / 工作区即可完成 checkpoint；所有状态在 git 视角无损迁移）

## 1. 环境

```text
Windows 版本：11
Windows Build：10.0.26200.0
Git 版本：2.52.0.windows.1
PowerShell 版本：7.6.6
core.autocrlf：true（本机全局生效值）
实验时间：2026/10/23
测试仓库：<工作区>\_aco-sandbox\git-checkpoint\repo（脚本自动新建，一次性）
```

脚本：

- `run-checkpoint-test.ps1`：主实验，构造全部脏状态后做 checkpoint + worktree，并逐项复核。
- `run-autocrlf-realworld-test.ps1`：用 git 自己检出的文件验证换行行为（排除测试构造假象）。
- `run-autocrlf-diff-test.ps1`：比较两种入库方式对"最终提交 diff"的影响。

## 2. 初始 Git 状态构造

- [x] staged 文件（a.txt）
- [x] unstaged 文件（b.txt）
- [x] 同一文件同时有 staged + unstaged 修改（c.txt）
- [x] untracked 文件（含子目录、CRLF、中文文件名、二进制）
- [x] 删除文件（staged 删除 d.txt、unstaged 删除 f.txt）
- [x] rename（e.txt → e2.txt）
- [x] ignored 文件（secret.env、build/）
- [x] 空目录（git 不跟踪）

原始 `git status --porcelain=v2`（摘要）：

```text
1 M.  a.txt
1 .M  b.txt
1 MM  c.txt
1 D.  d.txt
2 R.  e2.txt <- e.txt
1 .D  f.txt
? bin.dat / new.txt / sub/deep/x.txt / untracked-crlf.txt / 新文件.md
```

## 3. Checkpoint 算法（实测可行）

核心：用临时 index（`GIT_INDEX_FILE`），完全不碰用户的 HEAD、`.git/index`、工作区。

```powershell
Copy-Item .git\index $tmpIdx
$env:GIT_INDEX_FILE = $tmpIdx
$stagedTree = git write-tree          # 用户 staged 的状态
git add -A                            # 只写临时 index；遵守 .gitignore
$fullTree   = git write-tree          # 工作区全部内容（含 untracked）
Remove-Item Env:GIT_INDEX_FILE; Remove-Item $tmpIdx
$idxCommit = git commit-tree $stagedTree -p HEAD -m 'aco: staged state'
$cp        = git commit-tree $fullTree  -p HEAD -p $idxCommit -m 'aco: checkpoint'
git update-ref refs/aco/checkpoints/<task-id> $cp
git worktree add -b aco/<task-id> <worktree-path> $cp
```

结构与 `git stash` 类似（两个父提交：原 HEAD + staged 提交），但不改用户的 stash 列表。
耗时约 2–4 秒（小仓库）。

## 4. 结果

### 4.1 文件迁移（git 视角内容 = 按用户 autocrlf/.gitattributes 规范化后的 blob id）

| 文件 | 状态 | git 视角内容 | 原始字节 |
|---|---|---|---|
| a.txt / b.txt / c.txt | staged / unstaged / 两者 | 一致 | 换行不同（见 4.4） |
| e2.txt | rename | 一致 | 换行不同 |
| new.txt / sub/deep/x.txt / 新文件.md | untracked | 一致 | 换行不同 |
| untracked-crlf.txt / crlf.txt | CRLF 文件 | 一致 | 相同 |
| bin.dat | 二进制 untracked | 一致 | 相同 |
| d.txt / f.txt / e.txt | 已删除 / 改名前 | worktree 中不存在（正确） | — |
| secret.env / build/out.txt | ignored | 未复制（正确） | — |
| empty-dir | 空目录 | 未复制（git 不跟踪，预期） | — |

### 4.2 原仓库复核：完全未变

```text
HEAD 未变              True
当前分支未变           True
.git/index 字节未变    True
status 未变            True
所有文件内容未变       True
唯一新增：aco/<task-id> 分支（worktree 需要）与 refs/aco/checkpoints/<task-id>
```

### 4.3 staged / unstaged 区别可还原

在第二个 worktree 里执行 `reset --soft <原HEAD>` + `read-tree <staged提交>`，
得到的 status XY 状态与原仓库完全一致。V0.1 不要求，但说明信息没有丢。

### 4.4 换行（autocrlf）：需要按用户配置走，不能"按原始字节"

三组对照实验：

| 实验 | 做法 | 结果 |
|---|---|---|
| 主实验首轮 | 沿用 autocrlf | 原始字节不同 → 一度判 FAIL |
| 真实检出（git 自己检出 + 用户编辑） | 沿用 autocrlf / 原始字节 | 两种都逐字节一致 |
| 最终 diff 对比 | 沿用 autocrlf | diff 只含 2 个真实改动文件 |
| 最终 diff 对比 | 原始字节（`-c core.autocrlf=false` + `--renormalize`） | diff 多出整文件换行噪音，**连未修改的文件都显示改了 20 行** |

结论：

- 首轮"原始字节不同"是测试构造假象：脚本直接往 `autocrlf=true` 仓库写 LF 文件，真实场景里文件是 git 检出的 CRLF。
- **checkpoint 必须沿用用户自己的 autocrlf / .gitattributes**；"按原始字节入库"会污染最终提交，弃用。
- 无损的判定标准应是"git 视角内容一致"（`git hash-object --path`），不是原始字节 SHA256。

## 5. 结论

```text
PASS
```

### 可以作为正式实现依据的事实

- 临时 index（`GIT_INDEX_FILE`）+ `write-tree` + `commit-tree` 可以在不改用户 HEAD / index / 工作区 / stash 的前提下完整固化 staged、unstaged、untracked、删除、rename。
- `git add -A` 自动遵守 .gitignore，ignored 文件天然不迁移，与 ADR-0002 一致。
- 中文文件名、二进制、嵌套目录均无问题（需 `core.quotepath=false` 才能正确显示中文路径）。
- checkpoint 挂在 `refs/aco/checkpoints/<task-id>`，不进分支列表、不被 gc 回收，可作为长期恢复锚点。
- 用两个父提交保存 staged 状态，需要时能还原 staged/unstaged 区分。

### 不能依赖的假设

- 不能用原始字节一致作为验收标准：Windows 上 autocrlf 会让同一内容在不同 worktree 呈现不同换行。
- 不能"关掉换行转换"来追求字节一致：会把整文件换行差异带进最终提交。
- 空目录不会被迁移（git 不跟踪）；若任务依赖空目录，需要另行处理。
- 未测：子模块、LFS、超大仓库耗时、符号链接、`.gitattributes` 里的 filter（如 LFS clean/smudge）。

## 6. 对 TDD 的影响

- checkpoint 算法：采用第 3 节的临时 index 方案；全程不得调用会改用户 index 的命令（`git add`、`git stash` 等）而不设置 `GIT_INDEX_FILE`。
- untracked 处理：临时 index 上 `git add -A`，自动纳入。
- ignored 处理：默认不迁移；allowlist 以后通过显式复制实现。
- 换行：沿用用户的 autocrlf / .gitattributes；验收用 `git hash-object --path` 比对。
- worktree 创建：`git worktree add -b aco/<task-id> <path> <checkpoint>`；路径按 TDD 放 `%LOCALAPPDATA%\AgentCapacityOrchestrator\worktrees\<task-id>`。
- finalize/squash：最终提交以 checkpoint 的 HEAD 父提交为基准 squash，diff 只会含真实改动（4.4 已验证）。
- 异常恢复：checkpoint ref 独立存在，worktree 被删后可用 `git worktree add` 从 ref 重建；残留 worktree 需 `git worktree prune`。

## 7. 其他发现

- 在 DSH 文件沙箱里，PowerShell `& git` 捕获输出会报 `StandardOutputEncoding` / 拒绝访问；改用 `ProcessStartInfo` 并在非沙箱模式下运行解决。与 ACO 本身无关，只影响本实验环境。
- PowerShell 函数若用 `param()` 接收 git 参数，`-p` / `-m` 会被当成 PowerShell 公共参数（`-PipelineVariable` 等）导致歧义；ACO 实现时应用参数数组调用 git，不要用字符串拼接。
