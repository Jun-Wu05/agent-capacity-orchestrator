import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointService } from "../../src/infra/git/checkpoint-service.js";
import {
  commitFile,
  git,
  initRepo,
  recheckout,
  write,
} from "../fixtures/git-repos/builder.js";

const workspaceRoot = join(import.meta.dirname, "..", "..", "..");

let dir: string;
let service: CheckpointService;

/** git 的 objects 文件是只读的，Windows 下 rmSync 需要先清只读位。 */
function rmForce(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true });
  } catch {
    const clearReadOnly = (p: string): void => {
      for (const entry of readdirSync(p)) {
        const child = join(p, entry);
        if (statSync(child).isDirectory()) clearReadOnly(child);
        else chmodSync(child, 0o666);
      }
    };
    clearReadOnly(path);
    rmSync(path, { recursive: true, force: true });
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

/** 全仓库字节快照（排除 .git 内容，但单独包含 .git/index）。 */
function snapshotFiles(repo: string): Map<string, string> {
  const files = new Map<string, string>();
  const walk = (current: string): void => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const child = join(current, entry.name);
      if (entry.isDirectory()) walk(child);
      else files.set(relative(repo, child).replaceAll("\\", "/"), sha256(readFileSync(child)));
    }
  };
  walk(repo);
  files.set("<.git/index>", sha256(readFileSync(join(repo, ".git", "index"))));
  return files;
}

async function headOf(repo: string): Promise<string> {
  const { stdout } = await git(repo, "rev-parse", "HEAD");
  return stdout.trim();
}

async function statusOf(repo: string): Promise<string> {
  const { stdout } = await git(repo, "status", "--porcelain=v2");
  return stdout;
}

async function lsTree(repo: string, commitish: string): Promise<string[]> {
  const { stdout } = await git(repo, "ls-tree", "-r", "--name-only", "-z", commitish);
  return stdout.split("\0").filter((t) => t !== "");
}

async function blobOf(repo: string, commitish: string, path: string): Promise<string> {
  const { stdout } = await git(repo, "rev-parse", `${commitish}:${path}`);
  return stdout.trim();
}

async function hashAsPath(repo: string, path: string): Promise<string> {
  const { stdout } = await git(repo, "hash-object", "--path", path, path);
  return stdout.trim();
}

/** P0-05 RESULT §2 场景矩阵（autocrlf=false 仓库）。 */
async function buildScenario(repo: string): Promise<void> {
  await commitFile(repo, ".gitignore", "*.env\nbuild/\n");
  await commitFile(repo, "a.txt", "A\n");
  await commitFile(repo, "b.txt", "B\n");
  await commitFile(repo, "c.txt", "C\n");
  await commitFile(repo, "d.txt", "D\n");
  await commitFile(repo, "f.txt", "F\n");
  await commitFile(repo, "e.txt", "E\n");

  // staged：a.txt 修改并 add
  await write(repo, "a.txt", "A-staged\n");
  await git(repo, "add", "a.txt");
  // unstaged：b.txt 修改不 add
  await write(repo, "b.txt", "B-unstaged\n");
  // 同文件 staged + unstaged：c.txt
  await write(repo, "c.txt", "C-staged\n");
  await git(repo, "add", "c.txt");
  await write(repo, "c.txt", "C-unstaged\n");
  // staged 删除：d.txt
  await git(repo, "rm", "d.txt");
  // staged rename：e.txt → e2.txt
  await git(repo, "mv", "e.txt", "e2.txt");
  // unstaged 删除：f.txt
  rmSync(join(repo, "f.txt"));
  // untracked：二进制 / CRLF / 中文文件名 / 嵌套目录
  await write(repo, "bin.dat", Buffer.from([0x00, 0x01, 0x02, 0xff]));
  await write(repo, "untracked-crlf.txt", "crlf\r\ncontent\r\n");
  await write(repo, "新文件.md", "中文内容\n");
  mkdirSync(join(repo, "sub", "deep"), { recursive: true });
  await write(repo, join("sub", "deep", "x.txt"), "x\n");
  // ignored
  await write(repo, "secret.env", "SECRET=1\n");
  mkdirSync(join(repo, "build"), { recursive: true });
  await write(repo, join("build", "out.txt"), "out\n");
  // 空目录（git 不跟踪）
  mkdirSync(join(repo, "empty-dir"));
}

beforeEach(() => {
  dir = mkdtempSync(join(workspaceRoot, ".test-tmp-"));
  service = new CheckpointService();
});

afterEach(() => {
  rmForce(dir);
});

