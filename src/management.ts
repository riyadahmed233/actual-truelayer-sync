import { createHash, randomUUID, timingSafeEqual } from 'crypto'
import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import fs from 'fs/promises'
import path from 'path'
import { getAccounts, initActual, shutdownActual, withActualLock } from './actual/actual'
import { CONFIG_PATH, STATE_PATH, writeConfig } from './config/config'
import type { FileConfig, State } from './config/schema'
import { exchangeCode, getMe, listAccounts, listCards, refreshToken } from './truelayer/truelayer'
import { readJSON, writeJSON } from './utils/file'

const SCOPES = { accounts: 'accounts balance transactions offline_access', cards: 'cards balance transactions offline_access' } as const
type ConnectionType = keyof typeof SCOPES
type Account = { id: string; label: string }
type PendingConnection = { type: ConnectionType; refreshToken?: string; existingConnection?: string; accounts: Account[]; actualAccounts: Array<{ id: string; name: string }> }
type SyncStatus = { running: boolean; startedAt?: string; finishedAt?: string; phase: string; connections: { total: number; completed: number; current?: string }; accounts: { total: number; completed: number; current?: string }; error?: string }

const pendingConnections = new Map<string, PendingConnection>()

function authUrl(clientId: string, type: ConnectionType, redirectUri: string): string {
  return `https://auth.truelayer.com/?${new URLSearchParams({ response_type: 'code', client_id: clientId, scope: SCOPES[type], redirect_uri: redirectUri, providers: 'uk-ob-all uk-oauth-all' })}`
}

function authorised(req: IncomingMessage, password: string): boolean {
  const header = req.headers.authorization
  if (!header?.startsWith('Basic ')) return false
  try {
    const credentials = Buffer.from(header.slice(6), 'base64').toString('utf8')
    const supplied = credentials.slice(credentials.indexOf(':') + 1)
    const hash = (value: string) => createHash('sha256').update(value).digest()
    return timingSafeEqual(hash(supplied), hash(password))
  } catch { return false }
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
    } finally { await shutdownActual().catch(() => undefined) }
  })
}

