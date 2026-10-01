// Pre-flight checks that run BEFORE npm dependencies exist, so they live in
// plain .mjs under cli/ and may not import anything from node_modules.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error -- plain JS module, no type declarations by design
import {
  ADDON_CHECKSUMS_PATH,
  AddonChecksumError,
  RUNTIME_DEPENDENCIES,
  SUPPORTED_PLATFORMS,
  addonRelativePath,
  findMissingDeps,
  findMissingAddons,
  isSupportedPlatform,
  npmInstallArgs,
  pinnedAddonDigest,
  platformTag,
  readAddonChecksums,
  unsupportedPlatformMessage,
} from '../cli/install-check.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let root: string;

function writePackage(name: string, { manifest = true } = {}) {
  const dir = path.join(root, 'node_modules', ...name.split('/'));
  fs.mkdirSync(dir, { recursive: true });
  if (manifest) {
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name, version: '1.0.0' }));
  }
}

function writeAddon(relative: string) {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, 'binary');
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'starmemory-preflight-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe('findMissingDeps', () => {
  it('reports every runtime dependency when node_modules is absent', () => {
    expect(findMissingDeps(root)).toEqual([...RUNTIME_DEPENDENCIES]);
  });

  it('reports nothing once every dependency is installed', () => {
    for (const name of RUNTIME_DEPENDENCIES) writePackage(name);

    expect(findMissingDeps(root)).toEqual([]);
  });

  it('reports only the dependency that is missing', () => {
    for (const name of RUNTIME_DEPENDENCIES) if (name !== 'zod') writePackage(name);

    expect(findMissingDeps(root)).toEqual(['zod']);
  });

  it('treats a package folder with no manifest as missing', () => {
    // A half-extracted package would slip past a bare existsSync on the folder
    // and then crash the server with ERR_MODULE_NOT_FOUND after handoff.
    for (const name of RUNTIME_DEPENDENCIES) writePackage(name);
    fs.rmSync(path.join(root, 'node_modules', 'zod', 'package.json'));

    expect(findMissingDeps(root)).toEqual(['zod']);
  });
});

describe('findMissingAddons', () => {
  // One addon per platform: tantivy BM25 and usearch HNSW live in the same Rust
  // crate, named native/starmemory_native.<platform>-<arch>.node.
  it('names the file for this machine when it has not been built', () => {
    expect(findMissingAddons(root)).toEqual([addonRelativePath(platformTag())]);
  });

  it('reports nothing once it is present', () => {
    writeAddon(addonRelativePath(platformTag()));

    expect(findMissingAddons(root)).toEqual([]);
  });

  it('looks for the named platform, not the running one', () => {
    writeAddon('native/starmemory_native.darwin-arm64.node');

    expect(findMissingAddons(root, 'linux-x64')).toEqual(['native/starmemory_native.linux-x64.node']);
    expect(findMissingAddons(root, 'darwin-arm64')).toEqual([]);
  });
});

describe('platformTag', () => {
  it('joins platform and arch the way the addon files are named', () => {
    expect(platformTag('win32', 'x64')).toBe('win32-x64');
    expect(addonRelativePath('linux-arm64')).toBe('native/starmemory_native.linux-arm64.node');
  });
});

