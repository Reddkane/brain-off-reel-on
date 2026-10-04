import { open } from "node:fs/promises";
import { resolve, relative, isAbsolute } from "node:path";
import { strictDate } from "../src/domain/metadata-evidence.ts";
import { decodeConfig } from "../src/server/ingestion/config.ts";
import { array, exactKeys, integer, object, providerId, text } from "../src/server/providers/tmdb-validation.ts";
export const firstImportLimits: Readonly<Record<"pages" | "operations" | "titles" | "details" | "attempts" | "catalog" | "durationMs" | "databaseMs", number>> = Object.freeze({
  pages: 2,
  operations: 40,
  titles: 100,
  details: 100,
  attempts: 200,
  catalog: 1000,
  durationMs: 600000,
  databaseMs: 120000
});
export const subscriptions = Object.freeze({
  Netflix: "Without ads, direct",
  "HBO Max": "Standard, no ads, direct",
  "Disney+": "Disney+/Hulu bundle with ads; no Live TV",
  Hulu: "Disney+/Hulu bundle with ads; no Live TV"
});
export const privateDirectory = resolve(".cache/real-catalog/private");
// Only known internal codes are printable. Even a lowercase raw error/secret is
// not trusted merely because it happens to look like an identifier.
const diagnosticCodes = new Set([
  "invalid_action", "invalid_arguments", "image_pin", "image_not_cached",
  "container_identity", "container_binding", "container_network", "container_image",
  "container_id", "resource_identity", "resource_occupied", "port_occupied",
  "docker_failed", "credential_invalid", "credential_file_exists", "startup_failed",
  "setup_nonempty", "setup_failed_inspect_required", "setup_incomplete",
  "runtime_role_invalid", "runtime_membership_invalid", "target_guard",
  "regular_file_required", "file_limit", "private_path_required", "json_limit",
  "json_depth", "json_invalid", "duplicate_json_key", "invalid_input",
  "token_config_invalid", "token_file_failed", "runtime_credential_failed",
  "config_file_failed", "provider_listing_file_failed", "provider_listing_required",
  "provider_listing_invalid", "provider_mapping_unverified", "catalog_config_invalid",
  "mapping_invalid", "terms_required", "listing_refused", "listing_unverified",
  "listing_limit", "providers_required", "database_budget", "deadline",
  "catalog_readback_failed", "readback_integrity", "aggregate_readback_mismatch",
  "readback_mismatch", "finalization_deadline", "repository_sha_failed",
  "report_invalid", "report_exists", "catalog_report_failed"
]);
export function catalogCode(error: unknown, fallback: string): string {
  return error instanceof Error &&
    /^[a-z_]+$/.test(error.message) &&
    diagnosticCodes.has(error.message) ? error.message : fallback;
}
export const listingFilename = /^provider-list-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\.json$/;
export function privatePath(name: string): string {
  const path = resolve(name), rel = relative(privateDirectory, path);
  if (!rel ||
    rel.startsWith("..") ||
    isAbsolute(rel))
    throw new Error("private_path_required");
  return path;
}
export async function boundedText(path: string, max = 65536): Promise<string> {
  const file = await open(path, "r");
  try {
    if (!(await file.stat()).isFile())
      throw new Error("regular_file_required");
    const buffer = Buffer.alloc(max + 1);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, null);
      if (!bytesRead)
        break;
      size += bytesRead;
    }
    if (size > max)
      throw new Error("file_limit");
    return new TextDecoder("utf-8", {
      fatal: true
    }).decode(buffer.subarray(0, size));
  }
  finally {
    await file.close();
  }
}
// JSON.parse alone silently accepts duplicate object keys. Scan valid JSON's
// original tokens so credentials/configuration cannot have ambiguous meanings.
export function privateJson(source: string): unknown {
  if (source.length > 262144)
    throw new Error("json_limit");
  const parsed: unknown = JSON.parse(source);
  const tokens = source.match(/"(?:\\.|[^"\\])*"|true|false|null|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|[{}\[\]:,]/g) ?? [];
  let cursor = 0;
  function value(depth: number): void {
    if (depth > 64)
      throw new Error("json_depth");
    const token = tokens[cursor++];
    if (token === "{") {
      const seen = new Set<string>();
      if (tokens[cursor] !== "}")
        while (true) {
          const key: unknown = JSON.parse(tokens[cursor++]);
          if (typeof key !== "string" ||
            seen.has(key))
            throw new Error("duplicate_json_key");
          seen.add(key);
          if (tokens[cursor++] !== ":")
            throw new Error("json_invalid");
          value(depth + 1);
          if (tokens[cursor] !== ",")
            break;
          cursor++;
        }
      if (tokens[cursor++] !== "}")
        throw new Error("json_invalid");
    }
    else if (token === "[") {
      if (tokens[cursor] !== "]")
        while (true) {
          value(depth + 1);
          if (tokens[cursor] !== ",")
            break;
          cursor++;
        }
      if (tokens[cursor++] !== "]")
        throw new Error("json_invalid");
    }
  }
  value(0);
  if (cursor !== tokens.length)
    throw new Error("json_invalid");
  return parsed;
}
// Parse only this key. Never evaluate shell syntax or export unrelated settings.
export function decodeTokenFile(source: string, override?: string): string {
  const found: string[] = [];
  for (const line of source.split(/\r?\n/)) {
    if (!/^\s*(?:export\s+)?TMDB_READ_ACCESS_TOKEN\b/.test(line))
      continue;
    const match = /^\s*TMDB_READ_ACCESS_TOKEN\s*=\s*(?:"([A-Za-z0-9._-]+)"|'([A-Za-z0-9._-]+)'|([A-Za-z0-9._-]+))\s*$/.exec(line);
    if (!match)
      throw new Error("token_config_invalid");
    found.push(match[1] ?? match[2] ?? match[3]);
  }
  if (found.length !== 1 ||
    found[0].length < 20 ||
    found[0].length > 4096 ||
    (override !== undefined &&
      override !== found[0]))
    throw new Error("token_config_invalid");
  return found[0];
}
export function decodePassword(input: unknown): string {
  const o = object(input);
  exactKeys(o, ["password"]);
  if (typeof o.password !== "string" ||
    !/^[a-f0-9]{64}$/.test(o.password))
    throw new Error("credential_invalid");
  return o.password;
}
export function decodeProviderListing(input: unknown) {
  const o = object(input);
  exactKeys(o, ["checkedAt", "region", "providers", "action", "executionId", "attempts", "terms"]);
  const checkedAt = text(o.checkedAt);
  if (o.region !== "US" ||
    !strictDate(checkedAt))
    throw new Error("provider_listing_invalid");
  const providers = array(o.providers, 1000).map(value => {
    const p = object(value);
    exactKeys(p, ["id", "name"]);
    return {
      id: providerId(p.id),
      name: text(p.name, 200)
    };
  });
  if (new Set(providers.map(p => p.id)).size !== providers.length)
    throw new Error("provider_listing_invalid");
  return {
    checkedAt,
    region: "US",
    providers
  };
}
export function decodeCatalog(input: unknown, asOf: string, listing = false) {
  const o = object(input);
  exactKeys(o, ["version", "region", "mappingVersion", "services", "limits", "terms", "providerListing"]);
  const providerListing = o.providerListing === undefined ||
    o.providerListing === null ? null : text(o.providerListing, 100);
  if (providerListing !== null &&
    !listingFilename.test(providerListing))
    throw new Error("provider_listing_invalid");
  if (o.version !== "catalog-local-v1" ||
    o.region !== "US" ||
    o.mappingVersion !== "origin-v1" ||
    !strictDate(asOf))
    throw new Error("catalog_config_invalid");
  const services = array(o.services, 4).map(value => {
    const s = object(value);
    exactKeys(s, ["service", "providerId", "providerName", "checkedAt", "qualification", "omission"]);
    const service = text(s.service);
    if (!Object.hasOwn(subscriptions, service))
      throw new Error("catalog_config_invalid");
    if (s.providerId === null) {
      if (s.providerName !== null ||
        s.checkedAt !== null ||
        s.qualification !== null)
        throw new Error("catalog_config_invalid");
      return {
        service,
        providerId: null,
        providerName: null,
        checkedAt: null,
        qualification: null,
        omission: text(s.omission, 500)
      };
    }
    const checkedAt = text(s.checkedAt);
    if (!strictDate(checkedAt) ||
      s.omission !== null)
      throw new Error("catalog_config_invalid");
    return {
      service,
      providerId: providerId(s.providerId),
      providerName: text(s.providerName, 200),
      checkedAt,
      qualification: text(s.qualification, 500),
      omission: null
    };
  });
  if (services.length !== 4 ||
    new Set(services.map(s => s.service)).size !== 4)
    throw new Error("catalog_config_invalid");
  const ids = services.flatMap(s => s.providerId === null ? [] : [s.providerId]);
  if (new Set(ids).size !== ids.length ||
    (!listing &&
      !ids.length))
    throw new Error("catalog_config_invalid");
  const limits = {
    ...firstImportLimits
  }, supplied = o.limits === undefined ? {} : object(o.limits);
  exactKeys(supplied, Object.keys(limits));
  for (const k of Object.keys(limits) as (keyof typeof limits)[])
    if (supplied[k] !== undefined)
      limits[k] = integer(supplied[k], 1, limits[k]);
  // Reserve a real finalization window even with smaller operator bounds.
  if (limits.durationMs < 40000)
    throw new Error("catalog_config_invalid");
  const terms = object(o.terms);
  exactKeys(terms, ["accepted", "checkedAt", "source", "decision"]);
  if (typeof terms.accepted !== "boolean")
    throw new Error("catalog_config_invalid");
  if (terms.accepted &&
    (!strictDate(text(terms.checkedAt)) ||
      !/^https:\/\//.test(text(terms.source, 2000)) ||
      !text(terms.decision, 2000)))
    throw new Error("catalog_config_invalid");
  return {
    providerListing,
    services,
    terms,
    subscriptions,
    config: ids.length ? decodeConfig({
      version: "discovery-v1",
      region: "US",
      providerIds: ids,
      mappingVersion: "origin-v1",
      limits
    }, asOf) : null,
    limits
  };
}
