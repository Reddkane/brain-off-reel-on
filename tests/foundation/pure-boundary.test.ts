import path from "node:path";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const repositoryRoot = fileURLToPath(new URL("../../", import.meta.url));
// Default discovery loads the production config. No cwd or rule-root override.
const eslint = new ESLint();

async function lint(area: "domain" | "recommendation", source: string, extension = "ts") {
  const filePath = path.join(repositoryRoot, "src", area, `boundary-probe.${extension}`);
  const results = await eslint.lintText(source, { filePath });
  expect(results).toHaveLength(1);
  const result = results[0];
  expect(result.filePath).toBe(filePath);
  expect(result.messages.filter((message) =>
    /ignored|outside.*base path/i.test(message.message),
  )).toEqual([]);
  expect(result.fatalErrorCount).toBe(0);
  return result;
}

describe.each(["domain", "recommendation"] as const)("%s pure boundary", (area) => {
  it.each([
    ['declare const fetch: (url: string) => Promise<unknown>; void fetch;', "no-restricted-syntax", "ts"],
    ['declare const process: { env: Record<string, string | undefined> }; void process;', "no-restricted-syntax", "ts"],
    ['declare function fetch(url: string): Promise<unknown>; void fetch;', "no-restricted-syntax", "ts"],
    ['Reflect.get(globalThis, "fetch")("https://example.invalid");', "no-restricted-globals", "ts"],
    ['export {}; declare global { const window: { location: string } }', "no-restricted-syntax", "d.ts"],
  ])("rejects ambient runtime access: %s", async (source, ruleId, extension) => {
    const result = await lint(area, source, extension);
    expect(result.messages.map((message) => message.ruleId)).toEqual([ruleId]);
  });

  it("preserves the actual unique-symbol brand declarations", async () => {
    const source = await readFile(path.join(repositoryRoot, "src", "domain", "ids.ts"), "utf8");
    const result = await lint(area, source);
    expect(result.messages).toEqual([]);
  });

  it.each([
    ['declare class Request { constructor(url: string) } void Request;', ["no-restricted-syntax"]],
    ['declare enum Env { A } void Env;', ["no-restricted-syntax"]],
    ['Function("return this")().fetch("https://example.invalid");', ["no-new-func"]],
    ['new Function("return this")().fetch("https://example.invalid");', ["no-new-func"]],
    ['eval("fetch")("https://example.invalid");', ["no-eval"]],
    ['setTimeout("fetch()", 0);', ["no-implied-eval"]],
  ])("rejects ambient declarations and dynamic code: %s", async (source, ruleIds) => {
    const result = await lint(area, source);
    expect(result.messages.map((message) => message.ruleId)).toEqual(ruleIds);
  });

  it.each(["tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])(
    "rejects non-.ts pure source even without imports: .%s", async (extension) => {
      const result = await lint(area, 'void window;', extension);
      expect(result.messages.map((message) => message.ruleId)).toEqual(["no-restricted-syntax"]);
    },
  );
  it.each(["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"])(
    "enforces relative and package boundaries in .%s files", async (extension) => {
      const extensionErrors = extension === "ts" ? [] : ["no-restricted-syntax"];
      const forbiddenArea = await lint(area, 'import "../app/page";', extension);
      expect(forbiddenArea.messages.map((message) => message.ruleId).sort()).toEqual(["local/pure-boundary", ...extensionErrors].sort());
      const forbiddenPackage = await lint(area, 'import "react";', extension);
      expect(forbiddenPackage.messages.map((message) => message.ruleId).sort()).toEqual(["no-restricted-imports", ...extensionErrors].sort());
      const allowed = await lint(area, 'import "../domain/ids";', extension);
      expect(allowed.messages.map((message) => message.ruleId)).toEqual(extensionErrors);
    },
  );

  it.each([
    '/// <reference lib="dom" />',
    '/// <reference types="node" />',
    '/// <reference path="../app/page.tsx" />',
  ])("rejects ambient reference %s", async (reference) => {
    for (const extension of ["ts", "tsx", "mts", "cts", "js", "jsx", "mjs", "cjs"]) {
      const result = await lint(area, `${reference}\nexport {};`, extension);
      const extensionErrors = extension === "ts" ? [] : ["no-restricted-syntax"];
      expect(result.messages.map((message) => message.ruleId).sort()).toEqual(["@typescript-eslint/triple-slash-reference", ...extensionErrors].sort());
    }
  });

  const forbiddenRelative = [
    "../app/page", // Existing target.
    "../app/missing",
    "../components/missing",
    "../server/db/client",
    "../../tests/fixtures/synthetic-identities", // Existing fixture target.
    "../../tooling/eslint/pure-boundary.mjs", // Existing tooling target.
    "../domain/../server/db/client",
    "../domain-extra/ids",
    "../recommendation-extra/index",
    "../../../outside",
  ];

  it.each(forbiddenRelative)("rejects all static forms to %s with the area rule only", async (specifier) => {
    for (const source of [
      `import "${specifier}";`,
      `import type { Value } from "${specifier}"; export type { Value };`,
      `export { Value } from "${specifier}";`,
      `export type { Value } from "${specifier}";`,
      `export * from "${specifier}";`,
    ]) {
      const result = await lint(area, source);
      expect(result.messages.map((message) => message.ruleId)).toEqual(["local/pure-boundary"]);
    }
  });

  const nonRelative = [
    "react", "next/navigation", "@supabase/supabase-js", "unknown-sdk",
    "node:fs", "fs", "server-only", "client-only", "@/domain/ids",
    "@other/ids", "#domain/ids", "/src/domain/ids", "C:/src/domain/ids",
  ];

  it.each(nonRelative)("rejects non-relative static forms to %s with the regex rule only", async (specifier) => {
    for (const source of [
      `import "${specifier}";`,
      `import type { Value } from "${specifier}"; export type { Value };`,
      `export { Value } from "${specifier}";`,
      `export type { Value } from "${specifier}";`,
      `export * from "${specifier}";`,
    ]) {
      const result = await lint(area, source);
      expect(result.messages.map((message) => message.ruleId)).toEqual(["no-restricted-imports"]);
    }
  });

  it.each([
    ['void import("../domain/ids");', "no-restricted-syntax"],
    ['export type Value = import("../domain/ids").MovieId;', "@typescript-eslint/consistent-type-imports"],
    ['const value = require("../domain/ids"); void value;', "@typescript-eslint/no-require-imports"],
    ['import value = require("../domain/ids"); void value;', "@typescript-eslint/no-require-imports"],
    ['"use client"; export {};', "no-restricted-syntax"],
    ['"use server"; export {};', "no-restricted-syntax"],
    ['import type { MovieId } from "../domain/ids"; export const value = "abc" as MovieId;', "@typescript-eslint/consistent-type-assertions"],
    ['export type Value = any;', "@typescript-eslint/no-explicit-any"],
  ])("rejects %s via %s", async (source, ruleId) => {
    const result = await lint(area, source);
    expect(result.messages.map((message) => message.ruleId)).toEqual([ruleId]);
  });

  it("disables inline waivers", async () => {
    const result = await lint(area, '/* eslint-disable no-restricted-imports */\nimport "react";');
    expect(result.messages.filter((message) => message.ruleId !== null).map((message) => message.ruleId)).toEqual(["no-restricted-imports"]);
    expect(result.messages.filter((message) => message.ruleId === null)).toHaveLength(1);
    expect(result.messages.some((message) => /noInlineConfig/.test(message.message))).toBe(true);
  });

  it.each([
    'import type { MovieId } from "../domain/ids"; export type { MovieId };',
    'export type { MovieIdentity } from "../domain/movie-identity";',
    'export * from "../domain/ids";',
    'import "../domain/nested/../ids";',
  ])("allows domain dependencies: %s", async (source) => {
    const result = await lint(area, source);
    expect(result.messages).toEqual([]);
  });
});

it("rejects domain-to-recommendation imports and re-exports", async () => {
  for (const source of [
    'import "../recommendation/index";',
    'export type { MovieIdentity } from "../recommendation/index";',
    'export * from "../recommendation/index";',
  ]) {
    const result = await lint("domain", source);
    expect(result.messages.map((message) => message.ruleId)).toEqual(["local/pure-boundary"]);
  }
});

it("allows recommendation-to-recommendation dependencies", async () => {
  const result = await lint("recommendation", 'export type { MovieIdentity } from "./index";');
  expect(result.messages).toEqual([]);
});
