import tseslint from 'typescript-eslint'

/**
 * The dependency-boundary rule is the mechanical enforcement of INV-10:
 * "No React component, route handler, job handler or Internal Ops screen
 * contains a financial business rule." The domain cannot import a framework,
 * so financial logic cannot drift into one.
 */
const FORBIDDEN_IN_DOMAIN = [
  { group: ['react', 'react-*', 'react/*'], message: 'packages/domain must not import React (INV-10).' },
  { group: ['next', 'next/*'], message: 'packages/domain must not import Next.js (INV-10).' },
  { group: ['**/apps/**'], message: 'packages/domain must not import from an app (INV-10).' },
  { group: ['@inrsettle/ui', '@inrsettle/ui/*'], message: 'packages/domain must not import the UI package (INV-10).' },
  { group: ['**/providers/**', '@inrsettle/providers', '@inrsettle/providers/*'],
    message: 'packages/domain owns provider ports; it must not import an adapter (ARCHITECTURE.md § 5).' },
  { group: ['drizzle-orm', 'drizzle-orm/*'],
    message: 'packages/domain must not import an ORM. Express the need as a port and implement it in @inrsettle/app-services.' },
  { group: ['@inrsettle/db', '@inrsettle/db/*'],
    message: 'packages/domain must not depend on the database package. Express the need as a port (ARCHITECTURE.md § 2).' },
  { group: ['@inrsettle/app-services', '@inrsettle/app-services/*'],
    message: 'packages/domain must not import the application layer; the dependency runs the other way.' },
]

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/*.d.ts',
    'storybook-static/**', '**/storybook-static/**'] },
  ...tseslint.configs.recommended,
  {
    files: ['packages/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: FORBIDDEN_IN_DOMAIN }],
    },
  },
  {
    // INV-01: money never touches a JS number.
    files: ['packages/money/**/*.ts', 'packages/domain/**/*.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        { name: 'parseFloat', message: 'Money is bigint minor units (INV-01).' },
        { name: 'parseInt', message: 'Use BigInt(), not parseInt, in the money path (INV-01).' },
      ],
    },
  },
  {
    files: ['**/*.test.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off' },
  },
)
