# Security

starmemory reads and stores your Claude Code and Codex conversations, and it loads native code into the processes that do it. A bad release would reach every user's memory. This page says how to report a problem, what a release guarantees, and how a release is made.

## Reporting a vulnerability

Please report it privately, not in a public issue or pull request.

Use **Report a vulnerability** on the repository's Security tab. It opens a private advisory that only the maintainer sees. The button appears once the maintainer turns on private vulnerability reporting (see below). Until then, open an issue that asks for a private way to get in touch, and leave the details out of it.

It helps to include the version from package.json, your platform, and the steps that show the problem.

## What a release guarantees

- CI builds and tests the four native addons from the tagged commit, on GitHub-hosted runners. A tag build restores no caches, uses a fixed Rust toolchain, and fails if Cargo.lock is out of date.
- Every action the workflow uses is pinned to a full commit sha.
- The build jobs get a read-only token, and checkout does not leave it on disk. Only the release job can write, and what it creates is a draft.
- The release job writes SHA256SUMS and signs provenance attestations for the four addons and for SHA256SUMS.
- Nothing is public until a maintainer has checked the draft and published it.
- CI fails when the committed dist/ does not match a fresh build of src/.
- On first run the plugin installs its dependencies with `npm ci --omit=dev --ignore-scripts`. That gives exactly the versions and hashes in package-lock.json, and no package's install script runs. CI installs the same way, so the tests run against what users get.
- A downloaded addon is installed only when its sha256 matches both the release's SHA256SUMS and the entry for that version and platform in native/addon-checksums.json. When there is no entry yet, it is checked against SHA256SUMS alone, and the plugin says so on stderr.

Two gaps remain. On a Mac with Apple silicon the plugin runs the committed darwin-arm64 addon, which was built on a developer machine and has no attestation. And until the settings below are on, anyone with write access can push to main or move a tag.

## Making a release

1. Bump the version in package.json and the plugin manifests, merge that to main, and push a `vX.Y.Z` tag on the commit.
2. Wait for CI to build and test all four platforms and create the draft release.
3. Check the draft. If anything fails, delete the draft and do not publish.

   ```sh
   gh release download vX.Y.Z --repo albericliu0/starmemory --dir check
   cd check
   shasum -a 256 -c SHA256SUMS
   for f in starmemory_native.*.node SHA256SUMS
   do
     gh attestation verify "$f" --repo albericliu0/starmemory \
       --signer-workflow albericliu0/starmemory/.github/workflows/build.yml \
       --source-ref refs/tags/vX.Y.Z --deny-self-hosted-runners
   done
   ```

4. Commit the hashes to native/addon-checksums.json before you publish. Add an entry for the version that maps each platform to its hash from SHA256SUMS, and merge it to main the usual way.

   ```json
   "X.Y.Z": { "darwin-arm64": "<sha256>", "linux-x64": "<sha256>", "linux-arm64": "<sha256>", "win32-x64": "<sha256>" }
   ```

5. Publish the draft.

A copy installed from the tag's own commit finds no entry for its version, because the hashes land in the commit after it. Its download falls back to SHA256SUMS and says so. Copies from the hashes commit onward check both.

## What only the owner can do

These are repository settings and release choices, so no code change can make them.

- **Rulesets on main.** Require a pull request with an approving review, require the build checks to pass, block force pushes and deletion, and require signed commits.
- **A ruleset on `v*` tags.** Only maintainers can create them, and nobody can move or delete one.
- **CODEOWNERS.** Add `.github/CODEOWNERS` naming the maintainer, at least for `.github/`, `cli/`, `hooks/`, `native/`, `dist/` and `package-lock.json`. Then require code owner review in the main ruleset.
- **Immutable releases.** Once a release is published, its assets and its tag can no longer change.
- **A protected release environment.** The release job already runs in an environment named `release`. Give it required reviewers and let only `v*` tags deploy to it.
- **Private vulnerability reporting.** Turn it on in the repository's security settings, so the Report a vulnerability button appears.
- **A darwin-arm64 addon built in CI.** The committed one was built on a laptop and embeds a home directory path. Build it on the macos-14 runner with `RUSTFLAGS="--remap-path-prefix=$HOME=~"` so no home path is embedded, attest it with the other three, and then either commit that file or let bootstrap download it like the others.
- **A pinned marketplace entry.** The marketplace entry is `"./"` on the default branch today, so an install runs whatever main holds. List the plugin with a fixed ref and its full commit sha instead, such as a release tag and the commit it names, and move the pin only when you release. Pinning to the commit that adds a release's hashes, rather than the tag's own commit, lets those installs check downloads against them too.
