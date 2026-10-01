// End-to-end tests for Showroom.
// Runs code.js in a mock Figma sandbox and ui.html in jsdom, against a fake Figma REST API.
// Usage: npm install && npm test
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { JSDOM } = require('jsdom')

const ROOT = path.join(__dirname, '..')
const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms))
let pass = 0, fail = 0
function check(name, cond, extra) {
  if (cond) { pass++; console.log('PASS ', name) } else { fail++; console.log('FAIL ', name, extra || '') }
}

// ---------- a fake Figma file + sandbox ----------
function makeNodeFactory(pageRef) {
  return (id, name, type, w, h) => ({
    id, name, type, width: w, height: h, parent: pageRef, _d: {},
    getSharedPluginData(ns, k) { return this._d[ns + '/' + k] || '' },
    setSharedPluginData(ns, k, v) { this._d[ns + '/' + k] = v },
    setRelaunchData(d) { this._r = d },
  })
}

function makeEnv({ fileKey, fileName = 'Holiday Emails', user = 'Bryce', store } = {}) {
  store = store || new Map()
  const nodes = new Map()
  const opened = []
  let sel = []
  const handlers = {}
  const page = { type: 'PAGE', id: '0:1', name: 'Emails', _d: {},
    getSharedPluginData(ns, k) { return this._d[ns + '/' + k] || '' }, setSharedPluginData(ns, k, v) { this._d[ns + '/' + k] = v } }
  const root = { name: fileName, children: [page], _d: {},
    getSharedPluginData(ns, k) { return this._d[ns + '/' + k] || '' }, setSharedPluginData(ns, k, v) { this._d[ns + '/' + k] = v } }
  const mkNode = makeNodeFactory(page)
  const env = { store, nodes, opened, handlers, root, page, fileKey }
  env.figma = {
    fileKey, root, currentUser: { name: user },
    currentPage: { get selection() { return sel }, set selection(v) { sel = v }, name: 'Emails', id: '0:1' },
    viewport: { scrollAndZoomIntoView() {} },
    clientStorage: {
      async getAsync(k) { await tick(1); return store.has(k) ? structuredClone(store.get(k)) : undefined },
      async setAsync(k, v) { await tick(1); store.set(k, structuredClone(v)) },
      async deleteAsync(k) { await tick(1); store.delete(k) },
      async keysAsync() { await tick(1); return [...store.keys()] },
    },
    ui: { onmessage: null, postMessage: null, resize(w, h) { env.size = [w, h] } },
    showUI() {}, notify() {}, on(ev, fn) { handlers[ev] = fn },
    openExternal(u) { opened.push(u) },
    getNodeByIdAsync: async (id) => nodes.get(id) || null,
    setCurrentPageAsync: async () => {},
  }
  env.mk = (id, name, type, w, h) => { const n = mkNode(id, name, type, w, h); nodes.set(id, n); return n }
  env.setSel = (list) => { sel = list; handlers.selectionchange && handlers.selectionchange() }
  // What the REST API would return for this file's document (root + first page plugin data).
  env.document = () => ({
    id: '0:0', type: 'DOCUMENT', name: 'Document',
    sharedPluginData: root._d['showroom/manifest'] ? { showroom: { manifest: root._d['showroom/manifest'] } } : undefined,
    children: [{ id: '0:1', type: 'CANVAS', name: 'Emails' }],
  })
  return env
}

// ---------- a fake Figma REST API ----------
function makeApi() {
  const api = { calls: [], files: {}, folders: {}, folderMeta: {}, teams: {}, subfolders: {}, fail: null, vars: {}, varsReadOnly: false }
  let nextId = 1
  // files[key] = { name, version, touched, nodes: { id: doc }, env?, versions: [...], old: { versionId: { id: doc } } }
  api.fetch = async (url, opts) => {
    await new Promise((r) => setTimeout(r, 2))
    const u = new URL(url)
    api.calls.push(u.pathname + u.search)
    if (api.fail === 'network') throw new TypeError('Failed to fetch')
    if (!opts || !opts.headers || !opts.headers['X-Figma-Token']) return resp(403, { err: 'no token' })
    const p = u.pathname
    if (p === '/v1/me') return resp(200, { handle: 'Bryce', email: 'b@x.com' })
    let m = p.match(/^\/v2\/folders\/([^/]+)\/files$/)
    if (m) {
      const f = api.folders[m[1]]; if (!f) return resp(404, { err: 'Not found' })
      return resp(200, { files: f.map((k) => ({ key: k, name: api.files[k].name, last_modified: api.files[k].touched })) })
    }
    // Variables (Team sync index): vars[fileKey] = { collections: {}, variables: {} }
    m = p.match(/^\/v1\/files\/([^/]+)\/variables(\/local)?$/)
    if (m) {
      if (!api.files[m[1]]) return resp(404, { error: true, message: 'Not found' })
      const store = api.vars[m[1]] = api.vars[m[1]] || { variableCollections: {}, variables: {} }
      if (!opts.method) return resp(200, { status: 200, meta: structuredClone(store) })
      if (api.varsReadOnly) return resp(403, { error: true, message: 'Forbidden' })
      const b = JSON.parse(opts.body); const map = {}
      for (const c of b.variableCollections || []) { const id = 'VC:' + nextId++, mode = 'M:' + nextId++; map[c.id] = id; map[c.initialModeId] = mode; store.variableCollections[id] = { id, name: c.name, defaultModeId: mode, modes: [{ modeId: mode, name: 'Mode 1' }] } }
      for (const v of b.variables || []) { const id = 'V:' + nextId++; map[v.id] = id; store.variables[id] = { id, name: v.name, variableCollectionId: map[v.variableCollectionId] || v.variableCollectionId, resolvedType: v.resolvedType, valuesByMode: {} } }
      for (const mv of b.variableModeValues || []) { const vid = map[mv.variableId] || mv.variableId; if (!store.variables[vid]) return resp(400, { error: true, message: 'bad variable' }); store.variables[vid].valuesByMode[map[mv.modeId] || mv.modeId] = mv.value }
      api.posts = (api.posts || 0) + 1
      return resp(200, { status: 200, error: false, meta: { tempIdToRealId: map } })
    }
    m = p.match(/^\/v2\/folders\/([^/]+)\/meta$/)
    if (m) { const at = api.folderMeta[m[1]]; return at ? resp(200, { id: m[1], name: 'Folder', updated_at: at }) : resp(404, { err: 'Not found' }) }
    m = p.match(/^\/v2\/folders\/([^/]+)\/folders$/)
    if (m) return resp(200, { folders: api.subfolders[m[1]] || [] })
    m = p.match(/^\/v1\/teams\/([^/]+)\/projects$/)
    if (m) return api.teams[m[1]] ? resp(200, { name: 'Marketing', projects: api.teams[m[1]] }) : resp(404, { err: 'Not found' })
    m = p.match(/^\/v2\/teams\/([^/]+)\/folders$/)
    if (m) { const t = api.teams[m[1]]; return t ? resp(200, { folders: t }) : resp(404, { err: 'Not found' }) }
    m = p.match(/^\/v1\/files\/([^/]+)\/meta$/)
    if (m) { const f = api.files[m[1]]; if (!f) return resp(404, { err: 'Not found' }); return resp(200, { file: { name: f.name, version: String(f.version), last_touched_at: f.touched, last_touched_by: { handle: 'Sam' } } }) }
    m = p.match(/^\/v1\/files\/([^/]+)\/versions$/)
    if (m) { const f = api.files[m[1]]; return resp(200, { versions: f.versions || [], pagination: {} }) }
    m = p.match(/^\/v1\/files\/([^/]+)\/nodes$/)
    if (m) { const f = api.files[m[1]]; const ids = u.searchParams.get('ids').split(','); const out = {}; ids.forEach((id) => { out[id] = f.nodes[id] ? { document: f.nodes[id] } : null }); return resp(200, { nodes: out }) }
    m = p.match(/^\/v1\/files\/([^/]+)$/)
    if (m) { const f = api.files[m[1]]; if (!f) return resp(404, { err: 'Not found' }); return resp(200, { name: f.name, document: f.env ? f.env.document() : { children: [] } }) }
    m = p.match(/^\/v1\/images\/([^/]+)$/)
    if (m) {
      const f = api.files[m[1]]; const ids = u.searchParams.get('ids').split(','); const version = u.searchParams.get('version'); const out = {}
      ids.forEach((id) => {
        const exists = version ? f.old && f.old[version] && f.old[version][id] : f.nodes[id]
        out[id] = exists ? 'https://figma-alpha-api.s3.us-west-2.amazonaws.com/images/' + m[1] + '/' + id + '/' + (version || 'v' + f.version) : null
      })
      return resp(200, { images: out })
    }
    return resp(404, { err: 'unknown ' + p })
  }
  function resp(status, body) { return { ok: status >= 200 && status < 300, status, headers: { get: () => null }, json: async () => body } }
  return api
}

