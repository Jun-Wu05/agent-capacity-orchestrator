import * as fs from "node:fs";
import { dirname, join } from "node:path";

import { DomainError } from "../../domain/errors.js";
import { TaskState } from "../../domain/task-state.js";

/**
 * Snapshot Schema v1 当前版本（TDD §6.3，#11 定稿）。
 * 发布后任何字段变更必须递增并配套 migration（#14）。
 */
export const SNAPSHOT_SCHEMA_VERSION = 1;

/** BLOCKED 原因结构化（#11 决策）：code 复用 TDD §24 枚举，detail 仅给人看。 */
export interface TaskBlockedInfo {
  code: string;
  detail: string;
  occurred_at: string;
}

/** capacity.confidence 枚举（#11 决策）；新鲜度由 observed_at 读时推导，不落盘。 */
export type CapacityConfidence = "OBSERVED" | "USER_REPORT" | "UNKNOWN";

/** Task Snapshot Schema v1（TDD §6.3，字段名与文档一一对应，snake_case）。 */
export interface TaskSnapshotV1 {
  schema_version: typeof SNAPSHOT_SCHEMA_VERSION;
  task: {
    id: string;
    state: TaskState;
    created_at: string;
    updated_at: string;
    blocked: TaskBlockedInfo | null;
  };
  agent: {
    type: string;
    adapter_version: string;
  };
  project: {
    root: string;
    worktree: string | null;
    branch: string | null;
  };
  session: {
    id: string | null;
    source: string;
    last_verified_at: string | null;
    resumable: boolean;
  };
  objective: {
    summary: string;
    continuation_prompt: string;
  };
  git: {
    base_commit: string | null;
    checkpoint_commit: string | null;
    head_commit: string | null;
    dirty_summary: Record<string, unknown>;
    untracked_files: string[];
  };
  runtime: {
    model: string | null;
    model_override_by_user: string | null;
    reasoning_effort: string | null;
    sandbox: string | null;
    approval_policy: string | null;
    approval_notified_at: string | null;
    cwd: string | null;
  };
  capacity: {
    available: boolean;
    reset_at: string | null;
    confidence: CapacityConfidence;
    observed_at: string | null;
    source: string | null;
  };
  execution: {
    start_policy: "AUTO" | "MANUAL";
    continuation_count: number;
    transient_retry_count: number;
    permissions_profile: string;
  };
  progress: {
    last_checkpoint_type: string;
    last_checkpoint_at: string | null;
    last_test_status: string;
    summary: string;
  };
}

/** 迁移前后的中间形态：schema_version 已校验为数字，其余结构由各代 migration 自证。 */
export type RawSnapshot = { schema_version: number } & Record<string, unknown>;

/**
 * 单步迁移接口（#14 migration 框架的挂载点）。
 * 禁止跳版本：框架按 fromVersion 串行匹配，缺一环即 E_SNAPSHOT_MIGRATION_FAILED。
 */
export interface SnapshotMigration {
  readonly fromVersion: number;
  readonly toVersion: number;
  migrate(raw: RawSnapshot): RawSnapshot;
}

/** Snapshot 文件缺失、损坏或校验不过（E_SNAPSHOT_INVALID，TDD §24）。 */
export class SnapshotInvalidError extends DomainError {
  readonly code = "E_SNAPSHOT_INVALID";
}

