import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
const cases = [
  { name: "catalog_action_fallback_regression", file: "scripts/catalog-local.ts", from: 'action === "backup" ? backupCode(error) : "catalog_local_failed_inspect_required"', to: 'backupCode(error)', tests: ["tests/metadata/catalog-local-diagnostics.test.ts"] },
  { name: "batch_command_entry_removed", file: "scripts/availability-batch.ts", from: 'if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {', to: 'if (false) {', tests: ["tests/metadata/availability-batch.test.ts"] },
  { name: "batch_credit_total_reset", file: "scripts/availability-batch.ts", from: 'totals.attemptedCredits = count(totals.attemptedCredits + count(report.attemptedCredits));', to: 'totals.attemptedCredits = count(report.attemptedCredits);', tests: ["tests/metadata/availability-batch.test.ts"] },
  { name: "operational_exit_zero", file: "scripts/availability-sweeps.ts", from: "return result.exitCode;", to: "return 0;", tests: ["tests/metadata/availability-sweeps.test.ts"] },
  { name: "live_path_guards_removed", file: "scripts/availability-sweeps.ts", from: 'export async function validateLiveConfigPath(path: string, root = repositoryRoot) {', to: 'export async function validateLiveConfigPath(path: string, root = repositoryRoot) { return; ', tests: ["tests/metadata/availability-sweeps.test.ts"] },
  { name: "live_report_overwrites", file: "scripts/availability-live.ts", from: 'flag: "wx", mode: 0o600, signal,', to: 'flag: "w", mode: 0o600, signal,', tests: ["tests/metadata/availability-sweeps.test.ts"] },
  { name: "signal_listener_removed", file: "scripts/availability-sweeps.ts", from: 'process.on("SIGINT", cancel);', to: '// Removed SIGINT control.', tests: ["tests/metadata/availability-sweeps.test.ts"] },
  { name: "locked_preflight_removed", file: "src/server/ingestion/availability-sweeps.ts", from: "if (io.preflight) await database(() => lock!.inspect(io.preflight!));", to: "// Removed locked preflight control.", tests: ["tests/db/availability-live.test.ts"] },
  { name: "cli_refuses_all", file: "scripts/availability-sweeps.ts", from: "const result = await live(config, signal), r = result.report;", to: 'throw new Error("sweep_failed");\n    const result = await live(config, signal), r = result.report;', tests: ["tests/db/availability-live.test.ts"] },
  { name: "batch_always_stops", file: "scripts/availability-batch.ts", from: 'result("continue", "progress")', to: 'result("stop", "progress")', tests: ["tests/metadata/availability-batch.test.ts"] },
  { name: "backup_overwrites", file: "scripts/catalog-backup.ts", from: 'open(dumpPath, "wx", 0o600)', to: 'open(dumpPath, "w", 0o600)', tests: ["tests/db/catalog.test.ts"] },
  { name: "backup_identity_always_equal", file: "scripts/catalog-backup.ts", from: 'Reflect.get(before, key) === Reflect.get(after, key)', to: 'true', tests: ["tests/db/catalog.test.ts"] },
  { name: "backup_state_check_removed", file: "scripts/catalog-backup.ts", from: 'const state = await abortable(catalogSchemaState(client));', to: 'const state = 3;', tests: ["tests/db/catalog.test.ts"] },
  { name: "backup_snapshot_omitted", file: "scripts/catalog-backup.ts", from: '`--snapshot=${snapshot}`', to: '"--verbose"', tests: ["tests/db/catalog.test.ts"] },
  { name: "backup_failure_cleanup_removed", file: "scripts/catalog-backup.ts", from: "if (!success) {", to: "if (false) {", tests: ["tests/db/catalog.test.ts"] },
  { name: "backup_hash_check_removed", file: "scripts/catalog-backup.ts", from: 'if (hash.digest("hex") !== manifest.sha256)', to: 'if (false)', tests: ["tests/db/catalog.test.ts"] },
];
await mkdir(".cache/availability-controls", { recursive: true });
const selected = new Set(process.argv.slice(2));
if ([...selected].some(name => !cases.some(control => control.name === name))) throw new Error("mutation_name_invalid");
for (const control of cases.filter(control => selected.size === 0 || selected.has(control.name))) {
  const original = await readFile(control.file, "utf8"), normalized = original.replaceAll("\r\n", "\n");
  if (!normalized.includes(control.from)) throw new Error("mutation_anchor_missing");
  try {
    await writeFile(control.file, normalized.replace(control.from, control.to));
    const offline = control.tests[0].includes("/metadata/");
    const args = offline ? ["node_modules/vitest/vitest.mjs", "run", ...control.tests] : ["--test", ...control.tests];
    const result = await new Promise<{ code: number; output: string }>((resolve, reject) => {
      const child = spawn(process.execPath, args, { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let output = "";
      child.stdout.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
      child.stderr.setEncoding("utf8").on("data", (chunk: string) => { output += chunk; });
      child.on("error", reject); child.on("close", code => resolve({ code: code ?? 1, output }));
    });
    await writeFile(`.cache/availability-controls/${control.name}.log`, result.output);
    console.log(`${control.name}: expected-red exit=${result.code}`);
    console.log(result.output.split(/\r?\n/).filter(line => /(?:tests|pass|fail|cancelled|skipped) \d+$|Tests .*failed/.test(line)).join("\n"));
    if (result.code === 0 || !(offline ? /[1-9]\d* failed/.test(result.output) : /fail [1-9]/.test(result.output)))
      throw new Error("mutation_survived_or_no_assertion");
  }
  finally { await writeFile(control.file, original); }
}
console.log("All availability mutation sources restored; run shared commands for final green.");
