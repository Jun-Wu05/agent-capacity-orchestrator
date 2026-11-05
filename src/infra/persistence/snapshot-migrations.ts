import {
  SnapshotRepository,
  type SnapshotMigration,
} from "./snapshot-repository.js";

/**
 * Snapshot schema 迁移注册表（TDD §6.5，票 #14）。
 *
 * 当前程序版本 = schema v1，尚无历史版本需要迁移，注册表为空；
 * 读取 v1 文件时框架的迁移循环体不执行，直接进入 v1 校验。
 *
 * ## 未来新增一代（假设升到 v2）的标准步骤
 *
 * 1. `snapshot-repository.ts`：`SNAPSHOT_SCHEMA_VERSION` 递增为 2；
 * 2. `snapshot-repository.ts`：新增 `TaskSnapshotV2` 类型与 `validateSnapshotV2`
 *    （结构同构时可复用 `validateSnapshotV1(raw, 2)` 再补新字段检查），
 *    并定义 `SNAPSHOT_SCHEMA_V2: SnapshotSchemaLevel`；
 * 3. 在本数组**按序**追加一步：`{ fromVersion: 1, toVersion: 2, migrate }`，
 *    `migrate` 必须产出能通过 v2 校验的结构（缺省值在 migrate 里补齐，禁止在校验器里兜底）；
 * 4. fixture 样例文件放 `tests/fixtures/snapshots/`（v1 原样保留，用于回归）；
 * 5. 旧版本文件**不删除**：升级发生在读取时（内存中），落盘仍由 save 走
 *    current/previous 链，旧版 Snapshot 自然保留在 previous 一代里。
 *
 * 框架保证（#14 验收）：禁止跳版本（断链即 `E_SNAPSHOT_MIGRATION_FAILED`）、
 * 单步失败即停（包装为 `E_SNAPSHOT_MIGRATION_FAILED`，上层据此置 BLOCKED）。
 */
export const SNAPSHOT_MIGRATIONS: SnapshotMigration[] = [];

/** 生产入口：注入完整迁移注册表的默认 Snapshot 仓库。 */
export function createDefaultSnapshotRepository(baseDir: string): SnapshotRepository {
  return new SnapshotRepository(baseDir, SNAPSHOT_MIGRATIONS);
}
