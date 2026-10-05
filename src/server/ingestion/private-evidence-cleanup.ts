import { lstat, readdir, unlink, realpath, readFile } from "node:fs/promises";
import { resolve, join, relative, isAbsolute } from "node:path";
import { calendarMonths } from "../../domain/availability-evidence.ts";
/** Explicit provider-bearing file inventory. Credentials/config and unrelated work are excluded. */
export async function expirePrivateEvidence(root: string, now: number, signal: AbortSignal, maxFiles = 100) {
    const actualRoot = await realpath(root);
    const inventory = [
        { directory: resolve(root, '.cache/watchmode-verification'), names: /^(?:probe|title-probe)\.json$/, months: false },
        { directory: resolve(root, '.cache/availability/private'), names: /^(?:source-cache|evidence-report)-[a-f0-9-]{36}\.json$/, months: false },
        { directory: resolve(root, '.cache/real-catalog/private'), names: /^(?:provider-list|run-report)-[a-f0-9-]{36}\.json$/, months: true }
    ];
    let inspected = 0, deleted = 0;
    for (const item of inventory) {
        signal.throwIfAborted();
        try {
            const directory = await lstat(item.directory);
            if (directory.isSymbolicLink() || !directory.isDirectory())
                throw new Error('private_inventory_refused');
            const actual = await realpath(item.directory), rel = relative(actualRoot, actual);
            if (isAbsolute(rel) || rel.startsWith('..') || resolve(actual).toLowerCase() !== resolve(item.directory).toLowerCase())
                throw new Error('private_inventory_refused');
        }
        catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT')
                continue;
            throw error;
        }
        for (const name of (await readdir(item.directory)).sort()) {
            if (!item.names.test(name))
                continue;
            if (inspected >= maxFiles)
                return { inspected, deleted, bounded: true };
            signal.throwIfAborted();
            const path = join(item.directory, name), stat = await lstat(path);
            if (!stat.isFile() || stat.isSymbolicLink())
                throw new Error('private_inventory_refused');
            inspected++;
            // Exclusive cache files cannot renew original creation age by touching mtime.
            let acquired = Math.min(stat.birthtimeMs, stat.mtimeMs);
            if (stat.size > 2097152)
                throw new Error('private_inventory_limit');
            const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
            function inspect(value: unknown, depth: number) {
                if (depth > 30)
                    throw new Error('private_inventory_limit');
                if (!value || typeof value !== 'object')
                    return;
                for (const [key, child] of Object.entries(value)) {
                    if (/(?:checked_?at|observed_?at|metadata_refreshed_at|started_?at)$/i.test(key) && typeof child === 'string') {
                        const time = Date.parse(child);
                        if (Number.isFinite(time))
                            acquired = Math.min(acquired, time);
                    }
                    if (child && typeof child === 'object')
                        inspect(child, depth + 1);
                }
            }
            inspect(parsed, 0);
            signal.throwIfAborted();
            const expiry = item.months ? calendarMonths(acquired, 6) : acquired + 30 * 86400000;
            if (now > expiry) {
                await unlink(path);
                deleted++;
            }
        }
    }
    return { inspected, deleted, bounded: false };
}
