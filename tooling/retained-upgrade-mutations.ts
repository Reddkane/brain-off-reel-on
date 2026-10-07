import { spawn } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const cleanup = `    if (io.expirePrivateFiles) {
      try {
        privateCleanup = await io.expirePrivateFiles(io.now(), lock.signal);
        await lock.check();
      }
      catch {
        throw new SweepError("private_cleanup_failed");
      }
    }
`;
const cases = [
  {
    name: "state_check_removed",
    file: "scripts/catalog-local.ts",
    // State 3 deliberately forces replay at every later inventory, including state 6.
    mutate: (source: string) => source.replace("const state = await catalogSchemaState(client);", "const state = 3;"),
    test: "tests/db/catalog.test.ts",
  },
  {
    name: "cleanup_after_provider",
    file: "src/server/ingestion/availability-sweeps.ts",
    mutate: (source: string) => source.replace(cleanup, "").replace(
      "    before = await io.watchmode.status(wm);",
      "    before = await io.watchmode.status(wm);\n" + cleanup),
    test: "tests/db/availability-live.test.ts",
  },
];

async function run(test: string) {
  return new Promise<{ code: number; output: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ["--test", test], {
      shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => { output += value; });
    child.stderr.setEncoding("utf8").on("data", (value: string) => { output += value; });
    child.on("error", reject);
    child.on("close", code => resolve({ code: code ?? 1, output }));
  });
}

await mkdir(".cache/retained-upgrade", { recursive: true });
for (const control of cases) {
  const original = await readFile(control.file, "utf8"), normalized = original.replaceAll("\r\n", "\n");
  const mutated = control.mutate(normalized);
  if (normalized === mutated)
    throw new Error("mutation_anchor_missing");
  try {
    await writeFile(control.file, mutated);
    const result = await run(control.test);
    await writeFile(`.cache/retained-upgrade/${control.name}.log`, result.output);
    console.log(`${control.name}: expected-red exit=${result.code}`);
    console.log(result.output.split(/\r?\n/).filter(line => /(?:tests|pass|fail|cancelled|skipped) \d+$/.test(line)).join("\n"));
    if (result.code === 0 || !/fail [1-9]/.test(result.output))
      throw new Error("mutation_survived_or_no_assertion");
  }
  finally {
    await writeFile(control.file, original);
  }
}
console.log("Both mutation sources restored; run the shared commands for final green.");
