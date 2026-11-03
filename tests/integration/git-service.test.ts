import { chmodSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GitNotRepositoryError } from "../../src/domain/errors.js";
import { GitService } from "../../src/infra/git/git-service.js";
import {
  addSubmodule,
  commitFile,
  git,
  initRepo,
  write,
} from "../fixtures/git-repos/builder.js";

const workspaceRoot = join(import.meta.dirname, "..", "..", "..");

let dir: string;
let service: GitService;

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

beforeEach(() => {
  // 临时仓库放工作区根部（aco 仓库之外）：仓库内的目录会被父 repo 的
  // rev-parse 向上命中，无法构造真正的“非 git 目录”场景。
  dir = mkdtempSync(join(workspaceRoot, ".test-tmp-"));
  service = new GitService();
});

afterEach(() => {
  rmForce(dir);
});

async function tmp(name: string): Promise<string> {
  const path = join(dir, name);
  mkdirSync(path, { recursive: true });
  return path;
}

describe("GitService.detectRepo（TDD §12.1）", () => {
  it("从子目录调用返回仓库顶层根", async () => {
    const repo = await tmp("repo");
    await initRepo(repo);
    await commitFile(repo, "README.md");
    const nested = join(repo, "a", "b");
    mkdirSync(nested, { recursive: true });
    await expect(service.detectRepo(nested)).resolves.toBe(repo);
  });

  it("嵌套 git：内层仓库返回自己的根，不是外层的", async () => {
    const outer = await tmp("outer");
    await initRepo(outer);
    const inner = join(outer, "inner-repo");
    await initRepo(inner);
    await commitFile(inner, "inner.md");
    await expect(service.detectRepo(inner)).resolves.toBe(inner);
  });

  it("非 git 目录：抛 GitNotRepositoryError（E_GIT_NOT_REPOSITORY，中文报错）", async () => {
    const plain = await tmp("plain");
    await expect(service.detectRepo(plain)).rejects.toBeInstanceOf(GitNotRepositoryError);
    await expect(service.detectRepo(plain)).rejects.toMatchObject({
      code: "E_GIT_NOT_REPOSITORY",
    });
    await expect(service.detectRepo(plain)).rejects.toThrow(/不是 Git 仓库/);
  });
});

describe("GitService.captureDirtyState（TDD §12.1 + §6.3 git 节）", () => {
  it("干净仓库 → 全空", async () => {
    const repo = await tmp("clean");
    await initRepo(repo);
    await commitFile(repo, "README.md");
    const state = await service.captureDirtyState(repo);
    expect(state.repoRoot).toBe(repo);
    expect(state.stagedFiles).toEqual([]);
    expect(state.unstagedFiles).toEqual([]);
    expect(state.untrackedFiles).toEqual([]);
    expect(state.ignoredFiles).toEqual([]);
    expect(state.dirtySummary).toEqual({ staged: 0, unstaged: 0, untracked: 0, ignored: 0 });
  });

  it("仅 staged：修改并 add", async () => {
    const repo = await tmp("staged");
    await initRepo(repo);
    await commitFile(repo, "a.txt");
    await write(repo, "a.txt", "changed\n");
    await git(repo, "add", "a.txt");
    const state = await service.captureDirtyState(repo);
    expect(state.stagedFiles).toEqual(["a.txt"]);
    expect(state.unstagedFiles).toEqual([]);
  });

  it("仅 unstaged：修改不 add", async () => {
    const repo = await tmp("unstaged");
    await initRepo(repo);
    await commitFile(repo, "a.txt");
    await write(repo, "a.txt", "changed\n");
    const state = await service.captureDirtyState(repo);
    expect(state.stagedFiles).toEqual([]);
    expect(state.unstagedFiles).toEqual(["a.txt"]);
  });

  it("仅 untracked：新增文件", async () => {
    const repo = await tmp("untracked");
    await initRepo(repo);
    await commitFile(repo, "a.txt");
    await write(repo, "new.txt", "n\n");
    const state = await service.captureDirtyState(repo);
    expect(state.untrackedFiles).toEqual(["new.txt"]);
    expect(state.dirtySummary.untracked).toBe(1);
  });

  it("ignored 文件进 ignored 桶（--ignored 捕获）", async () => {
    const repo = await tmp("ignored");
    await initRepo(repo);
    await commitFile(repo, ".gitignore", "*.log\n");
    await write(repo, "debug.log", "l\n");
    const state = await service.captureDirtyState(repo);
    expect(state.ignoredFiles).toEqual(["debug.log"]);
    expect(state.untrackedFiles).toEqual([]);
    expect(state.dirtySummary.ignored).toBe(1);
  });

  it("组合场景：staged + unstaged + untracked + ignored 同时存在", async () => {
    const repo = await tmp("combo");
    await initRepo(repo);
    await commitFile(repo, "a.txt");
    await commitFile(repo, "b.txt");
    await commitFile(repo, ".gitignore", "*.log\n");
    await write(repo, "a.txt", "staged-change\n");
    await git(repo, "add", "a.txt"); // a.txt staged
    await write(repo, "b.txt", "unstaged-change\n"); // b.txt unstaged
    await write(repo, "c.txt", "untracked\n");
    await write(repo, "x.log", "ignored\n");

    const state = await service.captureDirtyState(repo);
    expect(state.stagedFiles).toEqual(["a.txt"]);
    expect(state.unstagedFiles).toEqual(["b.txt"]);
    expect(state.untrackedFiles).toEqual(["c.txt"]);
    expect(state.ignoredFiles).toEqual(["x.log"]);
    expect(state.dirtySummary).toEqual({ staged: 1, unstaged: 1, untracked: 1, ignored: 1 });
  });

  it("嵌套 git 目录对外层表现为 untracked", async () => {
    const outer = await tmp("nest-outer");
    await initRepo(outer);
    await commitFile(outer, "README.md");
    const inner = join(outer, "inner-repo");
    await initRepo(inner);
    await commitFile(inner, "inner.md");

    const state = await service.captureDirtyState(outer);
    expect(state.untrackedFiles).toContain("inner-repo/");
  });

  it("submodule：内部修改后父仓库捕获到 submodule 路径", async () => {
    const parent = await tmp("sm-parent");
    const source = await tmp("sm-source");
    await initRepo(source);
    await commitFile(source, "inner.txt");
    await initRepo(parent);
    await commitFile(parent, "README.md");
    await addSubmodule(parent, source, "sub");

    await write(parent, join("sub", "inner.txt"), "changed inside submodule\n");

    const state = await service.captureDirtyState(parent);
    expect([...state.stagedFiles, ...state.unstagedFiles]).toContain("sub");
    // submodule 自身也是合法仓库，可独立捕获
    const subState = await service.captureDirtyState(join(parent, "sub"));
    expect(subState.unstagedFiles).toEqual(["inner.txt"]);
  }, 120000);
});
