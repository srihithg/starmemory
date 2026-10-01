// Pre-flight checks for the plugin entry points.
//
// These run BEFORE `npm install` has necessarily happened, so this file must
// stay dependency-free: node builtins only, no imports from dist/ or
// node_modules. Keeping the logic pure also makes it testable without spawning
// anything.
import fs from 'node:fs';
import path from 'node:path';

/** Packages `dist/` imports at runtime. Kept in step with package.json's
 * `dependencies` -- test/install-check.test.ts pins the list. */
export const RUNTIME_DEPENDENCIES = Object.freeze([
  '@huggingface/transformers',
  '@modelcontextprotocol/sdk',
  'zod',
]);

/** Platforms a release carries a prebuilt addon for, as `<platform>-<arch>`
 * tags. Tantivy BM25 and usearch HNSW live in one Rust crate, so there is one
 * file per platform: `native/starmemory_native.<tag>.node`. darwin-arm64 is
 * committed; the others are attached to the GitHub release and fetched on
 * first run (bootstrap.mjs). Design doc windows-support §03, §04. */
export const SUPPORTED_PLATFORMS = Object.freeze(['darwin-arm64', 'linux-x64', 'linux-arm64', 'win32-x64']);

export function platformTag(platform = process.platform, arch = process.arch) {
  return `${platform}-${arch}`;
}

/** The addon for `tag`, relative to the plugin root. */
export function addonRelativePath(tag = platformTag()) {
  return `native/starmemory_native.${tag}.node`;
}

/** Kept for callers that still think in lists; one entry per current platform. */
export const NATIVE_ADDONS = Object.freeze([addonRelativePath()]);

/** Where a release keeps the addon for `tag`. The base is overridable so tests
 * (and a mirror) can point somewhere else. */
export const DEFAULT_ADDON_BASE_URL = 'https://github.com/albericliu0/starmemory/releases/download';

/** A base URL we are willing to download native code from: https, or plain
 * http only to the local machine (tests). Throws otherwise, so a hostile
 * environment variable cannot point the download at an http mirror. */
export function checkedAddonBaseUrl(base = process.env.STARMEMORY_ADDON_BASE_URL ?? DEFAULT_ADDON_BASE_URL) {
  const url = new URL(base);
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback)) {
    throw new Error(`refusing to download the native addon over ${url.protocol.replace(':', '')} from ${url.host}; STARMEMORY_ADDON_BASE_URL must be https`);
  }
  return base.replace(/\/+$/, '');
}

export function addonDownloadUrl(version, tag = platformTag(), base) {
  return `${checkedAddonBaseUrl(base)}/v${version}/starmemory_native.${tag}.node`;
}

/** The checksum file the release carries beside the binaries: one
 * `<sha256>  <file name>` line per asset, as `sha256sum` writes them. */
export function addonChecksumsUrl(version, base) {
  return `${checkedAddonBaseUrl(base)}/v${version}/SHA256SUMS`;
}

/** The hex digest for `fileName` in a SHA256SUMS text, or undefined. */
export function expectedDigest(sumsText, fileName) {
  for (const line of sumsText.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (m && m[2].trim() === fileName) return m[1].toLowerCase();
  }
  return undefined;
}

/** Each release's addon hashes as committed to the repo, relative to the plugin
 * root: `{ "<version>": { "<platform-tag>": "<sha256>" } }`. A release's own
 * SHA256SUMS shows that a download arrived intact, but whoever can replace a
 * release asset can replace that file as well. This one changes only by a
 * commit. SECURITY.md has the release steps that fill it in. */
export const ADDON_CHECKSUMS_PATH = 'native/addon-checksums.json';

/** A download refused because of its hash, as opposed to one that never arrived. */
export class AddonChecksumError extends Error {
  name = 'AddonChecksumError';
}

const isMap = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The committed hashes under `root`. A missing file reads as no entries. A
 * malformed one throws, since ignoring it would quietly fall back to the
 * release's own SHA256SUMS. */
