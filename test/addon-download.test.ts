// Design doc windows-support §04: only the darwin-arm64 addon is committed;
// every other platform's binary is a release asset fetched on first run. It is
// native code loaded into our own process, so it is verified against the
// release's SHA256SUMS and against the sha256 the repo commits for that version
// and platform, when there is one, and only ever fetched over https (or
// loopback http, here).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error -- plain JS module, no type declarations by design
import { addonDownloadUrl, addonChecksumsUrl, checkedAddonBaseUrl, expectedDigest, platformTag, DEFAULT_ADDON_BASE_URL } from '../cli/install-check.mjs';
// @ts-expect-error -- plain JS module, no type declarations by design
import { downloadAddon, ensureReady } from '../cli/bootstrap.mjs';

let root: string;
let server: http.Server;
let base: string;
const body = Buffer.from('pretend this is a .node file');
const digest = createHash('sha256').update(body).digest('hex');
let responses: Record<string, { status: number; body: string | Buffer }>;
let requests: string[];

beforeEach(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-addon-dl-'));
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'starmemory', version: '9.9.9' }));
  responses = {
    '/dl/v9.9.9/SHA256SUMS': { status: 200, body: `${digest}  starmemory_native.linux-x64.node\n${'0'.repeat(64)}  starmemory_native.win32-x64.node\n` },
    '/dl/v9.9.9/starmemory_native.linux-x64.node': { status: 200, body },
    '/dl/v9.9.9/starmemory_native.win32-x64.node': { status: 200, body },
  };
  requests = [];
  server = http.createServer((req, res) => {
    requests.push(req.url ?? '');
    const r = responses[req.url ?? ''] ?? { status: 404, body: 'nope' };
    res.statusCode = r.status;
    res.end(r.body);
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address() as { port: number };
  base = `http://127.0.0.1:${address.port}/dl`;
  process.env.STARMEMORY_ADDON_BASE_URL = base;
});

afterEach(async () => {
  delete process.env.STARMEMORY_ADDON_BASE_URL;
  await new Promise<void>((r) => server.close(() => r()));
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('release URLs', () => {
  it('point at the asset and the checksum file for the version and platform', () => {
    expect(addonDownloadUrl('0.4.0', 'linux-x64', DEFAULT_ADDON_BASE_URL)).toBe(`${DEFAULT_ADDON_BASE_URL}/v0.4.0/starmemory_native.linux-x64.node`);
    expect(addonChecksumsUrl('0.4.0', 'https://mirror.example/r/')).toBe('https://mirror.example/r/v0.4.0/SHA256SUMS');
  });

  it('refuse anything but https, except http to the local machine', () => {
    expect(checkedAddonBaseUrl('https://example.com/x/')).toBe('https://example.com/x');
    expect(checkedAddonBaseUrl('http://127.0.0.1:8080/x')).toBe('http://127.0.0.1:8080/x');
    expect(() => checkedAddonBaseUrl('http://mirror.example/x')).toThrow(/must be https/);
    expect(() => checkedAddonBaseUrl('ftp://mirror.example/x')).toThrow(/must be https/);
  });

  it('read a sha256sum-style checksum file', () => {
    const sums = `${digest}  starmemory_native.linux-x64.node\nabc  not-a-digest\n`;
    expect(expectedDigest(sums, 'starmemory_native.linux-x64.node')).toBe(digest);
    expect(expectedDigest(sums, 'starmemory_native.win32-x64.node')).toBeUndefined();
  });
});

describe('downloadAddon', () => {
  it('saves a verified asset at the platform path and leaves no partial file', async () => {
    const lines: string[] = [];
    const warnings: string[] = [];

    const target = await downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: (l: string) => lines.push(l), warn: (l: string) => warnings.push(l) });

    expect(target).toBe(path.join(root, 'native', 'starmemory_native.linux-x64.node'));
    expect(fs.readFileSync(target)).toEqual(body);
    expect(fs.readdirSync(path.join(root, 'native'))).toEqual(['starmemory_native.linux-x64.node']);
    expect(lines.join('\n')).toContain('sha256 verified');
    // No native/addon-checksums.json at all here: the release's SHA256SUMS is
    // the only check, and it says so.
    expect(warnings).toEqual([expect.stringMatching(/no entry for v9\.9\.9 linux-x64 yet.*SHA256SUMS only/)]);
  });

  it('refuses a binary whose checksum does not match, and writes nothing', async () => {
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'win32-x64', log: () => {} })).rejects.toThrow(/does not match the release checksum/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
  });

  it('refuses a binary the checksum file does not list', async () => {
    responses['/dl/v9.9.9/SHA256SUMS'] = { status: 200, body: 'nothing here\n' };
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {} })).rejects.toThrow(/no entry for starmemory_native.linux-x64.node/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
  });

  it('fails with the URL in the message when the release has no such asset', async () => {
    delete responses['/dl/v9.9.9/starmemory_native.linux-x64.node'];
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {} })).rejects.toThrow(/HTTP 404 .*v9\.9\.9\/starmemory_native\.linux-x64\.node/);
    expect(fs.existsSync(path.join(root, 'native'))).toBe(false);
  });

  it('never fetches native code from a plain-http host', async () => {
    process.env.STARMEMORY_ADDON_BASE_URL = 'http://mirror.example/dl';
    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {} })).rejects.toThrow(/must be https/);
  });
});

