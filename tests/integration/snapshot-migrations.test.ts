import * as fs from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  SnapshotInvalidError,
  SnapshotMigrationError,
  SnapshotRepository,
  validateSnapshotV1,
  type SnapshotMigration,
  type SnapshotSchemaLevel,
  type TaskSnapshotV1,
} from "../../src/infra/persistence/snapshot-repository.js";
import {
  SNAPSHOT_MIGRATIONS,
  createDefaultSnapshotRepository,
} from "../../src/infra/persistence/snapshot-migrations.js";

const repoRoot = join(import.meta.dirname, "..", "..");
const fixtureV1Path = join(repoRoot, "tests", "fixtures", "snapshots", "v1-task-fixture-001.json");

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(join(repoRoot, ".test-tmp-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** 把 fixture v1 复制进临时仓库的 tasks/<id>/snapshot.json。 */
function seedFromFixture(taskId = "task_fixture_001"): void {
  const snapDir = join(dir, "tasks", taskId);
  fs.mkdirSync(snapDir, { recursive: true });
  fs.copyFileSync(fixtureV1Path, join(snapDir, "snapshot.json"));
}

function readFixture(): TaskSnapshotV1 {
  return JSON.parse(fs.readFileSync(fixtureV1Path, "utf8")) as TaskSnapshotV1;
}

describe("默认仓库与空注册表（生产入口）", () => {
  it("SNAPSHOT_MIGRATIONS 当前为空：v1 文件直接通过 v1 校验，迁移循环不执行", () => {
    expect(SNAPSHOT_MIGRATIONS).toEqual([]);
    seedFromFixture();
    const repo = createDefaultSnapshotRepository(dir);
    const loaded = repo.load("task_fixture_001");
    expect(loaded.task.id).toBe("task_fixture_001");
    expect(loaded.schema_version).toBe(1);
  });

  it("v1 文件 + 默认仓库 round-trip 后字段与 fixture 一致", () => {
    seedFromFixture();
    const loaded = createDefaultSnapshotRepository(dir).load("task_fixture_001");
    expect(loaded).toEqual(readFixture());
  });
});

describe("v1→v2 假想迁移（fixture 驱动，票 #14 验收）", () => {
  /** 假想 v2 = v1 + 必填 `runtime.ui_locale`；校验器复用 v1 校验并传版本标签 2。 */
  function validateSnapshotV2(value: unknown): TaskSnapshotV1 {
    const snapshot = validateSnapshotV1(value, 2);
    const runtime = (value as Record<string, unknown>).runtime as Record<string, unknown>;
    if (typeof runtime.ui_locale !== "string") {
      throw new SnapshotInvalidError("snapshot.runtime.ui_locale: v2 要求必填字符串");
    }
    return snapshot;
  }

  const V2_LEVEL: SnapshotSchemaLevel = { version: 2, validate: validateSnapshotV2 };

  /** 假想迁移：补缺省值并递增版本；缺省值在 migrate 里补齐，不在校验器里兜底。 */
  const v1ToV2: SnapshotMigration = {
    fromVersion: 1,
    toVersion: 2,
    migrate: (raw) =>
      ({
        ...raw,
        schema_version: 2,
        runtime: { ...(raw.runtime as Record<string, unknown>), ui_locale: "zh-CN" },
      }) as Parameters<SnapshotMigration["migrate"]>[0],
  };

  it("读取 v1 fixture → 串行迁移 → v2 校验 → 返回已升级结构", () => {
    seedFromFixture();
    const repo = new SnapshotRepository(dir, [v1ToV2], V2_LEVEL);
    const loaded = repo.load("task_fixture_001");
    expect(loaded.schema_version).toBe(2);
    expect((loaded.runtime as unknown as Record<string, unknown>).ui_locale).toBe("zh-CN");
    // 其余字段原样保留
    expect(loaded.task.id).toBe("task_fixture_001");
    expect(loaded.execution.continuation_count).toBe(1);
  });

  it("升级后不删除旧 Snapshot：save 推进 current，previous 仍保存 v1 原文，fixture 不被触碰", () => {
    seedFromFixture();
    const repo = new SnapshotRepository(dir, [v1ToV2], V2_LEVEL);
    const migrated = repo.load("task_fixture_001");
    repo.save(migrated as unknown as TaskSnapshotV1);

    const current = JSON.parse(
      fs.readFileSync(repo.snapshotFilePath("task_fixture_001"), "utf8"),
    ) as Record<string, unknown>;
    expect(current.schema_version).toBe(2);

    const previous = JSON.parse(
      fs.readFileSync(repo.previousFilePath("task_fixture_001"), "utf8"),
    ) as Record<string, unknown>;
    expect(previous.schema_version).toBe(1);
    expect(previous).toEqual(readFixture());

    // fixture 样例文件本身不被任何测试写入改动
    expect(readFixture().schema_version).toBe(1);
  });

  it("负路径 1：跳版本（v1 文件 + 只有 2→3 迁移）→ 拒绝使用并给中文错误", () => {
    seedFromFixture();
    const repo = new SnapshotRepository(
      dir,
      [{ fromVersion: 2, toVersion: 3, migrate: (r) => r }],
      { version: 3, validate: (v) => validateSnapshotV1(v, 3) },
    );
    try {
      repo.load("task_fixture_001");
      expect.unreachable("必须拒绝使用 snapshot");
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotMigrationError);
      expect((err as Error).message).toContain("禁止跳版本");
      expect((err as SnapshotMigrationError).code).toBe("E_SNAPSHOT_MIGRATION_FAILED");
    }
  });

  it("负路径 2：迁移执行失败 → 即停（E_SNAPSHOT_MIGRATION_FAILED 中文错误），不回退 previous、不继续", () => {
    seedFromFixture();
    // previous 也放一份合法 v1：证明失败不靠回退掩盖，而是直接停止
    fs.copyFileSync(
      fixtureV1Path,
      join(dir, "tasks", "task_fixture_001", "snapshot.previous.json"),
    );
    const boom = new Error("disk corrupt mid-migration");
    const repo = new SnapshotRepository(
      dir,
      [
        {
          fromVersion: 1,
          toVersion: 2,
          migrate: () => {
            throw boom;
          },
        },
      ],
      V2_LEVEL,
    );
    try {
      repo.load("task_fixture_001");
      expect.unreachable("必须拒绝使用 snapshot");
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotMigrationError);
      expect((err as Error).message).toContain("迁移失败");
      expect((err as Error).message).toContain("不得带病继续");
      expect((err as SnapshotMigrationError).cause).toBe(boom);
    }
  });

  it("默认仓库（v1）读到 schema_version 2 的文件 → 版本过新，拒绝并给中文错误", () => {
    seedFromFixture();
    const path = join(dir, "tasks", "task_fixture_001", "snapshot.json");
    const future = JSON.parse(fs.readFileSync(path, "utf8")) as Record<string, unknown>;
    future.schema_version = 2;
    fs.writeFileSync(path, JSON.stringify(future));
    try {
      createDefaultSnapshotRepository(dir).load("task_fixture_001");
      expect.unreachable("必须拒绝使用 snapshot");
    } catch (err) {
      expect(err).toBeInstanceOf(SnapshotInvalidError);
      expect((err as Error).message).toContain("版本过新");
    }
  });
});
