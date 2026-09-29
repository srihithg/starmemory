import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    {
      // A Windows checkout has CRLF line endings, and Vite's SSR transform
      // takes a hashbang line only when it ends in LF. Otherwise it puts the
      // imports above `#!/usr/bin/env node`, which is then a syntax error, so a
      // test cannot import cli/desktop-launch.mjs. Node itself runs such a file
      // fine. Dropping the CRs moves nothing to another line or column.
      name: 'lf-line-endings',
      enforce: 'pre',
      transform(code, id) {
        if (!/\.[cm]?js$/.test(id.split('?')[0]) || !code.includes('\r\n')) return null;
        return { code: code.replace(/\r\n/g, '\n'), map: null };
      },
    },
  ],
  test: {
    // `npm run package` stages a full copy of the repo under build-pkg/, tests
    // included. Without this the suite runs twice and reports doubled counts.
    exclude: ['**/node_modules/**', '**/dist/**', 'build-pkg/**'],
    // Processes start slowly on Windows, and there each desktop-install run
    // also starts PowerShell to ask whether the Claude app is running.
    testTimeout: process.platform === 'win32' ? 30_000 : 5_000,
  },
});
