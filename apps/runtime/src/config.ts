import { resolve } from 'node:path'

export interface RuntimeConfig {
  appUrl: string
  workerUrl: string
  simulatorUrl: string
  host: string
  port: number
  destinationKey: Buffer
  webhookKey: Buffer
  fingerprintKey: Buffer
  artifactRoot: string
  workspaceId: string
}

export function sandboxOnly(env: NodeJS.ProcessEnv): void {
  if (env['INRSETTLE_ENVIRONMENT'] !== 'sandbox') {
    throw new Error('This runtime requires INRSETTLE_ENVIRONMENT=sandbox. Live adapters and operating terms are not configured.')
  }
}

export function databaseUrl(env: NodeJS.ProcessEnv, name: string, role?: string): string {
  const value = env[name]
  if (!value) throw new Error(`${name} is required`)
  const url = new URL(value)
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error(`${name} must be a PostgreSQL URL`)
  if (role && decodeURIComponent(url.username) !== role) throw new Error(`${name} must use the ${role} role`)
  return value
}

export function secretKey(env: NodeJS.ProcessEnv, name: string): Buffer {
  const value = env[name]
  if (!value || !/^[a-fA-F0-9]{64}$/.test(value)) throw new Error(`${name} must contain 32 random bytes encoded as 64 hex characters`)
  return Buffer.from(value, 'hex')
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RuntimeConfig {
  sandboxOnly(env)
  const port = Number(env['INRSETTLE_PORT'] ?? '8080')
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('INRSETTLE_PORT must be a valid TCP port')
  return {
    appUrl: databaseUrl(env, 'INRSETTLE_DATABASE_URL', 'inrsettle_app'),
    workerUrl: databaseUrl(env, 'INRSETTLE_WORKER_DATABASE_URL', 'inrsettle_worker'),
    simulatorUrl: databaseUrl(env, 'INRSETTLE_SIMULATOR_DATABASE_URL', 'inrsettle_simulator'),
    host: env['INRSETTLE_HOST'] ?? '127.0.0.1', port,
    destinationKey: secretKey(env, 'INRSETTLE_DESTINATION_KEY'),
    webhookKey: secretKey(env, 'INRSETTLE_WEBHOOK_KEY'),
    fingerprintKey: secretKey(env, 'INRSETTLE_FINGERPRINT_KEY'),
    artifactRoot: resolve(env['INRSETTLE_ARTIFACT_ROOT'] ?? '.sandbox/artifacts'),
    workspaceId: env['INRSETTLE_WORKSPACE_ID'] ?? 'ws_partner_sandbox',
  }
}
