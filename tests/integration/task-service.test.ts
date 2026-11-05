import * as fs from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TASK_LOG_EVENTS } from "../../src/domain/task-log-event.js";
import { TaskState } from "../../src/domain/task-state.js";
import { TaskService, type TaskEventPayload } from "../../src/application/task-service.js";
import { SnapshotRepository, type TaskSnapshotV1 } from "../../src/infra/persistence/snapshot-repository.js";
import {
  initSchema,
  openTaskDatabase,
} from "../../src/infra/persistence/sqlite.js";
import { TaskRepository, type TaskRecord } from "../../src/infra/persistence/task-repository.js";

/** ESM 下无法 spy node:fs 导出，用模块级 mock + 开关模拟「rename 前中断」（同 #12 测试）。 */
const renameControl = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (oldPath, newPath) => {
    if (renameControl.fail) throw new Error("EIO: process killed before rename");
    return actual.renameSync(oldPath, newPath);
  };
  return { ...actual, renameSync };
});

const repoRoot = join(import.meta.dirname, "..", "..");

let dir: string;
let db: DatabaseSync;
let taskRepo: TaskRepository;
let snapshots: SnapshotRepository;
let service: TaskService;

function taskRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_001",
    agent: "codex",
    state: TaskState.CAPTURING,
    projectRoot: "D:\\repo",
    worktreePath: "D:\\wt",
    branchName: "aco/task/task_001",
    sessionId: "uuid-1",
    snapshotPath: join(dir, "tasks", "task_001", "snapshot.json"),
    snapshotVersion: 1,
    startPolicy: "AUTO",
    continuationCount: 0,
    transientRetryCount: 0,
    nextCheckAt: null,
    createdAt: "2026-11-05T10:00:00.000Z",
    updatedAt: "2026-11-05T10:00:00.000Z",
    ...overrides,
  };
}

function snapshotV1(overrides: { id?: string; patch?: (s: TaskSnapshotV1) => void } = {}): TaskSnapshotV1 {
  const s: TaskSnapshotV1 = {
    schema_version: 1,
    task: {
      id: overrides.id ?? "task_001",
      state: TaskState.CAPTURING,
      created_at: "2026-11-05T10:00:00.000Z",
      updated_at: "2026-11-05T10:00:00.000Z",
      blocked: null,
    },
    agent: { type: "codex", adapter_version: "0.1.0" },
    project: { root: "D:\\repo", worktree: "D:\\wt", branch: "aco/task/task_001" },
    session: { id: "uuid-1", source: "local-session", last_verified_at: null, resumable: true },
    objective: { summary: "修复解析器", continuation_prompt: "继续" },
    git: {
      base_commit: "a".repeat(40),
      checkpoint_commit: null,
      head_commit: "c".repeat(40),
      dirty_summary: {},
      untracked_files: [],
    },
    runtime: {
      model: "gpt-5.1-codex",
      model_override_by_user: null,
      reasoning_effort: "high",
      sandbox: "workspace-write",
      approval_policy: "on-request",
      approval_notified_at: null,
      cwd: "D:\\wt",
    },
    capacity: {
      available: false,
      reset_at: null,
      confidence: "OBSERVED",
      observed_at: "2026-11-05T10:00:00.000Z",
      source: "rollout-rate-limits",
    },
    execution: {
      start_policy: "AUTO",
      continuation_count: 0,
      transient_retry_count: 0,
      permissions_profile: "workspace-safe",
    },
    progress: {
      last_checkpoint_type: "CAPTURED",
      last_checkpoint_at: null,
      last_test_status: "UNKNOWN",
      summary: "",
    },
  };
  overrides.patch?.(s);
  return s;
}

function fileSha(path: string): string {
  return createHash("sha256").update(fs.readFileSync(path)).digest("hex");
}

function eventRows(taskId = "task_001"): { id: number; event_type: string; payload_json: string }[] {
  return db
    .prepare("SELECT id, event_type, payload_json FROM task_events WHERE task_id = ? ORDER BY id")
    .all(taskId) as unknown as { id: number; event_type: string; payload_json: string }[];
}

beforeEach(() => {
  dir = fs.mkdtempSync(join(repoRoot, ".test-tmp-"));
  db = openTaskDatabase(join(dir, "aco.db"));
  initSchema(db);
  taskRepo = new TaskRepository(db);
  snapshots = new SnapshotRepository(dir);
  service = new TaskService(db, snapshots);
});