// ---------- boot one plugin window ----------
async function boot(env, api, { folders, welcome } = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8')
  if (folders) html = html.replace("folders: [\n    // { id: '123456789', name: 'Email' },\n  ],", 'folders: ' + JSON.stringify(folders) + ',')
  const dom = new JSDOM(html, { runScripts: 'outside-only', pretendToBeVisual: true })
  const w = dom.window
  w.fetch = api.fetch
  w.CW_TIER1_PER_MIN = 1000
  w.parent.postMessage = (m) => { setTimeout(() => env.figma.ui.onmessage(m.pluginMessage), 0) }
  env.figma.ui.postMessage = (m) => { setTimeout(() => w.onmessage({ data: { pluginMessage: m } }), 0) }
  Object.defineProperty(w.HTMLElement.prototype, 'clientWidth', { get() { return this.id === 'viewport' ? 1200 : 0 } })
  Object.defineProperty(w.HTMLElement.prototype, 'clientHeight', { get() { return this.id === 'viewport' ? 750 : 0 } })
  w.HTMLElement.prototype.setPointerCapture = () => {}
  w.document.execCommand = () => true
  const code = fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8')
  const ctx = vm.createContext({ figma: env.figma, __html__: '', setTimeout, clearTimeout, setInterval, clearInterval, console, JSON, Promise, Date, Math, String, Object, Array, Error, encodeURIComponent })
  vm.runInContext(code, ctx)
  w.eval(html.match(/<script>([\s\S]*?)<\/script>/)[1])
  await tick(80)
  // Most tests start past the first-run setup screen.
  if (!welcome && w.document.getElementById('ob-skip')) { w.document.getElementById('ob-skip').click(); await tick(30) }
  return w
}

const $ = (w, sel) => w.document.querySelector(sel)
const click = (w, sel) => { const el = $(w, sel); if (!el) throw new Error('no element ' + sel); el.click() }
const text = (w) => w.document.getElementById('app').textContent
async function connect(w) {
  click(w, '#settings'); await tick(10)
  $(w, '#token').value = 'figd_test'
  click(w, '#test-token'); await tick(80)
  click(w, '#back'); await tick(10)
}
function pointer(w, type, target, extra) {
  const e = new w.MouseEvent(type, Object.assign({ bubbles: true, clientX: 10, clientY: 10, button: 0 }, extra || {}))
  e.pointerId = 1
  target.dispatchEvent(e)
}

