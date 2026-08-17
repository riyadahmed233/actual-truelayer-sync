import cron from 'node-cron'
import { loadConfig, writeState } from './config/config'
import { initActual, shutdownActual, withActualLock } from './actual/actual'
import { syncConnection } from './sync/connection'
import { log, logError } from './utils/logger'
import type { Config } from './config/schema'
import { startManagementServer } from './management'

const dryRun = process.argv.includes('--dry-run')
let activeSync: Promise<void> | undefined
type SyncStatus = {
  running: boolean
  startedAt?: string
  finishedAt?: string
  phase: string
  connections: { total: number; completed: number; current?: string }
  accounts: { total: number; completed: number; current?: string }
  error?: string
}
let syncStatus: SyncStatus = { running: false, phase: 'Idle', connections: { total: 0, completed: 0 }, accounts: { total: 0, completed: 0 } }

async function mainTask(): Promise<void> {
  try {
    const config: Config = await loadConfig()
    syncStatus.connections.total = config.connections.length
    syncStatus.accounts.total = config.connections.reduce((total, connection) => total + connection.accounts.length, 0)
    await withActualLock(async () => {
      try {
        await initActual({
          serverURL: config.env.ACTUAL_SERVER_URL,
          password: config.env.ACTUAL_SERVER_PASSWORD,
          syncId: config.env.ACTUAL_SYNC_ID,
          verbose: !!config.env.DEBUG,
        })

        for (const connection of config.connections) {
          syncStatus.connections.current = connection.name
          syncStatus.phase = `Syncing ${connection.name}`
          const result = await syncConnection(connection, config, dryRun, ({ phase, account, completed }) => {
            syncStatus.phase = phase
            syncStatus.accounts.current = account
            if (completed) syncStatus.accounts.completed += 1
          })
          if (result) {
            config.state.connections[connection.name] = result
            await writeState(config)
          }
          syncStatus.connections.completed += 1
        }
      } finally {
        await shutdownActual()
      }
    })
  } catch (e) {
    logError(['Sync'], 'Global sync error:', e)
    syncStatus.error = 'Sync failed. Check the pod logs for details.'
  } finally {
    syncStatus.running = false
    syncStatus.finishedAt = new Date().toISOString()
    syncStatus.phase = syncStatus.error ? 'Failed' : 'Completed'
    log(['Sync'], 'Sync cycle finished. Sleeping...')
  }
}

function triggerSync(): boolean {
  if (activeSync) return false
  syncStatus = { running: true, startedAt: new Date().toISOString(), phase: 'Preparing sync', connections: { total: 0, completed: 0 }, accounts: { total: 0, completed: 0 } }
  activeSync = mainTask().finally(() => {
    activeSync = undefined
  })
  return true
}

function getSyncStatus(): SyncStatus {
  return syncStatus
}

void (async () => {
  startManagementServer(triggerSync, getSyncStatus)
  let config: Config
  try {
    config = await loadConfig()
  } catch (err) {
    logError(['Sync'], 'Failed to load config:', err)
    if (process.env.MANAGEMENT_PORT) return
    process.exit(1)
  }

  if (dryRun) {
    log(['DRY RUN'], 'No transactions will be imported and no runs will be scheduled.')
  }

  if (triggerSync()) await activeSync

  if (dryRun) {
    if (config.env.CRON_SCHEDULE) {
      log(['DRY RUN'], `Would have scheduled: ${config.env.CRON_SCHEDULE}`)
    }
    return
  }

  if (config.env.CRON_SCHEDULE) {
    const timezone = config.env.TZ
    log(
      ['Sync'],
      `Scheduler initialized with pattern: ${config.env.CRON_SCHEDULE}${timezone ? ` (timezone: ${timezone})` : ''}`,
    )
    cron.schedule(
      config.env.CRON_SCHEDULE,
      () => {
        if (!triggerSync()) log(['Sync'], 'Scheduled sync skipped because a sync is already running.')
      },
      {
        noOverlap: true,
        ...(timezone ? { timezone } : {}),
      },
    )
  }
})()

process.on('SIGTERM', () => {
  log(['Sync'], 'SIGTERM received, shutting down...')
  shutdownActual()
    .catch((err) => logError(['Sync'], 'Error during shutdown:', err))
    .finally(() => process.exit(0))
})