describe('isSupportedPlatform', () => {
  it('accepts every platform a release ships binaries for', () => {
    expect(SUPPORTED_PLATFORMS).toEqual(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64']);
    expect(isSupportedPlatform('darwin', 'arm64')).toBe(true);
    expect(isSupportedPlatform('linux', 'x64')).toBe(true);
    expect(isSupportedPlatform('linux', 'arm64')).toBe(true);
    expect(isSupportedPlatform('win32', 'x64')).toBe(true);
  });

  it('rejects an Intel Mac and other platforms with no binary', () => {
    expect(isSupportedPlatform('darwin', 'x64')).toBe(false);
    expect(isSupportedPlatform('freebsd', 'x64')).toBe(false);
    expect(isSupportedPlatform('win32', 'arm64')).toBe(false);
  });
});

describe('unsupportedPlatformMessage', () => {
  it('names the platform it actually found and every one it supports', () => {
    const message = unsupportedPlatformMessage('freebsd', 'x64');

    expect(message).toContain('freebsd-x64');
    for (const tag of SUPPORTED_PLATFORMS) expect(message).toContain(tag);
  });

  it('says how to proceed rather than only what failed', () => {
    expect(unsupportedPlatformMessage('darwin', 'x64')).toMatch(/build|npm run build/i);
  });
});

describe('npmInstallArgs', () => {
  it('installs exactly what the lockfile records, running no install scripts', () => {
    fs.writeFileSync(path.join(root, 'package-lock.json'), '{}');

    expect(npmInstallArgs(root)).toEqual(['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  });

  it('counts npm-shrinkwrap.json as a lockfile', () => {
    fs.writeFileSync(path.join(root, 'npm-shrinkwrap.json'), '{}');

    expect(npmInstallArgs(root)[0]).toBe('ci');
  });

  it('falls back to npm install without a lockfile, still running no install scripts', () => {
    expect(npmInstallArgs(root)).toEqual(['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund']);
  });

  it('uses npm ci for this checkout, which commits its lockfile', () => {
    expect(npmInstallArgs(repoRoot)[0]).toBe('ci');
  });
});

describe('install scripts in package-lock.json', () => {
  // bootstrap.mjs and CI both install with --ignore-scripts, and each package
  // here works without its script. A new one needs the same check: either it
  // works without, or it gets an `npm rebuild <name>` after the install.
  const WORK_WITHOUT_THEIR_SCRIPTS = [
    'node_modules/esbuild',
    'node_modules/fsevents',
    'node_modules/onnxruntime-node',
    'node_modules/protobufjs',
    'node_modules/sharp',
  ];

  it('belong only to packages known to work without them', () => {
    const lock = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package-lock.json'), 'utf8'));
    const withScripts = Object.entries(lock.packages as Record<string, { hasInstallScript?: boolean }>)
      .filter(([, entry]) => entry.hasInstallScript)
      .map(([name]) => name);

    expect(withScripts.filter((name) => !WORK_WITHOUT_THEIR_SCRIPTS.includes(name))).toEqual([]);
  });
});

describe('readAddonChecksums and pinnedAddonDigest', () => {
  const digest = 'ab'.repeat(32);

  function writeChecksums(text: string) {
    fs.mkdirSync(path.join(root, 'native'), { recursive: true });
    fs.writeFileSync(path.join(root, ADDON_CHECKSUMS_PATH), text);
  }

  it('read a missing file as no entries', () => {
    expect(readAddonChecksums(root)).toEqual({});
  });

  it('refuse a file that is not JSON rather than fall back to the weaker check', () => {
    writeChecksums('{ "0.4.0": ');

    expect(() => readAddonChecksums(root)).toThrow(AddonChecksumError);
  });

  it('refuse a file of the wrong shape', () => {
    for (const text of ['[]', '{"0.4.0": "abc"}', '{"0.4.0": {"linux-x64": 7}}', `{"0.4.0": {"linux-x64": "${'z'.repeat(64)}"}}`]) {
      writeChecksums(text);

      expect(() => readAddonChecksums(root), text).toThrow(/must map each version/);
    }
  });

  it('give the digest for a version and platform, and nothing for anything else', () => {
    writeChecksums(JSON.stringify({ '0.4.0': { 'linux-x64': digest.toUpperCase() } }));
    const checksums = readAddonChecksums(root);

    expect(pinnedAddonDigest(checksums, '0.4.0', 'linux-x64')).toBe(digest);
    expect(pinnedAddonDigest(checksums, '0.4.0', 'win32-x64')).toBeUndefined();
    expect(pinnedAddonDigest(checksums, '0.5.0', 'linux-x64')).toBeUndefined();
    expect(pinnedAddonDigest(checksums, 'constructor', 'toString')).toBeUndefined();
  });

  it('read the committed file, which names only real versions and platforms', () => {
    const checksums = readAddonChecksums(repoRoot);

    expect(Object.keys(checksums).length).toBeGreaterThan(0);
    for (const [version, byTag] of Object.entries(checksums)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+(-[0-9A-Za-z.]+)?$/);
      for (const tag of Object.keys(byTag as Record<string, string>)) expect(SUPPORTED_PLATFORMS).toContain(tag);
    }
  });
});
