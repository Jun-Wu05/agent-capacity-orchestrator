import type { DatabaseSync } from "node:sqlite";

import type { AgentKind, StartPolicy } from "../../domain/task.js";
import { TaskState } from "../../domain/task-state.js";

/**
 * tasks 表行 ↔ 领域 Task 的映射载体：领域字段（TDD §5.1）+
 * 持久化元数据（snapshot_path、next_check_at，TDD §7.2）。
 */
export interface TaskRecord {
  id: string;
  agent: AgentKind;
  state: TaskState;
  projectRoot: string;
  worktreePath?: string;
  branchName?: string;
  sessionId?: string;
  snapshotPath: string;
  snapshotVersion: number;
  startPolicy: StartPolicy;
  continuationCount: number;
  transientRetryCount: number;
  nextCheckAt: string | null;
  createdAt: string;
  updatedAt: string;
}

interface TaskRow {
  id: string;
  agent: string;
  state: string;
  project_root: string;
  worktree_path: string | null;
  branch_name: string | null;
  session_id: string | null;
  snapshot_path: string;
  snapshot_version: number;
  start_policy: string;
  continuation_count: number;
  transient_retry_count: number;
  next_check_at: string | null;
  created_at: string;
  updated_at: string;
}

const UPSERT_SQL = `
  INSERT INTO tasks (
    id, agent, state, project_root, worktree_path, branch_name, session_id,
    snapshot_path, snapshot_version, start_policy,
    continuation_count, transient_retry_count, next_check_at,
    created_at, updated_at
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(id) DO UPDATE SET
    agent = excluded.agent,
    state = excluded.state,
    project_root = excluded.project_root,
    worktree_path = excluded.worktree_path,
    branch_name = excluded.branch_name,
    session_id = excluded.session_id,
    snapshot_path = excluded.snapshot_path,
    snapshot_version = excluded.snapshot_version,
    start_policy = excluded.start_policy,
    continuation_count = excluded.continuation_count,
    transient_retry_count = excluded.transient_retry_count,
    next_check_at = excluded.next_check_at,
    updated_at = excluded.updated_at
`;

const SELECT_SQL = `
  SELECT id, agent, state, project_root, worktree_path, branch_name, session_id,
         snapshot_path, snapshot_version, start_policy,
         continuation_count, transient_retry_count, next_check_at,
         created_at, updated_at
  FROM tasks
`;

function toRecord(row: TaskRow): TaskRecord {
  return {
    id: row.id,
    agent: row.agent as AgentKind,
    state: row.state as TaskState,
    projectRoot: row.project_root,
    ...(row.worktree_path === null ? {} : { worktreePath: row.worktree_path }),
    ...(row.branch_name === null ? {} : { branchName: row.branch_name }),
    ...(row.session_id === null ? {} : { sessionId: row.session_id }),
    snapshotPath: row.snapshot_path,
    snapshotVersion: row.snapshot_version,
    startPolicy: row.start_policy as StartPolicy,
    continuationCount: row.continuation_count,
    transientRetryCount: row.transient_retry_count,
    nextCheckAt: row.next_check_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/**
 * Task 持久化仓库（TDD §7）。
 *
 * 只做存取与查询，不做状态迁移（迁移统一走领域层 TaskStateMachine），
 * 也不负责时间戳生成——createdAt/updatedAt 由应用层写入 record。
 */
export class TaskRepository {
  constructor(private readonly db: DatabaseSync) {}

  save(record: TaskRecord): void {
    this.db.prepare(UPSERT_SQL).run(
      record.id,
      record.agent,
      record.state,
      record.projectRoot,
      record.worktreePath ?? null,
      record.branchName ?? null,
      record.sessionId ?? null,
      record.snapshotPath,
      record.snapshotVersion,
      record.startPolicy,
      record.continuationCount,
      record.transientRetryCount,
      record.nextCheckAt,
      record.createdAt,
      record.updatedAt,
    );
  }

  findById(id: string): TaskRecord | null {
    const row = this.db.prepare(`${SELECT_SQL} WHERE id = ?`).get(id) as TaskRow | undefined;
    return row === undefined ? null : toRecord(row);
  }

  listAll(): TaskRecord[] {
    const rows = this.db.prepare(`${SELECT_SQL} ORDER BY created_at, id`).all() as unknown as TaskRow[];
    return rows.map(toRecord);
  }

  /** Phase 4 Scheduler 预留：next_check_at 已到期的 Task。 */
  listDue(now: string): TaskRecord[] {
    const rows = this.db
      .prepare(`${SELECT_SQL} WHERE next_check_at IS NOT NULL AND next_check_at <= ? ORDER BY next_check_at`)
      .all(now) as unknown as TaskRow[];
    return rows.map(toRecord);
  }

  /** WAITING_SESSION 退避重试等调度场景：更新下次检查时间；null 表示清除。 */
  setNextCheckAt(id: string, at: string | null): void {
    const result = this.db
      .prepare("UPDATE tasks SET next_check_at = ? WHERE id = ?")
      .run(at, id);
    if (result.changes === 0) {
      throw new Error(`Task not found: ${id}`);
    }
  }
}
