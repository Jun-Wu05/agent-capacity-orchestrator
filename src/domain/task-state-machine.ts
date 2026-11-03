import { InvalidTransitionError } from "./errors.js";
import type { Task } from "./task.js";
import { TaskEvent, TaskState } from "./task-state.js";

/**
 * 迁移策略上限（TDD §5.3 / §14.1）：
 * - 续跑上限默认 3，可配置，超过 → BLOCKED；
 * - 瞬时错误重试独立计数，最多 3，超过 → FAILED。
 */
export interface TransitionPolicy {
  maxContinuations: number;
  maxTransientRetries: number;
}

export const defaultTransitionPolicy: TransitionPolicy = {
  maxContinuations: 3,
  maxTransientRetries: 3,
};

type TransitionHandler = (task: Task, policy: TransitionPolicy) => Task;

function moveTo(state: TaskState): TransitionHandler {
  return (task) => ({ ...task, state });
}

function continueNextRound(task: Task, policy: TransitionPolicy): Task {
  const continuationCount = task.continuationCount + 1;
  if (continuationCount > policy.maxContinuations) {
    // 续跑超上限 → BLOCKED（§5.3；原因码 E_CONTINUATION_EXHAUSTED 由应用层记录）
    return { ...task, state: TaskState.BLOCKED };
  }
  return { ...task, state: TaskState.RUNNING, continuationCount };
}

function retryTransientError(task: Task, policy: TransitionPolicy): Task {
  const transientRetryCount = task.transientRetryCount + 1;
  if (transientRetryCount > policy.maxTransientRetries) {
    // 瞬时重试耗尽 → FAILED（§5.3；原因码 E_RETRY_EXHAUSTED 由应用层记录）
    return { ...task, state: TaskState.FAILED };
  }
  return { ...task, state: TaskState.RUNNING, transientRetryCount };
}

const transitionTable: ReadonlyMap<string, TransitionHandler> = new Map([
  // CAPTURING
  [key(TaskState.CAPTURING, TaskEvent.CAPTURE_SUCCEEDED), moveTo(TaskState.WAITING_CAPACITY)],
  [key(TaskState.CAPTURING, TaskEvent.CAPTURE_FAILED), moveTo(TaskState.BLOCKED)],
  // WAITING_CAPACITY
  [key(TaskState.WAITING_CAPACITY, TaskEvent.CAPACITY_ELIGIBLE), moveTo(TaskState.READY)],
  [key(TaskState.WAITING_CAPACITY, TaskEvent.CANCEL_REQUESTED), moveTo(TaskState.CANCELLED)],
  [key(TaskState.WAITING_CAPACITY, TaskEvent.FATAL_ERROR), moveTo(TaskState.BLOCKED)],
  // READY
  [key(TaskState.READY, TaskEvent.START_AUTO), moveTo(TaskState.PREFLIGHT)],
  [key(TaskState.READY, TaskEvent.START_MANUAL), moveTo(TaskState.READY)],
  // PREFLIGHT
  [key(TaskState.PREFLIGHT, TaskEvent.PREFLIGHT_PASSED), moveTo(TaskState.RESUMING_SESSION)],
  [key(TaskState.PREFLIGHT, TaskEvent.PREFLIGHT_FAILED), moveTo(TaskState.BLOCKED)],
  // RESUMING_SESSION
  [key(TaskState.RESUMING_SESSION, TaskEvent.SESSION_RESUMED), moveTo(TaskState.RUNNING)],
  [key(TaskState.RESUMING_SESSION, TaskEvent.SESSION_LOCKED), moveTo(TaskState.WAITING_SESSION)],
  [
    key(TaskState.RESUMING_SESSION, TaskEvent.SESSION_NOT_FOUND_WITH_SNAPSHOT),
    moveTo(TaskState.RESUMING_TASK),
  ],
  [
    key(TaskState.RESUMING_SESSION, TaskEvent.SESSION_NOT_FOUND_WITHOUT_SNAPSHOT),
    moveTo(TaskState.BLOCKED),
  ],
  [key(TaskState.RESUMING_SESSION, TaskEvent.QUOTA_EXHAUSTED), moveTo(TaskState.WAITING_CAPACITY)],
  [key(TaskState.RESUMING_SESSION, TaskEvent.UNSAFE_RESUME), moveTo(TaskState.BLOCKED)],
  // WAITING_SESSION（ADR 0003：无自动超时迁移）
  [key(TaskState.WAITING_SESSION, TaskEvent.SESSION_RETRY), moveTo(TaskState.PREFLIGHT)],
  [
    key(TaskState.WAITING_SESSION, TaskEvent.USER_RESUME_AS_TASK),
    moveTo(TaskState.RESUMING_TASK),
  ],
  [key(TaskState.WAITING_SESSION, TaskEvent.CANCEL_REQUESTED), moveTo(TaskState.CANCELLED)],
  // RESUMING_TASK
  [key(TaskState.RESUMING_TASK, TaskEvent.TASK_RESUME_SUCCEEDED), moveTo(TaskState.RUNNING)],
  [key(TaskState.RESUMING_TASK, TaskEvent.TASK_RESUME_FAILED), moveTo(TaskState.BLOCKED)],
  // RUNNING（§8.6 每轮结果判定）
  [key(TaskState.RUNNING, TaskEvent.ROUND_DONE), moveTo(TaskState.FINALIZING)],
  [
    key(TaskState.RUNNING, TaskEvent.ROUND_DONE_ESCALATION_DENIED),
    moveTo(TaskState.BLOCKED),
  ],
  [key(TaskState.RUNNING, TaskEvent.AGENT_REPORTED_BLOCKED), moveTo(TaskState.BLOCKED)],
  [key(TaskState.RUNNING, TaskEvent.QUOTA_EXHAUSTED), moveTo(TaskState.WAITING_CAPACITY)],
  [key(TaskState.RUNNING, TaskEvent.FATAL_ERROR), moveTo(TaskState.BLOCKED)],
  [key(TaskState.RUNNING, TaskEvent.CONTINUE_NEXT_ROUND), continueNextRound],
  [key(TaskState.RUNNING, TaskEvent.TRANSIENT_ERROR), retryTransientError],
  // FINALIZING
  [key(TaskState.FINALIZING, TaskEvent.FINALIZE_SUCCEEDED), moveTo(TaskState.COMPLETED)],
  [key(TaskState.FINALIZING, TaskEvent.FINALIZE_FAILED), moveTo(TaskState.BLOCKED)],
  // TESTING 的迁移在 V0.1 全部禁用（§5.3 注记），刻意不注册。
]);

function key(state: TaskState, event: TaskEvent): string {
  return `${state}:${event}`;
}

/**
 * 统一状态迁移入口（TDD §5.3）：所有 Task 状态变化必须经此完成，
 * 业务代码不得直接修改 `state`。
 *
 * 纯函数语义：返回新的 Task，不修改入参，不触碰时间戳（`updatedAt`
 * 由应用层在持久化时更新），不产生副作用，不依赖时钟与平台。
 */
export class TaskStateMachine {
  constructor(
    private readonly policy: TransitionPolicy = defaultTransitionPolicy,
  ) {}

  transition(task: Task, event: TaskEvent): Task {
    const handler = transitionTable.get(key(task.state, event));
    if (handler === undefined) {
      throw new InvalidTransitionError(task.state, event);
    }
    return handler(task, this.policy);
  }

  canTransition(task: Task, event: TaskEvent): boolean {
    return transitionTable.has(key(task.state, event));
  }
}
