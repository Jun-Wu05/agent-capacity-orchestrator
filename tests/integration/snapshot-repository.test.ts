import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskState } from "../../src/domain/task-state.js";
import {
  SnapshotInvalidError,
  SnapshotMigrationError,
  SnapshotRepository,
  SNAPSHOT_SCHEMA_VERSION,
  validateSnapshotV1,
  type RawSnapshot,
  type SnapshotMigration,
  type TaskSnapshotV1,
} from "../../src/infra/persistence/snapshot-repository.js";

const repoRoot = join(import.meta.dirname, "..", "..");

/**
 * ESM 下无法 spy node:fs 的导出，改用模块级 mock + 开关：
 * fail=true 时 renameSync 抛错，精确模拟「临时文件已写、rename 前进程中断」。
 */
const renameControl = vi.hoisted(() => ({ fail: false }));

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const renameSync: typeof actual.renameSync = (oldPath, newPath) => {
    if (renameControl.fail) throw new Error("EIO: process killed before rename");
    return actual.renameSync(oldPath, newPath);
  };
  return { ...actual, renameSync };
});

let dir: string;
let repo: SnapshotRepository;

/** 构造一份合法的 v1 Snapshot（TDD §6.3 #11 定稿版），测试按需覆盖字段。 */
function snapshotV1(overrides: {
  id?: string;
  patch?: (s: TaskSnapshotV1) => void;
} = {}): TaskSnapshotV1 {
  const s: TaskSnapshotV1 = {
    schema_version: SNAPSHOT_SCHEMA_VERSION,
    task: {
      id: overrides.id ?? "task_001",
      state: TaskState.WAITING_CAPACITY,
      created_at: "2026-11-05T10:00:00.000Z",
      updated_at: "2026-11-05T10:00:00.000Z",
      blocked: null,
    },
    agent: { type: "codex", adapter_version: "0.1.0" },
    project: { root: "D:\\repo", worktree: "D:\\wt", branch: "aco/task/task_001" },
    session: {
      id: "uuid-1",
      source: "local-session",
      last_verified_at: "2026-11-05T10:00:00.000Z",
      resumable: true,
    },
    objective: { summary: "修复解析器", continuation_prompt: "继续上次的工作" },
    git: {
      base_commit: "a".repeat(40),
      checkpoint_commit: "b".repeat(40),
      head_commit: "c".repeat(40),
      dirty_summary: { modified: 2 },
      untracked_files: ["a.ts", "b.ts"],
    },
    runtime: {
      model: "gpt-5.1-codex",
      model_override_by_user: null,
      reasoning_effort: "high",
      sandbox: "workspace-write",
      approval_policy: "on-request",
      approval_notified_at: "2026-11-05T10:00:01.000Z",
      cwd: "D:\\wt",
    },
    capacity: {
      available: false,
      reset_at: "2026-11-05T12:00:00.000Z",
      confidence: "OBSERVED",
      observed_at: "2026-11-05T10:00:00.000Z",
      source: "rollout-rate-limits",
    },
    execution: {
      start_policy: "AUTO",
      continuation_count: 1,
      transient_retry_count: 0,
      permissions_profile: "workspace-safe",
    },
    progress: {
      last_checkpoint_type: "CAPTURED",
      last_checkpoint_at: "2026-11-05T10:00:00.000Z",
      last_test_status: "UNKNOWN",
      summary: "已完成解析器骨架",
    },
  };
  overrides.patch?.(s);
  return s;
}

beforeEach(() => {
  dir = fs.mkdtempSync(join(repoRoot, ".test-tmp-"));
  repo = new SnapshotRepository(dir);
});