export function readAddonChecksums(root) {
  const file = path.join(root, ADDON_CHECKSUMS_PATH);
  if (!fs.existsSync(file)) return {};
  let checksums;
  try {
    checksums = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new AddonChecksumError(`${ADDON_CHECKSUMS_PATH} is unreadable (${error.message}); not installing an addon it cannot check`);
  }
  const wellFormed =
    isMap(checksums) &&
    Object.values(checksums).every((byTag) => isMap(byTag) && Object.values(byTag).every((digest) => typeof digest === 'string' && /^[0-9a-fA-F]{64}$/.test(digest)));
  if (!wellFormed) {
    throw new AddonChecksumError(`${ADDON_CHECKSUMS_PATH} must map each version to { "<platform-tag>": "<sha256>" }; not installing an addon it cannot check`);
  }
  return checksums;
}

/** The committed sha256 for `version` on `tag`, or undefined when there is none
 * yet. A release is tagged before its binaries exist, so its hashes can only
 * land in a later commit. */
export function pinnedAddonDigest(checksums, version, tag = platformTag()) {
  const byTag = Object.hasOwn(checksums, version) ? checksums[version] : undefined;
  return byTag && Object.hasOwn(byTag, tag) ? byTag[tag].toLowerCase() : undefined;
}

/** Throw unless a downloaded addon's sha256 (`actual`) matches the release's
 * SHA256SUMS entry (`released`) and, when the repo has one, the committed entry
 * (`pinned`). Returns whether the committed entry was checked. */
export function verifyAddonDigest(actual, { fileName, released, pinned, version, tag }) {
  if (actual !== released) {
    throw new AddonChecksumError(`the downloaded ${fileName} does not match the release checksum (got ${actual}, expected ${released}); not installing it`);
  }
  if (pinned === undefined) return false;
  if (actual !== pinned) {
    throw new AddonChecksumError(
      `the downloaded ${fileName} does not match the sha256 that ${ADDON_CHECKSUMS_PATH} records for v${version} ${tag} ` +
        `(got ${actual}, expected ${pinned}). The release asset is not the one this version was published with, so it is not installed.`
    );
  }
  return true;
}

/** The npm arguments that install the runtime dependencies under `root`.
 *
 * `npm ci` whenever a lockfile is there, so every package is the version and
 * sha512 it records. --ignore-scripts because no runtime dependency needs its
 * install script: onnxruntime-node's only fetches CUDA libraries on linux-x64,
 * which the embedder never loads since it runs on the CPU, sharp's only decides
 * whether to compile from source instead of using the prebuilt package npm
 * installs anyway, and protobufjs's only prints a warning. */
export function npmInstallArgs(root) {
  const locked = ['package-lock.json', 'npm-shrinkwrap.json'].some((name) => fs.existsSync(path.join(root, name)));
  return [locked ? 'ci' : 'install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'];
}

/** Dependencies that are not usably installed under `root`.
 *
 * Probing each package's own package.json rather than just the node_modules
 * directory matters: a half-extracted package leaves the folder behind, passes
 * a bare existence check, and then fails with ERR_MODULE_NOT_FOUND after the
 * wrapper has already handed off to the server. */
export function findMissingDeps(root) {
  return RUNTIME_DEPENDENCIES.filter((name) => {
    const manifest = path.join(root, 'node_modules', ...name.split('/'), 'package.json');
    return !fs.existsSync(manifest);
  });
}

/** Prebuilt addons missing from `root` for `tag`, as plugin-relative paths. */
export function findMissingAddons(root, tag = platformTag()) {
  const relative = addonRelativePath(tag);
  return fs.existsSync(path.join(root, relative)) ? [] : [relative];
}

export function isSupportedPlatform(platform = process.platform, arch = process.arch) {
  return SUPPORTED_PLATFORMS.includes(platformTag(platform, arch));
}

export function unsupportedPlatformMessage(platform = process.platform, arch = process.arch) {
  return [
    `starmemory ships prebuilt binaries for ${SUPPORTED_PLATFORMS.join(', ')}, but this machine is ${platformTag(platform, arch)}.`,
    'Nothing is broken -- this release just has no binaries for your platform yet.',
    'To use it here, build the native addon from source (Rust toolchain needed): see "Build from source" in README.md,',
    '  https://github.com/albericliu0/starmemory#build-from-source',
  ].join('\n');
}
