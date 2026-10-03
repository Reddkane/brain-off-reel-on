import type { Certification, CertificationEvidence, DateEvidence, Issue } from "./metadata.ts";

export function strictDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value))
    return false;

  const y = Number(value.slice(0, 4)), m = Number(value.slice(5, 7)), d = Number(value.slice(8));
  const leap = y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return y > 0 && m >= 1 && m <= 12 && d > 0 && d <= days[m - 1];
}

export function releaseDay(value: string): string | null {
  const day = value.slice(0, 10);

  if (!strictDate(day))
    return null;

  if (value.length === 10)
    return day;

  const match = /^\d{4}-\d{2}-\d{2}T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,9})?(?:Z|([+-])(\d{2}):(\d{2}))$/.exec(value);

  if (!match ||
    Number(match[1]) > 23 ||
    Number(match[2]) > 59 ||
    Number(match[3]) > 59 ||
    Number(match[5] ?? 0) > 14 ||
    Number(match[6] ?? 0) > 59 ||
    (Number(match[5]) === 14 &&
      Number(match[6]) !== 0))
    return null;

  return day;
}

export interface ReleaseEvent {
  readonly country: string;
  readonly date: string;
  readonly type: number;
  readonly certification: string;
}

export function normalizeRelease(events: readonly ReleaseEvent[], primary: string | null, at: string): {
  release: DateEvidence | null;
  issues: readonly Issue[];
} {
  const us = events.filter(e => e.country === "US" && [2, 3, 4].includes(e.type));
  const choices = (us.length ? us : events.filter(e => [2, 3, 4, 5, 6].includes(e.type))).slice().sort((a, b) => a.date.localeCompare(b.date) ||
    a.country.localeCompare(b.country) ||
    a.type - b.type);
  const selected = choices[0];
  const explained = primary !== null && events.some(e => e.date <= primary);

  if (!selected ||
    (primary !== null &&
      (primary > selected.date ||
        (!us.length &&
          primary < selected.date &&
          !explained)))) {
    return {
      release: null,

      issues: [{
        code: "release_ambiguous",
        field: "release",
        severity: "warning"
      }]
    };
  }

  return {
    release: {
      date: selected.date,
      semantics: selected.type === 2 ||
        selected.type === 3 ? "theatrical" : selected.type === 4 ? "digital" : "other",
      source: `tmdb-release-v1/release_dates/${us.length ? "US" : "worldwide_fallback"}/${selected.country}/type-${selected.type}`,
      checkedAt: at
    },

    issues: []
  };
}

function certification(value: string): Certification | null {
  switch (value) {
    case "G":
    case "PG":
    case "PG-13":
    case "R":
    case "NC-17":
    case "NR":
      return value;
    default:
      return null;
  }
}

export function normalizeCertification(events: readonly ReleaseEvent[], at: string): {
  certification: CertificationEvidence | null;
  issues: readonly Issue[];
} {
  const us = events.filter(e => e.country === "US" && e.certification.trim() !== "");
  const theatrical = us.filter(e => e.type === 2 || e.type === 3);
  const tier = theatrical.length ? theatrical : us.filter(e => e.type === 4);
  const codes = [...new Set(tier.map(e => e.certification))];
  const value = codes.length === 1 ? certification(codes[0]) : null;

  return value ? {
    certification: {
      value,
      source: `tmdb-us-certification-v1/release_dates/US/${theatrical.length ? "theatrical" : "digital"}`,
      checkedAt: at
    },

    issues: []
  } : {
    certification: null,

    issues: [{
      code: codes.length ? "certification_ambiguous" : "certification_missing",
      field: "certification",
      severity: "warning"
    }]
  };
}
