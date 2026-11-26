import { open } from 'node:fs/promises'
import { SaberSandboxClient, SABER_SANDBOX_URL, type SaberSandboxCredentials } from '@inrsettle/providers'

const required = ['SABER_ENVIRONMENT', 'SABER_CLIENT_ID', 'SABER_CLIENT_SECRET'] as const
export function loadSaberCredentials(env: NodeJS.ProcessEnv): SaberSandboxCredentials {
  if (required.some(name => !env[name])) throw new Error('Saber sandbox credentials are missing; fill .env.saber')
  if (env['SABER_ENVIRONMENT'] !== 'sandbox' || (env['SABER_BASE_URL'] && env['SABER_BASE_URL'] !== SABER_SANDBOX_URL)) {
    throw new Error('Saber configuration must use the official sandbox environment')
  }
  const credentials = { environment: 'sandbox' as const, clientId: env['SABER_CLIENT_ID']!, clientSecret: env['SABER_CLIENT_SECRET']! }
  new SaberSandboxClient(credentials) // validate without making any request
  return credentials
}
export function saberSetupStatus(env: NodeJS.ProcessEnv) {
  const missing = required.filter(name => !env[name])
  let state: 'credentials_missing' | 'configured_untested' | 'configuration_invalid' = 'credentials_missing'
  if (!missing.length) {
    try { loadSaberCredentials(env); state = 'configured_untested' } catch { state = 'configuration_invalid' }
  }
  return { provider: 'saber', environment: 'sandbox', state, missing, execution_provider: 'simulator',
    api_url: SABER_SANDBOX_URL, documentation_url: 'https://guides.saber.money/offramp/currencies/inr',
    access_url: 'https://saber.money/contact' }
}
export async function configureSaber(path = '.env.saber'): Promise<void> {
  // Exclusive creation preserves any existing merchant credentials.
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile('# Saber-issued sandbox credentials. Never put production credentials here.\nSABER_ENVIRONMENT=sandbox\nSABER_CLIENT_ID=\nSABER_CLIENT_SECRET=\n# Optional UUID of a user created in this Saber sandbox merchant.\nSABER_TEST_USER_ID=\n')
    await file.sync()
  } finally { await file.close() }
}
