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
Continue the exact prior Agent conversation/session using that platform's own session identity or resume primitive. Resume Session is preferred when reliable, but task durability must not depend on session durability.

### Task snapshot
A durable checkpoint owned by the orchestrator that records enough state to continue an Agent-bound task even if native session resume is unavailable or fails. It may reference the agent session, project/worktree, objective, git state, progress/checkpoint metadata, execution policy, model/runtime settings, and last known capacity state. The exact fields are still under design.

### Capacity
The observed or inferred ability of an Agent to execute work under platform limits such as rolling usage windows, quota reset times, or peak/off-peak rules.

### Eligibility
Whether a specific Agent-bound task is allowed to run now, based on the selected Agent's capacity state and the task's configured scheduling policy.

### Capacity confidence
How trustworthy a capacity observation is: `EXACT`, `OBSERVED`, `ESTIMATED`, or `UNKNOWN`.

### Task isolation
Executing a task in an isolated working context so unattended work cannot collide with the user's active checkout. The exact isolation mechanism is still under design.

### Start policy
The rule that decides whether an eligible task starts automatically or waits for user action. Candidate modes are `AUTO`, `MANUAL`, and later `ASK` through a notification/control channel.

## MVP boundaries already decided

- Same-agent continuation only.
- No automatic Codex ↔ ZCODE task handoff.
- First executable slice may be Codex-only.
- MVP intake starts with explicit handoff after quota exhaustion (`resume-later` style); automatic detection is a later step.
- Prefer native Resume Session when reliable, with Resume Task as the durable fallback.
- Windows-first.
- Task isolation is required from the first version.
- Capacity confidence is modeled from the first version.
- No AI scoring for agent selection.
- Unattended execution may modify files, run tests, and create a local commit; remote push/merge are not MVP defaults.
- Start policy governs behavior after reset, including when the machine was offline at the nominal reset time.

## Open design questions

- Exact Codex session discovery and capture mechanism.
- Exact Task snapshot schema and checkpoint semantics.
- Whether isolation starts before the Agent task begins or can safely migrate an already-modified checkout after quota exhaustion.
- Permission boundary for unattended file/system access.
- Exact `AUTO` versus `MANUAL` default.
- CLI/daemon lifecycle and installation/distribution model.
- Notification/control channels such as Feishu or WeChat.
- Exact task isolation mechanism on Windows.
- How model, reasoning, sandbox, approval, and other runtime settings are captured and restored across resume.
