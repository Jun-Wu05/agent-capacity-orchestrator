import { DatabaseSync } from "node:sqlite";

/**
 * 当前 DB schema 版本（TDD §7.2）。
 * schema 变更必须递增此版本并在 initSchema 中以幂等方式补齐；
 * Snapshot 文件自身的 migration 框架是另一回事（#14），不在此处。
 */
export const DB_SCHEMA_VERSION = 1;

/**
 * 打开 Task 数据库并应用连接参数（TDD §7.3）：
 * - WAL：读连接不被未提交写事务阻塞；
 * - foreign_keys=ON：task_events 的外键真正生效；
 * - busy_timeout=5000：写锁争用时等待而非立即抛 SQLITE_BUSY。
 */
export function openTaskDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * 幂等建表（TDD §7.2）。重复调用（包括新连接）不报错、不重复记录版本。
 *
 * 与 §7.2 原文的差异（随 #10 决策同步）：tasks.retry_count 拆为
 * continuation_count + transient_retry_count 两个独立计数器。
 */
export function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (
      id TEXT PRIMARY KEY,
      agent TEXT NOT NULL,
      state TEXT NOT NULL,
      project_root TEXT NOT NULL,
      worktree_path TEXT,
      branch_name TEXT,
      session_id TEXT,
      snapshot_path TEXT NOT NULL,
      snapshot_version INTEGER NOT NULL,
      start_policy TEXT NOT NULL,
      continuation_count INTEGER NOT NULL DEFAULT 0,
      transient_retry_count INTEGER NOT NULL DEFAULT 0,
      next_check_at TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_tasks_next_check_at ON tasks (next_check_at);

    CREATE TABLE IF NOT EXISTS task_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      task_id TEXT NOT NULL,
      event_type TEXT NOT NULL,
      payload_json TEXT,
      created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES tasks(id)
    );

    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  db.prepare("INSERT OR IGNORE INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
    DB_SCHEMA_VERSION,
    new Date().toISOString(),
  );
}
