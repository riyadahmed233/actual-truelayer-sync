import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import fs from 'fs/promises'
import path from 'path'
import { getAccounts, initActual, shutdownActual, withActualLock } from './actual/actual'
import { CONFIG_PATH, STATE_PATH, writeConfig } from './config/config'
import type { FileConfig, State } from './config/schema'
import { exchangeCode, getMe, listAccounts, listCards } from './truelayer/truelayer'
import { readJSON, writeJSON } from './utils/file'

const SCOPES = {
  accounts: 'accounts balance transactions offline_access',
  cards: 'cards balance transactions offline_access',
} as const

type ConnectionType = keyof typeof SCOPES
type DiscoveredAccount = { id: string; label: string }
type PendingConnection = { type: ConnectionType; refreshToken: string; accounts: DiscoveredAccount[]; actualAccounts: Array<{ id: string; name: string }> }

const pendingConnections = new Map<string, PendingConnection>()

function authUrl(clientId: string, type: ConnectionType, redirectUri: string): string {
  const params = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    scope: SCOPES[type],
    redirect_uri: redirectUri,
    providers: 'uk-ob-all uk-oauth-all',
  })
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
    const suppliedPassword = separator === -1 ? '' : credentials.slice(separator + 1)
    return secureEqual(suppliedPassword, password)
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
  try {
    config = await readJSON<FileConfig>(CONFIG_PATH)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('File not found')) throw error
    config = { version: 2, includeCategoryInNotes: false, lookbackDays: 14, connections: [] }
  }
  try {
    state = await readJSON<State>(STATE_PATH)
  } catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith('File not found')) throw error
    state = { connections: {} }
  }
  return { config, state }
}

const page = `<!doctype html><meta charset="utf-8"><title>TrueLayer onboarding</title><style>body{font:16px system-ui;max-width:760px;margin:40px auto;padding:0 16px}label,select,input,textarea,button{display:block;margin:8px 0}input,textarea,select{width:100%;box-sizing:border-box;padding:8px}textarea{height:80px}#accounts label{border:1px solid #ddd;padding:8px}#status{white-space:pre-wrap;color:#333}</style><h1>TrueLayer onboarding</h1><label>Connection type <select id="type"><option value="accounts">Bank accounts</option><option value="cards">Cards</option></select></label><label>Registered redirect URI <input id="redirect" value="https://console.truelayer.com/redirect-page"></label><button id="start">Start TrueLayer authorisation</button><div id="auth"></div><label>Paste the full redirect URL <textarea id="returned"></textarea></label><button id="complete">Discover accounts</button><div id="accounts"></div><label>Connection name <input id="name"></label><button id="save">Save selected mappings</button><p id="status"></p><script>let session,actual=[];const $=id=>document.getElementById(id),api=async(path,data)=>{const r=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)}),j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j};$('start').onclick=async()=>{try{const j=await api('/api/oauth/start',{type:$('type').value,redirectUri:$('redirect').value});$('auth').innerHTML='<a target="_blank" rel="noopener" href="'+j.url+'">Open TrueLayer authorisation</a>'}catch(e){$('status').textContent=e.message}};$('complete').onclick=async()=>{try{const j=await api('/api/oauth/complete',{type:$('type').value,redirectUri:$('redirect').value,redirectUrl:$('returned').value});session=j.session;actual=j.actualAccounts;$('name').value=j.suggestedName||'';$('accounts').innerHTML=j.accounts.map(a=>'<label><input type="checkbox" data-id="'+a.id+'" data-label="'+a.label+'"> '+a.label+' <select data-map="'+a.id+'"><option value="">Do not map</option>'+actual.map(x=>'<option value="'+x.id+'">'+x.name+'</option>').join('')+'</select></label>').join('')}catch(e){$('status').textContent=e.message}};$('save').onclick=async()=>{try{const mappings=[...document.querySelectorAll('#accounts input:checked')].map(x=>({trueLayerId:x.dataset.id,actualId:document.querySelector('[data-map="'+x.dataset.id+'"]').value})).filter(x=>x.actualId);const j=await api('/api/connections',{session,name:$('name').value,mappings});$('status').textContent='Saved connection: '+j.name}catch(e){$('status').textContent=e.message}};</script>`

export function startManagementServer(): void {
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
      res.end(page)
      return
    }
    try {
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' })
      const input = await body(req)
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
        const actualAccounts = await withActualLock(async () => {
          if (!process.env.ACTUAL_SERVER_URL || !process.env.ACTUAL_SERVER_PASSWORD || !process.env.ACTUAL_SYNC_ID) throw new Error('Actual is not configured')
          try {
            await initActual({ serverURL: process.env.ACTUAL_SERVER_URL, password: process.env.ACTUAL_SERVER_PASSWORD, syncId: process.env.ACTUAL_SYNC_ID, verbose: false })
            return (await getAccounts()).filter((account) => !account.closed).map(({ id, name }) => ({ id, name }))
          } finally { await shutdownActual().catch(() => undefined) }
        })
        const session = randomUUID()
        pendingConnections.set(session, { type, refreshToken: tokens.refresh_token, accounts, actualAccounts })
        return json(res, 200, { session, suggestedName, accounts, actualAccounts })
      }
      if (req.url === '/api/connections') {
        const session = requireString(input, 'session')
        const name = requireString(input, 'name')
        const pending = pendingConnections.get(session)
        if (!pending) throw new Error('Onboarding session expired')
        if (!Array.isArray(input.mappings)) throw new Error('mappings must be an array')
        const mappings = input.mappings.map((mapping) => {
          if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid mapping')
          return mapping as Record<string, unknown>
        })
        const seen = new Set<string>()
        const accounts = mappings.map((mapping) => {
          const trueLayerId = requireString(mapping, 'trueLayerId')
          const actualId = requireString(mapping, 'actualId')
          const source = pending.accounts.find((account) => account.id === trueLayerId)
          if (!source || !pending.actualAccounts.some((account) => account.id === actualId) || seen.has(trueLayerId)) throw new Error('Invalid mapping')
          seen.add(trueLayerId)
          return { trueLayerId, actualId, friendlyName: source.label, ...(pending.type === 'cards' ? { isCard: true } : {}) }
        })
        await withActualLock(async () => {
          const { config, state } = await existingData()
          if (config.connections.some((connection) => connection.name === name) || state.connections[name]) throw new Error('Connection name is already in use')
          const usedActualIds = new Set(config.connections.flatMap((connection) => connection.accounts.map((account) => account.actualId)))
          if (accounts.some((account) => usedActualIds.has(account.actualId) || accounts.filter((other) => other.actualId === account.actualId).length > 1)) throw new Error('An Actual account can only be mapped once')
          await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
          await writeConfig({ ...config, connections: [...config.connections, { name, ...(pending.type === 'cards' ? { isCard: true } : {}), accounts }] })
          await writeJSON(STATE_PATH, { ...state, connections: { ...state.connections, [name]: { refreshToken: pending.refreshToken, accounts: {} } } })
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