describe("CheckpointService.createCheckpoint（TDD §12.2，P0-05 §4 基线）", () => {
  it("完整场景矩阵：原仓库完全不变，checkpoint 内容无损", async () => {
    const repo = join(dir, "matrix");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await buildScenario(repo);

    const headBefore = await headOf(repo);
    const statusBefore = await statusOf(repo);
    const filesBefore = snapshotFiles(repo);

    const result = await service.createCheckpoint(repo, "task_cp1");

    // 原仓库完全不变
    expect(await headOf(repo)).toBe(headBefore);
    expect(await statusOf(repo)).toBe(statusBefore);
    expect(snapshotFiles(repo)).toEqual(filesBefore);

    // ref 指向 checkpoint commit，双父：原 HEAD + staged 提交
    const { stdout: refOut } = await git(repo, "rev-parse", result.checkpointRef);
    expect(refOut.trim()).toBe(result.checkpointCommit);
    const { stdout: p1 } = await git(repo, "rev-parse", `${result.checkpointCommit}^1`);
    const { stdout: p2 } = await git(repo, "rev-parse", `${result.checkpointCommit}^2`);
    expect(p1.trim()).toBe(headBefore);
    expect(p2.trim()).toBe(result.stagedCommit);

    // 内容清单：tracked+untracked 全在；删除/改名前/ignored/空目录不在
    const tree = new Set(await lsTree(repo, result.checkpointCommit));
    for (const present of [
      ".gitignore",
      "a.txt",
      "b.txt",
      "c.txt",
      "e2.txt",
      "bin.dat",
      "untracked-crlf.txt",
      "新文件.md",
      "sub/deep/x.txt",
    ]) {
      expect(tree.has(present), `checkpoint 应包含 ${present}`).toBe(true);
    }
    for (const absent of ["d.txt", "f.txt", "e.txt", "secret.env", "build/out.txt"]) {
      expect(tree.has(absent), `checkpoint 不应包含 ${absent}`).toBe(false);
    }
    expect([...tree].some((p) => p.startsWith("empty-dir"))).toBe(false);

    // git 视角内容一致（P0-05 §4.4 判定标准）
    for (const path of ["a.txt", "b.txt", "c.txt", "e2.txt", "bin.dat", "新文件.md", "sub/deep/x.txt"]) {
      expect(await blobOf(repo, result.checkpointCommit, path)).toBe(await hashAsPath(repo, path));
    }

    // staged / unstaged 语义摘要（#16 的四桶计数）。
    // git 事实：-z 模式下 status 默认关闭 rename 检测，git mv 的 rename
    // 表现为 e.txt(D) + e2.txt(A) 两条 staged 条目，故 staged=4。
    expect(result.dirtySummary).toEqual({ staged: 4, unstaged: 3, untracked: 4, ignored: 2 });
    expect(result.originalHead).toBe(headBefore);

    // §12.3：ignored 存在 → 中文提醒
    expect(result.ignoredReminder).toContain("忽略");
    expect(result.ignoredReminder).toContain("secret.env");
  }, 120000);

  it("无 ignored 文件时 reminder 为 null", async () => {
    const repo = join(dir, "clean-ish");
    await initRepo(repo);
    await commitFile(repo, "README.md");
    await write(repo, "todo.txt", "t\n");

    const result = await service.createCheckpoint(repo, "task_cp2");
    expect(result.ignoredReminder).toBeNull();
    expect(result.dirtySummary).toEqual({ staged: 0, unstaged: 0, untracked: 1, ignored: 0 });
    const tree = new Set(await lsTree(repo, result.checkpointCommit));
    expect(tree.has("todo.txt")).toBe(true);
  }, 60000);

  it("autocrlf=true 真实仓库：原仓库 byte-level 不变，blob 按用户换行规范迁移", async () => {
    const repo = join(dir, "crlf-real");
    await initRepo(repo, "true");
    await commitFile(repo, "x.txt", "line1\nline2\n");
    await commitFile(repo, "y.txt", "Y\n");
    await recheckout(repo, "x.txt", "y.txt"); // 盘上现在是 git 检出的 CRLF

    await write(repo, "x.txt", "line1\r\nline2\r\nline3\r\n"); // 用户编辑
    await write(repo, "z.txt", "new\r\n"); // 新增

    const filesBefore = snapshotFiles(repo);
    const headBefore = await headOf(repo);

    const result = await service.createCheckpoint(repo, "task_cp3");

    expect(snapshotFiles(repo)).toEqual(filesBefore);
    expect(await headOf(repo)).toBe(headBefore);

    // git 视角内容一致：hash-object --path（clean filter 生效）与 checkpoint blob 相同
    for (const path of ["x.txt", "y.txt", "z.txt"]) {
      expect(await blobOf(repo, result.checkpointCommit, path)).toBe(await hashAsPath(repo, path));
    }
  }, 60000);

  it("taskId 含非法字符时拒绝（防 ref 注入）", async () => {
    const repo = join(dir, "tid");
    await initRepo(repo);
    await commitFile(repo, "README.md");
    await expect(service.createCheckpoint(repo, "bad id")).rejects.toThrow();
    await expect(service.createCheckpoint(repo, "a/b")).rejects.toThrow();
    await expect(service.createCheckpoint(repo, "..")).rejects.toThrow();
  }, 60000);
});
