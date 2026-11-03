import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { DomainError } from "../../domain/errors.js";
import { GitService, parsePorcelainV2, type DirtySummary } from "./git-service.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface CheckpointResult {
  taskId: string;
  repoRoot: string;
  originalHead: string;
  /** refs/aco/checkpoints/<task-id>，不进分支列表，可作为长期恢复锚点（P0-05 §5）。 */
  checkpointRef: string;
  checkpointCommit: string;
  /** 双父提交之二：用户 staged 状态（P0-05 §3）。 */
  stagedCommit: string;
  stagedTree: string;
  fullTree: string;
  /** staged/unstaged 语义摘要（§12.2，来自 #16 的捕获）。 */
  dirtySummary: DirtySummary;
  /** §12.3：存在 ignored 文件时的中文提醒；无则 null。 */
  ignoredReminder: string | null;
}

/** checkpoint 创建失败（E_CHECKPOINT_FAILED，TDD §24）。 */
export class CheckpointError extends DomainError {
  readonly code = "E_CHECKPOINT_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Checkpoint commit 无损迁移（TDD §12.2 / §12.3，算法按 P0-05 实测结论）。
 *
 * 核心机制：临时 index（GIT_INDEX_FILE 指向 .git 内的 index 副本），
 * 全程不碰用户的 HEAD、.git/index、工作区与 stash：
 *
 *   copy .git/index → tmpIdx
 *   write-tree              → stagedTree（用户 staged 状态）
 *   add -A + write-tree     → fullTree（tracked+untracked 全量，遵守 .gitignore）
 *   commit-tree stagedTree -p HEAD               → stagedCommit
 *   commit-tree fullTree -p HEAD -p stagedCommit → checkpoint
 *   update-ref refs/aco/checkpoints/<task-id>
 *
 * 换行沿用用户 autocrlf / .gitattributes（P0-05 §4.4 硬约束）；
 * ignored 文件默认不迁移，存在时返回中文提醒（§12.3）。
 */
export class CheckpointService {
  constructor(private readonly gitService: GitService = new GitService()) {}

  async createCheckpoint(repoRoot: string, taskId: string): Promise<CheckpointResult> {
    if (!TASK_ID_PATTERN.test(taskId) || taskId === ".." || taskId.includes("..")) {
      throw new CheckpointError(`非法 taskId，无法用作 checkpoint ref 名：${taskId}`);
    }

    const originalHead = await this.runGit(repoRoot, ["rev-parse", "HEAD"]);

    const dirtyState = await this.gitService.captureDirtyState(repoRoot);

    const gitDir = await this.runGit(repoRoot, ["rev-parse", "--absolute-git-dir"]);
    const tmpIndex = join(gitDir, `aco-index-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };

    try {
      const userIndex = join(gitDir, "index");
      if (existsSync(userIndex)) {
        copyFileSync(userIndex, tmpIndex);
      }

      // 用户 staged 状态快照
      const stagedTree = await this.runGit(repoRoot, ["write-tree"], env);

      // 全量快照：tracked + untracked；ignored 由 .gitignore 天然排除
      await this.runGit(repoRoot, ["add", "-A"], env);
      const fullTree = await this.runGit(repoRoot, ["write-tree"], env);

      // 捕获完整性校验（§12.2 “确认可重建现场”）：临时 index 视角下
      // 不应再有 untracked 或 unstaged 残留，否则 checkpoint 不完整。
      const statusOut = await this.runGit(
        repoRoot,
        ["status", "--porcelain=v2", "-z"],
        env,
      );
      const capture = parsePorcelainV2(statusOut);
      if (capture.untrackedFiles.length > 0 || capture.unstagedFiles.length > 0) {
        throw new CheckpointError(
          `checkpoint 捕获不完整：仍有 ${capture.untrackedFiles.length} 个 untracked 与 ${capture.unstagedFiles.length} 个 unstaged 文件未纳入`,
        );
      }

      // 双父提交：原 HEAD + staged 提交（结构类似 stash，但不占用户 stash 列表）
      const stagedCommit = await this.runGit(
        repoRoot,
        ["commit-tree", stagedTree, "-p", originalHead, "-m", "aco: staged state"],
      );
      const checkpointCommit = await this.runGit(
        repoRoot,
        [
          "commit-tree",
          fullTree,
          "-p",
          originalHead,
          "-p",
          stagedCommit,
          "-m",
          `aco: checkpoint ${taskId}`,
        ],
      );

      const checkpointRef = `refs/aco/checkpoints/${taskId}`;
      await this.runGit(repoRoot, ["update-ref", checkpointRef, checkpointCommit]);

      return {
        taskId,
        repoRoot,
        originalHead,
        checkpointRef,
        checkpointCommit,
        stagedCommit,
        stagedTree,
        fullTree,
        dirtySummary: dirtyState.dirtySummary,
        ignoredReminder: buildIgnoredReminder(dirtyState.ignoredFiles),
      };
    } finally {
      rmSync(tmpIndex, { force: true });
    }
  }

  private async runGit(
    repoRoot: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, {
        cwd: repoRoot,
        maxBuffer: MAX_BUFFER,
        env,
      });
      return stdout.trim();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new CheckpointError(`git ${args[0] ?? ""} 执行失败：${String(error)}`, {
        cause: error,
      });
    }
  }
}

function buildIgnoredReminder(ignoredFiles: string[]): string | null {
  if (ignoredFiles.length === 0) return null;
  const sample = ignoredFiles.slice(0, 10).join("、");
  const suffix = ignoredFiles.length > 10 ? ` 等 ${ignoredFiles.length} 个` : "";
  return (
    `存在被 .gitignore 忽略的文件未随 checkpoint 迁移（${sample}${suffix}）。` +
    "如任务运行需要这些文件，请手动处理；ACO 不会自动复制忽略文件。"
  );
}
