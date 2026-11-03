import { describe, expect, it } from "vitest";

import type { Task } from "../../src/domain/task.js";
import { InvalidTransitionError } from "../../src/domain/errors.js";
import { TaskStateMachine } from "../../src/domain/task-state-machine.js";
import { TaskEvent, TaskState } from "../../src/domain/task-state.js";

const S = TaskState;
const E = TaskEvent;

function taskIn(state: TaskState, overrides: Partial<Task> = {}): Task {
  return {
    id: "task_test",
    agent: "codex",
    state,
    projectRoot: "/repo",
    snapshotVersion: 1,
    startPolicy: "AUTO",
    continuationCount: 0,
    transientRetryCount: 0,
    createdAt: "2026-11-03T00:00:00.000Z",
    updatedAt: "2026-11-03T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * 期望值来源：TDD-V0.1 §5.3 状态迁移规则（逐一誊抄，不与实现共享推导）。
 * TESTING 的三条迁移按票面 #10 要求在 V0.1 禁用，故不在此表中。
 * RUNNING 的 CONTINUE_NEXT_ROUND / TRANSIENT_ERROR 依赖计数策略，另行单测。
 */
const legalTransitions: ReadonlyArray<{
  from: TaskState;
  event: TaskEvent;
  to: TaskState;
}> = [
  // CAPTURING
  { from: S.CAPTURING, event: E.CAPTURE_SUCCEEDED, to: S.WAITING_CAPACITY },
  { from: S.CAPTURING, event: E.CAPTURE_FAILED, to: S.BLOCKED },
  // WAITING_CAPACITY
  { from: S.WAITING_CAPACITY, event: E.CAPACITY_ELIGIBLE, to: S.READY },
  { from: S.WAITING_CAPACITY, event: E.CANCEL_REQUESTED, to: S.CANCELLED },
  { from: S.WAITING_CAPACITY, event: E.FATAL_ERROR, to: S.BLOCKED },
  // READY
  { from: S.READY, event: E.START_AUTO, to: S.PREFLIGHT },
  { from: S.READY, event: E.START_MANUAL, to: S.READY },
  // PREFLIGHT
  { from: S.PREFLIGHT, event: E.PREFLIGHT_PASSED, to: S.RESUMING_SESSION },
  { from: S.PREFLIGHT, event: E.PREFLIGHT_FAILED, to: S.BLOCKED },
  // RESUMING_SESSION：成功边 + 四条失败边（locked / not found 有无 Snapshot / quota / unsafe）
  { from: S.RESUMING_SESSION, event: E.SESSION_RESUMED, to: S.RUNNING },
  { from: S.RESUMING_SESSION, event: E.SESSION_LOCKED, to: S.WAITING_SESSION },
  { from: S.RESUMING_SESSION, event: E.SESSION_NOT_FOUND_WITH_SNAPSHOT, to: S.RESUMING_TASK },
  { from: S.RESUMING_SESSION, event: E.SESSION_NOT_FOUND_WITHOUT_SNAPSHOT, to: S.BLOCKED },
  { from: S.RESUMING_SESSION, event: E.QUOTA_EXHAUSTED, to: S.WAITING_CAPACITY },
  { from: S.RESUMING_SESSION, event: E.UNSAFE_RESUME, to: S.BLOCKED },
  // WAITING_SESSION（ADR 0003：会话被 Desktop 占用）
  { from: S.WAITING_SESSION, event: E.SESSION_RETRY, to: S.PREFLIGHT },
  { from: S.WAITING_SESSION, event: E.USER_RESUME_AS_TASK, to: S.RESUMING_TASK },
  { from: S.WAITING_SESSION, event: E.CANCEL_REQUESTED, to: S.CANCELLED },
  // RESUMING_TASK
  { from: S.RESUMING_TASK, event: E.TASK_RESUME_SUCCEEDED, to: S.RUNNING },
  { from: S.RESUMING_TASK, event: E.TASK_RESUME_FAILED, to: S.BLOCKED },
  // RUNNING（§8.6 每轮结果判定）
  { from: S.RUNNING, event: E.ROUND_DONE, to: S.FINALIZING },
  { from: S.RUNNING, event: E.ROUND_DONE_ESCALATION_DENIED, to: S.BLOCKED },
  { from: S.RUNNING, event: E.AGENT_REPORTED_BLOCKED, to: S.BLOCKED },
  { from: S.RUNNING, event: E.QUOTA_EXHAUSTED, to: S.WAITING_CAPACITY },
  { from: S.RUNNING, event: E.FATAL_ERROR, to: S.BLOCKED },
  // FINALIZING
  { from: S.FINALIZING, event: E.FINALIZE_SUCCEEDED, to: S.COMPLETED },
  { from: S.FINALIZING, event: E.FINALIZE_FAILED, to: S.BLOCKED },
];

describe("TaskStateMachine：TDD §5.3 合法迁移", () => {
  const machine = new TaskStateMachine();

  it.each(legalTransitions)(
    "$from + $event → $to",
    ({ from, event, to }) => {
      const next = machine.transition(taskIn(from), event);
      expect(next.state).toBe(to);
    },
  );

  it("迁移返回新对象，原 Task 不可变", () => {
    const before = taskIn(S.READY);
    const after = machine.transition(before, E.START_AUTO);
    expect(after).not.toBe(before);
    expect(before.state).toBe(S.READY);
  });
});

describe("TaskStateMachine：WAITING_SESSION 出边封闭（无自动超时）", () => {
  const machine = new TaskStateMachine();

  it("仅接受 SESSION_RETRY / USER_RESUME_AS_TASK / CANCEL_REQUESTED，其余事件全部拒绝", () => {
    const allowed = new Set([E.SESSION_RETRY, E.USER_RESUME_AS_TASK, E.CANCEL_REQUESTED]);
    for (const event of Object.values(TaskEvent)) {
      if (allowed.has(event)) continue;
      expect(() => machine.transition(taskIn(S.WAITING_SESSION), event)).toThrow(
        InvalidTransitionError,
      );
    }
  });
});

describe("TaskStateMachine：RUNNING 续跑与瞬时重试独立计数", () => {
  it("CONTINUE_NEXT_ROUND 递增 continuationCount 并保持 RUNNING", () => {
    const machine = new TaskStateMachine();
    const next = machine.transition(taskIn(S.RUNNING), E.CONTINUE_NEXT_ROUND);
    expect(next.state).toBe(S.RUNNING);
    expect(next.continuationCount).toBe(1);
    expect(next.transientRetryCount).toBe(0);
  });

  it("续跑超过默认上限 3 → BLOCKED", () => {
    const machine = new TaskStateMachine();
    let task = taskIn(S.RUNNING);
    for (let i = 0; i < 3; i++) {
      task = machine.transition(task, E.CONTINUE_NEXT_ROUND);
      expect(task.state).toBe(S.RUNNING);
    }
    const exceeded = machine.transition(task, E.CONTINUE_NEXT_ROUND);
    expect(exceeded.state).toBe(S.BLOCKED);
  });

  it("TRANSIENT_ERROR 递增 transientRetryCount 并保持 RUNNING，与续跑计数互不影响", () => {
    const machine = new TaskStateMachine();
    const next = machine.transition(taskIn(S.RUNNING), E.TRANSIENT_ERROR);
    expect(next.state).toBe(S.RUNNING);
    expect(next.transientRetryCount).toBe(1);
    expect(next.continuationCount).toBe(0);
  });

  it("瞬时重试超过默认上限 3 → FAILED", () => {
    const machine = new TaskStateMachine();
    let task = taskIn(S.RUNNING);
    for (let i = 0; i < 3; i++) {
      task = machine.transition(task, E.TRANSIENT_ERROR);
      expect(task.state).toBe(S.RUNNING);
    }
    const exceeded = machine.transition(task, E.TRANSIENT_ERROR);
    expect(exceeded.state).toBe(S.FAILED);
  });

  it("上限可配置：maxContinuations=1 时第二次续跑即 BLOCKED", () => {
    const machine = new TaskStateMachine({ maxContinuations: 1, maxTransientRetries: 3 });
    let task = machine.transition(taskIn(S.RUNNING), E.CONTINUE_NEXT_ROUND);
    expect(task.state).toBe(S.RUNNING);
    task = machine.transition(task, E.CONTINUE_NEXT_ROUND);
    expect(task.state).toBe(S.BLOCKED);
  });
});

describe("TaskStateMachine：V0.1 禁用面与终态", () => {
  const machine = new TaskStateMachine();

  it("TESTING：全部事件均被拒绝（枚举保留，迁移禁用）", () => {
    for (const event of Object.values(TaskEvent)) {
      expect(() => machine.transition(taskIn(S.TESTING), event)).toThrow(InvalidTransitionError);
    }
  });

  it.each([S.COMPLETED, S.CANCELLED, S.FAILED, S.BLOCKED])("%s：全部事件均被拒绝", (state) => {
    for (const event of Object.values(TaskEvent)) {
      expect(() => machine.transition(taskIn(state), event)).toThrow(InvalidTransitionError);
    }
  });
});

describe("InvalidTransitionError 契约", () => {
  it("携带 E_INVALID_TRANSITION 错误码与 from/event 信息", () => {
    const machine = new TaskStateMachine();
    let thrown: unknown;
    try {
      machine.transition(taskIn(S.COMPLETED), E.CAPTURE_SUCCEEDED);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(InvalidTransitionError);
    const err = thrown as InvalidTransitionError;
    expect(err.code).toBe("E_INVALID_TRANSITION");
    expect(err.from).toBe(S.COMPLETED);
    expect(err.event).toBe(E.CAPTURE_SUCCEEDED);
    expect(err.message).toContain("COMPLETED");
    expect(err.message).toContain("CAPTURE_SUCCEEDED");
  });

  it("canTransition 与 transition 一致：合法返回 true，非法返回 false", () => {
    const machine = new TaskStateMachine();
    expect(machine.canTransition(taskIn(S.READY), E.START_AUTO)).toBe(true);
    expect(machine.canTransition(taskIn(S.READY), E.CAPTURE_SUCCEEDED)).toBe(false);
    expect(machine.canTransition(taskIn(S.TESTING), E.PREFLIGHT_PASSED)).toBe(false);
  });
});
