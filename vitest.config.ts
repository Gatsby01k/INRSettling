import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

const pkg = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url))

export default defineConfig({
  resolve: {
    // Source-level aliases keep the test graph acyclic: @inrsettle/testing
    // depends on @inrsettle/db, and db's tests use the harness, which would be
    // a dependency cycle if it were expressed in package.json.
    alias: {
      '@inrsettle/money': pkg('money'),
      '@inrsettle/ids': pkg('ids'),
      '@inrsettle/contracts': pkg('contracts'),
      '@inrsettle/db': pkg('db'),
      // The browser-safe subset must resolve before the barrel, or the alias
      // for '@inrsettle/domain' would swallow the subpath.
      '@inrsettle/domain/browser': fileURLToPath(
        new URL('./packages/domain/src/browser.ts', import.meta.url),
      ),
      '@inrsettle/domain': pkg('domain'),
      '@inrsettle/jobs': pkg('jobs'),
      '@inrsettle/providers': pkg('providers'),
      '@inrsettle/testing': pkg('testing'),
      '@inrsettle/app-services': pkg('app'),
      '@inrsettle/ui': pkg('ui'),
    },
  },
  test: {
    include: [
      'packages/**/*.test.ts', 'packages/**/*.test.tsx',
      'apps/**/*.test.ts', 'apps/**/*.test.tsx',
      'scripts/**/*.test.ts',
    ],
    // Component behaviour needs a DOM; everything else runs in node. The
    // per-file `@vitest-environment jsdom` comment opts a file in.
    environmentMatchGlobs: [
      ['packages/ui/**/*.test.tsx', 'jsdom'],
      ['apps/app/**/*.test.tsx', 'jsdom'],
      ['apps/ops/**/*.test.tsx', 'jsdom'],
    ],
    // Integration tests provision their own database and take real row locks.
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