afterEach(() => {
  renameControl.fail = false;
  fs.rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe("写入布局与 round-trip（TDD §6.2）", () => {
  it("保存后落在 tasks/<task-id>/snapshot.json，读取原样返回", () => {
    const snap = snapshotV1();
    repo.save(snap);
    expect(fs.existsSync(join(dir, "tasks", "task_001", "snapshot.json"))).toBe(true);
    expect(repo.load("task_001")).toEqual(snap);
  });

  it("round-trip 保留 blocked 结构化对象（#11）", () => {
    const snap = snapshotV1({
      patch: (s) => {
        s.task.state = TaskState.BLOCKED;
        s.task.blocked = {
          code: "E_CONTINUATION_EXHAUSTED",
          detail: "续跑轮数已达上限 3",
          occurred_at: "2026-11-05T11:00:00.000Z",
        };
      },
    });
    repo.save(snap);
    expect(repo.load("task_001").task.blocked).toEqual(snap.task.blocked);
  });
});

describe("snapshot.previous.json 只保留 1 代（#11）", () => {
  it("首次保存没有 previous；此后每次保存，previous 恰为上一代", () => {
    repo.save(snapshotV1({ id: "t", patch: (s) => { s.progress.summary = "v1"; } }));
    const prevPath = repo.previousFilePath("t");
    expect(fs.existsSync(prevPath)).toBe(false);

    repo.save(snapshotV1({ id: "t", patch: (s) => { s.progress.summary = "v2"; } }));
    expect((JSON.parse(fs.readFileSync(prevPath, "utf8")) as TaskSnapshotV1).progress.summary).toBe("v1");
    expect(repo.load("t").progress.summary).toBe("v2");

    repo.save(snapshotV1({ id: "t", patch: (s) => { s.progress.summary = "v3"; } }));
    expect((JSON.parse(fs.readFileSync(prevPath, "utf8")) as TaskSnapshotV1).progress.summary).toBe("v2");
    expect(repo.load("t").progress.summary).toBe("v3");
  });
});

describe("写入顺序：临时文件 → fsync → 原子 rename → DB transaction", () => {
  it("回调 commitDb 时当前文件已含新内容（rename 先于 DB）", () => {
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "old"; } }));
    const seen: string[] = [];
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "new"; } }), () => {
      seen.push(
        (JSON.parse(fs.readFileSync(repo.snapshotFilePath("task_001"), "utf8")) as TaskSnapshotV1)
          .progress.summary,
      );
    });
    seen.push("returned");
    expect(seen).toEqual(["new", "returned"]);
  });

  it("commitDb 抛错时文件已是新版（file-ahead-of-DB，§23.2 由上层对账）", () => {
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "old"; } }));
    expect(() =>
      repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "new"; } }), () => {
        throw new Error("db down");
      }),
    ).toThrow("db down");
    expect(repo.load("task_001").progress.summary).toBe("new");
  });
});

describe("半写模拟：rename 前中断进程（票 #12 验收）", () => {
  it("旧 snapshot 完整可用，不留损坏文件，临时文件被清理", () => {
    // 先建立两代：current=gen-A，previous=gen-0
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "gen-0"; } }));
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "gen-A"; } }));

    renameControl.fail = true;
    expect(() => repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "gen-B"; } }))).toThrow(
      "process killed before rename",
    );

    // 当前文件未被失败写入触碰；previous 在 rename 前已被推进为 current 的副本（仍是完整可用文件）
    expect(repo.load("task_001").progress.summary).toBe("gen-A");
    expect(
      (JSON.parse(fs.readFileSync(repo.previousFilePath("task_001"), "utf8")) as TaskSnapshotV1).progress
        .summary,
    ).toBe("gen-A");
    // 临时文件已被清理，不留半写残留
    expect(fs.existsSync(join(dir, "tasks", "task_001", "snapshot.json.tmp"))).toBe(false);

    // 解除中断后下一次写入正常：current=gen-B，previous 推进为 gen-A
    renameControl.fail = false;
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "gen-B"; } }));
    expect(repo.load("task_001").progress.summary).toBe("gen-B");
    expect(
      (JSON.parse(fs.readFileSync(repo.previousFilePath("task_001"), "utf8")) as TaskSnapshotV1).progress
        .summary,
    ).toBe("gen-A");
  });

  it("上次崩溃遗留的临时文件在下次保存前被清理", () => {
    const tmp = join(dir, "tasks", "task_001", "snapshot.json.tmp");
    fs.mkdirSync(join(dir, "tasks", "task_001"), { recursive: true });
    fs.writeFileSync(tmp, "garbage");
    repo.save(snapshotV1());
    expect(fs.existsSync(tmp)).toBe(false);
    expect(repo.load("task_001").schema_version).toBe(SNAPSHOT_SCHEMA_VERSION);
  });
});

