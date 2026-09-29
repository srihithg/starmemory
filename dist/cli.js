#!/usr/bin/env node
// CLI entry -- `starmemory sync`, `starmemory search <query>`, `starmemory mcp-server`,
// `starmemory desktop-install`.
// Mirrors episodic-memory's cli/ commands closely enough that hooks.json needs
// no restructuring beyond swapping the invoked script.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { openStore } from './store.js';
import { VectorIndex } from './vector-index.js';
import { isTextIndexAvailable, openVersionedTextIndex } from './text-index.js';
import { WRITER_WAIT_MS, syncAll } from './sync.js';
import { search } from './search.js';
import { defaultForgottenPath, readForgotten } from './forget.js';
import { defaultCoworkRoot } from './cowork.js';
const DB_PATH = process.env.STARMEMORY_DB_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'store.mdb');
const INDEX_PATH = process.env.STARMEMORY_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'index.hnsw');
// The base path only: the schema version is appended (text -> text-v2), so
// builds with different schemas never share a directory (design doc §10).
const TEXT_INDEX_PATH = process.env.STARMEMORY_TEXT_INDEX_PATH ?? path.join(os.homedir(), '.config', 'starmemory', 'text');
function openEngine() {
    fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
    const store = openStore(DB_PATH);
    const index = VectorIndex.open(store, INDEX_PATH);
    // Without the compiled addon the engine still works, on the substring fallback.
    const textIndex = isTextIndexAvailable() ? openVersionedTextIndex(TEXT_INDEX_PATH) : undefined;
    return { store, index, textIndex };
}
async function main() {
    const [, , command, ...rest] = process.argv;
    if (command === 'sync') {
        const background = rest.includes('--background');
        // The detached child cli/starmemory.mjs forks: nobody waits on it, so it
        // may wait for the text-index writer another sync holds (sync.ts).
        const detached = rest.includes('--detached');
        // What remember and forget start (sync-trigger.ts): the Cowork records only.
        const coworkOnly = rest.includes('--cowork-only');
        const { store, index, textIndex } = openEngine();
        try {
            const result = await syncAll(store, index, coworkOnly ? [defaultCoworkRoot()] : undefined, textIndex, {
                writerWaitMs: detached ? WRITER_WAIT_MS : 0,
            });
            if (!background) {
                const bm25 = result.textSkipped
                    ? 'BM25 index left to another running sync'
                    : `${result.textIndexed} added to the BM25 index`;
                const migrated = result.reembedded > 0 ? `, re-embedded ${result.reembedded} for the new model` : '';
                const failed = result.summaryFailed > 0 ? ` (${result.summaryFailed} failed, see sync.log)` : '';
                const expired = result.expiredFiles > 0 ? `, expired ${result.expiredFiles} conversations (${result.expired} exchanges)` : '';
                const forgot = result.forgottenFiles > 0 ? `, forgot ${result.forgottenFiles} conversations (${result.forgotten} exchanges)` : '';
                // Deletions another sync held up: they are still due, which the log should show.
                const held = [
                    ...(result.forgetSkipped ? ['deleting forgotten sessions'] : []),
                    ...(result.expireSkipped ? ['expiring old conversations'] : []),
                ];
                const deferred = held.length > 0 ? `; ${held.join(' and ')} left to the sync holding the text-index writer, or a later one` : '';
                console.log(`Scanned ${result.filesScanned} files, archived ${result.archived}, indexed ${result.exchangesIndexed} new exchanges${migrated}, ${bm25}, ${result.summarized} summaries written${failed}${expired}${forgot}${deferred}.`);
            }
        }
        finally {
            await store.close();
        }
        return;
    }
    if (command === 'search') {
        const query = rest.join(' ');
        if (!query) {
            console.error('Usage: starmemory search <query>');
            process.exit(1);
        }
        const { store, index, textIndex } = openEngine();
        try {
            const excludeSessions = readForgotten(defaultForgottenPath());
            const results = await search(store, index, query, { limit: 10, excludeSessions }, textIndex);
            for (const [i, r] of results.entries()) {
                const pct = r.similarity !== undefined ? ` (${Math.round(r.similarity * 100)}%)` : '';
                console.log(`${i + 1}. [${r.exchange.project}]${pct} ${r.snippet}`);
            }
            if (results.length === 0)
                console.log('No results found.');
        }
        finally {
            await store.close();
        }
        return;
    }
    if (command === 'mcp-server') {
        await import('./mcp-server.js');
        return;
    }
    if (command === 'desktop-install') {
        // Plain node under cli/, shared with cli/starmemory.mjs, which runs it
        // before any dependency is installed.
        const entry = pathToFileURL(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'desktop-install.mjs')).href;
        const { main: install } = (await import(entry));
        process.exit(await install(rest));
    }
    console.error('Usage: starmemory <sync [--background] [--cowork-only] | search <query> | mcp-server | desktop-install [--name <name>] [--replace] [--restart]>');
    process.exit(1);
}
main().catch((err) => {
    console.error(err);
    process.exit(1);
});
