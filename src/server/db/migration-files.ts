import { readdir } from "node:fs/promises";

/** Shared filename discovery for setup, upgrades and disposable replay. */
export async function migrationFiles() {
  return (await readdir(new URL("../../../supabase/migrations/", import.meta.url)))
    .filter(file => file.endsWith(".sql")).sort();
}