afterEach(() => {
  renameControl.fail = false;
  vi.restoreAllMocks();
  db.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("§6.4 全部触发点 + WAITING_SESSION 进/出各有事件写入", () => {
  it("16 种事件类型逐一落库，payload 结构化可解析", () => {
    taskRepo.save(taskRecord());
    for (const type of TASK_LOG_EVENTS) {
      service.record({ taskId: "task_001", type, data: { note: `fire ${type}` } });
    }
    const rows = eventRows();
    expect(rows.map((r) => r.event_type)).toEqual([...TASK_LOG_EVENTS]);
    for (const row of rows) {
      const payload = JSON.parse(row.payload_json) as TaskEventPayload;
      expect(payload.type).toBe(row.event_type);
      expect(payload.from_state).toBeNull();
      expect(payload.to_state).toBeNull();
      expect(payload.snapshot_sha256).toBeNull();
      expect(payload.data).toEqual({ note: `fire ${payload.type}` });
      expect(payload.occurred_at).toBeTruthy();
    }
  });

  it("WAITING_SESSION 进入/退出事件带状态迁移字段", () => {
    taskRepo.save(taskRecord());
    service.record({
      taskId: "task_001",
      type: "SESSION_WAIT_ENTERED",
      stateChange: { from: TaskState.RESUMING_SESSION, to: TaskState.WAITING_SESSION },
      reason: "会话被 Codex Desktop 占用",
    });
    service.record({
      taskId: "task_001",
      type: "SESSION_WAIT_EXITED",
      stateChange: { from: TaskState.WAITING_SESSION, to: TaskState.RESUMING_SESSION },
      reason: "Desktop 已退出，重试成功",
    });
    const [entered, exited] = eventRows().map((r) => JSON.parse(r.payload_json) as TaskEventPayload);
    expect(entered).toBeDefined();
    expect(exited).toBeDefined();
    expect(entered!.to_state).toBe(TaskState.WAITING_SESSION);
    expect(entered!.reason).toBe("会话被 Codex Desktop 占用");
    expect(exited!.from_state).toBe(TaskState.WAITING_SESSION);
  });

  it("未知事件类型直接拒绝", () => {
    expect(() =>
      service.record({ taskId: "task_001", type: "NOT_A_TRIGGER" as never }),
    ).toThrow(/unknown task log event type/);
  });
});

describe("状态变化三写：snapshot 文件 → 同事务（tasks 行 + 事件）", () => {
  it("文件、DB 行、事件三者一次到位，事件记录 snapshot 哈希", () => {
    const snap = snapshotV1();
    const sha = service.record({
      taskId: "task_001",
      type: "TASK_CAPTURED",
      stateChange: { from: TaskState.CAPTURING, to: TaskState.WAITING_CAPACITY },
      record: taskRecord({ state: TaskState.WAITING_CAPACITY }),
      snapshot: snap,
      occurredAt: "2026-11-05T10:00:05.000Z",
    });

    expect(sha).toBe(fileSha(snapshots.snapshotFilePath("task_001")));
    expect(taskRepo.findById("task_001")?.state).toBe(TaskState.WAITING_CAPACITY);
    const [payload] = eventRows().map((r) => JSON.parse(r.payload_json) as TaskEventPayload);
    expect(payload).toMatchObject({
      type: "TASK_CAPTURED",
      from_state: TaskState.CAPTURING,
      to_state: TaskState.WAITING_CAPACITY,
      snapshot_sha256: sha,
    });
  });

  it("离线重放：纯事件流折叠出的状态与哈希 == DB 行与磁盘文件", () => {
    taskRepo.save(taskRecord());
    service.record({
      taskId: "task_001",
      type: "TASK_CAPTURED",
      stateChange: { from: TaskState.CAPTURING, to: TaskState.WAITING_CAPACITY },
      record: taskRecord({ state: TaskState.WAITING_CAPACITY }),
      snapshot: snapshotV1({ patch: (s) => { s.task.state = TaskState.WAITING_CAPACITY; } }),
    });
    service.record({
      taskId: "task_001",
      type: "SESSION_WAIT_ENTERED",
      stateChange: { from: TaskState.RESUMING_SESSION, to: TaskState.WAITING_SESSION },
      record: taskRecord({ state: TaskState.WAITING_SESSION, continuationCount: 2 }),
      snapshot: snapshotV1({ patch: (s) => { s.task.state = TaskState.WAITING_SESSION; } }),
    });

    const replayed = service.replay("task_001");
    expect(replayed.state).toBe(TaskState.WAITING_SESSION);
    expect(replayed.snapshotSha256).toBe(fileSha(snapshots.snapshotFilePath("task_001")));
    expect(replayed.events).toHaveLength(2);
    expect(taskRepo.findById("task_001")?.state).toBe(replayed.state);
    expect(taskRepo.findById("task_001")?.continuationCount).toBe(2);
  });
});

describe("崩溃一致性：任一环节中断后三者可判定且一致（#15 验收）", () => {
  it("窗口 1（rename 前中断）：三者全停旧状态，reconcile 判定 CONSISTENT", () => {
    // 先提交一代
    service.record({
      taskId: "task_001",
      type: "TASK_CAPTURED",
      stateChange: { from: TaskState.CAPTURING, to: TaskState.WAITING_CAPACITY },
      record: taskRecord({ state: TaskState.WAITING_CAPACITY }),
      snapshot: snapshotV1({ patch: (s) => { s.task.state = TaskState.WAITING_CAPACITY; } }),
    });
    const committedSha = service.replay("task_001").snapshotSha256;

    renameControl.fail = true;
    expect(() =>
      service.record({
        taskId: "task_001",
        type: "RUN_STARTED",
        stateChange: { from: TaskState.WAITING_CAPACITY, to: TaskState.RUNNING },
        record: taskRecord({ state: TaskState.RUNNING }),
        snapshot: snapshotV1({ patch: (s) => { s.task.state = TaskState.RUNNING; } }),
      }),
    ).toThrow("process killed before rename");

    // 事件未追加、DB 行未变、当前文件未变
    expect(eventRows()).toHaveLength(1);
    expect(taskRepo.findById("task_001")?.state).toBe(TaskState.WAITING_CAPACITY);
    expect(fileSha(snapshots.snapshotFilePath("task_001"))).toBe(committedSha);
    expect(fs.existsSync(join(dir, "tasks", "task_001", "snapshot.json.tmp"))).toBe(false);

    expect(service.reconcile("task_001")).toBe("CONSISTENT");
    const replayed = service.replay("task_001");
    expect(replayed.state).toBe(taskRepo.findById("task_001")?.state);
    expect(replayed.snapshotSha256).toBe(fileSha(snapshots.snapshotFilePath("task_001")));
  });

  function crashAt(sqlMarker: string): void {
    const realExec = db.exec.bind(db);
    vi.spyOn(db, "exec").mockImplementation((sql: string) => {
      if (sql.startsWith(sqlMarker)) throw new Error(`simulated crash at ${sqlMarker}`);
      return realExec(sql);
    });
  }

  it.each([
    ["BEGIN（事务未开始）", "BEGIN IMMEDIATE"],
    ["COMMIT（事务回滚）", "COMMIT"],
  ])("窗口 2（rename 后、%s 中断）：snapshot 前卫可判定，reconcile 回滚到 last committed", (_label, marker) => {
    service.record({
      taskId: "task_001",
      type: "TASK_CAPTURED",
      stateChange: { from: TaskState.CAPTURING, to: TaskState.WAITING_CAPACITY },
      record: taskRecord({ state: TaskState.WAITING_CAPACITY }),
      snapshot: snapshotV1({ patch: (s) => { s.task.state = TaskState.WAITING_CAPACITY; } }),
    });
    const committedSha = service.replay("task_001").snapshotSha256;

    crashAt(marker);
    expect(() =>
      service.record({
        taskId: "task_001",
        type: "RUN_STARTED",
        stateChange: { from: TaskState.WAITING_CAPACITY, to: TaskState.RUNNING },
        record: taskRecord({ state: TaskState.RUNNING }),
        snapshot: snapshotV1({ patch: (s) => { s.task.state = TaskState.RUNNING; } }),
      }),
    ).toThrow(`simulated crash at ${marker}`);
    vi.restoreAllMocks();

    // 中断后：事件未追加、DB 行未变，但 snapshot 文件已前卫到 RUNNING
    expect(eventRows()).toHaveLength(1);
    expect(taskRepo.findById("task_001")?.state).toBe(TaskState.WAITING_CAPACITY);
    expect(fileSha(snapshots.snapshotFilePath("task_001"))).not.toBe(committedSha);
    const aheadState = (
      JSON.parse(fs.readFileSync(snapshots.snapshotFilePath("task_001"), "utf8")) as TaskSnapshotV1
    ).task.state;
    expect(aheadState).toBe(TaskState.RUNNING);

    // 对账：回滚到 last committed，三者重新一致，且幂等
    expect(service.reconcile("task_001")).toBe("SNAPSHOT_ROLLED_BACK");
    expect(service.reconcile("task_001")).toBe("CONSISTENT");
    const replayed = service.replay("task_001");
    expect(replayed.state).toBe(TaskState.WAITING_CAPACITY);
    expect(taskRepo.findById("task_001")?.state).toBe(replayed.state);
    expect(fileSha(snapshots.snapshotFilePath("task_001"))).toBe(replayed.snapshotSha256);
  });

  it("创建事务中断（无 DB 行）：snapshot 目录为孤儿，reconcile 清理", () => {
    // 模拟：创建流程中 rename 已发生、事务未提交 → 无行、无事件、有文件
    fs.mkdirSync(join(dir, "tasks", "task_orphan"), { recursive: true });
    fs.writeFileSync(snapshots.snapshotFilePath("task_orphan"), JSON.stringify(snapshotV1({ id: "task_orphan" })));
    expect(taskRepo.findById("task_orphan")).toBeNull();

    expect(service.reconcile("task_orphan")).toBe("ORPHAN_CLEANED");
    expect(fs.existsSync(join(dir, "tasks", "task_orphan"))).toBe(false);
  });

  it("DB 有行但 snapshot 文件缺失：判为 SNAPSHOT_MISSING（不可自动修复）", () => {
    taskRepo.save(taskRecord());
    expect(service.reconcile("task_001")).toBe("SNAPSHOT_MISSING");
  });
});
