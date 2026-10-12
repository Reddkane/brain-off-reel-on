import { createHash } from "node:crypto";
import { mkdir, open, readFile, unlink, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";
const cases = [
  { name: "validator", file: "src/domain/classification.ts", from: " || value < min || value > max", to: "", test: "tests/classification/core.test.ts" },
  { name: "provenance", file: "src/domain/classification.ts", from: "return [f, { basis, evidence_refs: refs }];", to: "return [f, { basis: basis.slice(0, 1), evidence_refs: refs }];", test: "tests/classification/core.test.ts" },
  { name: "personal_sentinel", file: "src/server/classification/codec.ts", from: 'hash({ version: "classification-input-v1", input })', to: 'hash({ version: "classification-input-v1", input, history: (value as { history?: unknown }).history })', test: "tests/classification/core.test.ts" },
  { name: "coverage_intersection", file: "src/domain/classification-reports.ts", from: "if (e.passing && current && ready) effectiveLinked++;", to: "if (e.passing && current) effectiveLinked++;", test: "tests/classification/reports.test.ts" },
  { name: "terms", file: "src/server/classification/phase-b.ts", from: 'if (terms.noTraining !== true)', to: 'if (false)', test: "tests/classification/anthropic.test.ts" },
  { name: "check_freshness", file: "src/server/classification/phase-b.ts", from: 'now - time > 7 * 86400000)', to: 'false)', test: "tests/classification/anthropic.test.ts", occurrence: 0 },
  { name: "known_rejections", file: "src/server/classification/anthropic.ts", from: 'const known = zeroCostVerified && rejection(response.status, response.body);', to: 'const known = false;', test: "tests/classification/anthropic.test.ts" },
  { name: "ambiguous_rejections", file: "src/server/classification/anthropic.ts", from: 'const known = zeroCostVerified && rejection(response.status, response.body);', to: 'const known = true;', test: "tests/classification/anthropic.test.ts" },
  { name: "usage_shape", file: "src/server/classification/anthropic.ts", from: 'value.cache_read_input_tokens !== 0)', to: 'value.cache_read_input_tokens !== -1)', test: "tests/classification/anthropic.test.ts" },
  { name: "no_fallback", file: "src/server/classification/anthropic.ts", from: 'return { model: c.model, max_tokens: c.maxTokens,', to: 'return { fallbacks: ["different-model"], model: c.model, max_tokens: c.maxTokens,', test: "tests/classification/anthropic.test.ts" },
  { name: "single_request", file: "src/server/classification/anthropic.ts", from: 'const response = await io.fetch(', to: 'await io.fetch(`https://api.anthropic.com/v1/${path}`, { method: "POST", signal }); const response = await io.fetch(', test: "tests/classification/anthropic.test.ts" },
  { name: "model_match", file: "src/server/classification/anthropic.ts", from: 'body.model !== c.model ? "model_mismatch"', to: 'false ? "model_mismatch"', test: "tests/classification/anthropic.test.ts" },
  { name: "readable_identity", file: "src/server/classification/phase-b.ts", from: 'return `${c.model}:effort=${c.effort}:out=${c.maxTokens}:ms=${c.timeoutMs}:v1`;', to: 'return hash(c);', test: "tests/classification/anthropic.test.ts" },
  { name: "count_schema", file: "src/server/classification/anthropic.ts", from: 'request("messages/count_tokens", body, signal,', to: 'request("messages/count_tokens", { model: body.model, messages: body.messages }, signal,', test: "tests/classification/anthropic.test.ts" },
  { name: "spend_cap", file: "src/server/classification/phase-b-run.ts", from: 'if (report.actual + report.unknown + projection > config.spendCap)', to: 'if (false)', test: "tests/classification/phase-b.test.ts" },
  { name: "oversized_input", file: "src/server/classification/phase-b-run.ts", from: 'v.budget > 5000', to: 'v.budget > 500000', test: "tests/classification/phase-b.test.ts" },
  { name: "unknown_spend", file: "src/server/classification/phase-b-run.ts", from: 'if (cost === null || !Number.isSafeInteger(cost) || cost < 0)', to: 'if (false)', test: "tests/classification/phase-b.test.ts" },
  { name: "retry_deadline", file: "src/server/classification/phase-b-run.ts", from: 'if (delay > c.timeoutMs || now() + delay + c.timeoutMs > end)', to: 'if (false)', test: "tests/classification/phase-b.test.ts" },
  { name: "phase_carryover", file: "src/server/classification/phase-b.ts", from: 'return { actual: previous.actual, unknown: previous.unknown };', to: 'return { actual: 0, unknown: 0 };', test: "tests/classification/phase-spend.test.ts" },
  { name: "continuation_phase", file: "src/server/classification/phase-b.ts", from: 'r.phaseId !== phaseId', to: 'false', test: "tests/classification/phase-b.test.ts" },
  { name: "pilot_overhead", file: "src/server/classification/phase-b.ts", from: 'config.fallbackOverhead < Math.max(', to: 'config.fallbackOverhead < -100000 + Math.max(', test: "tests/classification/phase-b.test.ts" },
  { name: "credential_duplicates", file: "scripts/classification-private.ts", from: 'if (lines.length !== 1)', to: 'if (!lines.length)', test: "tests/classification/phase-b.test.ts" },
  { name: "private_path", file: "scripts/classification-private.ts", from: 'if (!rel || isAbsolute(rel) || rel.split(sep).includes(".."))', to: 'if (false)', test: "tests/classification/phase-b.test.ts" },
  { name: "input_identity_state", file: "src/server/db/classification-store.ts", from: 'if (rows.length !== ids.length)', to: 'if (false)', test: "tests/db/classification.test.ts", db: true },
  { name: "input_expiry", file: "src/server/db/classification-store.ts", from: 'if (rows.some(r => calendarMonths(new Date(r.metadata_refreshed_at).getTime(), 6) <= Date.now()))', to: 'if (false)', test: "tests/db/classification.test.ts", db: true },
  { name: "composition_schema", file: "scripts/classification-effects.ts", from: 'if (await catalogSchemaState(client) !== currentMigrationCount)', to: 'if (false)', test: "tests/db/classification.test.ts", db: true },
  { name: "credential_permissions", file: "scripts/classification-private.ts", from: process.platform === "win32" ? '$bad.Count -ne 0' : '((await lstat(path)).mode & 0o077) !== 0', to: process.platform === "win32" ? '$false' : 'false', test: "tests/classification/private-key-process.test.ts" },
  { name: "main_fallback_measurement", file: "src/server/classification/phase-b-run.ts", from: 'if (config.stage === "main" && counted.fallback)', to: 'if (false)', test: "tests/classification/phase-b.test.ts" },
  { name: "skip_finished", file: "src/server/classification/phase-b-run.ts", from: 'if (done(index, candidateId(c))) continue;', to: 'if (false) continue;', test: "tests/classification/phase-spend.test.ts" },
  { name: "remainder_projection", file: "src/server/classification/phase-b-run.ts", from: 'done(i, candidateId(config.candidates[j])) ? 0 :', to: 'false ? 0 :', test: "tests/classification/phase-spend.test.ts" },
  { name: "fresh_db_history", file: "scripts/classification-private.ts", from: 'if (hasModels || config.continuation || prior !== undefined)', to: 'if (config.continuation || prior !== undefined)', test: "tests/classification/phase-spend.test.ts" },
  { name: "latest_phase_report", file: "scripts/classification-private.ts", from: 'head.reportHash !== hash(prior)', to: 'false', test: "tests/classification/phase-spend.test.ts" },
];
function checksum(s: string) { return createHash("sha256").update(s).digest("hex"); }
function run(args: string[]) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, args, { windowsHide: true, shell: false, timeout: 240000 }); let output = "";
    child.stdout.setEncoding("utf8").on("data", v => { output += v; }); child.stderr.setEncoding("utf8").on("data", v => { output += v; });
    child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, output }));
  });
}
await mkdir(".cache/classification/evidence", { recursive: true });
const lock = await open(".cache/classification/controls.lock", "wx");
try {
  for (const c of cases) {
    const original = await readFile(c.file, "utf8");
    const occurrences = original.split(c.from).length - 1;
    if (occurrences !== ("occurrence" in c ? 2 : 1)) throw new Error(`control_anchor_${c.name}`);
    let result;
    try { await writeFile(c.file, original.replace(c.from, c.to)); result = await run("db" in c ? ["--test", c.test] : ["node_modules/vitest/vitest.mjs", "run", c.test]); }
    finally { await writeFile(c.file, original); if (checksum(await readFile(c.file, "utf8")) !== checksum(original)) throw new Error("control_restore_failed"); }
    await writeFile(`.cache/classification/evidence/control-${c.name}.log`, result.output);
    if (result.code === 0 || !result.output.includes("AssertionError")) throw new Error(`control_not_observed_${c.name}`);
    console.log(`control=${c.name} exit=${result.code} restored=true`);
  }
  const offline = await run(["node_modules/vitest/vitest.mjs", "run", "tests/classification"]);
  await writeFile(".cache/classification/evidence/controls-offline-green.log", offline.output);
  if (offline.code) throw new Error("control_final_offline_failed");
  const db = await run(["--test", "tests/db/classification.test.ts"]);
  await writeFile(".cache/classification/evidence/controls-db-green.log", db.output);
  if (db.code) throw new Error("control_final_db_failed");
  console.log(`controls=${cases.length} offline=0 db=0 restored=true`);
} finally { await lock.close(); await unlink(".cache/classification/controls.lock"); }
