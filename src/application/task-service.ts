import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync } from "node:sqlite";

import { isTaskLogEventType, type TaskLogEventType } from "../domain/task-log-event.js";
import type { TaskState } from "../domain/task-state.js";
import type { SnapshotRepository, TaskSnapshotV1 } from "../infra/persistence/snapshot-repository.js";
import { TaskRepository, type TaskRecord } from "../infra/persistence/task-repository.js";

/**
 * task_events.payload_json 的结构（#15）：结构化、可离线重放。
 * - `snapshot_sha256`：同事务之前刚落盘 Snapshot 的 SHA-256；纯状态类事件为 null。
 *   它是崩溃对账（reconcile）的准绳：event log 是权威历史，DB 是投影，
 *   snapshot 文件最多前卫一个未提交事务。
 */
export interface TaskEventPayload {
  type: TaskLogEventType;
  from_state: TaskState | null;
  to_state: TaskState | null;
  reason: string | null;
  snapshot_sha256: string | null;
  data: Record<string, unknown> | null;
  occurred_at: string;
}

export interface RecordEventInput {
  taskId: string;
  type: TaskLogEventType;
  /** 状态迁移（有则记入 payload；配合 record/snapshot 形成「状态变化三写」）。 */
  stateChange?: { from: TaskState; to: TaskState };
  /** 事件自由载荷（结构化 JSON，可离线重放）。 */
  data?: Record<string, unknown>;
  reason?: string;
  /** 同事务内更新的 tasks 行（新的完整行）。 */
  record?: TaskRecord;
  /** DB 事务前原子落盘的新 Snapshot（§6.2：文件先于 DB）。 */
  snapshot?: TaskSnapshotV1;
  /** 缺省取当前时间。 */
  occurredAt?: string;
}

export interface ReplayStep {
  eventId: number;
  payload: TaskEventPayload;
}

export interface ReplayResult {
  /** 事件流折叠出的当前状态；无事件为 null。 */
  state: TaskState | null;
  /** 事件流折叠出的最后已提交 Snapshot 哈希；无 Snapshot 类事件为 null。 */
  snapshotSha256: string | null;
  events: ReplayStep[];
}

export type ReconcileResult =
  | "CONSISTENT"
  | "SNAPSHOT_ROLLED_BACK"
  | "ORPHAN_CLEANED"
  | "SNAPSHOT_MISSING"
  | "SNAPSHOT_UNRECOVERABLE";

const INSERT_EVENT_SQL =
  "INSERT INTO task_events (task_id, event_type, payload_json, created_at) VALUES (?, ?, ?, ?)";

/**
 * Application Service：状态变化的统一写入顺序（TDD §6.4 / §7.3，票 #15）。
 *
 * 每次状态变化 = DB transaction + event append + snapshot write，顺序固定为：
 *
 *   snapshot 原子落盘（tmp → fsync → rename，#12）
 *   → 同一 DB 事务内：更新 tasks 行 + 追加 task_events（提交点）
 *
 * 崩溃窗口只有两类，且都可判定（§23.2）：
 * - rename 前中断：三者全停在旧状态，天然一致；
 * - rename 后、事务提交前中断：snapshot 前卫一个未提交事务，
 *   `reconcile()` 以 event log 为准绳把它回滚到 last committed（previous 一代恰好就是）。
 * 纯通知类事件（不更新状态/快照）可以只追加事件。
 */
export class TaskService {
  private readonly tasks: TaskRepository;

  constructor(
    private readonly db: DatabaseSync,
    private readonly snapshots: SnapshotRepository,
  ) {
    this.tasks = new TaskRepository(db);
  }

  /**
   * 记录一个事件，并按需同步 tasks 行与 Snapshot 文件。
   * @returns 本次落盘 Snapshot 的 SHA-256（未落盘为 null）。
   */
  record(input: RecordEventInput): string | null {
    if (!isTaskLogEventType(input.type)) {
      throw new Error(`unknown task log event type: ${String(input.type)}`);
    }
    const occurredAt = input.occurredAt ?? new Date().toISOString();
    if (input.snapshot) {
      // 文件先落（原子 rename），哈希随回调进入同一 DB 事务（§6.2 顺序）。
      return this.snapshots.save(input.snapshot, (sha256) =>
        this.commitInTransaction(input, occurredAt, sha256),
      );
    }
    this.commitInTransaction(input, occurredAt, null);
    return null;
  }

