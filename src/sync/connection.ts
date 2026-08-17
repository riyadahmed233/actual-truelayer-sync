import { refreshToken } from '../truelayer/truelayer'
import { syncAccount } from './account'
import { fetchAccountMap } from './accounts'
import { currentDate } from '../utils/date'
import { log, logError } from '../utils/logger'
import { getConnectionState, getAccountLastSyncDate } from '../config/state'
import type { Connection, Config, ConnectionState } from '../config/schema'
import type { TrueLayerAccount, TrueLayerCard } from '../truelayer/types'

type Progress = (progress: { phase: string; account?: string; completed?: boolean }) => void

export async function syncConnection(
  connection: Connection,
  config: Config,
  dryRun = false,
  progress?: Progress,
): Promise<ConnectionState | undefined> {
  const connectionState = getConnectionState(config.state, connection.name)
  if (!connectionState) {
    logError([connection.name], 'No state entry — skipping. Add this connection to state.json.')
    return undefined
  }

  const startedAt = Date.now()
  const prefix = [connection.name]
  log(prefix, 'Starting sync, authenticating with TrueLayer...')
  progress?.({ phase: `Authenticating ${connection.name}` })

  let accessToken: string
  let newRefreshToken: string
  try {
    const { access_token, refresh_token } = await refreshToken(
      config.env.TRUELAYER_CLIENT_ID,
      config.env.TRUELAYER_CLIENT_SECRET,
      connectionState.refreshToken,
    )
    accessToken = access_token
    newRefreshToken = refresh_token
  } catch (err) {
    logError(prefix, 'Authentication failed:', err)
    return undefined
  }

  const tokenChanged = newRefreshToken !== connectionState.refreshToken
  log(prefix, `└ Refresh token ${tokenChanged ? 'CHANGED' : 'unchanged'}.`)

  let trueLayerAccountsById: Map<string, TrueLayerAccount | TrueLayerCard>
  try {
    progress?.({ phase: `Loading accounts for ${connection.name}` })
    trueLayerAccountsById = await fetchAccountMap(connection, accessToken)
  } catch (err) {
    logError(prefix, 'Sync failed:', err)

    if (tokenChanged) {
      return { ...connectionState, refreshToken: newRefreshToken }
    } else {
      return undefined
    }
  }

  const updatedAccounts = { ...connectionState.accounts }
  for (const configAccount of connection.accounts) {
    progress?.({ phase: `Syncing ${configAccount.friendlyName}`, account: configAccount.friendlyName })
    const lastSyncDate = getAccountLastSyncDate(config.state, connection.name, configAccount.trueLayerId)
    let hadTransactions = false
    try {
      hadTransactions = await syncAccount({
        configAccount,
        connection,
        accessToken,
        trueLayerAccountsById,
        includeCategoryInNotes: config.includeCategoryInNotes,
        lookbackDays: config.lookbackDays,
        lastSyncDate,
        dryRun,
      })
    } finally {
      progress?.({ phase: `Synced ${configAccount.friendlyName}`, account: configAccount.friendlyName, completed: true })
    }

    if (hadTransactions) {
      updatedAccounts[configAccount.trueLayerId] = { lastSyncDate: currentDate() }
    }
  }

  const elapsed = ((Date.now() - startedAt) / 1000).toFixed(1)
  log(prefix, `Done in ${elapsed}s.`)

  // Dry run only saves state of refresh token changed
  if (dryRun) {
    if (tokenChanged) {
      return { ...connectionState, refreshToken: newRefreshToken }
    } else {
      return undefined
    }
  }

  return { refreshToken: newRefreshToken, accounts: updatedAccounts }
}
