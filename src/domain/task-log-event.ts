/**
 * Task 事件日志的事件类型（TDD §6.4 触发点清单 + #15 补充的 WAITING_SESSION 进/出）。
 *
 * 与状态机迁移事件（task-state.ts 的 TaskEvent）是两个命名空间：
 * TaskEvent 是状态机的触发条件，TaskLogEventType 是 task_events.event_type 的取值域。
 * 事件 payload 结构化（JSON），可离线重放（task-service.ts 的 replay）。
 */
export const TASK_LOG_EVENTS = [
  // §6.4 触发点
  "TASK_CAPTURED",
  "CHECKPOINT_CREATED",
  "WORKTREE_CREATED",
  "CAPACITY_OBSERVED",
  "PREFLIGHT_STARTED",
  "SESSION_RESUMED",
  "TASK_FALLBACK_STARTED",
  "RUN_STARTED",
  "QUOTA_INTERRUPTED",
  "TEST_COMPLETED",
  "FINAL_COMMIT_CREATED",
  "TASK_COMPLETED",
  "TASK_BLOCKED",
  "TASK_FAILED",
  // #15 补充：WAITING_SESSION 进入 / 退出
  "SESSION_WAIT_ENTERED",
  "SESSION_WAIT_EXITED",
] as const;

export type TaskLogEventType = (typeof TASK_LOG_EVENTS)[number];

export function isTaskLogEventType(value: unknown): value is TaskLogEventType {
  return typeof value === "string" && (TASK_LOG_EVENTS as readonly string[]).includes(value);
}
