import { execFile } from "node:child_process";
import { mkdir, rm, writeFile } from "node:fs/promises";
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

export async function initRepo(path: string, autocrlf = "false"): Promise<void> {
  await mkdir(path, { recursive: true });
  await git(path, "init", "-b", "main");
  await git(path, "config", "user.name", "ACO Test");
  await git(path, "config", "user.email", "aco-test@example.invalid");
  await git(path, "config", "core.autocrlf", autocrlf);
}

export async function commitFile(
  repo: string,
  name: string,
  content: string | Buffer = "hello\n",
): Promise<void> {
  await write(repo, name, content);
  await git(repo, "add", name);
  await git(repo, "commit", "-m", `add ${name}`);
}

export async function write(repo: string, name: string, content: string | Buffer): Promise<void> {
  await writeFile(join(repo, name), content, "utf8");
}

/** 让 git 重新检出文件（配合 autocrlf=true 得到真实 CRLF 工作区，避免脚本构造假象）。 */
export async function recheckout(repo: string, ...names: string[]): Promise<void> {
  for (const name of names) {
    await rm(join(repo, name), { force: true }).catch(() => undefined);
  }
  await git(repo, "checkout", "HEAD", "--", ...names);
}

/** 用本地仓库作为源添加 submodule（新 git 需要 protocol.file.allow）。 */
export async function addSubmodule(parent: string, source: string, path: string): Promise<void> {
  await git(parent, "-c", "protocol.file.allow=always", "submodule", "add", source, path);
  await git(parent, "commit", "-m", `add submodule ${path}`);
}
