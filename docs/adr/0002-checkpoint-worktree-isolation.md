# ADR 0002：使用本地 Checkpoint Commit + Isolated Worktree 作为 MVP 任务隔离机制

- 状态：已接受
- 日期：2026-09-07

## 背景

MVP 的真实场景允许用户在 Codex 中先工作一段时间，额度耗尽后才执行 `aco resume-later`。此时当前 Git 工作区可能包含 staged、unstaged、untracked 修改。

后台无人值守恢复如果直接在用户当前 checkout 中继续，容易与用户之后的手工开发产生冲突，也扩大了无人值守修改的风险范围。

## 决策

MVP 只支持 Git 仓库，并采用以下隔离方向：

1. 中途接管时，系统先捕获当前 Git 状态。
2. 通过本地临时 checkpoint commit 固化可恢复状态。
3. 创建 isolated worktree 作为后台恢复执行环境。
4. 后续无人值守修改、测试和本地提交均发生在该 worktree 中。
5. 运行过程中允许存在内部 checkpoint commits。
6. 任务最终成功时，将内部 checkpoint 整理为一个正常的最终提交。
7. 默认不复制 `.gitignore` 命中的文件；后续通过显式 allowlist 支持必要 ignored 资源。

## 影响

### 正面

- 降低后台任务与用户当前 checkout 冲突的概率。
- checkpoint commit 提供稳定的 Git 恢复锚点。
- worktree 便于清理、审查、测试和后续并行任务扩展。

### 代价

- 需要谨慎处理 staged、unstaged、untracked 状态。
- 需要设计 checkpoint squash、异常清理和 worktree 生命周期。
- ignored 文件需要独立安全策略，不能直接全量复制。
