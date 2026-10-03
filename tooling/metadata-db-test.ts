import { createVitest } from "vitest/node";
import { withDisposable } from "./metadata-disposable.ts";

try {
  if (process.argv.length !== 2)
    throw new Error("no_arguments");

  const signal = AbortSignal.timeout(480000);

  for (let cycle = 0;cycle < 2;cycle++) await withDisposable(async target => {
    const runner = await createVitest({
      config: false,
      root: process.cwd(),
      watch: false,
      reporters: ["verbose"],
      testTimeout: 15000,
      hookTimeout: 15000,
      maxWorkers: 1,
      fileParallelism: false,
      include: ["tests/db/metadata.test.ts", "tests/db/ratings.test.ts", "tests/db/metadata-runner.test.ts"],

      provide: {
        metadataTarget: {
          ...target.pool.options,
          password: target.pool.options.password
        }
      }
    });

    let timedOut = false;

    const cancel = () => {
      timedOut = true;
      void runner.cancelCurrentRun("test-failure");
    };

    const suiteTimer = setTimeout(cancel, 150000);

    target.signal.addEventListener("abort", cancel, {
      once: true
    });

    try {
      await runner.start();

      if (timedOut ||
        runner.state.getUnhandledErrors().length ||
        runner.state.getFiles().length !== 3 ||
        runner.state.getFiles().some(f => f.result?.state !== "pass"))
        throw new Error("metadata_database_failed");
    } finally {
      clearTimeout(suiteTimer);
      target.signal.removeEventListener("abort", cancel);
      await runner.close();
    }

    console.log(`PASS fresh PR 3 cycle=${cycle + 1}`);
  }, {
    signal
  });
} catch {
  console.error("metadata_database_failed");
  process.exitCode = 1;
}
