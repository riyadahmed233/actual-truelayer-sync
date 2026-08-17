import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import fs from 'fs/promises'
import path from 'path'
import { getAccounts, initActual, shutdownActual, withActualLock } from './actual/actual'
import { CONFIG_PATH, STATE_PATH, writeConfig } from './config/config'
import type { FileConfig, State } from './config/schema'
import { exchangeCode, getMe, listAccounts, listCards, refreshToken } from './truelayer/truelayer'
import { readJSON, writeJSON } from './utils/file'

const SCOPES = {
  accounts: 'accounts balance transactions offline_access',
  cards: 'cards balance transactions offline_access',
} as const

type ConnectionType = keyof typeof SCOPES
type DiscoveredAccount = { id: string; label: string }
type PendingConnection = {
  type: ConnectionType
  refreshToken?: string
  existingConnection?: string
  accounts: DiscoveredAccount[]
  actualAccounts: Array<{ id: string; name: string }>
}
type SyncTrigger = () => Promise<boolean>

const pendingConnections = new Map<string, PendingConnection>()

function authUrl(clientId: string, type: ConnectionType, redirectUri: string): string {
  const params = new URLSearchParams({ response_type: 'code', client_id: clientId, scope: SCOPES[type], redirect_uri: redirectUri, providers: 'uk-ob-all uk-oauth-all' })
  return `https://auth.truelayer.com/?${params}`
}

function secureEqual(value: string, expected: string): boolean {
  const hash = (input: string) => createHash('sha256').update(input).digest()
  return timingSafeEqual(hash(value), hash(expected))
}

function authorised(req: IncomingMessage, password: string): boolean {
  const header = req.headers.authorization
  if (!header?.startsWith('Basic ')) return false
  try {
    const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const separator = credentials.indexOf(':')
    return secureEqual(separator === -1 ? '' : credentials.slice(separator + 1), password)
  } catch {
    return false
  }
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  let raw = ''
  for await (const chunk of req) {
    raw += chunk
    if (raw.length > 1024 * 1024) throw new Error('Request is too large')
  }
  const parsed: unknown = JSON.parse(raw)
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Expected a JSON object')
  return parsed as Record<string, unknown>
}

function json(res: ServerResponse, status: number, data: object): void {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(data))
}

function requireString(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${key} is required`)
  return value.trim()
}

async function existingData(): Promise<{ config: FileConfig; state: State }> {
  let config: FileConfig
  let state: State
  try { config = await readJSON<FileConfig>(CONFIG_PATH) } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('File not found')) throw error
    config = { version: 2, includeCategoryInNotes: false, lookbackDays: 14, connections: [] }
  }
  try { state = await readJSON<State>(STATE_PATH) } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('File not found')) throw error
    state = { connections: {} }
  }
  return { config, state }
}

async function actualAccounts(): Promise<Array<{ id: string; name: string }>> {
  return withActualLock(async () => {
    if (!process.env.ACTUAL_SERVER_URL || !process.env.ACTUAL_SERVER_PASSWORD || !process.env.ACTUAL_SYNC_ID) throw new Error('Actual is not configured')
    try {
      await initActual({ serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_SERVER_PASSWORD, syncId: process.env.ACTUAL_SYNC_ID, verbose: false })
      return (await getAccounts()).filter((account) => !account.closed).map(({ id, name }) => ({ id, name }))
    } finally {
      await shutdownActual().catch(() => undefined)
    }
  })
}

const page = `<!doctype html><meta charset="utf-8"><title>TrueLayer onboarding</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px}label,select,input,textarea,button{display:block;margin:8px 0}input,textarea,select{width:100%;box-sizing:border-box;padding:8px}textarea{height:80px}#accounts label{border:1px solid #ddd;padding:8px}#status{white-space:pre-wrap;color:#333}</style><h1>TrueLayer onboarding</h1><h2>Add a connection</h2><label>Connection type <select id="type"><option value="accounts">Bank accounts</option><option value="cards">Cards</option></select></label><label>Registered redirect URI <input id="redirect" value="https://console.truelayer.com/redirect-page"></label><button id="start">Start TrueLayer authorisation</button><div id="auth"></div><label>Paste the full redirect URL <textarea id="returned"></textarea></label><button id="complete">Discover accounts</button><h2>Add accounts to an existing connection</h2><label>Existing connection <select id="connection"><option value="">Loading connections...</option></select></label><button id="discover-existing">Discover unmapped accounts</button><div id="accounts"></div><label>Connection name <input id="name"></label><button id="save">Save selected mappings</button><p id="status"></p><script>let session,actual=[];const $=id=>document.getElementById(id),api=async(path,data={})=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j},show=j=>{session=j.session;actual=j.actualAccounts;$('accounts').innerHTML=j.accounts.map(a=>'<label><input type="checkbox" data-id="'+a.id+'"> '+a.label+' <select data-map="'+a.id+'"><option value="">Do not map</option>'+actual.map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('')+'</select></label>').join('')||'No unmapped TrueLayer accounts found.'};api('/api/connections/list').then(j=>{$('connection').innerHTML='<option value="">Choose connection</option>'+j.connections.map(x=>'<option value="'+x.name+'">'+x.name+'</option>').join('')}).catch(e=>{$('status').textContent=e.message});$('start').onclick=async()=>{try{const j=await api('/api/oauth/start',{type:$('type').value,redirectUri:$('redirect').value});$('auth').innerHTML='<a target="_blank" rel="noopener" href="'+j.url+'">Open TrueLayer authorisation</a>'}catch(e){$('status').textContent=e.message}};$('complete').onclick=async()=>{try{const j=await api('/api/oauth/complete',{type:$('type').value,redirectUri:$('redirect').value,redirectUrl:$('returned').value});$('name').value=j.suggestedName||'';show(j)}catch(e){$('status').textContent=e.message}};$('discover-existing').onclick=async()=>{try{const name=$('connection').value;if(!name)throw Error('Choose a connection');const j=await api('/api/connections/discover',{name});$('name').value=name;show(j)}catch(e){$('status').textContent=e.message}};$('save').onclick=async()=>{try{const mappings=[...document.querySelectorAll('#accounts input:checked')].map(x=>({trueLayerId:x.dataset.id,actualId:document.querySelector('[data-map="'+x.dataset.id+'"]').value})).filter(x=>x.actualId);const j=await api('/api/connections',{session,name:$('name').value,mappings});$('status').textContent='Saved '+j.name}catch(e){$('status').textContent=e.message}}</script>`

