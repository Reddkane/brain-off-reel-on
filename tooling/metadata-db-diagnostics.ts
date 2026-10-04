// Never forward raw Docker, driver, filesystem or runner errors.
const codes = new Set([
  "no_arguments", "docker_unavailable", "docker_timeout", "docker_version_failed",
  "docker_network_failed", "docker_run_failed", "docker_inspect_failed",
  "docker_exec_failed", "docker_image_failed", "docker_rm_failed",
  "docker_ps_failed", "container_binding", "container_isolation",
  "network_isolation", "target_guard", "network_id", "image_pin",
  "container_id", "startup_timeout", "cleanup_timeout",
  "container_teardown", "network_teardown", "invalid_input",
  "metadata_suite_timeout", "metadata_unhandled_errors",
  "metadata_suite_inventory", "metadata_suite_failed"
]);

export function metadataDatabaseCodes(error: unknown): string[] {
  if (error instanceof AggregateError) {
    // The disposable runner preserves work and cleanup failures separately.
    return [...new Set(error.errors.slice(0, 2).flatMap(metadataDatabaseCodes))];
  }
  return [error instanceof Error && codes.has(error.message)
    ? error.message : "metadata_database_failed"];
}
