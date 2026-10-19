import { existsSync } from 'node:fs'
import { loadConfig } from './config.js'
import { configureSandbox, provisionSandbox } from './provision.js'
import { migrateSandbox } from './migrate.js'
import { startApi } from './server.js'
import { startWorker } from './worker.js'

const command = process.argv[2]
const services: { stop(): Promise<void> }[] = []
try {
  if (command === 'configure') {
    await configureSandbox()
    console.log('Created .env.sandbox with random local credentials. Existing configuration is never overwritten.')
  } else {
    if (existsSync('.env.sandbox')) process.loadEnvFile('.env.sandbox')
    if (existsSync('.env.saber')) process.loadEnvFile('.env.saber')
    if (command === 'migrate') { await migrateSandbox(process.env); console.log('Sandbox migrations and reference data are current.') }
    else if (command === 'provision') {
      const created = await provisionSandbox(process.env)
      console.log(`Sandbox workspace: ${created.workspaceId}. Test key saved in .sandbox/${created.workspaceId}.json (owner-only).`)
    } else if (command === 'api' || command === 'worker' || command === 'dev') {
      const config = loadConfig()
      if (command !== 'worker') services.push(await startApi(config))
      if (command !== 'api') services.push(await startWorker(config))
      console.log(JSON.stringify({ event: 'sandbox_started', command, url: `http://${config.host}:${config.port}/workspace` }))
      let stopping = false
      const stop = async () => {
        if (stopping) return
        stopping = true
        await Promise.all(services.map(service => service.stop()))
      }
      process.once('SIGINT', () => { void stop() })
      process.once('SIGTERM', () => { void stop() })
    } else throw new Error('Use configure, migrate, provision, api, worker or dev')
  }
} catch (error) {
  await Promise.allSettled(services.map(service => service.stop()))
  // Configuration diagnostics never print connection strings or field keys.
  console.error(error instanceof Error && error.message.match(/^(INRSETTLE_|This runtime|Use |Run sandbox|Sandbox)/)
    ? error.message : 'Sandbox command failed. Check database availability, migration state and local configuration.')
  process.exitCode = 1
}
