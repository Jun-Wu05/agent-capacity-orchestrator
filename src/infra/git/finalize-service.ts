import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFileSync, existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

import { DomainError } from "../../domain/errors.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/** 与 Checkpoint/Worktree 一致的 ref 安全 taskId 白名单（防 ref 注入）。 */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const BRANCH_PREFIX = "aco/task/";
const CHECKPOINT_REF_PREFIX = "refs/aco/checkpoints/";

/** §6.4 FINAL_COMMIT_CREATED 事件载荷（真实 Snapshot 落盘随 #15 接线）。 */
export interface FinalCommitCreatedEvent {
  type: "FINAL_COMMIT_CREATED";
  taskId: string;
  worktreePath: string;
  branchName: string;
  /** 最终正常 commit；用户可读历史的唯二主角之一（另一个是接管时 HEAD）。 */
  finalCommit: string;
  /** squash 基准：checkpoint 的第一父提交 = 接管时的用户 HEAD（P0-05 §6）。 */
  baselineCommit: string;
  finalTree: string;
  message: string;
  createdAt: string;
}

/** §6.4 TASK_COMPLETED 事件载荷。 */
export interface TaskCompletedEvent {
  type: "TASK_COMPLETED";
  taskId: string;
  worktreePath: string;
  branchName: string;
  /** 净零改动时为 null（不造空提交）。 */
  finalCommit: string | null;
  completedAt: string;
}

export interface FinalizeResult {
  taskId: string;
  worktreePath: string;
  branchName: string;
  checkpointCommit: string;
  /** checkpoint 的第一父提交 = 接管时的用户 HEAD。 */
  baselineCommit: string;
  /** 最终正常 commit；净零改动时不创建空提交，为 null。 */
  finalCommit: string | null;
  finalTree: string;
  /** §12.5：worktree 不物理删除，进入可清理状态（为 `aco cleanup` 预留）。 */
  cleanupReady: boolean;
}

export interface FinalizeOptions {
  /** 最终提交信息；缺省 `aco: finalize task <taskId>`。 */
  message?: string;
}

export interface FinalizeServiceOptions {
  /** 最终提交创建成功后的事件 port（§6.4 FINAL_COMMIT_CREATED）。 */
  onFinalCommitCreated?: (event: FinalCommitCreatedEvent) => void | Promise<void>;
  /** 任务完成后的事件 port（§6.4 TASK_COMPLETED）。 */
  onTaskCompleted?: (event: TaskCompletedEvent) => void | Promise<void>;
}

/** finalize 失败（TDD §24：FINALIZING + FINALIZE_FAILED → BLOCKED）。 */
export class FinalizeError extends DomainError {
  readonly code = "E_FINALIZE_FAILED";

  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
  }
}

/**
 * Finalize 流程（TDD §12.5，squash 基准按 P0-05 §6 实测结论）。
 *
 * 在 isolated worktree 内完成，绝不触碰用户原仓库与 checkpoint ref：
 *
 *   1. 前置校验：taskId 合法、目标是 linked worktree、分支 = aco/task/<task-id>、
 *      checkpointCommit 存在且带父提交（是 ACO checkpoint 结构）；
 *   2. 临时 index（GIT_INDEX_FILE）+ add -A + write-tree 固化 worktree
 *      全量内容（tracked + untracked，ignored 由 .gitignore 天然排除）；
 *   3. 与 baseline（checkpoint^1）的树比较：净零改动不造空提交；
 *   4. commit-tree <finalTree> -p <baseline> → 最终正常 commit，
 *      `reset --hard` 让分支 / index / 工作区三者一致；
 *   5. 触发 FINAL_COMMIT_CREATED、TASK_COMPLETED（§6.4 事件 port）；
 *   6. worktree 不物理删除（cleanupReady），checkpoint ref 原样保留作恢复锚点。
 *
 * V0.1 不自动 merge 回用户分支；任何一步 git 失败 → E_FINALIZE_FAILED，
 * 此时分支出未被移动、worktree 与 checkpoint ref 完好，现场可恢复。
 */
export class FinalizeService {
  constructor(private readonly options: FinalizeServiceOptions = {}) {}

