# Prototype 验证指南

本目录用于验证 `docs/tdd/TDD-V0.1.md` 第 27 节中的外部技术事实。

这些 Prototype 的目标是**验证事实，不是实现正式产品**。不要把实验代码直接放进 `src/`，也不要因为某次实验观察到一个字段，就把它当成长期稳定协议。

## 执行顺序

建议依次执行：

1. `P0-01-codex-session`：Codex Session Discovery 与项目绑定
2. `P0-02-codex-resume`：Resume Session 与 Runtime 恢复
3. `P0-03-codex-capacity`：Capacity / Quota Exhaustion 信号
4. `P0-04-windows-integration`：Windows 本地通知与 daemon 启动
5. `P0-05-git-checkpoint`：Git checkpoint / worktree 无损迁移

P0-01 与 P0-02 应最先完成，因为它们会直接影响 Codex Adapter 和 Task Snapshot schema。

## 结果提交方式

每个实验目录都有一个 `RESULT.md`。

请：

1. 在 Windows 本机执行实验；
2. 将实际命令、关键输出和结论填入对应 `RESULT.md`；
3. 删除或打码 token、邮箱、私有仓库路径中的敏感信息；
4. 不要提交 Codex 登录凭证、API Key、cookie 或完整私密 Session 内容；
5. 提交到 GitHub；
6. 告诉 ChatGPT “P0-01 已提交”即可，ChatGPT 将直接读取结果并修订 TDD。

## 结果等级

每个 Prototype 最终选择：

- `PASS`：得到稳定、可用于正式设计的结论；
- `PARTIAL`：部分行为明确，但仍存在版本/环境不确定性；
- `FAIL`：原设计假设不可行，需要调整 TDD。

## 环境信息

每次实验至少记录：

```text
Windows 版本：
Codex CLI 版本：
Node.js 版本：
Git 版本：
PowerShell 版本：
实验时间：
```

## 安全要求

- Prototype 只在专门测试 Git 仓库执行会修改文件/Git 历史的实验。
- P0-05 不要直接拿重要工作仓库测试。
- 不提交 `%USERPROFILE%\.codex` 下的完整原始 Session 文件；只摘录与字段结构/行为验证相关且已脱敏的片段。
- 如果不确定某段日志是否含敏感信息，先不要提交原文，只记录字段名、类型和脱敏值。

## GitHub Tickets

- #1 P0-01 Codex Session Discovery
- #2 P0-02 Codex Resume / Runtime
- #3 P0-03 Codex Capacity / Quota
- #4 P0-04 Windows Integration
- #5 P0-05 Git Checkpoint / Worktree