describe("单写者并发保护", () => {
  it("连续多次写入后 current/previous 链始终完整可读，计数器单调", () => {
    for (let i = 1; i <= 20; i++) {
      repo.save(snapshotV1({ patch: (s) => { s.execution.continuation_count = i; } }));
      const loaded = repo.load("task_001");
      expect(loaded.execution.continuation_count).toBe(i);
      const prev = repo.previousFilePath("task_001");
      if (i > 1) {
        expect(
          (JSON.parse(fs.readFileSync(prev, "utf8")) as TaskSnapshotV1).execution.continuation_count,
        ).toBe(i - 1);
      }
    }
    // 目录里不积累任何临时/残留文件
    expect(fs.readdirSync(join(dir, "tasks", "task_001")).sort()).toEqual([
      "snapshot.json",
      "snapshot.previous.json",
    ]);
  });
});

describe("统一读取入口：inspect → migrate → validate（TDD §6.5 / #14 接口）", () => {
  it("当前文件损坏时回退 previous", () => {
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "good-prev"; } }));
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "good-cur"; } }));
    fs.writeFileSync(repo.snapshotFilePath("task_001"), "{broken json");
    const loaded = repo.load("task_001");
    expect(loaded.progress.summary).toBe("good-prev");
  });

  it("当前与 previous 都不可读时抛 E_SNAPSHOT_INVALID", () => {
    fs.mkdirSync(join(dir, "tasks", "task_001"), { recursive: true });
    fs.writeFileSync(repo.snapshotFilePath("task_001"), "{");
    fs.writeFileSync(repo.previousFilePath("task_001"), "}");
    expect(() => repo.load("task_001")).toThrow(SnapshotInvalidError);
  });

  it("文件缺失时抛 E_SNAPSHOT_INVALID", () => {
    expect(() => repo.load("missing")).toThrow(SnapshotInvalidError);
  });

  it("schema_version 比当前新时拒绝读取（不猜测未来格式）", () => {
    fs.mkdirSync(join(dir, "tasks", "task_001"), { recursive: true });
    const future = JSON.parse(JSON.stringify(snapshotV1())) as Record<string, unknown>;
    future.schema_version = 2;
    fs.writeFileSync(repo.snapshotFilePath("task_001"), JSON.stringify(future));
    expect(() => repo.load("task_001")).toThrow(SnapshotInvalidError);
  });

  it("注册的 migration 按版本串行执行，输出经同一校验（#14 挂载点）", () => {
    const v0ToV1: SnapshotMigration = {
      fromVersion: 0,
      toVersion: 1,
      migrate: (raw: RawSnapshot): RawSnapshot => {
        // 测试用假迁移：把 v0 骨架补成合法 v1
        const base = JSON.parse(JSON.stringify(snapshotV1({ id: "legacy" }))) as unknown as RawSnapshot;
        return base;
      },
    };
    const legacyRepo = new SnapshotRepository(dir, [v0ToV1]);
    fs.mkdirSync(join(dir, "tasks", "legacy"), { recursive: true });
    const v0: RawSnapshot = { schema_version: 0, note: "ancient" };
    fs.writeFileSync(legacyRepo.snapshotFilePath("legacy"), JSON.stringify(v0));
    const loaded = legacyRepo.load("legacy");
    expect(loaded.task.id).toBe("legacy");
  });

  it("迁移链缺一环时抛 E_SNAPSHOT_MIGRATION_FAILED（禁止跳版本）", () => {
    const halfRepo = new SnapshotRepository(dir, [
      { fromVersion: 0, toVersion: 1, migrate: (r) => r },
    ]);
    fs.mkdirSync(join(dir, "tasks", "old"), { recursive: true });
    // v(-1) 无对应迁移 → 断链
    fs.writeFileSync(halfRepo.snapshotFilePath("old"), JSON.stringify({ schema_version: -1 }));
    expect(() => halfRepo.load("old")).toThrow(SnapshotMigrationError);
  });
});

