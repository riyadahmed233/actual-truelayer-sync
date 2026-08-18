import actual from '@actual-app/api'

let actualQueue: Promise<void> = Promise.resolve()

// The Actual API client is process-global, so UI requests and sync runs cannot use it concurrently.
export async function withActualLock<T>(task: () => Promise<T>): Promise<T> {
  let release!: () => void
  const previous = actualQueue
  actualQueue = new Promise<void>((resolve) => {
    release = resolve
  })
  await previous
  try {
    return await task()
  } finally {
    release()
  }
}

interface InitOptions {
  serverURL: string
  password: string
  syncId: string
  verbose: boolean
}

export async function initActual(options: InitOptions): Promise<void> {
  await actual.init({
    serverURL: options.serverURL,
    password: options.password,
    verbose: options.verbose,
    // Keep Actual's downloaded budget cache separate from persistent config/state.
    dataDir: './data/actual-cache',
  })
  await actual.downloadBudget(options.syncId)
}

export async function importTransactions(
  accountId: string,
  transactions: Parameters<typeof actual.importTransactions>[1],
): Promise<{ added: string[]; updated: string[] }> {
  const result = await actual.importTransactions(accountId, transactions)
  if (result.errors.length > 0) {
    throw new Error(`Import errors for account ${accountId}: ${JSON.stringify(result.errors)}`)
  }
  return { added: result.added, updated: result.updated }
}

export async function getAccounts(): Promise<Array<{ id: string; name: string; closed: boolean }>> {
  return actual.getAccounts()
}

export async function shutdownActual(): Promise<void> {
  await actual.shutdown()
}
