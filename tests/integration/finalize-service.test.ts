import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { CheckpointService } from "../../src/infra/git/checkpoint-service.js";
import {
  FinalizeService,
  type FinalCommitCreatedEvent,
  type TaskCompletedEvent,
} from "../../src/infra/git/finalize-service.js";
import { WorktreeService } from "../../src/infra/git/worktree-service.js";
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
let finalizeService: FinalizeService;
let finalCommitEvents: FinalCommitCreatedEvent[];
let taskCompletedEvents: TaskCompletedEvent[];

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

/** 与 #17/#18 同源的小型脏场景，构造接管起点。 */
async function buildScenario(repo: string): Promise<void> {
  await commitFile(repo, "a.txt", "A\n");
  await commitFile(repo, "b.txt", "B\n");
  await commitFile(repo, "e.txt", "E\n");
  await commitFile(repo, ".gitignore", "*.env\n");

  await write(repo, "a.txt", "A-staged\n");
  await git(repo, "add", "a.txt"); // staged
  await write(repo, "b.txt", "B-unstaged\n"); // unstaged
  await write(repo, "新文件.md", "中文内容\n"); // untracked
  await write(repo, "secret.env", "S\n"); // ignored
}

interface Harness {
  repo: string;
  baseline: string;
  cp: Awaited<ReturnType<CheckpointService["createCheckpoint"]>>;
  info: Awaited<ReturnType<WorktreeService["createWorktree"]>>;
  repoHeadBefore: string;
  repoStatusBefore: string;
}

/** 建仓 → 脏现场 → checkpoint → worktree；返回 finalize 前的全部锚点。 */
async function setupTakenOver(name: string): Promise<Harness> {
  const repo = join(dir, name);
  await initRepo(repo);
  await buildScenario(repo);

  const repoHeadBefore = (await git(repo, "rev-parse", "HEAD")).stdout.trim();
  const repoStatusBefore = (await git(repo, "status", "--porcelain=v2")).stdout;

  const cp = await checkpointService.createCheckpoint(repo, `task_${name}`);
  const info = await worktreeService.createWorktree(repo, `task_${name}`, cp.checkpointCommit);
  const baseline = (await git(repo, "rev-parse", `${cp.checkpointCommit}^1`)).stdout.trim();
  expect(baseline).toBe(repoHeadBefore);

  return { repo, baseline, cp, info, repoHeadBefore, repoStatusBefore };
}

/** 模拟 agent 在 worktree 里干活：两次正常 commit + 遗留未提交改动。 */
async function simulateAgentWork(info: Harness["info"]): Promise<void> {
  const wt = info.worktreePath;
  await write(wt, "a.txt", "A-agent\n");
  await git(wt, "add", "a.txt");
  await git(wt, "commit", "-m", "agent: feat 1");

  await write(wt, "new-module.ts", "export {};\n");
  await git(wt, "add", "new-module.ts");
  await git(wt, "commit", "-m", "agent: feat 2");

  // 遗留现场：staged 修改 + unstaged 修改 + untracked 文件
  await write(wt, "a.txt", "A-agent-final\n");
  await git(wt, "add", "a.txt");
  await write(wt, "b.txt", "B-agent-touched\n");
  await write(wt, "notes.md", "agent notes\n");
}

beforeEach(() => {
  dir = mkdtempSync(join(workspaceRoot, ".test-tmp-"));
  baseDir = join(dir, "worktrees");
  finalCommitEvents = [];
  taskCompletedEvents = [];
  checkpointService = new CheckpointService();
  worktreeService = new WorktreeService({ worktreesBaseDir: baseDir });
  finalizeService = new FinalizeService({
    onFinalCommitCreated: (event) => {
      finalCommitEvents.push(event);
    },
    onTaskCompleted: (event) => {
      taskCompletedEvents.push(event);
    },
  });
});

afterEach(() => {
  rmForce(dir);
});

