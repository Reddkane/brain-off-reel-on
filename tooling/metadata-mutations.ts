import { mkdir, readFile, writeFile } from "node:fs/promises";
import { spawn } from "node:child_process";

const cases = [{
  name: "distribution_as_production",
  file: "src/domain/production-origin.ts",
  from: /r => \["production", "co_production", "commissioning", "financing"\]\.includes\(r\.relationship\) &&\s+/g,
  to: "r => ",

  extra: {
    from: /uncovered \|\|\s+conflicting/g,
    to: "uncovered"
  },

  test: "tests/metadata/origin.test.ts"
}, {
  name: "primary_as_selected_release",
  file: "src/domain/metadata-evidence.ts",
  from: /date: selected\.date,/g,
  to: "date: primary ?? selected.date,",
  test: "tests/metadata/evidence.test.ts"
}, {
  name: "request_accounting_removed",
  file: "src/server/providers/tmdb.ts",
  from: "ctx.budget.attempts++;",
  to: "",
  test: "tests/metadata/security.test.ts"
}, {
  name: "personal_overwrite_enabled",
  file: "src/domain/ratings-import.ts",
  from: "  if (existing &&",
  to: "  existing = null;\n  if (existing &&",
  test: "tests/metadata/ratings.test.ts"
}, {
  name: "catalog_error_committed",
  file: "src/server/db/pg-store.ts",
  from: 'await client.query("ROLLBACK");',
  to: 'await client.query("COMMIT");',
  test: "database"
}, {
  name: "capability_check_removed",
  file: "src/server/db/pg-store.ts",
  from: /const issued = operators\.get\(op\);\s+return issued !== undefined &&\s+issued\.profileId === op\.profileId &&\s+issued\.accountId === op\.accountId;/g,
  to: "void op; return true;",
  test: "database"
}, {
  name: "profile_lock_removed",
  file: "src/server/db/pg-store.ts",
  from: "SELECT account_id FROM app.profiles WHERE id=$1 FOR UPDATE",
  to: "SELECT account_id FROM app.profiles WHERE id=$1",
  test: "database"
}];

function hasOneMatch(source: string, anchor: string | RegExp): boolean {
  return typeof anchor === "string" ? source.split(anchor).length === 2 : [...source.matchAll(anchor)].length === 1;
}

function run(args: string[]): Promise<{
  code: number;
  output: string;
}> {
  return new Promise((resolve, reject) => {
    const p = spawn(process.execPath, args, {
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"]
    });

    let output = "";

    p.stdout.setEncoding("utf8").on("data", (s: string) => {
      output += s;
    });

    p.stderr.setEncoding("utf8").on("data", (s: string) => {
      output += s;
    });

    p.on("error", reject);

    p.on("close", code => resolve({
      code: code ?? 1,
      output
    }));
  });
}

try {
  if (process.argv.length !== 2)
    throw new Error("no_arguments");

  await mkdir(".cache/pr03", {
    recursive: true
  });

  for (const control of cases) {
    const original = await readFile(control.file, "utf8");

    if (!hasOneMatch(original, control.from))
      throw new Error("mutation_anchor");

    try {
      let mutated = original.replace(control.from, control.to);

      if ("extra" in control && control.extra) {
        if (!hasOneMatch(mutated, control.extra.from))
          throw new Error("mutation_anchor");

        mutated = mutated.replace(control.extra.from, control.extra.to);
      }

      await writeFile(control.file, mutated);

      const result = await run(
        control.test === "database" ? ["tooling/metadata-db-test.ts"] : ["node_modules/vitest/vitest.mjs", "run", control.test]
      );

      await writeFile(`.cache/pr03/${control.name}.log`, result.output);
      const output = result.output.replace(/\x1b\[[0-9;]*m/g, "");

      if (result.code === 0 ||
        !/AssertionError/.test(output) ||
        /PARSE_ERROR|Transform failed|Cannot find|SyntaxError/.test(output))
        throw new Error("mutation_not_detected");

      if (control.name === "profile_lock_removed" &&
        (!/FAIL\s+tests\/db\/ratings\.test\.ts\s*>\s*two imports lock profile/.test(output) ||
          !/FAIL\s+tests\/db\/ratings\.test\.ts\s*>\s*profile deletion synchronizes/.test(output)))
        throw new Error("profile_lock_assertions_missing");

      console.log(`EXPECTED RED ${control.name} assertion failure; restoration required`);
    } finally {
      await writeFile(control.file, original);
    }
  }

  const offline = await run(["node_modules/vitest/vitest.mjs", "run"]);
  await writeFile(".cache/pr03/controls-final-offline.log", offline.output);

  if (offline.code)
    throw new Error("final_offline_failed");

  const database = await run(["tooling/metadata-db-test.ts"]);
  await writeFile(".cache/pr03/controls-final-database.log", database.output);

  if (database.code)
    throw new Error("final_database_failed");

  console.log("PASS all seven named expected-red controls restored; final offline and two-cycle database green");
} catch {
  console.error("metadata_controls_failed");
  process.exitCode = 1;
}
