import { execFile } from "node:child_process";
import { normalize } from "node:path";
import { promisify } from "node:util";

import { GitNotRepositoryError } from "../../domain/errors.js";

const execFileAsync = promisify(execFile);

const MAX_BUFFER = 64 * 1024 * 1024;

/** 三桶计数（Snapshot §6.3 git 节的 dirty_summary）。 */
export interface DirtySummary {
  staged: number;
  unstaged: number;
  untracked: number;
  ignored: number;
}

/** porcelain=v2 解析结果：三桶 + ignored 桶与计数。 */
export interface PorcelainBuckets {
  stagedFiles: string[];
  unstagedFiles: string[];
  untrackedFiles: string[];
  ignoredFiles: string[];
  dirtySummary: DirtySummary;
}

/** captureDirtyState 的完整输出：解析结果 + 仓库根。 */
export interface DirtyState extends PorcelainBuckets {
  repoRoot: string;
}

/**
 * 解析 `git status --porcelain=v2 --ignored -z` 输出（NUL 分隔）。
 *
 * 纯函数，无 I/O。使用 -z 模式：路径不转义不引号，含空格路径按
 * “固定字段数 + 余下整体为路径”切分；rename（2 开头）条目后跟
 * origPath 独立 token，被消费不泄漏。XY 第一位是 index 状态（staged），
 * 第二位是 worktree 状态（unstaged），'.' 表示无变化。
 */
export function parsePorcelainV2(output: Buffer | string): PorcelainBuckets {
  const stagedFiles: string[] = [];
  const unstagedFiles: string[] = [];
  const untrackedFiles: string[] = [];
  const ignoredFiles: string[] = [];

  const text = typeof output === "string" ? output : output.toString("utf8");
  const tokens = text.split("\0");

  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (token === undefined || token === "") continue;

    const kind = token.slice(0, 2);
    if (kind === "? " || kind === "! ") {
      const path = token.slice(2);
      if (path === "") continue;
      if (kind === "? ") untrackedFiles.push(path);
      else ignoredFiles.push(path);
      continue;
    }
    if (token.startsWith("#")) continue;

    if (kind === "1 " || kind === "2 " || kind === "u ") {
      const fields = token.split(" ");
      const xy = fields[1] ?? "";
      let path: string;
      if (kind === "1 ") {
        path = fields.slice(8).join(" ");
      } else if (kind === "2 ") {
        path = fields.slice(9).join(" ");
        i++; // 消费紧随其后的 origPath token
      } else {
        path = fields.slice(10).join(" ");
      }
      if (path === "") continue;
      const x = xy.charAt(0);
      const y = xy.charAt(1);
      if (x !== "" && x !== ".") stagedFiles.push(path);
      if (y !== "" && y !== ".") unstagedFiles.push(path);
    }
  }

  return {
    stagedFiles,
    unstagedFiles,
    untrackedFiles,
    ignoredFiles,
    dirtySummary: {
      staged: stagedFiles.length,
      unstaged: unstagedFiles.length,
      untracked: untrackedFiles.length,
      ignored: ignoredFiles.length,
    },
  };
}

interface ExecError {
  stderr?: string | Buffer;
}

function isNotRepositoryError(error: unknown): boolean {
  const stderr = (error as ExecError | null)?.stderr;
  const text = typeof stderr === "string" ? stderr : stderr?.toString("utf8") ?? "";
  return text.includes("not a git repository");
}

/**
 * 接管前检查（TDD §12.1）：
 * - detectRepo：rev-parse --show-toplevel，非 git repo 抛 GitNotRepositoryError；
 * - captureDirtyState：status --porcelain=v2 --ignored -z 三桶捕获，
 *   输出结构对齐 Snapshot §6.3 git 节（dirty_summary + 文件清单）。
 */
export class GitService {
  async detectRepo(cwd: string): Promise<string> {
    let stdout: string;
    try {
      const result = await execFileAsync("git", ["rev-parse", "--show-toplevel"], {
        cwd,
        maxBuffer: MAX_BUFFER,
      });
      stdout = result.stdout;
    } catch (error) {
      if (isNotRepositoryError(error)) {
        throw new GitNotRepositoryError(cwd);
      }
      throw error;
    }
    return normalize(stdout.trim());
  }

  async captureDirtyState(repoRoot: string): Promise<DirtyState> {
    const toplevel = await this.detectRepo(repoRoot);
    const { stdout } = await execFileAsync(
      "git",
      ["status", "--porcelain=v2", "--ignored", "-z"],
      { cwd: repoRoot, maxBuffer: MAX_BUFFER },
    );
    return { repoRoot: toplevel, ...parsePorcelainV2(stdout) };
  }
}