describe('downloadAddon with native/addon-checksums.json', () => {
  const elsewhere = 'f'.repeat(64);

  function commitChecksums(checksums: unknown) {
    fs.mkdirSync(path.join(root, 'native'), { recursive: true });
    fs.writeFileSync(path.join(root, 'native', 'addon-checksums.json'), typeof checksums === 'string' ? checksums : JSON.stringify(checksums));
  }

  it('installs a binary that matches both the committed sha256 and the release, without the fallback notice', async () => {
    commitChecksums({ '9.9.9': { 'linux-x64': digest } });
    const lines: string[] = [];
    const warnings: string[] = [];

    const target = await downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: (l: string) => lines.push(l), warn: (l: string) => warnings.push(l) });

    expect(fs.readFileSync(target)).toEqual(body);
    expect(lines.join('\n')).toContain('verified against native/addon-checksums.json and the release');
    expect(warnings).toEqual([]);
  });

  it('refuses a binary its release vouches for when the committed sha256 differs, and writes nothing', async () => {
    commitChecksums({ '9.9.9': { 'linux-x64': elsewhere } });

    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {}, warn: () => {} })).rejects.toThrow(
      /does not match the sha256 that native\/addon-checksums.json records for v9\.9\.9 linux-x64.*not the one this version was published with/
    );
    expect(fs.readdirSync(path.join(root, 'native'))).toEqual(['addon-checksums.json']);
  });

  it('falls back to the release checksum when the repo has no entry for this version and platform, and says so once', async () => {
    commitChecksums({ '9.9.8': { 'linux-x64': elsewhere }, '9.9.9': { 'win32-x64': elsewhere } });
    const warnings: string[] = [];

    const target = await downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {}, warn: (l: string) => warnings.push(l) });

    expect(fs.readFileSync(target)).toEqual(body);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toMatch(/native\/addon-checksums.json has no entry for v9\.9\.9 linux-x64 yet, so starmemory_native.linux-x64.node was checked against the release's SHA256SUMS only/);
  });

  it('still refuses a binary that does not match the release checksum when the committed sha256 matches', async () => {
    // beforeEach lists win32-x64 in SHA256SUMS as all zeros.
    commitChecksums({ '9.9.9': { 'win32-x64': digest } });

    await expect(downloadAddon(root, { version: '9.9.9', tag: 'win32-x64', log: () => {}, warn: () => {} })).rejects.toThrow(/does not match the release checksum/);
    expect(fs.existsSync(path.join(root, 'native', 'starmemory_native.win32-x64.node'))).toBe(false);
  });

  it('downloads nothing when the committed checksums file is malformed', async () => {
    commitChecksums('{ "9.9.9": ');

    await expect(downloadAddon(root, { version: '9.9.9', tag: 'linux-x64', log: () => {}, warn: () => {} })).rejects.toThrow(/addon-checksums.json is unreadable/);
    expect(requests).toEqual([]);
  });
});

describe('ensureReady', () => {
  it('explains a refused download as a checksum problem, not a network one', async () => {
    const tag = platformTag();
    commitChecksumsFor(tag);
    const written: string[] = [];
    const spy = vi.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const ready = await ensureReady({ root }).finally(() => spy.mockRestore());

    expect(ready).toBe(false);
    const output = written.join('');
    expect(output).toContain(`records for v9.9.9 ${tag}`);
    expect(output).toContain('SECURITY.md says how to report this');
    expect(output).not.toContain('no network');
  });

  /** A release for this machine's platform whose asset matches its SHA256SUMS
   * but not the sha256 committed for it. */
  function commitChecksumsFor(tag: string) {
    responses['/dl/v9.9.9/SHA256SUMS'] = { status: 200, body: `${digest}  starmemory_native.${tag}.node\n` };
    responses[`/dl/v9.9.9/starmemory_native.${tag}.node`] = { status: 200, body };
    fs.mkdirSync(path.join(root, 'native'), { recursive: true });
    fs.writeFileSync(path.join(root, 'native', 'addon-checksums.json'), JSON.stringify({ '9.9.9': { [tag]: 'f'.repeat(64) } }));
  }
});
