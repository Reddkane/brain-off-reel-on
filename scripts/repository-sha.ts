import { execFile } from "node:child_process";
/** Leaf module: CLI entry files import it without importing each other. */
export function repositorySha(signal?: AbortSignal) {
  // The SHA is public repository metadata; no shell or inherited git output.
  return new Promise<string>((resolve, reject) => execFile("git", ["rev-parse", "HEAD"], {
    windowsHide: true,
    timeout: 5000,
    cwd: new URL("../", import.meta.url),
    signal,
  }, (error, stdout) => error ? reject(new Error("repository_sha_failed")) : resolve(stdout.trim())));
}
