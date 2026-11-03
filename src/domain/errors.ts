import type { TaskEvent, TaskState } from "./task-state.js";

/**
 * 领域错误基类。错误码是稳定契约（TDD-V0.1 §24），
 * CLI 层根据 `code` 输出中文文案，业务代码不散落中文字符串。
 */
export abstract class DomainError extends Error {
  abstract readonly code: string;

  constructor(
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = new.target.name;
  }
}

/** 非法状态迁移（E_INVALID_TRANSITION，TDD §24）。 */
export class InvalidTransitionError extends DomainError {
  readonly code = "E_INVALID_TRANSITION";

  constructor(
    readonly from: TaskState,
    readonly event: TaskEvent,
  ) {
    super(`Illegal transition: state ${from} does not accept event ${event}`);
  }
}
