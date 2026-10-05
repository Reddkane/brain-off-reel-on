import { boundedText } from "./catalog-config.ts";
import { SweepError } from "../src/server/providers/watchmode.ts";
export function decodeWatchmodeKeyFile(input: string): string {
  const matches = [...input.matchAll(/^\s*(?:export\s+)?(WATCHMODE[A-Z0-9_]*(?:KEY|TOKEN)[A-Z0-9_]*)\s*=\s*(.*?)\s*$/gm)];
  if (matches.length !== 1)
    throw new SweepError("credential_invalid");
  const key = matches[0][2].replace(/^(["'])(.*)\1$/, "$2");
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(key))
    throw new SweepError("credential_invalid");
  return key;
}
// Fixed credential file; no environment override, URL credential, or import-time read.
export async function readWatchmodeKey(): Promise<string> {
  try {
    return decodeWatchmodeKeyFile(await boundedText(".env.local", 65536));
  }
  catch {
    throw new SweepError("credential_invalid");
  }
}
