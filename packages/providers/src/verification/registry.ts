/**
 * Choosing a verification adapter.
 *
 * There is exactly one registered adapter today — the sandbox simulator — and
 * that is the honest state of `D-11`. This registry exists so that adding a
 * real adapter is a registration, not a refactor: nothing above it names a
 * provider, and live has no adapter at all rather than silently falling back to
 * the simulator.
 */
import type { BeneficiaryVerificationProvider } from '@inrsettle/domain'
import { createSandboxVerificationProvider } from './sandbox.js'

export type Environment = 'sandbox' | 'live'

export class NoVerificationProviderError extends Error {
  constructor(readonly environment: Environment) {
    super(
      `No beneficiary verification provider is configured for ${environment}. ` +
        'D-11 is open: a real adapter must be registered before live verification.',
    )
    this.name = 'NoVerificationProviderError'
  }
}

const registry = new Map<string, BeneficiaryVerificationProvider>()

export function registerVerificationProvider(p: BeneficiaryVerificationProvider): void {
  registry.set(p.id, p)
}

export function verificationProviderById(id: string): BeneficiaryVerificationProvider | undefined {
  return registry.get(id)
}

/**
 * Sandbox always resolves to the simulator. Live resolves to whatever has been
 * registered for it — nothing, today — and refuses rather than substituting the
 * simulator, because a simulated verification in live would be a lie about
 * whether money can be delivered.
 */
export function verificationProviderFor(
  environment: Environment,
): BeneficiaryVerificationProvider {
  if (environment === 'sandbox') {
    const existing = registry.get('sandbox')
    if (existing) return existing
    const created = createSandboxVerificationProvider()
    registry.set(created.id, created)
    return created
  }
  const live = [...registry.values()].find((p) => p.id !== 'sandbox')
  if (!live) throw new NoVerificationProviderError(environment)
  return live
}

/** Test seam: forget every registration, including the lazily created sandbox. */
export function resetVerificationProviders(): void {
  registry.clear()
}
