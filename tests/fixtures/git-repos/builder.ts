import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * git-repos fixture 动态构建器（票 #16）。
 *
 * 不提交静态 fixture 仓库：静态仓库在 checkout 时受 autocrlf 影响
 * （P0-05 验证过会污染状态判定），这里构建时显式钉死配置，保证确定性。
 */
export function git(cwd: string, ...args: string[]): Promise<{ stdout: string }> {
  return execFileAsync("git", args, { cwd, maxBuffer: 32 * 1024 * 1024 });
}

export async function initRepo(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "ACO Test");
  await git(path, "config", "user.email", "aco-test@example.invalid");
  await git(path, "config", "core.autocrlf", "false");
}

export async function commitFile(
  repo: string,
  name: string,
  content = "hello\n",
): Promise<void> {
  await write(repo, name, content);
  await git(repo, "add", name);
  await git(repo, "commit", "-m", `add ${name}`);
}

export async function write(repo: string, name: string, content: string): Promise<void> {
  await writeFile(join(repo, name), content, "utf8");
}

/** 用本地仓库作为源添加 submodule（新 git 需要 protocol.file.allow）。 */
export async function addSubmodule(parent: string, source: string, path: string): Promise<void> {
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", source, path);
  await git(parent, "commit", "-m", `add submodule ${path}`);
}