function pageWithControls(): string {
  return page
    .replace('<title>TrueLayer onboarding</title>', '<title>TrueLayer sync</title>')
    .replace('#accounts label{border:1px solid #ddd;padding:8px}', '#accounts label{border:1px solid #ddd;padding:8px}#accounts input[type="checkbox"]{display:none}.hint{color:#576071}')
    .replace('<h1>TrueLayer onboarding</h1>', '<h1>TrueLayer sync</h1><p class="hint">Manage connections and account mappings for Actual Budget.</p><h2>Sync</h2><p class="hint">Run an import now. A running sync will not be duplicated.</p><button id="sync">Sync now</button>')
    .replace('<h2>Add accounts to an existing connection</h2>', '<h2>Add accounts to an existing connection</h2><p class="hint">Find accounts that are not yet mapped. No re-authorisation is needed.</p>')
    .replace('Save selected mappings', 'Save mappings')
    .replace('Do not map</option>', 'Do not map this account</option>')
    .replace('</script>', `;const originalShow=show;show=j=>{originalShow(j);document.querySelectorAll('[data-id]').forEach(input=>{input.checked=true})};$('sync').onclick=async()=>{const button=$('sync');button.disabled=true;try{const j=await api('/api/sync');$('status').textContent=j.completed?'Sync completed. Check logs for connection errors.':'A sync is already running.'}catch(e){$('status').textContent=e.message}finally{button.disabled=false}};</script>`)
}

