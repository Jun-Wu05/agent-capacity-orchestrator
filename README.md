# Agent Capacity Orchestrator

A Windows-first local scheduler for resuming coding-agent work when the selected agent becomes eligible to run again.

> Status: pre-PRD / design grilling in progress.

## MVP direction

The MVP is intentionally **not** a cross-agent router.

A user selects an agent and one of that agent's projects/tasks (for example Codex, later ZCODE). The scheduler observes that agent's capacity/eligibility state and resumes work with the **same agent** when the configured condition is satisfied.

Initial principles:

- Same-agent resume first; no Codex → ZCODE or ZCODE → Codex handoff in MVP.
- Resume a durable task/work item, not merely rely on one live terminal process.
- Windows-first, with cross-platform domain boundaries where practical.
- CLI + local daemon first; MCP, notifications, and dashboard can be added later.
- Task isolation from the first version.
- Capacity confidence is part of the domain model.
- No AI scoring/routing in MVP.

The exact MVP contract is being defined through a `grill-with-docs` design session before a PRD is written.