describe("FinalizeService.finalize（TDD §12.5）", () => {
  it("端到端：agent 多次提交 + 未提交改动 → squash 成单个用户可读提交", async () => {
    const h = await setupTakenOver("e2e");
    await simulateAgentWork(h.info);
    const wtHeadBefore = (await git(h.info.worktreePath, "rev-parse", "HEAD")).stdout.trim();

    const result = await finalizeService.finalize(h.info.worktreePath, "task_e2e", h.cp.checkpointCommit, {
      message: "feat: 完成任务 task_e2e",
    });

    // 最终提交：父提交 = 接管时用户 HEAD（P0-05 §6 squash 基准）
    expect(result.finalCommit).not.toBeNull();
    const finalCommit = result.finalCommit as string;
    const parent = (await git(h.repo, "rev-parse", `${finalCommit}^1`)).stdout.trim();
    expect(parent).toBe(h.baseline);

    // 分支已指向最终提交，worktree 工作区干净
    const branchHead = (await git(h.repo, "rev-parse", "refs/heads/aco/task/task_e2e")).stdout.trim();
    expect(branchHead).toBe(finalCommit);
    expect((await git(h.info.worktreePath, "status", "--porcelain")).stdout).toBe("");

    // 历史用户可读：baseline..分支 之间只有最终提交一个，无 aco 噪声提交
    const subjects = (await git(h.repo, "log", "--format=%s", `${h.baseline}..aco/task/task_e2e`)).stdout
      .trim()
      .split("\n");
    expect(subjects).toEqual(["feat: 完成任务 task_e2e"]);

    // 内容完整：agent 提交过的、未提交的、untracked 的盘上内容全部在
    expect(await existsAndRead(h.info.worktreePath, "a.txt")).toBe("A-agent-final\n");
    expect(await existsAndRead(h.info.worktreePath, "b.txt")).toBe("B-agent-touched\n");
    expect(await existsAndRead(h.info.worktreePath, "new-module.ts")).toBe("export {};\n");
    expect(await existsAndRead(h.info.worktreePath, "notes.md")).toBe("agent notes\n");
    // ignored 仍未被纳入提交
    const committed = (await git(h.repo, "ls-tree", "-r", "--name-only", finalCommit)).stdout;
    expect(committed).not.toContain("secret.env");

    // §12.5：worktree 不物理删除，仍注册在案（可清理状态，aco cleanup 预留）
    expect(result.cleanupReady).toBe(true);
    expect(existsSync(h.info.worktreePath)).toBe(true);
    const wtList = (await git(h.repo, "worktree", "list", "--porcelain")).stdout;
    expect(wtList).toContain(h.info.worktreePath.replace(/\\/g, "/"));

    // 恢复锚点不动：checkpoint ref 原样保留
    const cpRef = (
      await git(h.repo, "rev-parse", `refs/aco/checkpoints/task_e2e`)
    ).stdout.trim();
    expect(cpRef).toBe(h.cp.checkpointCommit);
    expect(cpRef).not.toBe(wtHeadBefore); // 被整理的是分支，不是 checkpoint

    // 用户原仓库完全未被触碰（V0.1 不自动 merge）
    expect((await git(h.repo, "rev-parse", "HEAD")).stdout.trim()).toBe(h.repoHeadBefore);
    expect((await git(h.repo, "status", "--porcelain=v2")).stdout).toBe(h.repoStatusBefore);
    expect((await git(h.repo, "rev-parse", "--abbrev-ref", "HEAD")).stdout.trim()).toBe("main");

    // §6.4 事件 port：FINAL_COMMIT_CREATED + TASK_COMPLETED
    expect(finalCommitEvents).toHaveLength(1);
    expect(finalCommitEvents[0]).toMatchObject({
      type: "FINAL_COMMIT_CREATED",
      taskId: "task_e2e",
      branchName: "aco/task/task_e2e",
      finalCommit,
      baselineCommit: h.baseline,
      worktreePath: h.info.worktreePath,
    });
    expect(taskCompletedEvents).toHaveLength(1);
    expect(taskCompletedEvents[0]).toMatchObject({
      type: "TASK_COMPLETED",
      taskId: "task_e2e",
      finalCommit,
      branchName: "aco/task/task_e2e",
      worktreePath: h.info.worktreePath,
    });
  }, 180000);

  it("净零改动（干净接管 + agent 没动任何文件）→ 不造空提交，TASK_COMPLETED 仍触发", async () => {
    // 注意：脏现场接管时 checkpoint 树本身 ≠ baseline 树（用户脏改动是真实改动，
    // 应进最终提交）；真正的“净零”指 worktree 树与 baseline 树一致。
    const repo = join(dir, "repo-netzero");
    await initRepo(repo);
    await commitFile(repo, "README.md", "hello\n");
    const cp = await checkpointService.createCheckpoint(repo, "task_netzero");
    const info = await worktreeService.createWorktree(repo, "task_netzero", cp.checkpointCommit);
    const branchHeadBefore = (
      await git(repo, "rev-parse", "refs/heads/aco/task/task_netzero")
    ).stdout.trim();

    const result = await finalizeService.finalize(info.worktreePath, "task_netzero", cp.checkpointCommit);

    expect(result.finalCommit).toBeNull();
    expect(result.cleanupReady).toBe(true);
    // 分支原样（仍是 checkpoint），worktree 未被动过
    expect((await git(repo, "rev-parse", "refs/heads/aco/task/task_netzero")).stdout.trim()).toBe(
      branchHeadBefore,
    );
    expect((await git(info.worktreePath, "status", "--porcelain")).stdout).toBe("");
    // 没有 FINAL_COMMIT_CREATED，但任务照常完成
    expect(finalCommitEvents).toHaveLength(0);
    expect(taskCompletedEvents).toHaveLength(1);
    expect(taskCompletedEvents[0]).toMatchObject({
      type: "TASK_COMPLETED",
      taskId: "task_netzero",
      finalCommit: null,
    });
  }, 180000);

  it("传入主仓库路径冒充 worktree → 报错且主仓库分毫不动", async () => {
    const h = await setupTakenOver("mainrepo");
    const headBefore = (await git(h.repo, "rev-parse", "HEAD")).stdout.trim();

    await expect(
      finalizeService.finalize(h.repo, "task_mainrepo", h.cp.checkpointCommit),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });

    expect((await git(h.repo, "rev-parse", "HEAD")).stdout.trim()).toBe(headBefore);
    expect(finalCommitEvents).toHaveLength(0);
    expect(taskCompletedEvents).toHaveLength(0);
  }, 180000);

  it("worktree 分支与 taskId 不匹配 → 报错且不动任何分支", async () => {
    const h = await setupTakenOver("mismatch");

    await expect(
      finalizeService.finalize(h.info.worktreePath, "task_other", h.cp.checkpointCommit),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });

    // task_other 分支没有被凭空创建或移动
    await expect(git(h.repo, "rev-parse", "--verify", "--quiet", "refs/heads/aco/task/task_other")).rejects.toThrow();
    expect(
      (await git(h.repo, "rev-parse", "refs/heads/aco/task/task_mismatch")).stdout.trim(),
    ).toBe(h.cp.checkpointCommit);
    expect(finalCommitEvents).toHaveLength(0);
    expect(taskCompletedEvents).toHaveLength(0);
  }, 180000);

  it("checkpointCommit 不存在或不是 checkpoint 结构（无父提交）→ 报错", async () => {
    const h = await setupTakenOver("badcp");

    await expect(
      finalizeService.finalize(h.info.worktreePath, "task_badcp", "0123456789012345678901234567890123456789"),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });

    // 存在但不是 ACO checkpoint（根提交，无父）→ 拒绝，防误伤任意提交
    const orphanTree = (await git(h.repo, "rev-parse", "HEAD^{tree}")).stdout.trim();
    const orphan = (await git(h.repo, "commit-tree", orphanTree, "-m", "orphan root")).stdout.trim();
    await expect(
      finalizeService.finalize(h.info.worktreePath, "task_badcp", orphan),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });

    expect(finalCommitEvents).toHaveLength(0);
    expect(taskCompletedEvents).toHaveLength(0);
  }, 180000);

  it("半途失败（冲突未合并态）→ 报错且现场可恢复：分支 / worktree / checkpoint ref 全部原状", async () => {
    const h = await setupTakenOver("conflict");
    const wt = h.info.worktreePath;

    // 构造 add/add 冲突：两侧从同一起点对同一文件写不同内容
    await write(wt, "conflict.txt", "task side\n");
    await git(wt, "add", "conflict.txt");
    await git(wt, "commit", "-m", "task side");
    const branchHeadBefore = (
      await git(h.repo, "rev-parse", "refs/heads/aco/task/task_conflict")
    ).stdout.trim();
    await git(wt, "checkout", "-b", "aco/conflict-helper", "HEAD~1");
    await write(wt, "conflict.txt", "helper side\n");
    await git(wt, "add", "conflict.txt");
    await git(wt, "commit", "-m", "helper side");
    await git(wt, "checkout", "aco/task/task_conflict");
    await git(wt, "merge", "--no-ff", "aco/conflict-helper").catch(() => undefined);
    // add/add 冲突在 porcelain v1 里是 AA（unmerged 态）；普通内容冲突是 UU
    expect((await git(wt, "status", "--porcelain")).stdout).toMatch(/^(UU|AA) /m);

    await expect(
      finalizeService.finalize(wt, "task_conflict", h.cp.checkpointCommit),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });

    // 分支未动、worktree 在、checkpoint ref 在 —— 现场可从 checkpoint 恢复
    expect((await git(wt, "rev-parse", "refs/heads/aco/task/task_conflict")).stdout.trim()).toBe(
      branchHeadBefore,
    );
    expect(existsSync(wt)).toBe(true);
    expect((await git(h.repo, "rev-parse", `refs/aco/checkpoints/task_conflict`)).stdout.trim()).toBe(
      h.cp.checkpointCommit,
    );
    expect(finalCommitEvents).toHaveLength(0);
    expect(taskCompletedEvents).toHaveLength(0);
  }, 180000);

  it("非法 taskId（防 ref 注入）→ 报错", async () => {
    const h = await setupTakenOver("badid");
    await expect(
      finalizeService.finalize(h.info.worktreePath, "bad id", h.cp.checkpointCommit),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });
    await expect(
      finalizeService.finalize(h.info.worktreePath, "a/b", h.cp.checkpointCommit),
    ).rejects.toMatchObject({ code: "E_FINALIZE_FAILED" });
  }, 180000);
});

async function existsAndRead(root: string, name: string): Promise<string> {
  expect(existsSync(join(root, name))).toBe(true);
  return readFileSync(join(root, name), "utf8");
}
