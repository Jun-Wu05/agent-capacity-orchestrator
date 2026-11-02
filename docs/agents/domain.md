# Domain Docs

说明各工程类 skills 在探索本仓库时应如何使用领域文档。

本仓库的领域词汇表是根目录的 **`CONTEXT.md`**（相当于 skills 默认约定中的 `GLOSSARY.md`）。

## 探索前先读

- 根目录 **`CONTEXT.md`**：稳定的领域术语与 MVP 边界。
- **`docs/adr/`**：阅读与你即将处理的领域相关的 ADR。

如果其中某个文件不存在，**静默继续**。不要指出它们缺失，也不要预先建议创建。`/domain-modeling` skill（通过 `/grill-with-docs` 和 `/improve-codebase-architecture` 进入）会在术语或决策真正定案时按需创建。

## 文件结构

single-context 仓库：

```
/
├── CONTEXT.md                 ← 领域词汇表
├── AGENTS.md
├── docs/
│   ├── adr/
│   │   ├── 0001-task-first-session-optional.md
│   │   └── 0002-checkpoint-worktree-isolation.md
│   ├── prd/PRD-V0.1.md
│   ├── mvp/MVP-SPEC.md
│   └── tdd/TDD-V0.1.md
└── prototypes/                ← 外部技术事实验证（各 RESULT.md）
```

## 使用词汇表中的术语

当你的输出中出现领域概念（issue 标题、重构提议、假设、测试名）时，使用 `CONTEXT.md` 中定义的术语，不要换成词汇表明确避免的同义词。

如果你需要的概念还不在词汇表里，这是一个信号：要么你在发明项目不使用的语言（请重新考虑），要么确实存在空缺（记下来交给 `/domain-modeling`）。

## 标出 ADR 冲突

如果你的输出与已有 ADR 矛盾，要显式指出，不要静默覆盖：

> _与 ADR-0002（checkpoint + worktree 隔离）矛盾，但值得重新讨论，因为……_

文档之间冲突时，已接受的 ADR 优先于 PRD / MVP-SPEC / TDD（见 `docs/prd/PRD-V0.1.md` 第 24 节）；术语变化应先更新 `CONTEXT.md`。