export function startManagementServer(triggerSync: SyncTrigger): void {
  const port = process.env.MANAGEMENT_PORT
  if (!port) return
  const adminPassword = process.env.SYNC_ADMIN_PASSWORD
  if (!adminPassword) throw new Error('SYNC_ADMIN_PASSWORD is required when MANAGEMENT_PORT is set')
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('MANAGEMENT_PORT must be a valid port number')

  createServer(async (req, res) => {
    if (!authorised(req, adminPassword)) {
      res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TrueLayer onboarding"' })
      res.end()
      return
    }
    if (req.method === 'GET' && req.url === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(pageWithControls())
      return
    }
    try {
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' })
      const input = await body(req)
      if (req.url === '/api/sync') {
        const started = await triggerSync()
        return json(res, started ? 200 : 409, { completed: started, ...(started ? {} : { error: 'A sync is already running' }) })
      }
      if (req.url === '/api/oauth/start') {
        const type = requireString(input, 'type') as ConnectionType
        const redirectUri = requireString(input, 'redirectUri')
        if (!(type in SCOPES)) throw new Error('type must be accounts or cards')
        new URL(redirectUri)
        if (!process.env.TRUELAYER_CLIENT_ID) throw new Error('TrueLayer is not configured')
        return json(res, 200, { url: authUrl(process.env.TRUELAYER_CLIENT_ID, type, redirectUri) })
      }
      if (req.url === '/api/oauth/complete') {
        const type = requireString(input, 'type') as ConnectionType
        const redirectUri = requireString(input, 'redirectUri')
        const redirectUrl = requireString(input, 'redirectUrl')
        if (!(type in SCOPES)) throw new Error('type must be accounts or cards')
        const code = new URL(redirectUrl).searchParams.get('code')
        if (!code) throw new Error('The redirect URL does not contain a code')
        const clientId = process.env.TRUELAYER_CLIENT_ID
        const clientSecret = process.env.TRUELAYER_CLIENT_SECRET
        if (!clientId || !clientSecret) throw new Error('TrueLayer is not configured')
        const tokens = await exchangeCode(clientId, clientSecret, code, redirectUri)
        const discovered = type === 'cards' ? await listCards(tokens.access_token) : await listAccounts(tokens.access_token)
        const accounts = discovered.map((account) => ({ id: account.account_id, label: account.display_name }))
        let suggestedName = ''
        try { suggestedName = (await getMe(tokens.access_token)).provider.display_name } catch { /* optional */ }
        const session = randomUUID()
        pendingConnections.set(session, { type, refreshToken: tokens.refresh_token, accounts, actualAccounts: await actualAccounts() })
        return json(res, 200, { session, suggestedName, accounts, actualAccounts: pendingConnections.get(session)?.actualAccounts })
      }
      if (req.url === '/api/connections/list') {
        const { config } = await existingData()
        return json(res, 200, { connections: config.connections.map(({ name, isCard }) => ({ name, isCard: Boolean(isCard) })) })
      }
      if (req.url === '/api/connections/discover') {
        const name = requireString(input, 'name')
        const { config, state } = await existingData()
        const connection = config.connections.find((item) => item.name === name)
        const connectionState = state.connections[name]
        if (!connection || !connectionState) throw new Error('Connection is not configured')
        const clientId = process.env.TRUELAYER_CLIENT_ID
        const clientSecret = process.env.TRUELAYER_CLIENT_SECRET
        if (!clientId || !clientSecret) throw new Error('TrueLayer is not configured')
        const tokens = await refreshToken(clientId, clientSecret, connectionState.refreshToken)
        const discovered = connection.isCard ? await listCards(tokens.access_token) : await listAccounts(tokens.access_token)
        const accounts = discovered.filter((account) => !connection.accounts.some((mapped) => mapped.trueLayerId === account.account_id)).map((account) => ({ id: account.account_id, label: account.display_name }))
        // A refresh may rotate the credential; retain account sync state while persisting it.
        if (tokens.refresh_token !== connectionState.refreshToken) {
          await withActualLock(async () => {
            const current = await existingData()
            const currentState = current.state.connections[name]
            if (!currentState) throw new Error('Connection is not configured')
            await writeJSON(STATE_PATH, { ...current.state, connections: { ...current.state.connections, [name]: { ...currentState, refreshToken: tokens.refresh_token } } })
          })
        }
        const session = randomUUID()
        const availableActualAccounts = await actualAccounts()
        pendingConnections.set(session, { type: connection.isCard ? 'cards' : 'accounts', existingConnection: name, accounts, actualAccounts: availableActualAccounts })
        return json(res, 200, { session, accounts, actualAccounts: availableActualAccounts })
      }
      if (req.url === '/api/connections') {
        const session = requireString(input, 'session')
        const name = requireString(input, 'name')
        const pending = pendingConnections.get(session)
        if (!pending || (pending.existingConnection && pending.existingConnection !== name)) throw new Error('Onboarding session expired')
        if (!Array.isArray(input.mappings)) throw new Error('mappings must be an array')
        const seen = new Set<string>()
        const accounts = input.mappings.map((mapping) => {
          if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid mapping')
          const item = mapping as Record<string, unknown>
          const trueLayerId = requireString(item, 'trueLayerId')
          const actualId = requireString(item, 'actualId')
          const source = pending.accounts.find((account) => account.id === trueLayerId)
          if (!source || !pending.actualAccounts.some((account) => account.id === actualId) || seen.has(trueLayerId)) throw new Error('Invalid mapping')
          seen.add(trueLayerId)
          return { trueLayerId, actualId, friendlyName: source.label, ...(pending.type === 'cards' ? { isCard: true } : {}) }
        })
        await withActualLock(async () => {
          const { config, state } = await existingData()
          const usedElsewhere = new Set(config.connections.filter((connection) => connection.name !== name).flatMap((connection) => connection.accounts.map((account) => account.actualId)))
          if (accounts.some((account) => usedElsewhere.has(account.actualId) || accounts.filter((other) => other.actualId === account.actualId).length > 1)) throw new Error('An Actual account can only be mapped once')
          await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
          if (pending.existingConnection) {
            const connection = config.connections.find((item) => item.name === name)
            if (!connection || !state.connections[name] || accounts.some((account) => connection.accounts.some((mapped) => mapped.trueLayerId === account.trueLayerId))) throw new Error('Connection changed; discover accounts again')
            if (accounts.some((account) => connection.accounts.some((mapped) => mapped.actualId === account.actualId))) throw new Error('An Actual account can only be mapped once')
            await writeConfig({ ...config, connections: config.connections.map((item) => item.name === name ? { ...item, accounts: [...item.accounts, ...accounts] } : item) })
          } else {
            if (config.connections.some((connection) => connection.name === name) || state.connections[name]) throw new Error('Connection name is already in use')
            await writeConfig({ ...config, connections: [...config.connections, { name, ...(pending.type === 'cards' ? { isCard: true } : {}), accounts }] })
            await writeJSON(STATE_PATH, { ...state, connections: { ...state.connections, [name]: { refreshToken: pending.refreshToken!, accounts: {} } } })
          }
        })
        pendingConnections.delete(session)
        return json(res, 201, { name })
      }
      return json(res, 404, { error: 'Not found' })
    } catch {
      return json(res, 400, { error: 'Request failed' })
    }
  }).listen(portNumber)
}
