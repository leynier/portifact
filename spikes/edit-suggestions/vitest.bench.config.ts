import { defineConfig } from "vitest/config";

// The benchmarks at the size limits and the full corpora: wall-clock measurements the record
// quotes. Never part of `bun run test` (see `vitest.config.ts`), so the timeout can be generous.
export default defineConfig({
  test: {
    testTimeout: 600_000,
    hookTimeout: 600_000,
    // One file at a time, so the measurements do not compete for the machine.
    fileParallelism: false,
    include: ["bench/**/*.bench.ts"],
  },
});