const page = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>TrueLayer sync</title><style>:root{color:#e8edf7;background:#111827;font-family:Inter,ui-sans-serif,system-ui,sans-serif}body{max-width:960px;margin:0 auto;padding:32px 20px}header{margin-bottom:28px}h1{margin:0;font-size:28px}p{color:#9ca9bf}.tabs{display:flex;gap:8px;border-bottom:1px solid #334155;margin-bottom:24px}.tab,button{border:0;border-radius:8px;padding:10px 14px;font:inherit;font-weight:650;cursor:pointer}.tab{color:#9ca9bf;background:transparent;border-radius:8px 8px 0 0}.tab.active{background:#243047;color:#f8fafc}.panel{display:none}.panel.active{display:block}.card{background:#182235;border:1px solid #2c3a52;border-radius:12px;padding:20px;margin:14px 0}.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:12px}.metric{background:#111827;border-radius:8px;padding:14px}.metric b{display:block;font-size:22px;margin-top:4px}label{display:block;margin:14px 0 6px;color:#c8d2e3}input,select,textarea{width:100%;box-sizing:border-box;border:1px solid #40506a;border-radius:7px;background:#0f172a;color:#f8fafc;padding:10px;font:inherit}textarea{min-height:80px}button{background:#4f46e5;color:white}button:disabled{opacity:.55;cursor:wait}.secondary{background:#334155}.progress{height:10px;background:#0f172a;border-radius:999px;overflow:hidden;margin:16px 0}.progress i{display:block;height:100%;background:#66d9a6;transition:width .25s}.account{display:grid;grid-template-columns:minmax(180px,1fr) minmax(180px,1fr);gap:16px;align-items:center;border-top:1px solid #2c3a52;padding:14px 0}.account:first-child{border-top:0}.badge{display:inline-block;border-radius:999px;padding:3px 8px;font-size:12px;font-weight:700}.mapped{background:#164e42;color:#a7f3d0}.unmapped{background:#4c3820;color:#fde68a}.missing{background:#4a2630;color:#fecdd3}.notice{min-height:24px;color:#c8d2e3}@media(max-width:600px){body{padding:20px 14px}.account{grid-template-columns:1fr}}</style></head><body><header><h1>TrueLayer sync</h1><p>Manage transaction imports and account mappings for Actual Budget.</p></header><nav class="tabs"><button class="tab active" data-tab="sync">Sync</button><button class="tab" data-tab="accounts">Accounts</button><button class="tab" data-tab="add">Add connection</button></nav><main><section id="sync" class="panel active"><div class="card"><h2>Import status</h2><div class="grid"><div class="metric">Status<b id="sync-phase">Loading...</b></div><div class="metric">Connections<b id="connection-progress">-</b></div><div class="metric">Accounts<b id="account-progress">-</b></div></div><div class="progress"><i id="progress-bar" style="width:0"></i></div><p id="sync-detail"></p><button id="sync-now">Sync now</button></div></section><section id="accounts" class="panel"><div class="card"><h2>Account mappings</h2><p>Select a connection to refresh its provider accounts. Existing mappings are shown for reference; only unconfigured accounts can be added.</p><label>Connection<select id="connection"><option value="">Loading connections...</option></select></label><button id="discover" class="secondary">Refresh accounts</button><div id="mapping-list"></div><button id="save" disabled>Save new mappings</button></div></section><section id="add" class="panel"><div class="card"><h2>Add a new connection</h2><label>Connection type<select id="type"><option value="accounts">Bank accounts</option><option value="cards">Cards</option></select></label><label>Registered redirect URI<input id="redirect" value="https://console.truelayer.com/redirect-page"></label><button id="start">Start TrueLayer authorisation</button><p id="auth"></p><label>Paste the full redirect URL<textarea id="returned"></textarea></label><button id="complete">Discover accounts</button><div id="new-list"></div><label>Connection name<input id="name"></label><button id="save-new" disabled>Save new connection</button></div></section></main><p id="notice" class="notice"></p><script>const $=id=>document.getElementById(id);let existingSession,newSession;const api=async(path,data)=>{const options=data===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)};const r=await fetch(path,options);const j=await r.json();if(!r.ok)throw Error(j.error||'Request failed');return j};const notice=text=>$('notice').textContent=text;document.querySelectorAll('.tab').forEach(button=>button.onclick=()=>{document.querySelectorAll('.tab,.panel').forEach(x=>x.classList.remove('active'));button.classList.add('active');$(button.dataset.tab).classList.add('active')});function option(value,text){const el=document.createElement('option');el.value=value;el.textContent=text;return el}function renderAccounts(container,accounts,actual){container.replaceChildren();accounts.forEach(account=>{const row=document.createElement('div');row.className='account';const left=document.createElement('div');const title=document.createElement('strong');title.textContent=account.label;left.append(title,document.createElement('br'));const badge=document.createElement('span');badge.className='badge '+(account.actualId?'mapped':account.available===false?'missing':'unmapped');badge.textContent=account.actualId?'Mapped to '+(account.actualName||account.actualId):account.available===false?'Not currently returned by TrueLayer':'Unconfigured';left.append(badge);row.append(left);if(account.actualId){const mapped=document.createElement('span');mapped.textContent=account.actualName||account.actualId;row.append(mapped)}else if(account.available!==false){const select=document.createElement('select');select.dataset.map=account.id;select.append(option('','Do not map this account'),...actual.map(item=>option(item.id,item.name)));row.append(select)}container.append(row)});if(!accounts.length)container.textContent='No accounts found.'}async function refreshStatus(){try{const status=await api('/api/sync/status');$('sync-phase').textContent=status.phase;$('connection-progress').textContent=status.connections.completed+' / '+status.connections.total;$('account-progress').textContent=status.accounts.completed+' / '+status.accounts.total;const total=status.accounts.total||status.connections.total;const complete=status.accounts.total?status.accounts.completed:status.connections.completed;$('progress-bar').style.width=(total?Math.min(100,complete/total*100):status.running?8:0)+'%';$('sync-detail').textContent=status.running?(status.accounts.current?'Currently importing '+status.accounts.current:status.connections.current?'Working on '+status.connections.current:'Preparing import'):(status.finishedAt?'Last finished '+new Date(status.finishedAt).toLocaleString():'No import has run since this page opened')+(status.error?' '+status.error:'');$('sync-now').disabled=status.running;if(status.running)setTimeout(refreshStatus,1500)}catch(e){notice(e.message)}}$('sync-now').onclick=async()=>{try{const j=await api('/api/sync',{});notice(j.started?'Sync started. Progress is updating above.':'A sync is already running.');refreshStatus()}catch(e){notice(e.message)}};api('/api/connections/list').then(j=>{$('connection').replaceChildren(option('','Select a connection'),...j.connections.map(x=>option(x.name,x.name+(x.isCard?' (cards)':''))))}).catch(e=>notice(e.message));$('discover').onclick=async()=>{try{const name=$('connection').value;if(!name)throw Error('Select a connection');const j=await api('/api/connections/discover',{name});existingSession=j.session;renderAccounts($('mapping-list'),j.accounts,j.actualAccounts);$('save').disabled=false;notice('Mappings refreshed. Existing mappings are locked; choose Actual accounts only for unconfigured rows.')}catch(e){notice(e.message)}};$('save').onclick=async()=>{try{const mappings=[...document.querySelectorAll('#mapping-list [data-map]')].map(x=>({trueLayerId:x.dataset.map,actualId:x.value})).filter(x=>x.actualId);if(!mappings.length)throw Error('Choose at least one mapping');await api('/api/connections',{session:existingSession,name:$('connection').value,mappings});notice('Mappings saved. Refresh to confirm the configured state.');$('save').disabled=true}catch(e){notice(e.message)}};$('start').onclick=async()=>{try{const j=await api('/api/oauth/start',{type:$('type').value,redirectUri:$('redirect').value});const link=document.createElement('a');link.href=j.url;link.target='_blank';link.rel='noopener';link.textContent='Open TrueLayer authorisation';$('auth').replaceChildren(link)}catch(e){notice(e.message)}};$('complete').onclick=async()=>{try{const j=await api('/api/oauth/complete',{type:$('type').value,redirectUri:$('redirect').value,redirectUrl:$('returned').value});newSession=j.session;$('name').value=j.suggestedName||'';renderAccounts($('new-list'),j.accounts,j.actualAccounts);$('save-new').disabled=false;notice('Choose Actual accounts for the accounts you want to import.')}catch(e){notice(e.message)}};$('save-new').onclick=async()=>{try{const mappings=[...document.querySelectorAll('#new-list [data-map]')].map(x=>({trueLayerId:x.dataset.map,actualId:x.value})).filter(x=>x.actualId);if(!mappings.length)throw Error('Choose at least one mapping');await api('/api/connections',{session:newSession,name:$('name').value,mappings});notice('Connection saved.');$('save-new').disabled=true}catch(e){notice(e.message)}};refreshStatus();</script></body></html>`

function enhancedPage(): string {
  return page.replace('</body>', `<style>.inventory{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:12px;margin:16px 0}.connection-card,.coverage-row{background:#111827;border:1px solid #2c3a52;border-radius:9px;padding:14px}.connection-card h3{margin:0 0 6px}.danger{background:#9f1239}.coverage-row{display:flex;justify-content:space-between;gap:12px;margin:8px 0}.coverage-row strong{display:block}.coverage-row span{color:#9ca9bf;text-align:right}@media(max-width:600px){.coverage-row{display:block}.coverage-row span{text-align:left;display:block;margin-top:4px}}</style><script>const overviewApi=async(path,data={})=>{const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const value=await response.json();if(!response.ok)throw Error(value.error||'Request failed');return value};const noticeText=text=>document.getElementById('notice').textContent=text;const accountsCard=document.querySelector('#accounts .card');const inventory=document.createElement('div');inventory.id='connection-inventory';accountsCard.prepend(inventory);const coverageTab=document.createElement('button');coverageTab.className='tab';coverageTab.dataset.tab='coverage';coverageTab.textContent='Coverage';document.querySelector('.tabs').append(coverageTab);const coverage=document.createElement('section');coverage.id='coverage';coverage.className='panel';coverage.innerHTML='<div class="card"><h2>Actual account coverage</h2><p>Every open Actual account and the TrueLayer connection assigned to it.</p><div id="coverage-list"></div></div>';document.querySelector('main').append(coverage);coverageTab.onclick=()=>{document.querySelectorAll('.tab,.panel').forEach(item=>item.classList.remove('active'));coverageTab.classList.add('active');coverage.classList.add('active')};async function loadOverview(){try{const data=await overviewApi('/api/overview');inventory.replaceChildren();const title=document.createElement('h2');title.textContent='Connections';inventory.append(title);data.connections.forEach(connection=>{const card=document.createElement('div');card.className='connection-card';const heading=document.createElement('h3');heading.textContent=connection.name;const detail=document.createElement('p');detail.textContent=connection.type+' · '+connection.mappedAccounts+' mapped account'+(connection.mappedAccounts===1?'':'s');const remove=document.createElement('button');remove.className='danger';remove.textContent='Delete connection';remove.onclick=async()=>{if(!confirm('Delete '+connection.name+'? This removes its local TrueLayer token and mappings, but does not change Actual transactions.'))return;try{await overviewApi('/api/connections/delete',{name:connection.name});location.reload()}catch(error){noticeText(error.message)}};card.append(heading,detail,remove);inventory.append(card)});const list=document.getElementById('coverage-list');list.replaceChildren();data.actualAccounts.sort((a,b)=>a.name.localeCompare(b.name)).forEach(account=>{const row=document.createElement('div');row.className='coverage-row';const name=document.createElement('strong');name.textContent=account.name;const mapping=document.createElement('span');mapping.textContent=account.mapping?account.mapping.connection+' · '+account.mapping.providerAccount:'Unconnected';row.append(name,mapping);list.append(row)});if(!data.actualAccounts.length)list.textContent='No open Actual accounts found.'}catch(error){inventory.textContent='Unable to load connection inventory.';noticeText(error.message)}}loadOverview();</script></body>`)
}

export function startManagementServer(startSync: () => boolean, getSyncStatus: () => SyncStatus): void {
  const port = process.env.MANAGEMENT_PORT
  if (!port) return
  const password = process.env.SYNC_ADMIN_PASSWORD
  if (!password) throw new Error('SYNC_ADMIN_PASSWORD is required when MANAGEMENT_PORT is set')
  const portNumber = Number(port)
  if (!Number.isInteger(portNumber) || portNumber < 1 || portNumber > 65535) throw new Error('MANAGEMENT_PORT must be a valid port number')
  createServer(async (req, res) => {
    if (!authorised(req, password)) { res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="TrueLayer sync"' }); return res.end() }
    if (req.method === 'GET' && req.url === '/') { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return res.end(enhancedPage()) }
    if (req.method === 'GET' && req.url === '/api/sync/status') return json(res, 200, getSyncStatus())
    if (req.method === 'GET' && req.url === '/api/connections/list') { const { config } = await existingData(); return json(res, 200, { connections: config.connections.map(({ name, isCard }) => ({ name, isCard: Boolean(isCard) })) }) }
    try {
      if (req.method !== 'POST') return json(res, 404, { error: 'Not found' })
      const input = await body(req)
      if (req.url === '/api/sync') { const started = startSync(); return json(res, started ? 202 : 409, { started, status: getSyncStatus(), ...(started ? {} : { error: 'A sync is already running' }) }) }
      if (req.url === '/api/overview') {
        const { config } = await existingData()
        const actual = await actualAccounts()
        const mappings = config.connections.flatMap((connection) => connection.accounts.map((account) => ({ actualId: account.actualId, connection: connection.name, providerAccount: account.friendlyName })))
        return json(res, 200, {
          connections: config.connections.map((connection) => ({ name: connection.name, type: connection.isCard ? 'Cards' : 'Bank accounts', mappedAccounts: connection.accounts.length })),
          actualAccounts: actual.map((account) => ({ id: account.id, name: account.name, mapping: mappings.find((mapping) => mapping.actualId === account.id) })),
        })
      }
      if (req.url === '/api/connections/delete') {
        const name = requireString(input, 'name')
        await withActualLock(async () => {
          const { config, state } = await existingData()
          if (!config.connections.some((connection) => connection.name === name)) throw new Error('Connection is not configured')
          if (config.connections.length === 1) throw new Error('Add another connection before deleting the final connection')
          const connections = { ...state.connections }
          delete connections[name]
          await writeConfig({ ...config, connections: config.connections.filter((connection) => connection.name !== name) })
          await writeJSON(STATE_PATH, { ...state, connections })
        })
        for (const [session, pending] of pendingConnections) if (pending.existingConnection === name) pendingConnections.delete(session)
        return json(res, 200, { name })
      }
      if (req.url === '/api/oauth/start') {
        const type = requireString(input, 'type') as ConnectionType; const redirectUri = requireString(input, 'redirectUri')
        if (!(type in SCOPES)) throw new Error('type must be accounts or cards'); new URL(redirectUri)
        if (!process.env.TRUELAYER_CLIENT_ID) throw new Error('TrueLayer is not configured')
        return json(res, 200, { url: authUrl(process.env.TRUELAYER_CLIENT_ID, type, redirectUri) })
      }
      if (req.url === '/api/oauth/complete') {
        const type = requireString(input, 'type') as ConnectionType; const redirectUri = requireString(input, 'redirectUri'); const redirectUrl = requireString(input, 'redirectUrl')
        if (!(type in SCOPES)) throw new Error('type must be accounts or cards')
        const code = new URL(redirectUrl).searchParams.get('code'); if (!code) throw new Error('The redirect URL does not contain a code')
        const clientId = process.env.TRUELAYER_CLIENT_ID; const clientSecret = process.env.TRUELAYER_CLIENT_SECRET
        if (!clientId || !clientSecret) throw new Error('TrueLayer is not configured')
        const tokens = await exchangeCode(clientId, clientSecret, code, redirectUri)
        const found = type === 'cards' ? await listCards(tokens.access_token) : await listAccounts(tokens.access_token)
        let suggestedName = ''; try { suggestedName = (await getMe(tokens.access_token)).provider.display_name } catch { /* optional */ }
        const session = randomUUID(); const accounts = found.map((account) => ({ id: account.account_id, label: account.display_name }))
        pendingConnections.set(session, { type, refreshToken: tokens.refresh_token, accounts, actualAccounts: await actualAccounts() })
        return json(res, 200, { session, suggestedName, accounts, actualAccounts: pendingConnections.get(session)?.actualAccounts })
      }
      if (req.url === '/api/connections/list') { const { config } = await existingData(); return json(res, 200, { connections: config.connections.map(({ name, isCard }) => ({ name, isCard: Boolean(isCard) })) }) }
      if (req.url === '/api/connections/discover') {
        const name = requireString(input, 'name'); const { config, state } = await existingData(); const connection = config.connections.find((item) => item.name === name); const connectionState = state.connections[name]
        if (!connection || !connectionState) throw new Error('Connection is not configured')
        const clientId = process.env.TRUELAYER_CLIENT_ID; const clientSecret = process.env.TRUELAYER_CLIENT_SECRET
        if (!clientId || !clientSecret) throw new Error('TrueLayer is not configured')
        const tokens = await refreshToken(clientId, clientSecret, connectionState.refreshToken)
        const found = connection.isCard ? await listCards(tokens.access_token) : await listAccounts(tokens.access_token)
        if (tokens.refresh_token !== connectionState.refreshToken) await writeJSON(STATE_PATH, { ...state, connections: { ...state.connections, [name]: { ...connectionState, refreshToken: tokens.refresh_token } } })
        const allActual = await actualAccounts(); const actualById = new Map(allActual.map((account) => [account.id, account.name])); const mapped = new Map(connection.accounts.map((account) => [account.trueLayerId, account]))
        const accounts: Array<{ id: string; label: string; actualId?: string; actualName?: string; available?: boolean }> = found.map((account) => ({ id: account.account_id, label: account.display_name, ...(mapped.has(account.account_id) ? { actualId: mapped.get(account.account_id)?.actualId, actualName: actualById.get(mapped.get(account.account_id)!.actualId) } : {}) }))
        for (const account of connection.accounts) if (!accounts.some((item) => item.id === account.trueLayerId)) accounts.push({ id: account.trueLayerId, label: account.friendlyName, actualId: account.actualId, actualName: actualById.get(account.actualId), available: false })
        const usedActual = new Set(config.connections.flatMap((item) => item.accounts.map((account) => account.actualId)))
        const availableActual = allActual.filter((account) => !usedActual.has(account.id))
        const session = randomUUID(); pendingConnections.set(session, { type: connection.isCard ? 'cards' : 'accounts', existingConnection: name, accounts: found.map((account) => ({ id: account.account_id, label: account.display_name })), actualAccounts: availableActual })
        return json(res, 200, { session, accounts, actualAccounts: availableActual })
      }
      if (req.url === '/api/connections') {
        const session = requireString(input, 'session'); const name = requireString(input, 'name'); const pending = pendingConnections.get(session)
        if (!pending || (pending.existingConnection && pending.existingConnection !== name) || !Array.isArray(input.mappings)) throw new Error('Onboarding session expired')
        const seen = new Set<string>(); const accounts = input.mappings.map((mapping) => {
          if (!mapping || typeof mapping !== 'object' || Array.isArray(mapping)) throw new Error('Invalid mapping')
          const item = mapping as Record<string, unknown>; const trueLayerId = requireString(item, 'trueLayerId'); const actualId = requireString(item, 'actualId'); const source = pending.accounts.find((account) => account.id === trueLayerId)
          if (!source || !pending.actualAccounts.some((account) => account.id === actualId) || seen.has(trueLayerId)) throw new Error('Invalid mapping')
          seen.add(trueLayerId); return { trueLayerId, actualId, friendlyName: source.label, ...(pending.type === 'cards' ? { isCard: true } : {}) }
        })
        await withActualLock(async () => {
          const { config, state } = await existingData(); const usedElsewhere = new Set(config.connections.filter((connection) => connection.name !== name).flatMap((connection) => connection.accounts.map((account) => account.actualId)))
          if (accounts.some((account) => usedElsewhere.has(account.actualId) || accounts.filter((other) => other.actualId === account.actualId).length > 1)) throw new Error('An Actual account can only be mapped once')
          await fs.mkdir(path.dirname(CONFIG_PATH), { recursive: true })
          if (pending.existingConnection) {
            const connection = config.connections.find((item) => item.name === name)
            if (!connection || !state.connections[name] || accounts.some((account) => connection.accounts.some((mapped) => mapped.trueLayerId === account.trueLayerId || mapped.actualId === account.actualId))) throw new Error('Connection changed; refresh accounts again')
            await writeConfig({ ...config, connections: config.connections.map((item) => item.name === name ? { ...item, accounts: [...item.accounts, ...accounts] } : item) })
          } else {
            if (config.connections.some((connection) => connection.name === name) || state.connections[name]) throw new Error('Connection name is already in use')
            await writeConfig({ ...config, connections: [...config.connections, { name, ...(pending.type === 'cards' ? { isCard: true } : {}), accounts }] }); await writeJSON(STATE_PATH, { ...state, connections: { ...state.connections, [name]: { refreshToken: pending.refreshToken!, accounts: {} } } })
          }
        })
        pendingConnections.delete(session); return json(res, 201, { name })
      }
      return json(res, 404, { error: 'Not found' })
    } catch { return json(res, 400, { error: 'Request failed' }) }
  }).listen(portNumber)
}
