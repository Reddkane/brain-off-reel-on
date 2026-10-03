import { InvalidInput } from "../src/server/providers/tmdb-validation.ts";

export function argumentsFor(args: readonly string[], allowed: readonly string[]): Record<string, string> {
  const values: Record<string, string> = {};

  for (let i = 0;i < args.length;i += 2) {
    const key = args[i];

    if (!allowed.includes(key) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--") ||
      Object.hasOwn(values, key))
      throw new InvalidInput();

    values[key] = args[i + 1];
  }

  return values;
}
