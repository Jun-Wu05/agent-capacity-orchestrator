import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Worker } from "node:worker_threads";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TaskState } from "../../src/domain/task-state.js";
import {
  initSchema,
  openTaskDatabase,
} from "../../src/infra/persistence/sqlite.js";
import {
  TaskRepository,
  type TaskRecord,
} from "../../src/infra/persistence/task-repository.js";

const repoRoot = join(import.meta.dirname, "..", "..");

let dir: string;
let db: DatabaseSync;
let repo: TaskRepository;

function fullRecord(overrides: Partial<TaskRecord> = {}): TaskRecord {
  return {
    id: "task_001",
    agent: "codex",
    state: TaskState.WAITING_CAPACITY,
    projectRoot: "D:\\repo",
    worktreePath: "D:\\wt",
    branchName: "aco/task/task_001",
    sessionId: "uuid-1",
    snapshotPath: "C:\\aco\\tasks\\task_001\\snapshot.json",
    snapshotVersion: 1,
    startPolicy: "AUTO",
    continuationCount: 0,
    transientRetryCount: 0,
    nextCheckAt: null,
    createdAt: "2026-11-03T10:00:00.000Z",
    updatedAt: "2026-11-03T10:00:00.000Z",
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(repoRoot, ".test-tmp-"));
  db = openTaskDatabase(join(dir, "aco.db"));
  initSchema(db);
  repo = new TaskRepository(db);
});

afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("openTaskDatabase 连接参数（TDD §7.3）", () => {
  it("WAL / foreign_keys / busy_timeout=5000 全部生效", () => {
    expect(db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "wal" });
    expect(db.prepare("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(db.prepare("PRAGMA busy_timeout").get()).toEqual({ timeout: 5000 });
  });
});

describe("initSchema 幂等", () => {
  it("同一连接重复 initSchema 不报错、不重复记录版本", () => {
    expect(() => initSchema(db)).not.toThrow();
    const rows = db.prepare("SELECT version FROM schema_migrations").all();
    expect(rows).toEqual([{ version: 1 }]);
  });

  it("新连接再次 initSchema 同样幂等", () => {
    const second = openTaskDatabase(join(dir, "aco.db"));
    try {
      expect(() => initSchema(second)).not.toThrow();
      const rows = second.prepare("SELECT version FROM schema_migrations").all();
      expect(rows).toEqual([{ version: 1 }]);
    } finally {
      second.close();
    }
  });
});

describe("TaskRepository CRUD", () => {
  it("完整字段的 Task 保存后可原样读回（§5.1 / §7.2）", () => {
    repo.save(fullRecord());
    expect(repo.findById("task_001")).toEqual(fullRecord());
  });

  it("可选字段缺失时 round-trip 保持缺失", () => {
    const { worktreePath: _w, branchName: _b, sessionId: _s, ...minimal } = fullRecord();
    repo.save(minimal);
    const loaded = repo.findById("task_001");
    expect(loaded).toBeDefined();
    expect(loaded?.worktreePath).toBeUndefined();
    expect(loaded?.branchName).toBeUndefined();
    expect(loaded?.sessionId).toBeUndefined();
  });

  it("findById 不存在时返回 null", () => {
    expect(repo.findById("missing")).toBeNull();
  });

  it("重复 save 为更新：状态变化生效且不产生第二行", () => {
    repo.save(fullRecord());
    repo.save(fullRecord({ state: TaskState.WAITING_SESSION, continuationCount: 2 }));
    expect(repo.findById("task_001")?.state).toBe(TaskState.WAITING_SESSION);
    expect(repo.findById("task_001")?.continuationCount).toBe(2);
    expect(repo.listAll()).toHaveLength(1);
  });

  it("listAll 返回全部 Task", () => {
    repo.save(fullRecord());
    repo.save(fullRecord({ id: "task_002", state: TaskState.READY }));
    expect(repo.listAll().map((t) => t.id).sort()).toEqual(["task_001", "task_002"]);
  });
});

describe("next_check_at 调度查询（Phase 4 Scheduler 预留）", () => {
  const now = "2026-11-03T12:00:00.000Z";

  it("只返回 next_check_at <= now 的 Task", () => {
    repo.save(fullRecord({ id: "due", nextCheckAt: "2026-11-03T11:59:59.000Z" }));
    repo.save(fullRecord({ id: "future", nextCheckAt: "2026-11-03T12:00:01.000Z" }));
    repo.save(fullRecord({ id: "never" }));
    expect(repo.listDue(now).map((t) => t.id)).toEqual(["due"]);
  });

  it("边界相等算到期", () => {
    repo.save(fullRecord({ id: "edge", nextCheckAt: now }));
    expect(repo.listDue(now).map((t) => t.id)).toEqual(["edge"]);
  });

  it("setNextCheckAt 可设置与清除", () => {
    repo.save(fullRecord());
    repo.setNextCheckAt("task_001", "2026-11-03T13:00:00.000Z");
    expect(repo.findById("task_001")?.nextCheckAt).toBe("2026-11-03T13:00:00.000Z");
    repo.setNextCheckAt("task_001", null);
    expect(repo.findById("task_001")?.nextCheckAt).toBeNull();
  });

  it("setNextCheckAt 对不存在的 Task 抛错（不静默）", () => {
    expect(() => repo.setNextCheckAt("missing", now)).toThrow();
  });
});

describe("WAL 并发读写不产生 SQLITE_BUSY", () => {
  it("读连接在写事务未提交时看到旧快照，提交后看到新数据", () => {
    const writer = openTaskDatabase(join(dir, "aco.db"));
    try {
      writer.exec("BEGIN IMMEDIATE");
      writer
        .prepare(
          "INSERT INTO tasks (id, agent, state, project_root, snapshot_path, snapshot_version, start_policy, continuation_count, transient_retry_count, next_check_at, created_at, updated_at) VALUES ('task_w','codex','READY','D:\\\\repo','snap',1,'AUTO',0,0,NULL,'2026-11-03T10:00:00.000Z','2026-11-03T10:00:00.000Z')",
        )
        .run();

      // 读连接（repo 用的是另一个连接）不受未提交写事务影响
      expect(repo.findById("task_w")).toBeNull();

      writer.exec("COMMIT");
      expect(repo.findById("task_w")?.state).toBe(TaskState.READY);
    } finally {
      writer.close();
    }
  });

  it("busy_timeout 生效：另一线程持写锁 300ms 期间写入等待而非报 SQLITE_BUSY", async () => {
    const dbPath = join(dir, "aco.db");
    const worker = new Worker(
      `
      const { parentPort, workerData } = require("node:worker_threads");
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(workerData.path);
      db.exec("PRAGMA busy_timeout = 100");
      db.exec("BEGIN IMMEDIATE");
      parentPort.postMessage("locked");
      setTimeout(() => {
        db.exec("COMMIT");
        db.close();
        parentPort.postMessage("committed");
      }, 300);
      `,
      { eval: true, workerData: { path: dbPath } },
    );

    const messages: string[] = [];
    worker.on("message", (m: string) => messages.push(m));
    await new Promise<void>((resolve) => worker.once("message", (m: string) => {
      if (m === "locked") resolve();
    }));

    // 写锁被 worker 线程持有：这里必须阻塞等待（busy_timeout=5000）而不是抛 SQLITE_BUSY
    repo.save(fullRecord({ id: "task_main" }));

    expect(repo.findById("task_main")?.id).toBe("task_main");
    await new Promise<void>((resolve) => worker.once("message", (m: string) => {
      if (m === "committed") resolve();
    }));
    await worker.terminate();
    expect(messages).toContain("committed");
  }, 10000);
});
