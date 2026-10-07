# Hosting

Status: planning notes only; no hosting implementation or deployment is authorized.
The [architecture](../architecture.md) owns scheduler, protected-handler, connection
and runtime requirements. [Availability: sweeps](availability-sweeps.md) owns the
worker's six-hour resume window and bounded attempts.

## Availability recovery

A daily invocation alone cannot resume a sweep interrupted by a Watchmode outage:
the next daily run is beyond the six-hour window. When a run exits 2 with
`provider_transient` or `provider_throttled`, arrange a bounded follow-up invocation
before six hours from the existing sweep's original start, with provider backoff
and the same target/configuration generation. Do not measure the window from the
failure or retry time, and do not reset observation ages. Verify the remaining
window from the staged checkpoints when hosting is implemented.

Retain the originating transient/throttled diagnostic in operational run history
and relate retries/expiry to that run. A later `expired` event must not erase the
original cause from recovery diagnostics. Test timely resume, no retry storm during
an outage, expiry beyond the window, and overlap refusal under the shared lock.

Choose and verify the retry mechanism during hosting implementation; daily Cron
does not itself provide the required recovery policy. This note enables no schedule
and changes no current worker code. Retained live sweeps remain blocked until
Availability: evidence's retention path is implemented and accepted.

## Provider identity

Migration 6 seeds stable internal UUIDs and the verified direct Watchmode mappings
for Netflix (203), HBO Max (387), Disney+ (372) and Hulu (157) in every database,
including future hosted setup. Conflicting mappings abort the transaction; the
mapping guard denies updates/deletes and provider cascades. Live composition
checks the four mappings under its lock before cleanup or provider spending.
Hosting must apply migrations rather than reproducing a test or manual seed.
This note authorizes no hosted resources, schedule or provider requests.
