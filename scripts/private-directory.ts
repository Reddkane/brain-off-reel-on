import { lstat, mkdir, realpath } from "node:fs/promises";
import { resolve, join } from "node:path";
/** Walk each fixed component before creation; never follow a private-root junction. */
export async function safePrivateDirectory(root: string, parts: readonly string[]) {
  let path = await realpath(root);
  if (resolve(path).toLowerCase() !== resolve(root).toLowerCase()) throw new Error("private_path_required");
  for (const part of parts) {
    if (!/^[a-zA-Z0-9.-]+$/.test(part) || part === "." || part === "..") throw new Error("private_path_required");
    path = join(path, part);
    try { await mkdir(path, { mode: 0o700 }); }
    catch (error) { if (!error || typeof error !== "object" || !("code" in error) || error.code !== "EEXIST") throw error; }
    const stat = await lstat(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() ||
      resolve(await realpath(path)).toLowerCase() !== resolve(path).toLowerCase()) throw new Error("private_path_required");
  }
  return path;
}