;(async () => {
  const api = makeApi()
  const T0 = new Date(Date.now() - 7200e3).toISOString()

  // ===== Bryce, in "Holiday Emails" (file EMAILFILE0001) =====
  const bryce = makeEnv({ fileKey: 'EMAILFILE0001', fileName: 'Holiday Emails', user: 'Bryce' })
  api.files.EMAILFILE0001 = { name: 'Holiday Emails', version: 1, touched: T0, env: bryce,
    nodes: {
      '1:2': { id: '1:2', name: 'Email hero', absoluteBoundingBox: { x: 0, y: 0, width: 600, height: 1800 } },
      '1:3': { id: '1:3', name: 'Homepage hero', absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 720 } },
      '1:4': { id: '1:4', name: 'IG square', cornerRadius: 24, absoluteBoundingBox: { x: 0, y: 0, width: 1080, height: 1080 } },
      '1:5': { id: '1:5', name: 'Desktop', absoluteBoundingBox: { x: 0, y: 0, width: 1536, height: 864 }, absoluteRenderBounds: { x: 0, y: 0, width: 1536, height: 1600 } },
    },
    versions: [{ id: 'v200', created_at: new Date(Date.now() - 3600e3).toISOString(), label: 'Before copy edits', user: { handle: 'Sam' } },
               { id: 'v100', created_at: new Date(Date.now() - 86400e3).toISOString(), label: null, user: { handle: 'Bryce' } }],
    old: { v200: { '1:2': true }, v100: {} },
  }
  api.folders['111'] = ['EMAILFILE0001']
  const wb = await boot(bryce, api)
  check('first run: start a campaign', /Start a campaign/.test(text(wb)))
  $(wb, '#campaign-name').value = 'Holiday 2026'
  click(wb, '#create'); await tick(60)
  check('campaign created', /Holiday 2026/.test($(wb, '#campaign').textContent))

  const a = bryce.mk('1:2', 'Email hero', 'FRAME', 600, 1800)
  const b = bryce.mk('1:3', 'Homepage hero', 'FRAME', 1440, 720)
  const c = bryce.mk('1:4', 'IG square', 'FRAME', 1080, 1080)
  const t = bryce.mk('1:9', 'Some text', 'TEXT', 100, 20)
  bryce.setSel([a, b, c, t]); await tick(150)
  check('selection offers to add 3 frames', /Add 3 frames to Holiday 2026/.test(text(wb)), text(wb).slice(0, 200))
  click(wb, '#add'); await tick(80)
  const manifest = JSON.parse(bryce.root._d['showroom/manifest'])
  const cid = Object.keys(manifest.campaigns)[0]
  const mItems = manifest.campaigns[cid].items
  check('frames saved into the FILE (team-visible), with guessed channels', Object.keys(mItems).length === 3 && mItems['1:2'].channel === 'Email' && mItems['1:3'].channel === 'Site' && mItems['1:4'].channel === 'Social')
  check('who added it is recorded', mItems['1:2'].addedBy === 'Bryce')
  check('backup copy on first page', bryce.page._d['showroom/manifest'] === bryce.root._d['showroom/manifest'])
  check('nothing kept only on this computer', bryce.store.get('showroom.data').campaigns[0].items.length === 0)
  bryce.setSel([a]); await tick(150)
  check('re-select shows In campaign', /In campaign/.test(text(wb)) && /Update frame in Holiday 2026/.test(text(wb)))

  // connect + wall
  await connect(wb)
  api.calls.length = 0
  click(wb, '#open-wall'); await tick(300)
  check('wall: meta + nodes + images', api.calls.filter((x) => /\/meta$/.test(x)).length === 1 && api.calls.some((x) => /nodes/.test(x)) && api.calls.some((x) => /images/.test(x)), api.calls.join(' | '))
  check('3 images on the wall', wb.document.querySelectorAll('#world img').length === 3)
  const igTile = wb.document.querySelector('.fr[data-id="EMAILFILE0001|1:4"]')
  check('rounded frame: tile follows its corner radius, no background behind it', igTile && igTile.style.borderRadius === '24px', igTile && igTile.style.cssText)
  const tiles = () => [...wb.document.querySelectorAll('#world .fr')]
  const hero = tiles().find((f) => /Email hero/.test(f.textContent))
  check('frames at real size', hero && hero.style.width === '600px' && hero.style.height === '1800px')

  // manual refresh unchanged → no renders; content edit without version bump → caught
  api.calls.length = 0
  click(wb, '#wall-refresh'); await tick(150)
  check('manual refresh, unchanged: no renders', !api.calls.some((x) => /images/.test(x)), api.calls.join(' | '))
  api.files.EMAILFILE0001.nodes['1:3'] = { id: '1:3', name: 'Homepage hero v2', absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 800 } }
  api.calls.length = 0
  click(wb, '#wall-refresh'); await tick(150)
  check('edit caught: re-renders just that frame', api.calls.filter((x) => /images/.test(x)).length === 1 && decodeURIComponent(api.calls.find((x) => /images/.test(x))).includes('ids=1:3&'), api.calls.join(' | '))
  const site = tiles().find((f) => /Homepage hero v2/.test(f.textContent))
  check('Updated badge + new size', site && /Updated/.test(site.textContent) && site.style.height === '800px')
  click(wb, '#mark-seen'); await tick(80)
  check('Mark seen clears badges', !wb.document.querySelectorAll('#world .upd').length)

  // selection, refresh selected, double-click, multi-select, keyboard
  await tick(450)
  pointer(wb, 'pointerdown', tiles()[0]); pointer(wb, 'pointerup', tiles()[0]); await tick(10)
  check('click opens details', !$(wb, '#inspector').classList.contains('hidden'))
  await tick(450)
  pointer(wb, 'pointerdown', tiles()[1], { shiftKey: true }); pointer(wb, 'pointerup', tiles()[1], { shiftKey: true }); await tick(10)
  check('shift-click selects two', /2 frames selected/.test($(wb, '#inspector').textContent))
  api.calls.length = 0
  click(wb, '#insp-refresh'); await tick(150)
  const nodesCall = decodeURIComponent(api.calls.find((x) => /nodes/.test(x)) || '')
  const imgCall = decodeURIComponent(api.calls.find((x) => /images/.test(x)) || '')
  check('refresh selected: 1 read of all 3, re-render of the 2 picked', nodesCall.split('ids=')[1].split(',').length === 3 && imgCall.split('ids=')[1].split('&')[0].split(',').length === 2)
  wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true })); await tick(10)
  check('Ctrl+A selects all 3', /3 frames selected/.test($(wb, '#inspector').textContent))
  check('wall text unselectable', wb.document.body.classList.contains('walling'))
  wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
  bryce.figma.currentPage.selection = []
  await tick(450)
  const first = tiles()[0]
  pointer(wb, 'pointerdown', first); pointer(wb, 'pointerup', first); pointer(wb, 'pointerdown', first); pointer(wb, 'pointerup', first); await tick(40)
  check('double-click selects the frame in its file', bryce.figma.currentPage.selection.length === 1)

  // ===== history =====
  await tick(450)
  const emailTile = tiles().find((f) => /Email hero/.test(f.textContent))
  pointer(wb, 'pointerdown', emailTile); pointer(wb, 'pointerup', emailTile); await tick(10)
  api.calls.length = 0
  click(wb, '#insp-history'); await tick(80)
  check('history lists saved versions', /Before copy edits/.test($(wb, '#history').textContent) && /Autosave/.test($(wb, '#history').textContent))
  $(wb, '[data-version="v200"]').click(); await tick(80)
  const vCall = decodeURIComponent(api.calls.find((x) => /images/.test(x)) || '')
  check('picking a version renders that frame at that version', vCall.includes('version=v200') && vCall.includes('ids=1:2'), vCall)
  check('then image shown', /v200/.test(($(wb, '#history img') || {}).src || ''))
  click(wb, '#hist-now'); await tick(10)
  check('Now tab shows current image', /\/v\d+$/.test(($(wb, '#history img') || {}).src || ''))
  $(wb, '[data-version="v100"]').click(); await tick(80)
  check('frame missing in old version is explained', /didn’t exist yet/.test($(wb, '#history').textContent))
  click(wb, '#hist-then'); await tick(5)
  click(wb, '#hist-open'); await tick(40)
  check('Open version in Figma uses version-id', /version-id=v100/.test(bryce.opened[bryce.opened.length - 1] || ''), bryce.opened)
  click(wb, '#hist-close'); await tick(10)
  check('history closes', $(wb, '#history').classList.contains('hidden'))

  // ===== overflow frame =====
  click(wb, '#wall-back'); await tick(30)
  const d = bryce.mk('1:5', 'Desktop', 'FRAME', 1536, 864)
  bryce.setSel([d]); await tick(150); click(wb, '#add'); await tick(80)
  click(wb, '#open-wall'); await tick(300)
  const dt = tiles().find((f) => /Desktop/.test(f.textContent))
  check('non-clipping frame: tile uses render bounds', dt && dt.style.height === '1600px', dt && dt.style.cssText)
  check('non-clipping frame: edge marked', dt && dt.querySelector('.edge') && dt.querySelector('.edge').style.height === '864px')
  click(wb, '#wall-back'); await tick(30)

  // ===== Sam, on another computer, in a different file (ADFILE00002) =====
  const sam = makeEnv({ fileKey: 'ADFILE00002', fileName: 'Holiday Ads', user: 'Sam' })
  api.files.ADFILE00002 = { name: 'Holiday Ads', version: 1, touched: new Date().toISOString(), env: sam,
    nodes: { '7:1': { id: '7:1', name: 'MPU', absoluteBoundingBox: { x: 0, y: 0, width: 300, height: 250 } } } }
  api.files.EMAILFILE0001.touched = new Date().toISOString()
  api.folders['222'] = ['ADFILE00002']
  const ws = await boot(sam, api, { folders: [{ id: '111', name: 'Email' }, { id: '222', name: 'Ads' }] })
  $(ws, '#campaign-name') && ($(ws, '#campaign-name').value = '')
  await connect(ws); await tick(200)
  check('Sam’s search finds Bryce’s campaign', $(ws, '#campaign') && /Holiday 2026/.test($(ws, '#campaign').textContent), text(ws).slice(0, 300))
  check('search opened only the file with changes (1 read)', api.calls.filter((x) => /\/v1\/files\/EMAILFILE0001\?depth=1/.test(x)).length === 1)
  check('Sam sees Bryce’s 4 frames with who added them', /4\s*frames from 1 file/.test(text(ws)) && /added by Bryce/.test(text(ws)))
  const mpu = sam.mk('7:1', 'MPU', 'FRAME', 300, 250)
  sam.setSel([mpu]); await tick(150)
  check('Sam can add to the same campaign', /Add frame to Holiday 2026/.test(text(ws)))
  click(ws, '#add'); await tick(80)
  const samManifest = JSON.parse(sam.root._d['showroom/manifest'])
  check('Sam’s frame saved in Sam’s file under the same campaign ID', !!samManifest.campaigns[cid] && samManifest.campaigns[cid].items['7:1'].channel === 'Display ads')
  // creating a twin by name joins the existing one
  click(ws, '#new-campaign'); await tick(10)
  $(ws, '#campaign-name').value = 'holiday 2026'
  click(ws, '#create'); await tick(80)
  check('same-name campaign joins instead of duplicating', !sam.store.get('showroom.data').campaigns.some((x) => x.name === 'holiday 2026'))

  // Bryce searches and sees Sam's frame
  api.files.ADFILE00002.touched = new Date(Date.now() + 1000).toISOString()
  click(wb, '#settings'); await tick(10)
  $(wb, '#folder-link').value = 'https://www.figma.com/files/team/1/project/111/Email'
  click(wb, '#add-folder'); await tick(150)
  $(wb, '#folder-link').value = 'https://www.figma.com/files/team/1/project/222/Holiday-Ads'
  click(wb, '#add-folder'); await tick(200)
  check('folders added from links, names read from the link', /Email/.test(text(wb)) && /Holiday Ads/.test(text(wb)))
  click(wb, '#back'); await tick(20)
  check('Bryce now sees Sam’s frame', /5\s*frames from 2 files/.test(text(wb)) && /added by Sam/.test(text(wb)), text(wb).slice(0, 400))

  // Bryce removes Sam's frame → hidden only for Bryce; removes his own → removed for everyone
  const samItem = [...wb.document.querySelectorAll('[data-remove]')].find((el) => /ADFILE00002/.test(el.dataset.remove))
  samItem.click(); await tick(80)
  check('removing a frame from another file hides it for you only', bryce.store.get('showroom.data').hiddenItems[cid].length === 1 && /hidden on your wall/.test(text(wb)))
  click(wb, '#unhide-items'); await tick(80)
  check('hidden frames can be shown again', /5\s*frames/.test(text(wb)))
  const ownItem = [...wb.document.querySelectorAll('[data-remove]')].find((el) => /EMAILFILE0001\|1:4/.test(el.dataset.remove))
  ownItem.click(); await tick(80)
  check('removing a frame in this file removes it for everyone', !JSON.parse(bryce.root._d['showroom/manifest']).campaigns[cid].items['1:4'] && !c._d['showroom/campaigns'].includes(cid))

  // ===== campaign home =====
  click(wb, '#home'); await tick(20)
  const cards = [...wb.document.querySelectorAll('.ccard')]
  check('home shows each campaign as a card with frames, people and progress', cards.length >= 1 && /Holiday 2026/.test(cards[0].textContent) && /frames/.test(cards[0].textContent) && cards[0].querySelector('.avatars span') && cards[0].querySelector('.progress') && cards.some((c) => c.classList.contains('active')), cards.map((c) => c.textContent).join(' | '))
  cards.find((c) => /Holiday 2026/.test(c.textContent)).click(); await tick(30)
  check('panel shows recent activity', /Activity/.test(text(wb)) && /Sam\s*added/.test(text(wb)), text(wb).slice(0, 600))
  check('picking a card opens that campaign', $(wb, '#campaign') && /Holiday 2026/.test($(wb, '#campaign').selectedOptions[0].textContent))

  // ===== links between campaign files =====
  const bryceLinks = JSON.parse(bryce.root._d['showroom/manifest']).links || {}
  check('Bryce’s file now links to Sam’s file', !!bryceLinks.ADFILE00002 && !bryceLinks.EMAILFILE0001, JSON.stringify(bryceLinks))
  // Lee has no folders set up and opens the plugin in Bryce's file, on another computer.
  const lee = makeEnv({ fileKey: 'EMAILFILE0001', fileName: 'Holiday Emails', user: 'Lee' })
  Object.assign(lee.root._d, bryce.root._d); Object.assign(lee.page._d, bryce.page._d)
  const wl = await boot(lee, api)
  let mark = api.calls.length
  const since = () => api.calls.slice(mark)
  const reads = (key) => since().filter((x) => x.indexOf('/v1/files/' + key + '?depth') === 0).length
  await connect(wl); await tick(200)
  check('links alone find the team’s frames (no folders set up)', /4\s*frames from 2 files/.test(text(wl)) && !since().some((x) => /^\/v2\/folders/.test(x)), text(wl).slice(0, 300) + ' | ' + since().join(' | '))
  mark = api.calls.length
  await wl.showroomTest.discover({ manual: true }); await tick(20)
  check('unchanged linked file: cheap check only, not read', since().includes('/v1/files/ADFILE00002/meta') && reads('ADFILE00002') === 0, since().join(' | '))
  api.files.ADFILE00002.touched = new Date(Date.now() + 5000).toISOString()
  mark = api.calls.length
  await wl.showroomTest.discover(); await tick(20)
  check('edited linked file is read again', reads('ADFILE00002') === 1, since().join(' | '))

  // ===== folder search: Look back, daily re-check, unchanged folders =====
  api.files.PLAINFILE0004 = { name: 'Misc notes', version: 1, touched: new Date().toISOString(), nodes: {} }
  api.files.OLDFILE00005 = { name: 'Old promo', version: 1, touched: new Date(Date.now() - 60 * 86400e3).toISOString(), nodes: {} }
  api.folders['333'] = ['PLAINFILE0004', 'OLDFILE00005']
  api.folderMeta['333'] = '2026-09-01T00:00:00Z'
  click(wl, '#settings'); await tick(10)
  check('Look back defaults to 30 days', $(wl, '#look-back') && $(wl, '#look-back').value === '30')
  mark = api.calls.length
  $(wl, '#folder-link').value = 'https://www.figma.com/files/team/1/project/333/Misc'
  click(wl, '#add-folder'); await tick(200)
  check('new folder: recent file read, file older than Look back skipped', reads('PLAINFILE0004') === 1 && reads('OLDFILE00005') === 0, since().join(' | '))
  api.files.PLAINFILE0004.touched = new Date(Date.now() + 9000).toISOString()
  api.folderMeta['333'] = '2026-09-02T00:00:00Z'
  mark = api.calls.length
  await wl.showroomTest.discover(); await tick(20)
  check('edited file without campaign frames: not re-read within a day', since().includes('/v2/folders/333/files') && reads('PLAINFILE0004') === 0, since().join(' | '))
  mark = api.calls.length
  await wl.showroomTest.discover({ manual: true }); await tick(20)
  check('…but the refresh button re-reads it', reads('PLAINFILE0004') === 1, since().join(' | '))
  mark = api.calls.length
  const lookBack = $(wl, '#look-back'); lookBack.value = '90'; lookBack.dispatchEvent(new wl.Event('change')); await tick(200)
  check('longer Look back finds older files', reads('OLDFILE00005') === 1, since().join(' | '))
  check('Look back saved', (lee.store.get('showroom.prefs') || {}).lookBackDays === 90)

  // ===== team link: folders found automatically =====
  api.teams['9001'] = [{ id: '444', name: 'Social' }]
  api.subfolders['444'] = [{ id: '445', name: 'Paid social' }]
  api.files.SOCIALFILE06 = { name: 'Holiday Social', version: 1, touched: new Date().toISOString(), nodes: {} }
  api.folders['444'] = []; api.folders['445'] = ['SOCIALFILE06']
  mark = api.calls.length
  $(wl, '#team-link').value = 'https://www.figma.com/files/1205220171640458560/team/9001'
  click(wl, '#add-team'); await tick(250)
  check('team link finds its folders and subfolders', since().includes('/v2/teams/9001/folders') && reads('SOCIALFILE06') === 1 && /2 folders found/.test(text(wl)) && /Your team/.test(text(wl)), text(wl).slice(0, 200) + ' | ' + since().join(' | '))
  mark = api.calls.length
  await wl.showroomTest.discover(); await tick(20)
  check('team’s folder list is reused, not fetched every search', !since().includes('/v2/teams/9001/folders'), since().join(' | '))
  click(wl, '#back'); await tick(10)

  // ===== Team sync: a shared index in a file's variables =====
  api.files.INDEXFILE0099 = { name: 'Showroom Index', version: 1, touched: new Date().toISOString(), nodes: {} }
  const indexEntries = () => { const st = api.vars.INDEXFILE0099; return st ? Object.values(st.variables).reduce((o, v) => { o[v.name] = JSON.parse(Object.values(v.valuesByMode)[0]); return o }, {}) : {} }
  click(wb, '#settings'); await tick(10)
  $(wb, '#index-link').value = 'https://www.figma.com/design/INDEXFILE0099/Showroom-Index?node-id=0-1'
  click(wb, '#add-index'); await tick(1600)
  let entries = indexEntries()
  check('Team sync: index created with Bryce’s file and the files his search found', !!entries['f/EMAILFILE0001'] && !!entries['f/ADFILE00002'] && Object.keys(api.vars.INDEXFILE0099.variableCollections).length === 1, JSON.stringify(Object.keys(entries)))
  check('Team sync: entries hold the campaign list, without links', entries['f/ADFILE00002'] && entries['f/ADFILE00002'].campaigns[cid] && !('links' in entries['f/EMAILFILE0001']))
  check('Team sync shown as on in Settings', /On · 2 campaign files/.test(text(wb)), text(wb).slice(0, 600))
  click(wb, '#back'); await tick(10)
  // Kim: brand-new to the team, only the index file set up, plugin open in an unrelated file.
  const kim = makeEnv({ fileKey: 'KIMFILE00007', fileName: 'Kim scratch', user: 'Kim' })
  api.files.KIMFILE00007 = { name: 'Kim scratch', version: 1, touched: new Date().toISOString(), nodes: {} }
  const wk = await boot(kim, api)
  mark = api.calls.length
  await connect(wk)
  click(wk, '#settings'); await tick(10)
  $(wk, '#index-link').value = 'https://www.figma.com/design/INDEXFILE0099/Showroom-Index'
  click(wk, '#add-index'); await tick(200)
  click(wk, '#back'); await tick(20)
  check('Kim sees the team’s campaign from the index alone, without opening any design file', /frames from 2 files/.test(text(wk)) && !since().some((x) => /\?depth=1/.test(x)), text(wk).slice(0, 300) + ' | ' + since().join(' | '))
  // Sam adds a frame; it reaches Kim on her next index check (every 45 s in real use).
  click(ws, '#settings'); await tick(10)
  $(ws, '#index-link').value = 'https://www.figma.com/design/INDEXFILE0099/Showroom-Index'
  click(ws, '#add-index'); await tick(200)
  click(ws, '#back'); await tick(10)
  const mpu2 = sam.mk('7:2', 'Leaderboard', 'FRAME', 728, 90)
  sam.setSel([mpu2]); await tick(150)
  click(ws, '#add'); await tick(1600)
  await wk.showroomTest.pollIndex(); await tick(50)
  check('a frame Sam adds reaches Kim through the index', /frames from 2 files/.test(text(wk)) && entries['f/ADFILE00002'] && Object.keys(indexEntries()['f/ADFILE00002'].campaigns[cid].items).length === 2, text(wk).slice(0, 300))
  check('Kim gets a note when a teammate’s frame arrives', /Sam added/.test(wk.document.getElementById('toast').textContent), wk.document.getElementById('toast').textContent)
  const kimCount = (text(wk).match(/(\d+)\s*frames from 2 files/) || [])[1]
  check('Kim’s frame count went up by one', kimCount === '5', kimCount)
  // Someone whose token can only read: still sees the team's changes, and is told why theirs don't sync.
  api.varsReadOnly = true
  const postsBefore = api.posts
  const own = bryce.mk('1:9', 'Promo banner', 'FRAME', 600, 300)
  bryce.setSel([own]); await tick(150)
  click(wb, '#add'); await tick(1600)
  click(wb, '#settings'); await tick(10)
  check('read-only token: no write, and Settings says why', api.posts === postsBefore && /Read-only/.test(text(wb)), text(wb).slice(0, 700))
  click(wb, '#back'); await tick(10)
  api.varsReadOnly = false

  // ===== loading states: frames added while the wall is open load by themselves =====
  click(wb, '#open-wall'); await tick(400)
  const addOnSam = async (id, name, w, h) => {
    api.files.ADFILE00002.nodes[id] = { id, name, absoluteBoundingBox: { x: 0, y: 0, width: w, height: h } }
    sam.setSel([sam.mk(id, name, 'FRAME', w, h)]); await tick(150)
    click(ws, '#add'); await tick(1600)
  }
  await addOnSam('7:3', 'Skyscraper', 160, 600)
  mark = api.calls.length
  await wb.showroomTest.pollIndex(); await tick(1)
  const skyTile = () => wb.document.querySelector('.fr[data-id="ADFILE00002|7:3"]')
  check('new frame glides in with a glow and a “Sam added …” notice', skyTile() && skyTile().classList.contains('arrive') && /Sam added (Skyscraper|\d+ frames)/.test(($(wb, '#arrivals') || {}).textContent || ''), ($(wb, '#arrivals') || {}).textContent)
  check('new frame appears at once with a loading skeleton', skyTile() && skyTile().querySelector('.sk .spin') && /Waiting|Reading|Rendering/.test(skyTile().textContent), skyTile() && skyTile().innerHTML)
  await tick(300)
  check('…then loads by itself, without re-checking the other files', skyTile() && skyTile().querySelector('img') && since().some((x) => /ADFILE00002\/nodes\?ids=.*7%3A3/.test(x)) && !since().some((x) => /EMAILFILE0001\/(nodes|meta)/.test(x)), since().join(' | '))
  check('image waits to fade in until it has downloaded', skyTile() && skyTile().querySelector('img.ld') && skyTile().querySelector('.sk'))
  // A frame that arrives while the wall is busy refreshing still gets loaded afterwards.
  await addOnSam('7:4', 'Half page', 300, 600)
  click(wb, '#wall-refresh'); await tick(1)
  await wb.showroomTest.pollIndex(); await tick(500)
  check('frame added mid-refresh loads once the refresh finishes', !!wb.document.querySelector('.fr[data-id="ADFILE00002|7:4"] img'), (wb.document.querySelector('.fr[data-id="ADFILE00002|7:4"]') || {}).innerHTML)
  // ===== wall view options =====
  click(wb, '#view-opts'); await tick(10)
  check('View options opens from the cog', !$(wb, '#viewopts').classList.contains('hidden') && /Background/.test($(wb, '#viewopts').textContent))
  click(wb, '#viewopts [data-vo="bg"][data-val="dark"]'); await tick(20)
  const vp = () => $(wb, '#viewport')
  check('dark background applied and saved', vp().dataset.bg === 'dark' && (bryce.store.get('showroom.prefs').wallView || {}).bg === 'dark')
  const gridToggle = $(wb, '#viewopts [data-vo-toggle="grid"]'); gridToggle.checked = false; gridToggle.dispatchEvent(new wb.Event('change')); await tick(20)
  check('dot grid can be turned off', vp().classList.contains('no-grid'))
  click(wb, '#viewopts [data-vo="frame"][data-val="none"]'); await tick(20)
  check('frame borders can be turned off', vp().dataset.frame === 'none')
  click(wb, '#viewopts [data-vo="group"][data-val="file"]'); await tick(20)
  const heads = [...wb.document.querySelectorAll('#world .ch')].map((h) => h.firstChild.textContent)
  check('rows can be grouped by file', heads.includes('Holiday Emails') && heads.includes('Holiday Ads'), heads.join(', '))
  const adsHead = [...wb.document.querySelectorAll('#world .ch')].find((h) => /Holiday Ads/.test(h.textContent))
  pointer(wb, 'pointerdown', adsHead); pointer(wb, 'pointerup', adsHead); await tick(20)
  check('clicking a file heading selects that file’s frames', /frames selected/.test($(wb, '#inspector').textContent) && wb.document.querySelectorAll('#world .fr.sel').length === [...wb.document.querySelectorAll('#world .fr')].filter((f) => /ADFILE00002/.test(f.dataset.id)).length)
  wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
  check('Esc closes View options', $(wb, '#viewopts').classList.contains('hidden'))
  click(wb, '#view-opts'); await tick(10); click(wb, '#vo-reset'); await tick(20); click(wb, '#view-opts'); await tick(10)
  check('reset restores the defaults', vp().dataset.bg === 'auto' && !vp().classList.contains('no-grid') && vp().dataset.frame === 'border')

  {
  // ===== shortcuts, filters, present, remembered position, arranging =====
  const key = (k, extra) => { wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true }, extra || {}))); return tick(20) }
  const selIds = () => [...wb.document.querySelectorAll('#world .fr.sel')].map((f) => f.dataset.id)
  await key('Escape')
  await key('ArrowRight')
  const firstSel = selIds()
  await key('ArrowRight')
  const secondSel = selIds()
  check('arrow keys step from frame to frame', firstSel.length === 1 && secondSel.length === 1 && firstSel[0] !== secondSel[0], firstSel + ' → ' + secondSel)
  const zoomBefore = $(wb, '#zoom-val').textContent
  await key('@', { code: 'Digit2', shiftKey: true })
  check('Shift+2 zooms to the selection', $(wb, '#zoom-val').textContent !== zoomBefore, zoomBefore + ' → ' + $(wb, '#zoom-val').textContent)
  await key('?')
  check('? shows the keyboard shortcuts', !$(wb, '#shortcuts').classList.contains('hidden') && /Zoom to selection/.test($(wb, '#shortcuts').textContent))
  await key('Escape')
  // filters
  click(wb, '#filter-btn'); await tick(10)
  click(wb, '#filters [data-fk="channels"][data-fv="Display ads"]'); await tick(20)
  const tiles = () => [...wb.document.querySelectorAll('#world .fr')]
  const dimmed = tiles().filter((t) => t.classList.contains('dim'))
  check('filtering by channel fades the other frames', dimmed.length > 0 && dimmed.every((t) => /EMAILFILE0001/.test(t.dataset.id)) && /Showing \d+ of \d+/.test($(wb, '#filterpill').textContent), $(wb, '#filterpill') && $(wb, '#filterpill').textContent)
  await key('a', { ctrlKey: true })
  check('Select all only picks frames that match the filter', selIds().length > 0 && selIds().every((id) => /ADFILE00002/.test(id)), selIds().join(','))
  pointer(wb, 'pointerdown', $(wb, '#fp-clear')); pointer(wb, 'pointerup', $(wb, '#fp-clear'))
  click(wb, '#fp-clear'); await tick(20)
  check('clearing filters brings everything back', !wb.document.querySelector('#world .fr.dim') && !$(wb, '#filterpill'))
  // present (Esc closes the filter box, then clears the selection)
  await key('Escape'); await key('Escape')
  await key('p')
  check('P starts Present mode at the first frame', wb.document.body.classList.contains('presenting') && /^1 \/ \d+/.test($(wb, '#hud-what').textContent), $(wb, '#hud') && $(wb, '#hud').textContent)
  await key('ArrowRight')
  check('arrow keys move through Present mode', /^2 \/ \d+/.test($(wb, '#hud-what').textContent) && wb.document.querySelectorAll('#world .fr.cur').length === 1)
  pointer(wb, 'pointerdown', $(wb, '#hud-next')); pointer(wb, 'pointerup', $(wb, '#hud-next')); click(wb, '#hud-next'); await tick(20)
  check('Present controls respond to clicks', /^3 \/ \d+/.test($(wb, '#hud-what').textContent), $(wb, '#hud-what').textContent)
  await key('Escape')
  check('Esc leaves Present mode', !wb.document.body.classList.contains('presenting') && !$(wb, '#hud'))
  // remembered position
  click(wb, '#zoom-in'); click(wb, '#zoom-in'); await tick(900)
  const zoomSaved = $(wb, '#zoom-val').textContent
  const cidNow = bryce.store.get('showroom.data').activeCampaignId || cid
  check('wall position is saved per campaign', !!((bryce.store.get('showroom.prefs').wallPos || {})[cidNow]))
  click(wb, '#wall-back'); await tick(30); click(wb, '#open-wall'); await tick(300)
  check('reopening the wall returns to where you were', $(wb, '#zoom-val').textContent === zoomSaved, zoomSaved + ' vs ' + $(wb, '#zoom-val').textContent)
  // drag to arrange: move "Homepage hero" after "Desktop" in the Site row
  const tf = () => { const m = $(wb, '#world').style.transform.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([-\d.]+)\)/); return { tx: +m[1], ty: +m[2], z: +m[3] } }
  const tileOf = (id) => wb.document.querySelector('.fr[data-id="' + id + '"]')
  const box = (el) => ({ x: parseFloat(el.style.left), y: parseFloat(el.style.top), w: parseFloat(el.style.width), h: parseFloat(el.style.height) })
  const home = tileOf('EMAILFILE0001|1:3'), desk = tileOf('EMAILFILE0001|1:5')
  const T = tf(), hb = box(home), db = box(desk)
  const at = (b, fx) => ({ clientX: (b.x + b.w * fx) * T.z + T.tx, clientY: (b.y + b.h / 2) * T.z + T.ty })
  check('Homepage hero starts before Desktop', hb.x < db.x, hb.x + ' / ' + db.x)
  pointer(wb, 'pointerdown', home, at(hb, 0.5))
  pointer(wb, 'pointermove', $(wb, '#viewport'), at(db, 0.5))
  pointer(wb, 'pointermove', $(wb, '#viewport'), at(db, 0.9))
  check('dragging shows where the frame will land', !!wb.document.querySelector('#world .drop-line') && tileOf('EMAILFILE0001|1:3').classList.contains('dragging'))
  pointer(wb, 'pointerup', $(wb, '#viewport'), at(db, 0.9)); await tick(120)
  check('dropping moves the frame within its row', box(tileOf('EMAILFILE0001|1:3')).x > box(tileOf('EMAILFILE0001|1:5')).x)
  const layoutSaved = (JSON.parse(bryce.root._d['showroom/manifest']).layouts || {})[cidNow]
  check('the new order is saved in the file for the team', layoutSaved && layoutSaved.order.indexOf('EMAILFILE0001|1:3') > layoutSaved.order.indexOf('EMAILFILE0001|1:5'), JSON.stringify(layoutSaved))
  const emptyAt = { clientX: 5, clientY: 700 }
  const before2 = $(wb, '#world').style.transform
  pointer(wb, 'pointerdown', $(wb, '#viewport'), emptyAt); pointer(wb, 'pointermove', $(wb, '#viewport'), { clientX: 60, clientY: 720 }); pointer(wb, 'pointerup', $(wb, '#viewport'), { clientX: 60, clientY: 720 }); await tick(10)
  check('dragging empty space still pans', $(wb, '#world').style.transform !== before2)
  // review statuses
  const tapTile = (w, id) => { const el = w.document.querySelector('.fr[data-id="' + id + '"]'); pointer(w, 'pointerdown', el); pointer(w, 'pointerup', el) }
  await key('Escape'); await key('Escape')
  tapTile(wb, 'EMAILFILE0001|1:2'); await tick(20)
  click(wb, '#inspector [data-status="review"]'); await tick(80)
  check('status can be set from the wall and shows on the frame', !!wb.document.querySelector('.fr[data-id="EMAILFILE0001|1:2"] .st-review'))
  const savedSt = ((JSON.parse(bryce.root._d['showroom/manifest']).statuses || {})[cidNow] || {})['EMAILFILE0001|1:2']
  check('status is saved in the file for the team', savedSt && savedSt.s === 'review', JSON.stringify(savedSt))
  click(wb, '#filter-btn'); await tick(10)
  click(wb, '#filters [data-fk="statuses"][data-fv="In review"]'); await tick(20)
  const undimmed = [...wb.document.querySelectorAll('#world .fr:not(.dim)')].map((t) => t.dataset.id)
  check('filter by status', undimmed.length === 1 && undimmed[0] === 'EMAILFILE0001|1:2', undimmed.join(','))
  click(wb, '#fp-clear'); await tick(20); await key('Escape')
  // Sam approves his own frame from his wall; it reaches Bryce through Team sync.
  click(ws, '#open-wall'); await tick(400)
  tapTile(ws, 'ADFILE00002|7:1'); await tick(20)
  click(ws, '#inspector [data-status="approved"]'); await tick(1600)
  click(ws, '#wall-back'); await tick(30)
  await wb.showroomTest.pollIndex(); await tick(50)
  check('a teammate’s status change shows up', !!wb.document.querySelector('.fr[data-id="ADFILE00002|7:1"] .st-approved'))
  }
  click(wb, '#wall-back'); await tick(30)

  // ===== first-run setup =====
  {
    const api2 = makeApi()
    const newbie = makeEnv({ fileKey: 'WELCOMEFILE01', fileName: 'Spring Site', user: 'Ana' })
    api2.files.WELCOMEFILE01 = { name: 'Spring Site', version: 1, touched: new Date().toISOString(), nodes: {}, env: newbie, versions: [] }
    const wn = await boot(newbie, api2, { welcome: true })
    check('first run opens the setup guide with three steps', /Welcome to Showroom/.test(text(wn)) && wn.document.querySelectorAll('.ob-step').length === 3)
    check('Start is disabled until Figma is connected', $(wn, '#ob-start').disabled)
    $(wn, '#ob-token').value = 'figd_new'
    click(wn, '#ob-connect'); await tick(250)
    const okRows = [...wn.document.querySelectorAll('.scopes .sc.ok')].map((r) => r.textContent)
    check('connecting checks each permission separately', okRows.length === 4 && /File info/.test(okRows.join()) && /Version history/.test(okRows.join()) && wn.document.querySelectorAll('.scopes .sc.skip').length === 2, okRows.join(' | '))
    check('step 1 shows as done', wn.document.querySelector('.ob-step').classList.contains('done') && /Connected as/.test(text(wn)))
    click(wn, '#ob-start'); await tick(40)
    check('finishing setup goes to the panel and is remembered', /Start a campaign/.test(text(wn)) && newbie.store.get('showroom.prefs').onboarded === true)
    click(wn, '#settings'); await tick(10); click(wn, '#open-guide'); await tick(200)
    check('the setup guide can be reopened from Settings', /Welcome to Showroom/.test(text(wn)))
  }

  // ===== carry-over from the Campaign Wall test builds =====
  const oldStore = new Map()
  oldStore.set('cw.token', 'figd_old')
  oldStore.set('cw.prefs.v1', { wallSize: { width: 1400, height: 900 }, folders: [{ id: '111', name: 'Email' }] })
  oldStore.set('cw.data.v1', { version: 1, campaigns: [{ id: 'c_old', name: 'Old campaign', items: [{ id: 'X|1:1', fileKey: 'X', nodeId: '1:1', name: 'Old', channel: 'Site' }] }] })
  oldStore.set('cw.cache.v1', { files: {} })
  const fresh = makeEnv({ fileKey: 'NEWFILE00001', fileName: 'New file', store: oldStore })
  const wf = await boot(fresh, makeApi())
  await tick(100)
  check('old token and preferences carry over', oldStore.get('showroom.token') === 'figd_old' && oldStore.get('showroom.prefs').folders.length === 1)
  check('old campaigns and caches are cleared', !oldStore.has('cw.data.v1') && !oldStore.has('cw.cache.v1') && !oldStore.has('cw.token'))
  check('starts fresh', /Start a campaign/.test(text(wf)))

  // ===== two windows on one computer =====
  const winA = makeEnv({ fileKey: 'EMAILFILE0001', store: new Map() })
  const winB = makeEnv({ fileKey: 'ADFILE00002', store: winA.store })
  const wA = await boot(winA, api)
  $(wA, '#campaign-name').value = 'Shared'; click(wA, '#create'); await tick(80)
  const wB = await boot(winB, api)
  await tick(3300)
  check('window B picks up a campaign created in window A', /Shared/.test(($(wB, '#campaign') || {}).textContent || ''))

  // ===== network failure =====
  api.fail = 'network'
  click(wb, '#open-wall'); await tick(200)
  check('network error banner', /Couldn’t reach Figma’s API/.test($(wb, '#banner').textContent))
  api.fail = null

  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
