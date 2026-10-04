import { expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { metadataDatabaseCodes } from "../../tooling/metadata-db-diagnostics.ts";

it("the actual metadata DB entry point emits a safe argument refusal before Docker work", () => {
  const result = spawnSync(process.execPath, ["tooling/metadata-db-test.ts", "unsupported"], {
    encoding: "utf8", timeout: 15000, windowsHide: true
  });
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr.trim()).toBe("no_arguments");
}, 20000);

it("prints allowlisted lifecycle and suite failures, preserving work and cleanup codes", () => {
  for (const code of ["docker_exec_failed", "startup_timeout", "metadata_suite_timeout",
    "metadata_unhandled_errors", "metadata_suite_inventory", "metadata_suite_failed"])
    expect(metadataDatabaseCodes(new Error(code))).toEqual([code]);
  expect(metadataDatabaseCodes(new AggregateError([
    new Error("docker_exec_failed"), new Error("container_teardown")
  ]))).toEqual(["docker_exec_failed", "container_teardown"]);
});

it("redacts unknown errors including lowercase secret-like strings and aggregate children", () => {
  for (const error of [new Error("invented_secret_sentinel"), "docker_exec_failed", null])
    expect(metadataDatabaseCodes(error)).toEqual(["metadata_database_failed"]);
  expect(metadataDatabaseCodes(new AggregateError([
    new Error("invented_secret_sentinel"), new Error("docker_rm_failed")
  ], "invented_secret_sentinel"))).toEqual(["metadata_database_failed", "docker_rm_failed"]);
});