/** 迁移链断裂或单步迁移失败（E_SNAPSHOT_MIGRATION_FAILED，TDD §24）。 */
export class SnapshotMigrationError extends DomainError {
  readonly code = "E_SNAPSHOT_MIGRATION_FAILED";
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(path: string, why: string): never {
  throw new SnapshotInvalidError(`snapshot.${path}: ${why}`);
}

function expectObject(parent: Record<string, unknown>, key: string, path: string): Record<string, unknown> {
  const value = parent[key];
  if (!isPlainObject(value)) fail(path, `expected object, got ${value === null ? "null" : typeof value}`);
  return value;
}

function expectString(
  parent: Record<string, unknown>,
  key: string,
  path: string,
  { nullable = false }: { nullable?: boolean } = {},
): void {
  const value = parent[key];
  if (value === null) {
    if (nullable) return;
    fail(path, "must not be null");
  }
  if (typeof value !== "string") fail(path, `expected string, got ${typeof value}`);
}

function expectInt(parent: Record<string, unknown>, key: string, path: string): void {
  const value = parent[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    fail(path, `expected non-negative integer, got ${String(value)}`);
  }
}

/**
 * 校验 Snapshot v1 全字段（TDD §6.3 #11 定稿版）。
 * 读取入口与写入入口共用：写入时先校验，保证落盘文件永远可通过同一校验。
 */
export function validateSnapshotV1(value: unknown): TaskSnapshotV1 {
  if (!isPlainObject(value)) fail("(root)", "expected JSON object");
  if (value.schema_version !== SNAPSHOT_SCHEMA_VERSION) {
    fail("schema_version", `expected ${SNAPSHOT_SCHEMA_VERSION}, got ${String(value.schema_version)}`);
  }

  const task = expectObject(value, "task", "task");
  expectString(task, "id", "task.id");
  if (typeof task.state !== "string" || !Object.values(TaskState).includes(task.state as TaskState)) {
    fail("task.state", `unknown TaskState: ${String(task.state)}`);
  }
  expectString(task, "created_at", "task.created_at");
  expectString(task, "updated_at", "task.updated_at");
  const blocked = task.blocked;
  if (blocked !== null) {
    if (!isPlainObject(blocked)) fail("task.blocked", "expected object or null");
    expectString(blocked, "code", "task.blocked.code");
    expectString(blocked, "detail", "task.blocked.detail");
    expectString(blocked, "occurred_at", "task.blocked.occurred_at");
  }

  const agent = expectObject(value, "agent", "agent");
  expectString(agent, "type", "agent.type");
  expectString(agent, "adapter_version", "agent.adapter_version");

  const project = expectObject(value, "project", "project");
  expectString(project, "root", "project.root");
  expectString(project, "worktree", "project.worktree", { nullable: true });
  expectString(project, "branch", "project.branch", { nullable: true });

  const session = expectObject(value, "session", "session");
  expectString(session, "id", "session.id", { nullable: true });
  expectString(session, "source", "session.source");
  expectString(session, "last_verified_at", "session.last_verified_at", { nullable: true });
  if (typeof session.resumable !== "boolean") fail("session.resumable", `expected boolean, got ${typeof session.resumable}`);

  const objective = expectObject(value, "objective", "objective");
  expectString(objective, "summary", "objective.summary");
  expectString(objective, "continuation_prompt", "objective.continuation_prompt");

  const git = expectObject(value, "git", "git");
  expectString(git, "base_commit", "git.base_commit", { nullable: true });
  expectString(git, "checkpoint_commit", "git.checkpoint_commit", { nullable: true });
  expectString(git, "head_commit", "git.head_commit", { nullable: true });
  if (!isPlainObject(git.dirty_summary)) fail("git.dirty_summary", "expected object");
  if (!Array.isArray(git.untracked_files)) fail("git.untracked_files", "expected array");
  for (const [i, f] of git.untracked_files.entries()) {
    if (typeof f !== "string") fail(`git.untracked_files[${i}]`, "expected string");
  }

  const runtime = expectObject(value, "runtime", "runtime");
  for (const key of [
    "model",
    "model_override_by_user",
    "reasoning_effort",
    "sandbox",
    "approval_policy",
    "approval_notified_at",
    "cwd",
  ] as const) {
    expectString(runtime, key, `runtime.${key}`, { nullable: true });
  }

  const capacity = expectObject(value, "capacity", "capacity");
  if (typeof capacity.available !== "boolean") fail("capacity.available", `expected boolean, got ${typeof capacity.available}`);
  expectString(capacity, "reset_at", "capacity.reset_at", { nullable: true });
  if (
    typeof capacity.confidence !== "string" ||
    !["OBSERVED", "USER_REPORT", "UNKNOWN"].includes(capacity.confidence)
  ) {
    fail("capacity.confidence", `unknown confidence: ${String(capacity.confidence)}`);
  }
  expectString(capacity, "observed_at", "capacity.observed_at", { nullable: true });
  expectString(capacity, "source", "capacity.source", { nullable: true });

  const execution = expectObject(value, "execution", "execution");
  if (
    typeof execution.start_policy !== "string" ||
    !["AUTO", "MANUAL"].includes(execution.start_policy)
  ) {
    fail("execution.start_policy", `unknown start_policy: ${String(execution.start_policy)}`);
  }
  expectInt(execution, "continuation_count", "execution.continuation_count");
  expectInt(execution, "transient_retry_count", "execution.transient_retry_count");
  expectString(execution, "permissions_profile", "execution.permissions_profile");

  const progress = expectObject(value, "progress", "progress");
  expectString(progress, "last_checkpoint_type", "progress.last_checkpoint_type");
  expectString(progress, "last_checkpoint_at", "progress.last_checkpoint_at", { nullable: true });
  expectString(progress, "last_test_status", "progress.last_test_status");
  expectString(progress, "summary", "progress.summary");

  return value as unknown as TaskSnapshotV1;
}

/**
 * Snapshot 文件仓库（TDD §6.2，票 #12）。
 *
 * 写入顺序：临时文件 → write+fsync+close → 原子 rename（替换当前文件）→ DB transaction。
 * - 当前文件永远要么是完整的旧版、要么是完整的新版，不存在半写状态；
 * - rename 前把当前文件复制为 `snapshot.previous.json`（只保留 1 代，#11 决策）；
 *   若进程恰在「已复制、未 rename」之间中断，previous 与 current 短暂同为上一代，
 *   两者都完整可读，不变式不被破坏；
 * - rename 成功后才回调 `commitDb`（调用方在其中执行 DB 事务），保证「文件先于 DB」；
 * - 单写者不变式由 daemon 单实例保证（§13.2）；本类额外在每次写入前清理上次崩溃
 *   可能遗留的同名临时文件（固定临时名 + 同步写，进程内不存在并发交错）。
 *
 * fs 以 namespace 导入：测试通过 vi.spyOn(fs, "renameSync") 精确模拟「rename 前中断」。
 */
export class SnapshotRepository {
  constructor(
    /** ACO 数据根目录，例如 %LOCALAPPDATA%\AgentCapacityOrchestrator。 */
    private readonly baseDir: string,
    /** 注册的迁移链（#14 挂载）；当前为空，读取 v1 时循环体不执行。 */
    private readonly migrations: SnapshotMigration[] = [],
  ) {}