  async finalize(
    worktreePath: string,
    taskId: string,
    checkpointCommit: string,
    options: FinalizeOptions = {},
  ): Promise<FinalizeResult> {
    if (!TASK_ID_PATTERN.test(taskId) || taskId.includes("..")) {
      throw new FinalizeError(`非法 taskId，无法用作分支名：${taskId}`);
    }
    const branchName = `${BRANCH_PREFIX}${taskId}`;
    const message = options.message ?? `aco: finalize task ${taskId}`;

    if (!existsSync(worktreePath)) {
      throw new FinalizeError(`worktree 路径不存在：${worktreePath}`);
    }

    // 必须是 linked worktree，拒绝把用户主仓库检出当 finalize 对象
    const gitDir = await this.runGit(worktreePath, ["rev-parse", "--absolute-git-dir"]);
    const commonDir = await this.runGit(worktreePath, ["rev-parse", "--git-common-dir"]);
    if (gitDir === commonDir) {
      throw new FinalizeError(
        `目标不是 isolated worktree（疑似主仓库检出），拒绝 finalize：${worktreePath}`,
      );
    }

    // 分支必须匹配：finalize 只允许整理本任务的分支
    const currentBranch = await this.runGit(worktreePath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (currentBranch !== branchName) {
      throw new FinalizeError(
        `worktree 当前分支为 ${currentBranch}，与期望的 ${branchName} 不匹配，拒绝 finalize`,
      );
    }

    // checkpoint 结构校验：存在，且第一父提交存在（= 接管时用户 HEAD）
    if (
      !(await this.runQuiet(worktreePath, [
        "rev-parse",
        "--verify",
        "--quiet",
        `${checkpointCommit}^{commit}`,
      ]))
    ) {
      throw new FinalizeError(`checkpoint 提交不存在：${checkpointCommit}`);
    }
    let baselineCommit: string;
    try {
      baselineCommit = await this.runGit(worktreePath, ["rev-parse", `${checkpointCommit}^1`]);
    } catch {
      throw new FinalizeError(
        `${checkpointCommit} 不是 ACO checkpoint（无父提交），拒绝以它为 squash 基准`,
      );
    }

    // 未合并冲突必须显式拒绝：git add -A 会把 unmerged 路径按工作区内容
    // “就地解决”，不拦截就会把冲突标记静默提交进最终 commit。
    const unmerged = await this.runGit(worktreePath, [
      "diff",
      "--name-only",
      "--diff-filter=U",
    ]);
    if (unmerged !== "") {
      throw new FinalizeError(
        `worktree 存在未合并冲突，先解决再 finalize：${unmerged.split("\n").join("、")}`,
      );
    }

    // 临时 index 固化 worktree 全量内容（算法与 #17 checkpoint 同源，P0-05 §3）
    const tmpIndex = join(gitDir, `aco-finalize-index-${randomUUID()}`);
    const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
    let finalTree: string;
    try {
      const userIndex = join(gitDir, "index");
      if (existsSync(userIndex)) {
        copyFileSync(userIndex, tmpIndex);
      }
      await this.runGit(worktreePath, ["add", "-A"], env);
      finalTree = await this.runGit(worktreePath, ["write-tree"], env);
    } catch (error) {
      // 含冲突（unmerged）等无法固化的现场：分支出未动，现场可恢复
      throw new FinalizeError(
        `固化 worktree 最终内容失败，分支未被移动，可从 checkpoint 恢复：${errorMessage(error)}`,
        { cause: error },
      );
    } finally {
      rmSync(tmpIndex, { force: true });
    }

    const baselineTree = await this.runGit(worktreePath, ["rev-parse", `${baselineCommit}^{tree}`]);
    let finalCommit: string | null = null;
    if (finalTree !== baselineTree) {
      finalCommit = await this.runGit(
        worktreePath,
        ["commit-tree", finalTree, "-p", baselineCommit, "-m", message],
      ).catch((error) => {
        throw new FinalizeError(`创建最终提交失败：${errorMessage(error)}`, { cause: error });
      });

      // 分支 / index / 工作区三者同步到最终提交（内容与固化树一致，不会丢文件）
      await this.runGit(worktreePath, ["reset", "--hard", finalCommit]).catch((error) => {
        throw new FinalizeError(
          `最终提交 ${finalCommit} 已创建但 worktree 同步失败：${errorMessage(error)}`,
          { cause: error },
        );
      });

      await this.options.onFinalCommitCreated?.({
        type: "FINAL_COMMIT_CREATED",
        taskId,
        worktreePath,
        branchName,
        finalCommit,
        baselineCommit,
        finalTree,
        message,
        createdAt: new Date().toISOString(),
      });
    }

    await this.options.onTaskCompleted?.({
      type: "TASK_COMPLETED",
      taskId,
      worktreePath,
      branchName,
      finalCommit,
      completedAt: new Date().toISOString(),
    });

    return {
      taskId,
      worktreePath,
      branchName,
      checkpointCommit,
      baselineCommit,
      finalCommit,
      finalTree,
      cleanupReady: true,
    };
  }

  private async runGit(
    cwd: string,
    args: string[],
    env: NodeJS.ProcessEnv = process.env,
  ): Promise<string> {
    try {
      const { stdout } = await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER, env });
      return stdout.trim();
    } catch (error) {
      if (error instanceof DomainError) throw error;
      throw new FinalizeError(`git ${args[0] ?? ""} 执行失败：${errorMessage(error)}`, {
        cause: error,
      });
    }
  }

  /** exit 0 → true；非零 → false（不抛）。 */
  private async runQuiet(cwd: string, args: string[]): Promise<boolean> {
    try {
      await execFileAsync("git", args, { cwd, maxBuffer: MAX_BUFFER });
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

// 未使用常量前缀导出预留：aco cleanup（后续票）需要按前缀枚举 task 分支与 checkpoint ref
export { BRANCH_PREFIX, CHECKPOINT_REF_PREFIX };
