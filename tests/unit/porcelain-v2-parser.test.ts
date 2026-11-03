import { describe, expect, it } from "vitest";

import {
  parsePorcelainV2,
  type PorcelainBuckets,
} from "../../src/infra/git/git-service.js";

function nul(...tokens: string[]): Buffer {
  return Buffer.from(`${tokens.join("\0")}\0`, "utf8");
}

describe("parsePorcelainV2（纯解析，期望值按 git status --porcelain=v2 -z 格式手写）", () => {
  it("空输出 → 全空桶", () => {
    expect(parsePorcelainV2(nul())).toEqual<PorcelainBuckets>({
      stagedFiles: [],
      unstagedFiles: [],
      untrackedFiles: [],
      ignoredFiles: [],
      dirtySummary: { staged: 0, unstaged: 0, untracked: 0, ignored: 0 },
    });
  });

  it("仅 staged：X=M Y=. → 只进 staged 桶", () => {
    const out = nul(
      "# branch.oid 4b825dc642cb6eb9a060e54bf8d69288fbee4904",
      "# branch.head main",
      "1 M. N 100644 100644 100644 1111111 2222222 a.txt",
    );
    const buckets = parsePorcelainV2(out);
    expect(buckets.stagedFiles).toEqual(["a.txt"]);
    expect(buckets.unstagedFiles).toEqual([]);
    expect(buckets.untrackedFiles).toEqual([]);
    expect(buckets.ignoredFiles).toEqual([]);
    expect(buckets.dirtySummary).toEqual({ staged: 1, unstaged: 0, untracked: 0, ignored: 0 });
  });

  it("仅 unstaged：X=. Y=M → 只进 unstaged 桶", () => {
    const out = nul("1 .M N 100644 100644 100644 1111111 2222222 a.txt");
    const buckets = parsePorcelainV2(out);
    expect(buckets.stagedFiles).toEqual([]);
    expect(buckets.unstagedFiles).toEqual(["a.txt"]);
    expect(buckets.dirtySummary.staged).toBe(0);
    expect(buckets.dirtySummary.unstaged).toBe(1);
  });

  it("X=Y=M → 同时进 staged 与 unstaged 桶", () => {
    const out = nul("1 MM N 100644 100644 100644 1111111 2222222 a.txt");
    const buckets = parsePorcelainV2(out);
    expect(buckets.stagedFiles).toEqual(["a.txt"]);
    expect(buckets.unstagedFiles).toEqual(["a.txt"]);
  });

  it("untracked（? ）与 ignored（! ）各归各桶", () => {
    const out = nul("? new.txt", "! debug.log");
    const buckets = parsePorcelainV2(out);
    expect(buckets.untrackedFiles).toEqual(["new.txt"]);
    expect(buckets.ignoredFiles).toEqual(["debug.log"]);
    expect(buckets.dirtySummary).toEqual({ staged: 0, unstaged: 0, untracked: 1, ignored: 1 });
  });

  it("rename（2 开头）：path 与 origPath 双 token，只留 path 且 origPath 不泄漏成条目", () => {
    const out = nul(
      "2 R. N 100644 100644 100644 1111111 2222222 C100 renamed.txt",
      "original.txt",
      "? other.txt",
    );
    const buckets = parsePorcelainV2(out);
    expect(buckets.stagedFiles).toEqual(["renamed.txt"]);
    expect(buckets.unstagedFiles).toEqual([]);
    expect(buckets.untrackedFiles).toEqual(["other.txt"]); // original.txt 没被当成 untracked
  });

  it("unmerged（u 开头）：X/Y 均非点，同时进 staged 与 unstaged", () => {
    const out = nul(
      "u AA N 100644 100644 100644 100644 1111111 2222222 3333333 conflict.txt",
    );
    const buckets = parsePorcelainV2(out);
    expect(buckets.stagedFiles).toEqual(["conflict.txt"]);
    expect(buckets.unstagedFiles).toEqual(["conflict.txt"]);
  });

  it("路径含空格：整段路径保留", () => {
    const out = nul(
      "1 M. N 100644 100644 100644 1111111 2222222 my file with spaces.txt",
      "? another dir/new file.txt",
    );
    const buckets = parsePorcelainV2(out);
    expect(buckets.stagedFiles).toEqual(["my file with spaces.txt"]);
    expect(buckets.untrackedFiles).toEqual(["another dir/new file.txt"]);
  });

  it("header（# 开头）与空 token 被忽略", () => {
    const out = nul(
      "# branch.oid abc",
      "# branch.head main",
      "# branch.upstream origin/main",
      "# branch.ab +1 -2",
      "",
      "? x.txt",
    );
    const buckets = parsePorcelainV2(out);
    expect(buckets.untrackedFiles).toEqual(["x.txt"]);
    expect(buckets.stagedFiles).toEqual([]);
  });
});