  snapshotFilePath(taskId: string): string {
    return join(this.baseDir, "tasks", taskId, "snapshot.json");
  }

  previousFilePath(taskId: string): string {
    return join(this.baseDir, "tasks", taskId, "snapshot.previous.json");
  }

  private tempFilePath(taskId: string): string {
    return join(this.baseDir, "tasks", taskId, "snapshot.json.tmp");
  }

  /**
   * 落盘一个 Snapshot（先校验后写入）。
   * @param commitDb rename 成功后执行（调用方在此跑 DB transaction，TDD §6.2）。
   */
  save(snapshot: TaskSnapshotV1, commitDb?: () => void): void {
    // 写入前先按同一套校验把关，杜绝非法结构落盘。
    validateSnapshotV1(snapshot);
    const serialized = `${JSON.stringify(snapshot, null, 2)}\n`;
    const finalPath = this.snapshotFilePath(snapshot.task.id);
    const previousPath = this.previousFilePath(snapshot.task.id);
    const tempPath = this.tempFilePath(snapshot.task.id);
    fs.mkdirSync(dirname(finalPath), { recursive: true });

    // 上次「写临时文件后、rename 前」崩溃遗留的临时文件：单写者前提下必然是垃圾，直接清掉。
    fs.rmSync(tempPath, { force: true });

    const fd = fs.openSync(tempPath, "w");
    try {
      fs.writeSync(fd, serialized);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }

    try {
      if (fs.existsSync(finalPath)) {
        fs.copyFileSync(finalPath, previousPath);
      }
      fs.renameSync(tempPath, finalPath);
    } catch (err) {
      // rename 前失败：当前文件未被触碰，清掉临时文件后原样抛出（半写模拟测试覆盖）。
      fs.rmSync(tempPath, { force: true });
      throw err;
    }

    commitDb?.();
  }

  /**
   * 统一读取入口（TDD §6.5）：读文件 → inspect schema_version → 串行迁移 → 校验 → 返回。
   * 当前文件不可读（缺失/损坏/校验不过）时回退 `snapshot.previous.json`；
   * 两者都不可读时抛 E_SNAPSHOT_INVALID。
   */
  load(taskId: string): TaskSnapshotV1 {
    const attempts = [this.snapshotFilePath(taskId), this.previousFilePath(taskId)];
    const failures: string[] = [];
    for (const path of attempts) {
      if (!fs.existsSync(path)) {
        failures.push(`${path}: missing`);
        continue;
      }
      try {
        const raw: unknown = JSON.parse(fs.readFileSync(path, "utf8"));
        return validateSnapshotV1(this.runMigrations(raw));
      } catch (err) {
        if (err instanceof SnapshotMigrationError) {
          // schema 断链是版本层面的失败，previous 属于同一代链，回退无意义：直接上抛（§6.5 禁止带病继续）。
          throw err;
        }
        failures.push(`${path}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    throw new SnapshotInvalidError(
      `no readable snapshot for task ${taskId} (${attempts.length} locations tried):\n${failures.join("\n")}`,
    );
  }

  private runMigrations(raw: unknown): RawSnapshot {
    if (!isPlainObject(raw) || typeof raw.schema_version !== "number") {
      throw new SnapshotInvalidError("missing or invalid schema_version");
    }
    let current: RawSnapshot = raw as RawSnapshot;
    let version = current.schema_version;
    if (version > SNAPSHOT_SCHEMA_VERSION) {
      throw new SnapshotInvalidError(
        `snapshot schema_version ${version} is newer than supported ${SNAPSHOT_SCHEMA_VERSION}`,
      );
    }
    while (version < SNAPSHOT_SCHEMA_VERSION) {
      const step = this.migrations.find((m) => m.fromVersion === version);
      if (!step) {
        throw new SnapshotMigrationError(
          `no migration registered from schema_version ${version} to ${SNAPSHOT_SCHEMA_VERSION}`,
        );
      }
      if (step.toVersion <= step.fromVersion) {
        throw new SnapshotMigrationError(
          `migration ${step.fromVersion}->${step.toVersion} does not advance version`,
        );
      }
      current = step.migrate(current);
      if (current.schema_version !== step.toVersion) {
        throw new SnapshotMigrationError(
          `migration ${step.fromVersion}->${step.toVersion} produced schema_version ${current.schema_version}`,
        );
      }
      version = step.toVersion;
    }
    return current;
  }
}