describe("schema 校验拒绝非法结构", () => {
  it("save 拒绝非法 Snapshot：不落盘、不改旧文件", () => {
    repo.save(snapshotV1({ patch: (s) => { s.progress.summary = "old"; } }));
    const bad = snapshotV1({ patch: (s) => { s.capacity.confidence = "MAGIC" as never; } });
    expect(() => repo.save(bad)).toThrow(SnapshotInvalidError);
    expect(repo.load("task_001").progress.summary).toBe("old");
  });

  it.each([
    ["confidence 非枚举", (s: TaskSnapshotV1) => { s.capacity.confidence = "MAGIC" as never; }],
    ["continuation_count 负数", (s: TaskSnapshotV1) => { s.execution.continuation_count = -1; }],
    ["continuation_count 非整数", (s: TaskSnapshotV1) => { s.execution.continuation_count = 1.5; }],
    ["state 非法", (s: TaskSnapshotV1) => { s.task.state = "NOT_A_STATE" as never; }],
    ["blocked 缺字段", (s: TaskSnapshotV1) => { s.task.blocked = { code: "X" } as never; }],
    ["model_override_by_user 非空非串", (s: TaskSnapshotV1) => { s.runtime.model_override_by_user = 3 as never; }],
    ["start_policy 非法", (s: TaskSnapshotV1) => { s.execution.start_policy = "SOMETIMES" as never; }],
    ["untracked_files 非数组", (s: TaskSnapshotV1) => { s.git.untracked_files = "x" as never; }],
  ])("validateSnapshotV1 拒绝：%s", (_name, patch) => {
    const s = snapshotV1();
    patch(s);
    expect(() => validateSnapshotV1(s)).toThrow(SnapshotInvalidError);
  });

  it("schema_version 非 1 时拒绝", () => {
    const s = snapshotV1() as unknown as Record<string, unknown>;
    s.schema_version = 0;
    expect(() => validateSnapshotV1(s)).toThrow(SnapshotInvalidError);
  });
});

describe("Windows 特殊路径（票 #12 验收）", () => {
  it("中文目录名 round-trip", () => {
    const cnDir = join(dir, "中文用户名目录", "代理容量编排器");
    const cnRepo = new SnapshotRepository(cnDir);
    const snap = snapshotV1({ patch: (s) => { s.objective.summary = "中文摘要：修复解析器"; } });
    cnRepo.save(snap);
    expect(cnRepo.load("task_001")).toEqual(snap);
    expect(fs.readFileSync(cnRepo.snapshotFilePath("task_001"), "utf8")).toContain("中文摘要");
  });

  it("超长路径（>260 字符，\\\\?\\ 前缀）round-trip", () => {
    const deep = join(dir, ...Array.from({ length: 16 }, (_, i) => `层级目录${i}一些较长的中文与字母片段`));
    expect(deep.length).toBeGreaterThan(200);
    const longBase = `\\\\?\\${deep}`;
    const longRepo = new SnapshotRepository(longBase);
    const snap = snapshotV1({ patch: (s) => { s.objective.summary = "long path ok"; } });
    longRepo.save(snap);
    expect(longRepo.load("task_001")).toEqual(snap);
  });
});
