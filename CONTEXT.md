# Domain Context

This file captures stable domain language only. It is intentionally not a PRD or implementation plan.

## Core terms

### Agent
A coding platform/runtime chosen by the user for a task, such as Codex or ZCODE.

### Agent-bound task
A durable unit of work assigned to one specific Agent. In the MVP, the task stays bound to that Agent for its entire lifecycle. Cross-agent handoff is out of scope.

### Resume Task
Continue an Agent-bound task from durable task/workspace state after the Agent becomes eligible to run again. Resume Task does not require preserving a live terminal process.

### Resume Session
Continue the exact prior Agent conversation/session using that platform's own session identity or resume primitive. Resume Session may be used as an implementation optimization when supported, but it is not the MVP's core abstraction.

### Capacity
The observed or inferred ability of an Agent to execute work under platform limits such as rolling usage windows, quota reset times, or peak/off-peak rules.

### Eligibility
Whether a specific Agent-bound task is allowed to run now, based on the selected Agent's capacity state and the task's configured scheduling policy.

### Capacity confidence
How trustworthy a capacity observation is: `EXACT`, `OBSERVED`, `ESTIMATED`, or `UNKNOWN`.

### Task isolation
Executing a task in an isolated working context so unattended work cannot collide with the user's active checkout. The exact isolation mechanism is still under design.

## MVP boundaries already decided

- Same-agent continuation only.
- No automatic Codex ↔ ZCODE task handoff.
- Windows-first.
- Task isolation is required from the first version.
- Capacity confidence is modeled from the first version.
- No AI scoring for agent selection.
- Unattended execution may modify files, run tests, and create a local commit; remote push/merge are not MVP defaults.

## Open design questions

- Whether Codex-only is the first executable slice or Codex + ZCODE ship together.
- Exact meaning and mechanics of Resume Task per Agent.
- Whether platform-native Resume Session should be preferred when available.
- The permission boundary for unattended file/system access.
- CLI/daemon lifecycle and installation model.
- Notification/control channels such as Feishu or WeChat.
- Exact task isolation mechanism on Windows.
