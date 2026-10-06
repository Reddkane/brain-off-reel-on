import { expect, it } from "vitest";
import { catalogLocalDiagnostic } from "../../scripts/catalog-local.ts";
it.each(["setup", "upgrade", "inspect", "start", "stop"])("%s preserves the non-backup unknown failure diagnostic", async action => {
  expect(await catalogLocalDiagnostic(action, new Error("invented_secret_sentinel"))).toBe("catalog_local_failed_inspect_required");
});
it("backup retains its fixed fallback and allowlisted failures stay precise", async () => {
  expect(await catalogLocalDiagnostic("backup", new Error("invented_secret_sentinel"))).toBe("backup_failed");
  expect(await catalogLocalDiagnostic("upgrade", new Error("upgrade_required"))).toBe("upgrade_required");
});
