import cron from 'node-cron'
import { loadConfig, writeState } from './config/config'
import { initActual, shutdownActual, withActualLock } from './actual/actual'
import { syncConnection } from './sync/connection'
import { log, logError } from './utils/logger'
import type { Config } from './config/schema'
import { startManagementServer } from './management'

const dryRun = process.argv.includes('--dry-run')
let activeSync: Promise<void> | undefined

async function mainTask(): Promise<void> {
  try {
    const config: Config = await loadConfig()
    await withActualLock(async () => {
      try {
        await initActual({
          serverURL: config.env.ACTUAL_SERVER_URL,
          password: config.env.ACTUAL_SERVER_PASSWORD,
          syncId: config.env.ACTUAL_SYNC_ID,
          verbose: !!config.env.DEBUG,
        })

        for (const connection of config.connections) {
          const result = await syncConnection(connection, config, dryRun)
          if (result) {
            config.state.connections[connection.name] = result
            await writeState(config)
          }
        }
      } finally {
        await shutdownActual()
      }
    })
  } catch (e) {
    logError(['Sync'], 'Global sync error:', e)
  } finally {
    log(['Sync'], 'Sync cycle finished. Sleeping...')
  }
}

function triggerSync(): Promise<boolean> {
  if (activeSync) return Promise.resolve(false)
  activeSync = mainTask().finally(() => {
    activeSync = undefined
  })
  return activeSync.then(() => true)
}

void (async () => {
  startManagementServer(triggerSync)
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

  await triggerSync()

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
        triggerSync().then((started) => {
          if (!started) log(['Sync'], 'Scheduled sync skipped because a sync is already running.')
        }).catch((err) => logError(['Sync'], 'Unhandled task error:', err))
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
