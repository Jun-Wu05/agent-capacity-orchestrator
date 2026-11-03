import type { TaskState } from "./task-state.js";

export type AgentKind = "codex";
export type StartPolicy = "AUTO" | "MANUAL";

/**
 * Task 领域模型（TDD-V0.1 §5.1）。
 *
 * Task 只保存索引与当前关键状态，不保存全部 Snapshot 内容。
 *
 * 与 §5.1 原文的差异（票 #10）：原单一 `retryCount` 拆为两个独立计数器，
 * 因为 §5.3 要求续跑上限与瞬时重试上限分别计数（默认各 3）：
 * - `continuationCount`：RUNNING 内 CONTINUE / 缺失标记的续跑轮数；
 * - `transientRetryCount`：RUNNING 内瞬时错误的独立重试次数。
 * 计数器是否/何时清零属于 Snapshot 恢复语义，留给 #11 定稿。
 */
export interface Task {
  id: string;
  agent: AgentKind;
  state: TaskState;
  projectRoot: string;
  worktreePath?: string;
  branchName?: string;
  sessionId?: string;
  snapshotVersion: number;
  startPolicy: StartPolicy;
  continuationCount: number;
  transientRetryCount: number;
  createdAt: string;
  updatedAt: string;
}
