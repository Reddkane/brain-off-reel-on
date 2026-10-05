/** Public diagnostics are fixed codes; external error messages never enter reports. */
export const sweepCodes = [
  "refresh_overlap", "refresh_lock_lost", "refresh_lock_failed", "target_guard",
  "cancelled", "wall_budget", "credit_budget", "database_budget", "provider_auth",
  "provider_throttled", "provider_transient", "provider_http", "body_invalid",
  "body_limit", "status_invalid", "quota_insufficient", "page_invalid",
  "totals_invalid", "title_invalid", "identity_invalid", "popularity_invalid",
  "page_incomplete", "request_invalid", "checkpoint_failed", "sweep_expired",
  "sweep_closed", "page_conflict", "page_nonadvancing", "totals_changed",
  "page_stalled", "pagination_drift", "membership_incomplete", "page_budget",
  "catalog_limit", "metadata_failed", "readback_mismatch", "report_failed",
  "terms_required", "detail_budget", "credential_invalid", "config_invalid",
  "sweep_too_large", "service_partial", "sweep_failed", "combined_page_limit",
  "capacity_blocked", "complete",
] as const;

export type SweepCode = typeof sweepCodes[number];
const publicCodes: ReadonlySet<string> = new Set(sweepCodes);

export class SweepError extends Error {
  readonly code: SweepCode;
  constructor(code: SweepCode) {
    super(code);
    this.code = code;
  }
}

export function sweepCode(error: unknown): SweepCode {
  return error instanceof SweepError && publicCodes.has(error.code) ? error.code : "sweep_failed";
}
