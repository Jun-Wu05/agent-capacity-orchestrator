import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { DomainError } from "../../domain/errors.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/** 与 CheckpointService 一致的 ref 安全 taskId 白名单（防 ref 注入）。 */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * worktree 根目录（TDD §12.4）：Windows 用 %LOCALAPPDATA%，
 * 非 Windows 退回用户主目录（Windows-first 但不硬编码平台）。
 */
export function defaultWorktreesBaseDir(): string {
  const localAppData = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(localAppData, "AgentCapacityOrchestrator", "worktrees");
}

/** §6.4 WORKTREE_CREATED 事件载荷（真实落盘随 #12/#15 接线）。 */
export interface WorktreeCreatedEvent {
  type: "WORKTREE_CREATED";
  taskId: string;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  checkpointCommit: string;
  createdAt: string;
}

export interface WorktreeInfo {
  taskId: string;
  repoRoot: string;
  worktreePath: string;
  branchName: string;
  checkpointCommit: string;
}

export interface WorktreeServiceOptions {
  /** 默认 defaultWorktreesBaseDir()；测试注入临时目录。 */
  worktreesBaseDir?: string;
  /** 创建成功后的事件 port（§6.4 WORKTREE_CREATED）。 */
  onWorktreeCreated?: (event: WorktreeCreatedEvent) => void | Promise<void>;
}

/** worktree 创建失败（E_WORKTREE_FAILED，TDD §24）。 */
export class WorktreeError extends DomainError {
  readonly code = "E_WORKTREE_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Isolated worktree 创建（TDD §12.4，ADR 0002 / 0003）。
 *
 * `git worktree add -b aco/task/<task-id> <base>/<task-id> <checkpoint>`
 * —— worktree 即后续 `codex exec resume` 的 cwd。
 * 同 task-id 重复创建（目录或分支已存在）一律走错误路径，绝不覆盖。
 */
export class WorktreeService {
  private readonly baseDir: string;

  constructor(private readonly options: WorktreeServiceOptions = {}) {
    this.baseDir = options.worktreesBaseDir ?? defaultWorktreesBaseDir();
  }

  async createWorktree(
    repoRoot: string,
    taskId: string,
    checkpointCommit: string,
  ): Promise<WorktreeInfo> {
    if (!TASK_ID_PATTERN.test(taskId) || taskId.includes("..")) {
      throw new WorktreeError(`非法 taskId，无法用作分支名：${taskId}`);
    }

    const branchName = `aco/task/${taskId}`;
    const worktreePath = join(this.baseDir, taskId);

    if (existsSync(worktreePath)) {
      throw new WorktreeError(`worktree 路径已存在，拒绝覆盖：${worktreePath}`);
    }

    // 分支已存在（目录空闲）也是重复创建，走错误路径
    const branchExists = await this.runQuiet(repoRoot, [
      "rev-parse",
      "--verify",
      "--quiet",
      `refs/heads/${branchName}`,
    ]);
    if (branchExists) {
      throw new WorktreeError(`分支已存在，拒绝覆盖：${branchName}`);
    }

    try {
      await execFileAsync(
        "git",
        ["worktree", "add", "-b", branchName, worktreePath, checkpointCommit],
        { cwd: repoRoot, maxBuffer: MAX_BUFFER },
      );
    } catch (error) {
      throw new WorktreeError(
        `创建 worktree 失败（${worktreePath}）：${errorMessage(error)}`,
        { cause: error },
      );
    }

    const info: WorktreeInfo = {
      taskId,
      repoRoot,
      worktreePath,
      branchName,
      checkpointCommit,
    };

    await this.options.onWorktreeCreated?.({
      type: "WORKTREE_CREATED",
      ...info,
      createdAt: new Date().toISOString(),
    });

    return info;
  }

  /** exit 0 → true；非零 → false（不抛）。 */
  private async runQuiet(repoRoot: string, args: string[]): Promise<boolean> {
    try {
      await execFileAsync("git", args, { cwd: repoRoot, maxBuffer: MAX_BUFFER });
      return true;
    } catch {
      return false;
    }
  }
}

function errorMessage(error: unknown): string {
  const stderr = (error as { stderr?: string | Buffer } | null)?.stderr;
  if (typeof stderr === "string" && stderr !== "") return stderr.trim();
  if (stderr instanceof Buffer && stderr.length > 0) return stderr.toString("utf8").trim();
  return String(error);
}
