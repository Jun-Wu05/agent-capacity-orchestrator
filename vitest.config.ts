import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    // git 子进程在本机约 400ms/次，组合场景集成测试需要更长预算
    testTimeout: 30000,
  },
});
