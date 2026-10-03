import { describe, expect, it } from "vitest";
import { normalizeCertification, normalizeRelease, releaseDay, strictDate } from "../../src/domain/metadata-evidence.ts";
import { cohort } from "../../src/server/ingestion/discovery.ts";
import { at } from "./helpers.ts";

const event = (date: string, type = 3, country = "US", certification = "PG") => ({
  date,
  type,
  country,
  certification
});

describe("typed release policy", () => {
  it.each(["2023-02-29", "1900-02-29", "2024-04-31", "0000-01-01", "2026-13-01", "2026-00-01", "2026-01-00"])("rejects impossible %s", d => expect(strictDate(d)).toBe(false));
  it.each(["2000-02-29", "2024-02-29", "2026-10-03"])("accepts real %s", d => expect(strictDate(d)).toBe(true));

  it("retains date component and rejects invalid offsets", () => {
    expect(releaseDay("2025-01-01T23:59:59-14:00")).toBe("2025-01-01");

    for (const t of [
      "2025-01-01T25:00:00Z",
      "2025-01-01T00:00:00+14:01",
      "2025-01-01T00:00:00+01:60",
      "2025-02-29T00:00:00Z"
    ])
      expect(releaseDay(t)).toBeNull();
  });

  it("prefers earliest US 2/3/4 over festivals and foreign releases", () => {
    const result = normalizeRelease(
      [event("2000-01-01", 1), event("2025-03-01", 4), event("2025-02-01", 2), event("2025-01-01", 3, "GB")],
      "2000-01-01",
      at
    );

    expect(result.release?.date).toBe("2025-02-01");
    expect(result.release?.semantics).toBe("theatrical");
    expect(cohort(result.release?.date ?? null, "2026-10-03")).toBe("recent");
  });

  it(
    "festival-only remains unknown",
    () => expect(normalizeRelease([event("2000-01-01", 1)], "2000-01-01", at).release).toBeNull()
  );

  it("N2 later primary than selected US event is counted as release_ambiguous", () => {
    const r = normalizeRelease([event("2025-01-01", 2)], "2025-02-01", at);
    expect(r.release).toBeNull();
    expect(r.issues[0].code).toBe("release_ambiguous");
  });

  it("worldwide fallback checks unexplained earlier primary", () => {
    expect(normalizeRelease([event("2025-01-01", 5, "GB")], "2000-01-01", at).release).toBeNull();

    expect(
      normalizeRelease([event("2000-01-01", 1, "GB"), event("2025-01-01", 5, "GB")], "2000-01-01", at).release?.source
    ).toContain("worldwide_fallback");
  });

  it("future is separate and dates are never discovery truth", () => {
    expect(cohort("2099-01-01", "2026-10-03")).toBe("future");
    expect(cohort(null, "2026-10-03")).toBe("unknown");
  });

  it("certification uses US theatrical tier, not latest or least restrictive", () => {
    expect(
      normalizeCertification([event("2025-01-01", 3, "US", "R"), event("2025-02-01", 4, "US", "PG")], at).certification?.value
    ).toBe("R");

    expect(
      normalizeCertification([event("2025-01-01", 2, "US", "PG"), event("2025-02-01", 3, "US", "R")], at).certification
    ).toBeNull();
  });

  it.each(["", "Unrated", "NR"])(
    "blank/unrecognized/explicit NR %s",
    code => expect(normalizeCertification([event("2025-01-01", 4, "US", code)], at).certification?.value ?? null).toBe(code === "NR" ? "NR" : null)
  );

  it(
    "foreign certification does not apply",
    () => expect(normalizeCertification([event("2025-01-01", 3, "GB", "PG")], at).certification).toBeNull()
  );
});
