import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/foundation/pure-boundary.test.ts", "tests/metadata/*.test.ts", "tests/classification/*.test.ts"],
  },
});
