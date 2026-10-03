import test from "node:test";
import assert from "node:assert/strict";
import { disposable, validateArguments, verifyContainer } from "../../tooling/db-test.mjs";

const id = "a".repeat(64);
const token = "fixture";
const inspected = () => ({ Id: id, Name: `/bor-pr02-${token}`, Config: { Labels: { "bor.pr02.disposable": "true", "bor.pr02.run": token } }, HostConfig: { NetworkMode: "none", Tmpfs: { "/var/lib/postgresql/data": "" } }, Mounts: [] });
function stub({ mismatch = false, missing = false, ready = true, abort, abortReason = "handled interruption", sqlFailure = false, remaining = false } = {}) {
  const calls = [];
  const docker = async (args) => {
    calls.push(args);
    if (missing) throw new Error("Docker unavailable");
    if (args[0] === "run") return { code: 0, stdout: id, stderr: "" };
    if (args[0] === "inspect") return { code: 0, stdout: JSON.stringify([{ ...inspected(), ...(mismatch ? { Name: "/foreign" } : {}) }]), stderr: "" };
    if (args.includes("pg_isready")) {
      abort?.abort(new Error(abortReason));
      return { code: ready ? 0 : 1, stdout: "", stderr: "" };
    }
    if (args.includes("psql") && sqlFailure) return { code: 1, stdout: "", stderr: "synthetic SQL failure" };
    if (args[0] === "ps" && remaining) return { code: 0, stdout: id, stderr: "" };
    return { code: 0, stdout: "", stderr: "" };
  };
  return { docker, calls };
}
test("unexpected arguments refused", () => assert.throws(() => validateArguments(["reset"]), /no arguments/));
test("identity, labels, ports and storage mismatches refused", () => {
  verifyContainer(inspected(), id, token);
  for (const change of [{ Id: "foreign" }, { Name: "/foreign" }, { Config: { Labels: {} } }, { HostConfig: { NetworkMode: "bridge" } }, { HostConfig: { ...inspected().HostConfig, PortBindings: { port: [] } } }, { Mounts: [{ Type: "bind", Destination: "/data" }] }]) {
    assert.throws(() => verifyContainer({ ...inspected(), ...change }, id, token), /mismatch/);
  }
});
test("missing Docker is loud and creates nothing", async () => {
  const { docker, calls } = stub({ missing: true });
  await assert.rejects(disposable({ docker, image: "test", token, execute: async () => {} }), /unavailable/);
  assert.equal(calls.length, 1);
});
test("identity mismatch refuses SQL and removal", async () => {
  const { docker, calls } = stub({ mismatch: true });
  await assert.rejects(disposable({ docker, image: "test", token, execute: async () => assert.fail("SQL") }), /mismatch/);
  assert.ok(!calls.some((args) => args[0] === "rm" || args.includes("psql")));
});
test("bounded readiness failure cleans created container", async () => {
  const { docker, calls } = stub({ ready: false }); let time = 0;
  await assert.rejects(disposable({ docker, image: "test", token, now: () => time += 31000, pause: async () => {}, execute: async () => assert.fail("SQL") }), /readiness/);
  assert.ok(calls.some((args) => args[0] === "rm" && args[2] === id));
});
test("SQL/test failure cleans and verifies teardown", async () => {
  const { docker, calls } = stub();
  await assert.rejects(disposable({ docker, image: "test", token, execute: async () => { throw new Error("SQL test failure"); } }), /SQL test/);
  assert.equal(calls.at(-1)[0], "ps");
});
test("abort cleanup uses verified created ID", async () => {
  const abort = new AbortController(); const { docker, calls } = stub({ abort });
  await assert.rejects(disposable({ docker, image: "test", token, signal: abort.signal, execute: async (sql) => { await sql("SELECT 1"); } }), /handled interruption/);
  assert.ok(calls.some((args) => args[0] === "rm"));
  assert.ok(!calls.some((args) => args.includes("psql")));
});
test("stopped container remains inspectable and preserves execution error", async () => {
  const { docker, calls } = stub();
  const failure = new Error("Postgres stopped mid-run");
  let stopped = false;
  await assert.rejects(disposable({ docker: async (args, ...rest) => {
    // Model Docker auto-removal: a stopped --rm container cannot be inspected.
    if (args[0] === "inspect" && stopped && calls.find((call) => call[0] === "run")?.includes("--rm")) {
      return { code: 1, stdout: "", stderr: "no such container" };
    }
    return docker(args, ...rest);
  }, image: "test", token, execute: async () => { stopped = true; throw failure; } }), (error) => error === failure);
  assert.ok(!calls.find((args) => args[0] === "run").includes("--rm"));
  assert.equal(calls.at(-2)[0], "rm");
  assert.equal(calls.at(-1)[0], "ps");
});
test("nonzero psql exit fails acceptance and cleans up", async () => {
  const { docker, calls } = stub({ sqlFailure: true });
  await assert.rejects(disposable({ docker, image: "test", token, execute: async (sql) => { await sql("SELECT 1"); } }), /SQL acceptance failed/);
  assert.equal(calls.at(-1)[0], "ps");
});
test("teardown verification refuses a surviving container", async () => {
  const { docker } = stub({ remaining: true });
  await assert.rejects(disposable({ docker, image: "test", token, execute: async () => {} }), /teardown failed/);
});
test("successful SQL has explicit loopback, database and role flags", async () => {
  const { docker, calls } = stub();
  await disposable({ docker, image: "test", token, execute: async (sql) => { await sql("SELECT 1"); } });
  const sql = calls.find((args) => args.includes("psql"));
  assert.ok(sql.includes("127.0.0.1") && sql.includes("bor_migrator") && sql.includes("bor_pr02_test") && sql.includes("--single-transaction"));
  assert.equal(calls.at(-1)[0], "ps");
});