  private commitInTransaction(
    input: RecordEventInput,
    occurredAt: string,
    snapshotSha256: string | null,
  ): void {
    const payload: TaskEventPayload = {
      type: input.type,
      from_state: input.stateChange?.from ?? null,
      to_state: input.stateChange?.to ?? null,
      reason: input.reason ?? null,
      snapshot_sha256: snapshotSha256,
      data: input.data ?? null,
      occurred_at: occurredAt,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (input.record) {
        this.tasks.save(input.record);
      }
      this.db
        .prepare(INSERT_EVENT_SQL)
        .run(input.taskId, input.type, JSON.stringify(payload), occurredAt);
      this.db.exec("COMMIT");
    } catch (err) {
      // 事务是唯一提交点：任何一步失败整体回滚，DB 与 event log 保持一致；
      // 此时 snapshot 文件可能已前卫，由 reconcile() 对账（§23.2）。
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // 事务可能尚未开始（BEGIN 即失败）：无需回滚。
      }
      throw err;
    }
  }

  /**
   * 离线重放（#15 验收）：纯事件流折叠出当前状态与最后已提交的 Snapshot 哈希。
   * 不读 DB、不读文件——用于崩溃后校验三者一致性。
   */
  replay(taskId: string): ReplayResult {
    const rows = this.db
      .prepare(
        "SELECT id, payload_json FROM task_events WHERE task_id = ? ORDER BY id ASC",
      )
      .all(taskId) as unknown as { id: number; payload_json: string | null }[];
    let state: TaskState | null = null;
    let snapshotSha256: string | null = null;
    const events: ReplayStep[] = [];
    for (const row of rows) {
      if (row.payload_json === null) continue;
      const payload = JSON.parse(row.payload_json) as TaskEventPayload;
      if (payload.to_state !== null) state = payload.to_state;
      if (payload.snapshot_sha256 !== null) snapshotSha256 = payload.snapshot_sha256;
      events.push({ eventId: row.id, payload });
    }
    return { state, snapshotSha256, events };
  }

  /**
   * 崩溃对账（§23.2，#15 验收）：以 event log 重放结果为准绳，
   * 把 DB / event log / snapshot 三者归一到「可判定且一致」的状态。幂等，可重复调用。
   */
  reconcile(taskId: string): ReconcileResult {
    const row = this.tasks.findById(taskId);
    const currentPath = this.snapshots.snapshotFilePath(taskId);
    const previousPath = this.snapshots.previousFilePath(taskId);
    const committedSha = this.replay(taskId).snapshotSha256;
    const currentExists = fs.existsSync(currentPath);
    const previousExists = fs.existsSync(previousPath);

    if (!row) {
      // 没有任何已提交事务：task 目录若存在，只能是创建事务提交前的孤儿残留。
      if (currentExists || previousExists) {
        fs.rmSync(dirname(currentPath), { recursive: true, force: true });
        return "ORPHAN_CLEANED";
      }
      return "CONSISTENT";
    }

    const shaOf = (path: string): string =>
      createHash("sha256").update(fs.readFileSync(path)).digest("hex");

    if (!currentExists) {
      if (previousExists && committedSha !== null && shaOf(previousPath) === committedSha) {
        fs.copyFileSync(previousPath, currentPath);
        return "SNAPSHOT_ROLLED_BACK";
      }
      return "SNAPSHOT_MISSING";
    }

    if (committedSha !== null && shaOf(currentPath) === committedSha) {
      return "CONSISTENT";
    }

    // snapshot 前卫（rename 后、事务提交前中断）：previous 一代恰为 last committed，回滚之。
    if (previousExists && committedSha !== null && shaOf(previousPath) === committedSha) {
      fs.copyFileSync(previousPath, currentPath);
      return "SNAPSHOT_ROLLED_BACK";
    }
    return "SNAPSHOT_UNRECOVERABLE";
  }
}
