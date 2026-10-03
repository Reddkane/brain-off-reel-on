import { ESLint } from "eslint";
import { expect, it } from "vitest";
import { resolve } from "node:path";
const eslint = new ESLint();

it.each(["fs", "fs/promises", "node:fs", "node:fs/promises", "child_process", "node:child_process"])("actual app and client lint rejects privileged builtin %s", async spec => {
  for (const filePath of ["src/app/probe.ts", "src/client/probe.ts"]) {
    for (const code of [
      `"use client"; import x from "${spec}"; void x;`,
      `"use client"; void import("${spec}");`,
      `"use client"; export * from "${spec}";`
    ]) {
      const result = (await eslint.lintText(code, {
        filePath: resolve(filePath)
      }))[0];

      expect(result.fatalErrorCount).toBe(0);
      expect(result.messages.some(m => m.ruleId === "effects/boundary")).toBe(true);
    }
  }
});

it.each([
  ["src/app/probe.ts", 'import x from "../server/db/pg-store.ts"; void x;'],
  ["src/app/probe.ts", 'export * from "@/server/providers/tmdb.ts";'],
  ["src/app/probe.ts", 'void import("../server/providers/tmdb.ts");'],
  ["src/app/probe.ts", 'export type X = import("../server/db/pg-store.ts").PgStoreOptions;'],
  ["src/client/probe.ts", '"use client"; import pg from "pg/lib/client"; void pg;'],
  ["src/server/probe.ts", 'export type X = import("../../tests/metadata/helpers.ts").T;'],
  [
    "src/server/probe.ts",
    'import type { X } from "../../tests/metadata/helpers.ts"; export type Y = X;'
  ],
  ["scripts/probe.ts", 'export * from "../tooling/metadata-fixtures.ts";'],
  ["src/domain/probe.ts", 'export * from "../server/db/pg-store.ts";']
])("actual lint rejects ownership %s %s", async (filePath, code) => {
  const result = (await eslint.lintText(code, {
    filePath: resolve(filePath)
  }))[0];

  expect(result.fatalErrorCount).toBe(0);
  expect(result.messages.some(m => m.ruleId === "effects/boundary" ||
    m.ruleId === "local/pure-boundary")).toBe(true);
});

it("positive server inward imports accepted", async () => {
  const result = (await eslint.lintText('import type { MovieMetadata } from "../domain/metadata.ts"; export type M = MovieMetadata;', {
    filePath: resolve("src/server/probe.ts")
  }))[0];

  expect(result.messages).toEqual([]);
});
