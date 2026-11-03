import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointService } from "../../src/infra/git/checkpoint-service.js";
import {
  WorktreeService,
  defaultWorktreesBaseDir,
  type WorktreeCreatedEvent,
} from "../../src/infra/git/worktree-service.js";
import {
  commitFile,
  git,
  initRepo,
  write,
} from "../fixtures/git-repos/builder.js";

const workspaceRoot = join(import.meta.dirname, "..", "..", "..");

let dir: string;
let baseDir: string;
let checkpointService: CheckpointService;
let worktreeService: WorktreeService;
let events: WorktreeCreatedEvent[];

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

/** 与 #17 矩阵同源但更小的脏场景：验证 worktree 里现场完整。 */
async function buildScenario(repo: string): Promise<void> {
  await commitFile(repo, "a.txt", "A\n");
  await commitFile(repo, "b.txt", "B\n");
  await commitFile(repo, "e.txt", "E\n");
  await commitFile(repo, ".gitignore", "*.env\n");

  await write(repo, "a.txt", "A-staged\n");
  await git(repo, "add", "a.txt"); // staged
  await write(repo, "b.txt", "B-unstaged\n"); // unstaged
  await git(repo, "mv", "e.txt", "e2.txt"); // staged rename
  await write(repo, "新文件.md", "中文内容\n"); // untracked
  await write(repo, "secret.env", "S\n"); // ignored
}

beforeEach(() => {
  dir = mkdtempSync(join(workspaceRoot, ".test-tmp-"));
  baseDir = join(dir, "worktrees");
  events = [];
  checkpointService = new CheckpointService();
  worktreeService = new WorktreeService({
    worktreesBaseDir: baseDir,
    onWorktreeCreated: (event) => {
      events.push(event);
    },
  });
});

afterEach(() => {
  rmForce(dir);
});

describe("defaultWorktreesBaseDir", () => {
  it("LOCALAPPDATA 存在时落在其下（§12.4），不实际创建目录", () => {
    const base = defaultWorktreesBaseDir();
    if (process.env.LOCALAPPDATA) {
      expect(base).toBe(join(process.env.LOCALAPPDATA, "AgentCapacityOrchestrator", "worktrees"));
    } else {
      expect(base).toContain("AgentCapacityOrchestrator");
    }
  });
});

describe("WorktreeService.createWorktree（TDD §12.4）", () => {
  it("端到端：脏现场 → checkpoint → worktree，现场完整且原仓库不变", async () => {
    const repo = join(dir, "repo");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await buildScenario(repo);

    const statusBefore = (await git(repo, "status", "--porcelain=v2")).stdout;
    const cp = await checkpointService.createCheckpoint(repo, "task_wt1");
    const info = await worktreeService.createWorktree(repo, "task_wt1", cp.checkpointCommit);

    // 路径与分支（§12.4：base/<task-id>，aco/task/<task-id>）
    expect(info.worktreePath).toBe(join(baseDir, "task_wt1"));
    expect(info.branchName).toBe("aco/task/task_wt1");
    expect(existsSync(info.worktreePath)).toBe(true);

    // worktree 内 HEAD / branch 与 checkpoint 一致，工作区干净
    const wtHead = (await git(info.worktreePath, "rev-parse", "HEAD")).stdout.trim();
    const wtBranch = (await git(info.worktreePath, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim();
    expect(wtHead).toBe(cp.checkpointCommit);
    expect(wtBranch).toBe("aco/task/task_wt1");
    expect((await git(info.worktreePath, "status", "--porcelain")).stdout).toBe("");

    // 现场内容：staged / unstaged / untracked 的最终盘上内容都在
    expect(readFileSync(join(info.worktreePath, "a.txt"), "utf8")).toBe("A-staged\n");
    expect(readFileSync(join(info.worktreePath, "b.txt"), "utf8")).toBe("B-unstaged\n");
    expect(readFileSync(join(info.worktreePath, "e2.txt"), "utf8")).toBe("E\n");
    expect(readFileSync(join(info.worktreePath, "新文件.md"), "utf8")).toBe("中文内容\n");
    // 删除/改名前/ignored 不在
    for (const absent of ["e.txt", "secret.env"]) {
      expect(existsSync(join(info.worktreePath, absent))).toBe(false);
    }

    // 原仓库状态未被 worktree 创建改变
    expect((await git(repo, "status", "--porcelain=v2")).stdout).toBe(statusBefore);

    // WORKTREE_CREATED 事件 port 触发（§6.4，真实落盘随 #12/#15）
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      type: "WORKTREE_CREATED",
      taskId: "task_wt1",
      worktreePath: info.worktreePath,
      branchName: "aco/task/task_wt1",
      checkpointCommit: cp.checkpointCommit,
    });
  }, 120000);

  it("同 task-id 重复创建：目标目录已存在 → 报错且不覆盖既有 worktree", async () => {
    const repo = join(dir, "repo2");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commitFile(repo, "README.md");
    const cp = await checkpointService.createCheckpoint(repo, "task_wt2");
    const info = await worktreeService.createWorktree(repo, "task_wt2", cp.checkpointCommit);

    // 动过 worktree 里的文件，验证二次创建不会覆盖
    writeFileSync(join(info.worktreePath, "user-touched.txt"), "keep me\n");

    await expect(worktreeService.createWorktree(repo, "task_wt2", cp.checkpointCommit)).rejects.toMatchObject({
      code: "E_WORKTREE_FAILED",
    });
    expect(readFileSync(join(info.worktreePath, "user-touched.txt"), "utf8")).toBe("keep me\n");
    // 既有 worktree 仍可用
    expect((await git(info.worktreePath, "rev-parse", "HEAD")).stdout.trim()).toBe(cp.checkpointCommit);
  }, 120000);

  it("分支已存在（目录空闲）→ 报错路径", async () => {
    const repo = join(dir, "repo3");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commitFile(repo, "README.md");
    const cp = await checkpointService.createCheckpoint(repo, "task_wt3");
    // 手工预建同名分支，但不占目录
    await git(repo, "branch", "aco/task/task_wt3", cp.checkpointCommit);

    await expect(worktreeService.createWorktree(repo, "task_wt3", cp.checkpointCommit)).rejects.toMatchObject({
      code: "E_WORKTREE_FAILED",
    });
    expect(existsSync(join(baseDir, "task_wt3"))).toBe(false);
  }, 60000);

  it("base 目录被文件占用（磁盘/路径失败路径）→ 报错", async () => {
    const repo = join(dir, "repo4");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commitFile(repo, "README.md");
    const cp = await checkpointService.createCheckpoint(repo, "task_wt4");

    const fileBase = join(dir, "file-base");
    writeFileSync(fileBase, "occupied\n");
    const svc = new WorktreeService({ worktreesBaseDir: fileBase });

    await expect(svc.createWorktree(repo, "task_wt4", cp.checkpointCommit)).rejects.toMatchObject({
      code: "E_WORKTREE_FAILED",
    });
  }, 60000);

  it("taskId 非法（防 ref 注入）→ 报错", async () => {
    const repo = join(dir, "repo5");
    mkdirSync(repo, { recursive: true });
    await initRepo(repo);
    await commitFile(repo, "README.md");
    await expect(worktreeService.createWorktree(repo, "bad id", "abc")).rejects.toMatchObject({
      code: "E_WORKTREE_FAILED",
    });
    await expect(worktreeService.createWorktree(repo, "a/b", "abc")).rejects.toMatchObject({
      code: "E_WORKTREE_FAILED",
    });
  }, 60000);
});
