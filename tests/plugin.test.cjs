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
    getSharedPluginData(ns, k) { return this._d[ns + '/' + k] || '' }, setSharedPluginData(ns, k, v) { this._d[ns + '/' + k] = v },
    setRelaunchData(d) { this._r = d } }
  const mkNode = makeNodeFactory(page)
  const env = { store, nodes, opened, handlers, root, page, fileKey }
  env.figma = {
    fileKey, root, currentUser: { name: user, photoUrl: 'https://s3-alpha.figma.com/profile/' + user },
    currentPage: { get selection() { return sel }, set selection(v) { sel = v }, name: 'Emails', id: '0:1' },
    viewport: { scrollAndZoomIntoView() {} },
    clientStorage: {
      async getAsync(k) { await tick(1); return store.has(k) ? structuredClone(store.get(k)) : undefined },
      async setAsync(k, v) { await tick(1); store.set(k, structuredClone(v)) },
      async deleteAsync(k) { await tick(1); store.delete(k) },
      async keysAsync() { await tick(1); return [...store.keys()] },
    },
    ui: { onmessage: null, postMessage: null, resize(w, h) { env.size = [w, h] } },
    showUI(h, o) { env.shown = o || {} }, notify(m) { (env.notes = env.notes || []).push(m) }, closePlugin() { env.closed = true }, on(ev, fn) { handlers[ev] = fn },
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
    if (m) { const f = api.files[m[1]]; const ids = u.searchParams.get('ids').split(','); const out = {}; ids.forEach((id) => { out[id] = f.nodes[id] ? Object.assign({ document: f.nodes[id] }, f.components ? { components: f.components, componentSets: f.componentSets || {} } : {}) : null }); return resp(200, { nodes: out }) }
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
async function boot(env, api, { folders, welcome, presets } = {}) {
  let html = fs.readFileSync(path.join(ROOT, 'ui.html'), 'utf8')
  if (presets) html = html.replace('const TEAM_PRESETS = [\n]', 'const TEAM_PRESETS = ' + JSON.stringify(presets))
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
const cssEscT = (v) => String(v).replace(/["\\]/g, '\\$&')
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
  check('first run: start with a tag', /Start with a tag/.test(text(wb)))
  $(wb, '#campaign-name').value = 'Holiday 2026'
  click(wb, '#create'); await tick(60)
  check('tag created', /Holiday 2026/.test($(wb, '#view-pick').textContent))

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
  check('re-select shows its tag, with Update', !!wb.document.querySelector('.tagchip [data-tag-go]') && /Holiday 2026/.test($(wb, '.tagbox').textContent) && /Update frame/.test(text(wb)) && !$(wb, '#add'))
  check('the file gets an “Open Showroom” button in Figma’s properties panel for when nothing is selected', bryce.root._r && 'open-panel' in bryce.root._r, JSON.stringify(bryce.root._r))
  check('a tagged frame gets “Open in Showroom” / “Edit tags” in Figma’s properties panel, with its tag names', a._r && a._r.open === 'Holiday 2026' && 'tags' in a._r, JSON.stringify(a._r))
  // A second tag, typed into the panel (no wall needed)
  $(wb, '#tag-add').value = 'Black Friday'
  $(wb, '#tag-add').dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(120)
  const m2 = JSON.parse(bryce.root._d['showroom/manifest'])
  const bf = Object.keys(m2.campaigns).find((k) => m2.campaigns[k].name === 'Black Friday')
  check('typing a new tag adds it to the selection, keeping the channel and the active tag', bf && m2.campaigns[bf].items['1:2'] && m2.campaigns[bf].items['1:2'].channel === 'Email' && /Holiday 2026/.test($(wb, '#view-pick').textContent) && a._r.open === 'Holiday 2026, Black Friday', JSON.stringify(a._r))
  check('the panel shows both tags on the frame', wb.document.querySelectorAll('.tagbox .tagchip').length === 2)
  click(wb, '.tagchip [data-tag-del="' + bf + '"]'); await tick(120)
  const m3 = JSON.parse(bryce.root._d['showroom/manifest'])
  check('× takes a tag off the selected frame, right from the panel', !m3.campaigns[bf] && wb.document.querySelectorAll('.tagbox .tagchip').length === 1 && a._r.open === 'Holiday 2026', JSON.stringify(Object.keys(m3.campaigns)))

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
  {
    // Shift-drag a selection box: frames light up while dragging, then get selected.
    const vpEl = $(wb, '#viewport')
    pointer(wb, 'pointerdown', vpEl, { shiftKey: true, clientX: -100000, clientY: -100000 })
    pointer(wb, 'pointermove', vpEl, { shiftKey: true, clientX: 100000, clientY: 100000 })
    const lit = wb.document.querySelectorAll('#world .fr.willsel').length
    pointer(wb, 'pointerup', vpEl, { shiftKey: true, clientX: 100000, clientY: 100000 }); await tick(10)
    check('a Shift-drag box highlights the frames it touches, then selects them', lit === tiles().length && !wb.document.querySelector('#world .fr.willsel') && wb.document.querySelectorAll('#world .fr.sel').length === lit, lit + ' lit')
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
  }
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
  check('Sam’s search finds Bryce’s campaign', $(ws, '#view-pick') && /Holiday 2026/.test($(ws, '#view-pick').textContent), text(ws).slice(0, 300))
  check('search opened only the file with changes (1 read)', api.calls.filter((x) => /\/v1\/files\/EMAILFILE0001\?depth=1/.test(x)).length === 1)
  check('Sam sees Bryce’s 4 frames with who added them', /4\s*frames from 1 file/.test(text(ws)) && [...ws.document.querySelectorAll('.fr-mt')].some((el) => /by Bryce/.test(el.textContent)))
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
  check('Bryce now sees Sam’s frame', /5\s*frames from 2 files/.test(text(wb)) && [...wb.document.querySelectorAll('.fr-mt')].some((el) => /by Sam/.test(el.textContent)) && ![...wb.document.querySelectorAll('.fr-mt')].some((el) => /by Bryce/.test(el.textContent)), text(wb).slice(0, 400))

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
  const hcard = cards.find((c) => /Holiday 2026/.test(c.querySelector('.name').textContent))
  check('home shows each tag as a card with frames, people and progress', hcard && /frames/.test(hcard.textContent) && hcard.querySelector('.avatars span') && hcard.querySelector('.progress') && cards.some((c) => c.classList.contains('active')), cards.map((c) => c.textContent).join(' | '))
  check('…plus “All tagged frames” first, once there’s more than one tag', /All tagged frames/.test(cards[0].querySelector('.name').textContent) && cards[0].dataset.campaign === '__all')
  cards.find((c) => /Holiday 2026/.test(c.textContent)).click(); await tick(30)
  check('activity shows people’s Figma profile pictures', !!wb.document.querySelector('.activity img[src*="profile/Sam"]'))
  check('panel shows recent activity', /Activity/.test(text(wb)) && /Sam\s*added/.test(text(wb)), text(wb).slice(0, 600))
  check('picking a card opens that tag', $(wb, '#view-pick') && /Holiday 2026/.test($(wb, '#view-pick').textContent))

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
  check('Team sync shown as on in Settings', /On · 2 tagged files/.test(text(wb)), text(wb).slice(0, 600))
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
  // Clusters within rows
  const caps = () => [...wb.document.querySelectorAll('#world .sec-t')].map((s) => s.textContent)
  console.log('   file rows, clusters:', caps().join(', '))
  check('file rows cluster their frames by channel, in Figma-style sections', caps().length >= 2 && caps().includes('Email'), caps().join(', '))
  const secT = [...wb.document.querySelectorAll('#world .sec-t')].find((t) => t.textContent === 'Email')
  pointer(wb, 'pointerdown', secT); pointer(wb, 'pointerup', secT); await tick(20)
  check('clicking a section’s name selects the frames in it', wb.document.querySelectorAll('#world .fr.sel').length >= 1 && /^Select the (\d+) frame/.test(secT.title) && wb.document.querySelectorAll('#world .fr.sel').length === Number(secT.title.match(/\d+/)[0]), secT.title)
  click(wb, '#view-opts'); await tick(10)
  click(wb, '#viewopts [data-vo="subFile"][data-val="off"]'); await tick(20)
  check('clustering can be turned off', caps().length === 0 && (bryce.store.get('showroom.prefs').wallView || {}).subFile === 'off')
  click(wb, '#viewopts [data-vo="group"][data-val="channel"]'); await tick(20)
  check('the cluster option follows the grouping', /Cluster within channel rows by/.test($(wb, '#viewopts').textContent) && !!$(wb, '#viewopts [data-vo="subChannel"][data-val="filepage"]') && $(wb, '#viewopts [data-vo="subChannel"][data-val="file"]').classList.contains('on'))
  wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
  check('Esc closes View options', $(wb, '#viewopts').classList.contains('hidden'))
  // ===== device frames in Present =====
  {
    const t = wb.showroomTest
    const it = (name, channel, w, h, extra) => Object.assign({ id: 'X|' + name, fileKey: 'X', nodeId: name, name: name, channel: channel, width: w, height: h }, extra || {})
    check('auto device: a wide Site page gets a browser, a narrow one a phone', t.autoDevice(it('Desktop', 'Site', 1440, 3000)).d === 'browser' && t.autoDevice(it('Mobile home', 'Site', 390, 2400)).d === 'phone')
    check('auto device: page parts and other channels get none', t.autoDevice(it('PLP banner - D - section-category-tall', 'Site', 1440, 730)).d === 'none' &&
      t.autoDevice(it('In-Gallery Ad', 'Site', 390, 700)).d === 'none' && t.autoDevice(it('Gift guide', 'Email', 600, 2000)).d === 'none' && t.autoDevice(it('Strip', 'Site', 1440, 300)).d === 'none')
    const box = (x, y, w, h) => ({ x: x, y: y, width: w, height: h })
    const doc = { absoluteBoundingBox: box(100, 100, 1440, 4000), children: [
      { id: '9:1', name: 'Global Header / Desktop', absoluteBoundingBox: box(100, 100, 1440, 120) },
      { id: '9:2', name: 'Hero', absoluteBoundingBox: box(100, 220, 1440, 700) },
      { id: '9:3', name: 'Footer', absoluteBoundingBox: box(100, 3700, 1440, 400) } ] }
    const parts = t.pageParts(doc)
    check('a header layer across the top and a footer are recognised', parts.hdr && parts.hdr.id === '9:1' && parts.hdr.h === 120 && parts.ftr === true, JSON.stringify(parts))
    check('…inside a single wrapper too, but not a narrow or low "nav"', t.pageParts({ absoluteBoundingBox: box(0, 0, 390, 2000), children: [{ id: 'w', name: 'Content', absoluteBoundingBox: box(0, 0, 390, 2000), children: [{ id: 'h', name: 'Header', absoluteBoundingBox: box(0, 0, 390, 60) }] }] }).hdr.id === 'h' &&
      !t.pageParts({ absoluteBoundingBox: box(0, 0, 1440, 2000), children: [{ id: 'n', name: 'Side nav', absoluteBoundingBox: box(0, 0, 300, 2000) }, { id: 'n2', name: 'Nav', absoluteBoundingBox: box(0, 900, 1440, 80) }] }).hdr)
    // Headers and footers are also recognised by the component they're an instance of, whatever the layer is called.
    const comps = { components: { 'C:1': { name: 'Breakpoint=Desktop', componentSetId: 'S:1' }, 'C:2': { name: 'Site Footer' }, 'C:3': { name: 'Button' } }, componentSets: { 'S:1': { name: 'Global Header' } } }
    const renamed = { absoluteBoundingBox: box(0, 0, 1440, 3000), children: [
      { id: 'h1', name: 'Frame 427', type: 'INSTANCE', componentId: 'C:1', absoluteBoundingBox: box(0, 0, 1440, 100) },
      { id: 'f1', name: 'Group 12', type: 'INSTANCE', componentId: 'C:2', absoluteBoundingBox: box(0, 2700, 1440, 300) } ] }
    const pc = t.pageParts(renamed, comps)
    check('a renamed header or footer is recognised by its component (or component set)', pc.hdr && pc.hdr.id === 'h1' && pc.hdr.comp === 'Global Header' && pc.ftr === true && pc.ftrComp === 'Site Footer', JSON.stringify(pc))
    check('…but not without the component list, or for an unrelated component', !t.pageParts(renamed).hdr &&
      !t.pageParts({ absoluteBoundingBox: box(0, 0, 1440, 3000), children: [{ id: 'b', name: 'Frame 9', type: 'INSTANCE', componentId: 'C:3', absoluteBoundingBox: box(0, 0, 1440, 100) }] }, comps).hdr)
    // Make Bryce's "Desktop" frame a long page, then present it.
    api.files.EMAILFILE0001.nodes['1:5'] = { id: '1:5', name: 'Desktop hero', absoluteBoundingBox: { x: 0, y: 0, width: 1536, height: 3200 },
      children: [{ id: '1:50', name: 'Global Header', absoluteBoundingBox: { x: 0, y: 0, width: 1536, height: 110 } }] }
    api.files.EMAILFILE0001.nodes['1:50'] = { id: '1:50', name: 'Global Header', absoluteBoundingBox: { x: 0, y: 0, width: 1536, height: 110 } }
    const tile = () => wb.document.querySelector('#world .fr[data-id="EMAILFILE0001|1:5"]')
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#insp-refresh'); await tick(600)
    check('frame details offer a device choice, showing what Auto picks and why', !!$(wb, '#inspector [data-device="phone"]') && /Auto: browser \(1536 px wide, it has a header layer\)/.test($(wb, '#inspector').textContent), $(wb, '#inspector').textContent)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'p', bubbles: true })); await tick(100)
    const pageY = () => { const pg = wb.document.querySelector('#dev .dv-page'); const m = pg && /translateY\((-?[\d.]+)px\)/.exec(pg.style.transform); return m ? -Number(m[1]) : null }
    check('Present shows a long Site page in a browser window', !!wb.document.querySelector('#dev .dv-browser') && pageY() === 0, ($(wb, '#dev') || {}).innerHTML)
    const idxBefore = $(wb, '#hud-what').textContent
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true })); await tick(20)
    check('↓ scrolls the page inside the browser instead of moving on', pageY() > 0 && $(wb, '#hud-what').textContent === idxBefore, pageY() + ' ' + $(wb, '#hud-what').textContent)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true })); await tick(20)
    check('↑ scrolls back up', pageY() === 0)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    check('leaving Present removes the device', !$(wb, '#dev'))
    // The same page with its header renamed: Auto still finds it through the component, and says so.
    api.files.EMAILFILE0001.nodes['1:5'].children = [{ id: '1:50', name: 'Frame 427', type: 'INSTANCE', componentId: 'C:9', absoluteBoundingBox: { x: 0, y: 0, width: 1536, height: 110 } }]
    api.files.EMAILFILE0001.components = { 'C:9': { name: 'Breakpoint=Desktop', componentSetId: 'S:9' } }
    api.files.EMAILFILE0001.componentSets = { 'S:9': { name: 'Global Header' } }
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#insp-refresh'); await tick(600)
    check('Auto names the header component it found', /Auto: browser \(1536 px wide, it has the “Global Header” component\)/.test($(wb, '#inspector').textContent), $(wb, '#inspector').textContent)
    // A viewport-sized frame with the rest of the page spilling out below it (not clipped), and an orange fill.
    Object.assign(api.files.EMAILFILE0001.nodes['1:5'], { absoluteBoundingBox: { x: 0, y: 0, width: 1536, height: 864 }, absoluteRenderBounds: { x: 0, y: 0, width: 1536, height: 3000 },
      fills: [{ type: 'SOLID', color: { r: 1, g: 0.5, b: 0, a: 1 } }] })
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#insp-refresh'); await tick(600)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'p', bubbles: true })); await tick(100)
    const view = wb.document.querySelector('#dev .dv-view'), pg = wb.document.querySelector('#dev .dv-page')
    check('content spilling below a frame scrolls in Present: a real 16:9 window (864 with its bars), the page is everything', view && view.style.height === (864 - 88) + 'px' && pg.style.height === '3000px' && /255, 128, 0/.test(view.style.background), view && view.outerHTML.slice(0, 200))
    const wheel = (opts) => $(wb, '#viewport').dispatchEvent(new wb.WheelEvent('wheel', Object.assign({ bubbles: true, cancelable: true }, opts)))
    wheel({ deltaY: 300 }); await tick(10)
    const y1 = pageY()
    wheel({ deltaY: 3, deltaMode: 1 }); await tick(10)
    check('a mouse wheel scrolls it, anywhere over Present (pixels or lines)', y1 > 0 && pageY() > y1, y1 + ' → ' + pageY())
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    const dv = wb.showroomTest.deviceView
    check('device heights: real screens by default, whole screen-sized frames as an option, long pages a real screen either way',
      dv('phone', 390, 844, 2400, false, 'real') === 678 && dv('phone', 390, 844, 2400, false, 'frame') === 844 && dv('phone', 390, 600, 600, false, 'real') === 600 &&
      dv('phone', 390, 3000, 3000, false, 'frame') === 678 && dv('browser', 1536, 864, 3000, false, 'real') === 776 && dv('phone', 390, 844, 2400, true, 'real') === 844)
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="deviceHeight"][data-val="frame"]'); await tick(20)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'p', bubbles: true })); await tick(100)
    check('View options › “Whole frame” shows a screen-sized frame whole in Present', (wb.document.querySelector('#dev .dv-view') || {}).style.height === '864px' && (bryce.store.get('showroom.prefs').wallView || {}).deviceHeight === 'frame')
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="deviceHeight"][data-val="real"]'); await tick(20)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    // A prototype frame with a device plays inside it in Present.
    api.files.EMAILFILE0001.nodes['1:5'].interactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '9:9' }] }]
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#insp-refresh'); await tick(600)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'p', bubbles: true })); await tick(600)
    const devFrame = wb.document.querySelector('#dev .dv-browser .dv-live iframe')
    check('a prototype frame plays live inside its browser window in Present', !!devFrame && /scaling%3Dmin-zoom/.test(devFrame.src) && !wb.document.querySelector('#live .lv') && /Live prototype/.test($(wb, '#hud-what').textContent), ($(wb, '#dev') || {}).innerHTML)
    check('…showing the whole frame (the window is the frame’s height)', wb.document.querySelector('#dev .dv-view').style.height === '864px')
    click(wb, '#hud-play'); await tick(20)
    check('the HUD’s ■ stops the prototype and shows the page again', !$(wb, '#hud-play').classList.contains('hidden') && !wb.document.querySelector('#dev .dv-live') && !!wb.document.querySelector('#dev .dv-page') && /Prototype/.test($(wb, '#hud-what').textContent) && !/Live/.test($(wb, '#hud-what').textContent) && /Play/.test($(wb, '#hud-play').title))
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'k', bubbles: true })); await tick(20)
    check('…and K (or ▶) plays it again', !!wb.document.querySelector('#dev .dv-live iframe') && /Stop/.test($(wb, '#hud-play').title))
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    delete api.files.EMAILFILE0001.nodes['1:5'].interactions
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#insp-refresh'); await tick(600)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    // Device chrome on the wall too
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="devicePresent"][data-val="wall"]'); await tick(30)
    check('“Wall too” puts browser chrome around Site pages on the wall, with room above for it', tile().classList.contains('wdv-on') && !!tile().querySelector('.wdv-browser') && /--dvt:\s*88px/.test(tile().getAttribute('style')), tile().getAttribute('style'))
    click(wb, '#viewopts [data-vo="devicePresent"][data-val="on"]'); await tick(30)
    check('…and goes away again', !tile().classList.contains('wdv-on'))
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    // Choose "Phone" for it: saved in the file for the team, and Present follows.
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#inspector [data-device="phone"]'); await tick(150)
    const m = JSON.parse(bryce.figma.root.getSharedPluginData('showroom', 'manifest') || '{}')
    const saved = m.devices && Object.values(m.devices).some((cd) => cd['EMAILFILE0001|1:5'] && cd['EMAILFILE0001|1:5'].d === 'phone')
    check('a device choice is saved in the file for the team', saved, JSON.stringify(m.devices))
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'p', bubbles: true })); await tick(100)
    check('…and Present uses it', !!wb.document.querySelector('#dev .dv-phone'))
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="devicePresent"][data-val="wall"]'); await tick(30)
    const ph = tile().querySelector('.wdv-phone'), bgEl = tile().querySelector('.wdv-bg')
    check('on the wall the phone is a normal height, lying over the page, which runs on below it', ph && ph.style.height === (68 + Math.round(1536 * 2.164) - 166 + 126) + 'px' && ph.style.top === '-68px' &&
      /--dvt:\s*68px/.test(tile().getAttribute('style')) && !/border-radius/.test(tile().getAttribute('style')) && bgEl && /255, 128, 0/.test(bgEl.style.background), ph && ph.outerHTML.slice(0, 160))
    click(wb, '#viewopts [data-vo="devicePresent"][data-val="on"]'); await tick(30)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#inspector [data-device="auto"]'); await tick(150)
    // Devices on the wall + hidden outside content: the browser window is the frame; the rest of the page scrolls inside it.
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="devicePresent"][data-val="wall"]'); await tick(30)
    click(wb, '#viewopts [data-vo="outside"][data-val="hide"]'); await tick(30)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    const full = Math.round(1536 * 0.5625) - 88
    check('with Hide, a page in a browser on the wall is cropped to a real browser window', tile().style.height === full + 'px' && !!tile().querySelector('.crop img') && !!tile().querySelector('.wsb'), tile().getAttribute('style'))
    const imgTop = () => parseFloat(tile().querySelector('.crop img').style.top)
    const wheelOn = (el) => el.dispatchEvent(new wb.WheelEvent('wheel', { deltaY: 200, bubbles: true, cancelable: true }))
    wheelOn(tile().querySelector('.crop img')); await tick(10)
    check('…scrolling over it does nothing until it’s selected (the wall pans)', imgTop() === 0)
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    wheelOn(tile().querySelector('.crop img')); await tick(10)
    check('…and once selected, the wheel scrolls the page inside the window', imgTop() < 0 && /hidden below/.test($(wb, '#inspector').textContent), imgTop())
    const worldT = () => $(wb, '#world').style.transform
    for (let i = 0; i < 30; i++) wheelOn(tile().querySelector('.crop img'))
    await tick(10)
    const atEnd = worldT()
    wheelOn(tile().querySelector('.crop img')); await tick(10)
    check('…and at the end of the page it holds still instead of panning the wall', worldT() === atEnd && imgTop() <= -(3000 - full) + 1, imgTop())
    const lb = wb.showroomTest.liveBox(wb.showroomTest.placementOf('EMAILFILE0001|1:5'))
    check('a prototype played on the wall stays inside its browser window', lb.dev === 'browser' && lb.h === full && lb.top === 88, JSON.stringify(lb))
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="outside"][data-val="fade"]'); await tick(30)
    check('with Fade, the page below the browser window fades', !!tile().querySelector('.wdv-fd'))
    click(wb, '#viewopts [data-vo="devicePresent"][data-val="on"]'); await tick(30)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
  }

  // ===== live prototypes =====
  {
    const tile0 = wb.document.querySelector('#world .fr')
    const [fk, nid] = tile0.dataset.id.split('|')
    // Give that frame a prototype connection, then reload it from its file.
    api.files[fk].nodes[nid].interactions = [{ trigger: { type: 'ON_CLICK' }, actions: [{ type: 'NODE', destinationId: '9:9' }] }]
    pointer(wb, 'pointerdown', tile0); pointer(wb, 'pointerup', tile0); await tick(450)
    click(wb, '#insp-refresh'); await tick(600)
    const tile = () => wb.document.querySelector('#world .fr[data-id="' + fk + '|' + nid + '"]')
    const others = [...wb.document.querySelectorAll('#world .fr .pb')].length
    check('frames with prototype connections get a ▶ badge (and others don’t)', !!(tile() && tile().querySelector('.pb')) && others === 1, 'badges: ' + others)
    const pb = tile().querySelector('.pb')
    pointer(wb, 'pointerdown', pb); pointer(wb, 'pointerup', pb); await tick(30)
    const frameEl = () => wb.document.querySelector('#live .lv iframe')
    const src = () => (frameEl() || {}).src || ''
    check('▶ plays the live prototype in place, in the clean embed by default', !!frameEl() && src().indexOf('https://www.figma.com/embed?embed_host=showroom&url=') === 0 && decodeURIComponent(src()).indexOf('/proto/' + fk + '/?node-id=' + nid.replace(':', '-')) > 0 && tile().classList.contains('playing'), src())
    check('on the wall the prototype plays at actual size, cropped to the frame’s box', /scaling%3Dmin-zoom/.test(src()) && !!wb.document.querySelector('#live .lv .lv-crop iframe'), src())
    const before = frameEl()
    wb.showroomTest.renderWall(); await tick(10)
    check('wall redraws don’t reload a playing prototype', frameEl() === before && tile().classList.contains('playing'))
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="protoStyle"][data-val="kit2"]'); await tick(20)
    check('the “With controls” embed can be chosen in View options', src().indexOf('https://embed.figma.com/proto/' + fk) === 0 && /footer=false/.test(src()) && (bryce.store.get('showroom.prefs').wallView || {}).protoStyle === 'kit2', src())
    click(wb, '#viewopts [data-vo="protoStyle"][data-val="legacy"]'); await tick(20)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    check('Esc stops the prototype', !frameEl() && !tile().classList.contains('playing'))
    // Large window
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    click(wb, '#insp-play-large'); await tick(20)
    const big = () => ($(wb, '#pl-frame') || {}).src || ''
    check('“Large” plays it in a big window over the wall', !$(wb, '#player').classList.contains('hidden') && big().indexOf('https://www.figma.com/embed?') === 0, big())
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    check('Esc closes the big window', $(wb, '#player').classList.contains('hidden') && !$(wb, '#pl-frame'))
    {
      // A frame set as a flow starting point in Figma counts as a prototype too, and the file's manifest says so for the team.
      const bf = [...wb.document.querySelectorAll('#world .fr')].map((t) => t.dataset.id).find((id) => /^EMAILFILE0001\|/.test(id) && !wb.document.querySelector('.fr[data-id="' + id + '"] .pb'))
      bryce.page.flowStartingPoints = [{ nodeId: bf.split('|')[1], name: 'Flow 1' }]
      const ft = () => wb.document.querySelector('.fr[data-id="' + bf + '"]')
      pointer(wb, 'pointerdown', ft()); pointer(wb, 'pointerup', ft()); await tick(450)
      click(wb, '#inspector [data-status="draft"]'); await tick(150)
      const mf = JSON.parse(bryce.figma.root.getSharedPluginData('showroom', 'manifest') || '{}')
      check('a flow starting point gets ▶ and is listed in the file’s manifest', !!ft().querySelector('.pb') && (mf.flows || []).indexOf(bf.split('|')[1]) >= 0, JSON.stringify(mf.flows))
      bryce.page.flowStartingPoints = []
      click(wb, '#inspector [data-status=""]'); await tick(150)
      wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    }
    // Present plays prototype frames by themselves
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    pointer(wb, 'pointerdown', tile()); pointer(wb, 'pointerup', tile()); await tick(450)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'p', bubbles: true })); await tick(600)
    check('Present never shows a frame bigger than its real size', parseInt($(wb, '#zoom-val').textContent, 10) <= 100, $(wb, '#zoom-val').textContent)
    check('Present plays a prototype frame when you reach it', !!frameEl() && /Live prototype/.test(($(wb, '#hud-what') || {}).textContent || ''), ($(wb, '#hud-what') || {}).textContent)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true })); await tick(30)
    check('…and stops it when you move on', !frameEl())
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10)
    delete api.files[fk].nodes[nid].interactions
  }
  click(wb, '#view-opts'); await tick(10); click(wb, '#vo-reset'); await tick(20); click(wb, '#view-opts'); await tick(10)
  click(wb, '#view-opts'); await tick(10)
  check('outside-the-edge setting defaults to fade + line', vp().dataset.edge === 'both')
  const lineToggle = $(wb, '#viewopts [data-vo-toggle="edgeLine"]'); lineToggle.checked = false; lineToggle.dispatchEvent(new wb.Event('change')); await tick(20)
  check('content outside a frame can just fade (no edge line)', vp().dataset.edge === 'fade')
  click(wb, '#viewopts [data-vo="outside"][data-val="hide"]'); await tick(30)
  const dt2 = wb.document.querySelector('.fr[data-id="EMAILFILE0001|1:5"]')
  check('…or be hidden: the tile is the frame’s own box, the render cropped inside it', vp().dataset.edge === 'hide' && dt2 && dt2.style.height === '864px' && !!dt2.querySelector('.crop img') && !dt2.querySelector('.edge') && $(wb, '#viewopts [data-vo-toggle="edgeLine"]').disabled, dt2 && dt2.getAttribute('style'))
  click(wb, '#viewopts [data-vo-tab="present"]'); await tick(10)
  check('View options are split into Look, Layout and Present tabs', !wb.document.querySelector('#viewopts [data-pane="present"]').classList.contains('hidden') && wb.document.querySelector('#viewopts [data-pane="look"]').classList.contains('hidden'))
  click(wb, '#viewopts [data-vo-tab="look"]'); await tick(10)
  click(wb, '#vo-reset'); await tick(20); click(wb, '#view-opts'); await tick(10)
  check('reset restores the defaults', vp().dataset.bg === 'auto' && !vp().classList.contains('no-grid') && vp().dataset.frame === 'border')

  {
    // ===== tags on the wall: the details panel, “All tagged frames”, filtering by tag =====
    const esc2 = async () => { for (let i = 0; i < 2; i++) { wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(10) } }
    await esc2()
    const t12 = () => wb.document.querySelector('.fr[data-id="EMAILFILE0001|1:2"]')
    pointer(wb, 'pointerdown', t12()); pointer(wb, 'pointerup', t12()); await tick(450)
    $(wb, '#itag-add').value = 'Spring'
    $(wb, '#itag-add').dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(150)
    const mS = JSON.parse(bryce.root._d['showroom/manifest'])
    const sp = Object.keys(mS.campaigns).find((k) => mS.campaigns[k].name === 'Spring')
    check('the wall’s details can tag a frame from this file', sp && mS.campaigns[sp].items['1:2'] && /Spring/.test($(wb, '#inspector').textContent), $(wb, '#inspector').textContent.slice(0, 300))
    const otherTile = wb.document.querySelector('.fr[data-id^="ADFILE00002|"]')
    pointer(wb, 'pointerdown', otherTile); pointer(wb, 'pointerup', otherTile); await tick(450)
    check('…and shows another file’s frame’s tags read-only', !$(wb, '#itag-add') && /from its own file/.test($(wb, '#inspector').textContent))
    await esc2()
    click(wb, '#wall-back'); await tick(60)
    const pickTag = async (id) => { click(wb, '#view-pick'); await tick(20); const el = wb.document.querySelector('[data-view="' + id + '"]'); el.click(); await tick(100) }
    await pickTag('__all')
    click(wb, '#open-wall'); await tick(400)
    const ids = [...wb.document.querySelectorAll('#world .fr')].map((t) => t.dataset.id)
    check('“All tagged frames” shows every tagged frame once', ids.length >= 4 && new Set(ids).size === ids.length && ids.indexOf('EMAILFILE0001|1:2') >= 0, ids.join(', '))
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="group"][data-val="tag"]'); await tick(40)
    const heads2 = [...wb.document.querySelectorAll('#world .ch')].map((h) => h.firstChild.textContent)
    check('rows can be grouped by tag; a frame with two tags shows in both rows', heads2.indexOf('Spring') >= 0 && heads2.indexOf('Holiday 2026') >= 0 && wb.document.querySelectorAll('#world .fr[data-id="EMAILFILE0001|1:2"]').length === 2, heads2.join(', '))
    click(wb, '#viewopts [data-vo="group"][data-val="channel"]'); await tick(40)
    await esc2()
    click(wb, '#filter-btn'); await tick(20)
    click(wb, '#filters [data-fk="tags"][data-fv="' + sp + '"]'); await tick(30)
    check('filtering by a tag leaves only the frames that have it', wb.document.querySelectorAll('#world .fr:not(.dim)').length === 1 && !t12().classList.contains('dim'))
    click(wb, '#f-clear'); await tick(20)
    await esc2()
    pointer(wb, 'pointerdown', t12()); pointer(wb, 'pointerup', t12()); await tick(450)
    click(wb, '#inspector [data-itag-del="' + sp + '"]'); await tick(150)
    check('× in the details takes the tag off', !JSON.parse(bryce.root._d['showroom/manifest']).campaigns[sp])
    await esc2()
    click(wb, '#wall-back'); await tick(60)
    // ===== several tags viewed together =====
    const promo = bryce.mk('1:20', 'Promo banner', 'FRAME', 600, 300)
    bryce.setSel([promo]); await tick(150)
    $(wb, '#tag-add').value = 'Spring 2027'
    $(wb, '#tag-add').dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); await tick(150)
    const mSp = JSON.parse(bryce.root._d['showroom/manifest'])
    const sp2 = Object.keys(mSp.campaigns).find((k) => mSp.campaigns[k].name === 'Spring 2027')
    await pickTag(cid)
    const holidayCount = Number(($(wb, '.card.stack span') || {}).textContent)
    click(wb, '#view-pick'); await tick(20)
    const rows = [...wb.document.querySelectorAll('#view-menu [data-view]')]
    check('the tag picker lists All tagged frames first, then every tag with a tick box', rows[0].dataset.view === '__all' && wb.document.querySelectorAll('#view-menu [data-view-toggle]').length >= 2, rows.map((r) => r.dataset.view).join(','))
    click(wb, '#view-menu [data-view-toggle="' + sp2 + '"]'); await tick(120)
    check('ticking a second tag views both together, and the menu stays open', /Holiday 2026 \+ Spring 2027/.test($(wb, '#view-pick').textContent) && !!$(wb, '#view-menu') && /^__tags:/.test(bryce.store.get('showroom.data').activeCampaignId), $(wb, '#view-pick').textContent)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(30)
    const multiCount = Number(($(wb, '.card.stack span') || {}).textContent)
    check('…showing frames with either tag, each once', multiCount === holidayCount + 1 && !$(wb, '#view-menu'), holidayCount + ' → ' + multiCount)
    check('the summary counts frames per tag, and a tag chip narrows the view', wb.document.querySelectorAll('.tagpill').length === 2)
    check('with several tags, the selection offers which tag to add it to', !!$(wb, '[data-add-to="' + cid + '"]') && !$(wb, '#add'))
    click(wb, '[data-add-to="' + cid + '"]'); await tick(150)
    const mSp2 = JSON.parse(bryce.root._d['showroom/manifest'])
    check('…and adding keeps the view of both tags', mSp2.campaigns[cid].items['1:20'] && /Spring 2027/.test($(wb, '#view-pick').textContent))
    check('the frames list groups by file, this file first, with previews and sizes', /This file/.test($(wb, '.fl-file').textContent) && wb.document.querySelectorAll('.frow .fr-th').length === multiCount && [...wb.document.querySelectorAll('.fr-mt')].some((el) => /600 × 300/.test(el.textContent)))
    click(wb, '#open-wall'); await tick(400)
    const headsM = [...wb.document.querySelectorAll('#world .ch')].map((h) => h.firstChild.textContent)
    check('a wall of several tags groups rows by tag, without changing your usual grouping', headsM.indexOf('Holiday 2026') >= 0 && headsM.indexOf('Spring 2027') >= 0 && (bryce.store.get('showroom.prefs').wallView || {}).group !== 'tag', headsM.join(', '))
    click(wb, '#wall-back'); await tick(60)
    // home: tick two cards, open them together
    await pickTag(cid)
    click(wb, '#home'); await tick(40)
    check('home shows All tagged frames first', wb.document.querySelector('.ccard').dataset.campaign === '__all')
    click(wb, '[data-pick="' + cid + '"]'); await tick(20)
    click(wb, '[data-pick="' + sp2 + '"]'); await tick(20)
    check('ticking cards on home shows a bar to open them together', /2 tags/.test(($(wb, '.home-bar') || {}).textContent || '') && wb.document.querySelectorAll('.ccard.picked').length === 2)
    click(wb, '#pick-open'); await tick(120)
    check('…which opens a view of both tags', /\+ Spring 2027|Spring 2027 \+/.test($(wb, '#view-pick').textContent), $(wb, '#view-pick').textContent)
    // removing from a view of several tags takes each of them off the frame
    click(wb, '[data-remove="EMAILFILE0001|1:20"]'); await tick(150)
    const mSp3 = JSON.parse(bryce.root._d['showroom/manifest'])
    check('× in a view of several tags removes each of them from the frame', !(mSp3.campaigns[cid] || { items: {} }).items['1:20'] && !(mSp3.campaigns[sp2] || { items: {} }).items['1:20'])
    await pickTag(cid)
    click(wb, '#open-wall'); await tick(400)
  }
  {
    // ===== row width: sections stay whole =====
    const T = wb.showroomTest
    const mkItem = (file, i) => ({ id: file + '|' + i, fileKey: file, fileName: file === 'FA' ? 'File A' : 'File B', nodeId: String(i), name: 'F' + i, width: 1440, height: 900, channel: 'Site', tags: [] })
    const fake = { id: 'rowtest', name: 'Row test', items: [1, 2, 3, 4, 5].map((i) => mkItem('FA', i)).concat([6, 7, 8].map((i) => mkItem('FB', i))) }
    const L1 = T.layout(fake, 0.25, 4000)
    const segs = L1.groups[0].segments
    const inside = segs.every((sg) => sg.ids.every((id) => { const p = L1.groups[0].items.find((q) => q.it.id === id); return p.x >= sg.box.x && p.x + p.w <= sg.box.x + sg.box.w && p.y >= sg.box.y && p.y + p.h <= sg.box.y + sg.box.h }))
    check('a narrow row keeps each file in one section (wrapping inside it), never split in two', segs.length === 2 && inside && new Set(L1.groups[0].items.map((q) => q.oy)).size > 2, JSON.stringify(segs.map((s) => [s.label, s.ids.length])))
    const L2 = T.layout(fake, 0.25, 1e9)
    check('“One line” keeps a row on a single line', new Set(L2.groups[0].items.map((q) => q.oy)).size === 1)
    const wFit = T.fitRowWidth(fake)
    check('“Fit window” picks a row width that shows the wall at least as big as one long line', T.fitZoomFor(T.layout(fake, 0.25, wFit)) >= T.fitZoomFor(L2), wFit)
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-tab], #viewopts [data-vo-tab="layout"]'); await tick(10)
    check('View options › Layout has Row width', !!$(wb, '#viewopts [data-vo="rows"][data-val="fit"]') && $(wb, '#viewopts [data-vo="rows"][data-val="fit"]').classList.contains('on'))
    click(wb, '#viewopts [data-vo="rows"][data-val="line"]'); await tick(60)
    check('…and changing it is saved', (bryce.store.get('showroom.prefs').wallView || {}).rows === 'line')
    click(wb, '#viewopts [data-vo="rows"][data-val="fit"]'); await tick(60)
    wb.document.dispatchEvent(new wb.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); await tick(20)
  }
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
  await key('!', { code: 'Digit1', shiftKey: true })
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
  check('the Present toolbar offers ▶ only on prototype frames', $(wb, '#hud-play').classList.contains('hidden') === !wb.document.querySelector('#world .fr.cur .pb'))
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
  {
    // Rows split into sections: frames stay in their own section; sections move by their name.
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="group"][data-val="file"]'); await tick(60)
    await key('Escape')
    const secs = () => [...wb.document.querySelectorAll('#world .sec')].filter((el) => el.querySelector('.sec-t').dataset.seg.split(':')[0] === gi)
    const firstMulti = [...wb.document.querySelectorAll('#world .sec-t')].map((t) => t.dataset.seg.split(':')[0]).find((g, i, all) => all.filter((x) => x === g).length >= 2)
    const gi = firstMulti
    const T2 = tf()
    const sBox = (el) => box(el)
    const names = () => secs().map((el) => el.querySelector('.sec-t').textContent)
    const before3 = names()
    const s0 = secs()[0], sLast = secs()[secs().length - 1]
    const b0 = sBox(s0), bL = sBox(sLast)
    const pt = (b, fx, fy) => ({ clientX: (b.x + b.w * fx) * T2.z + T2.tx, clientY: (b.y + b.h * fy) * T2.z + T2.ty })
    // a frame from the first section dropped in the middle of the last one stays in its own section
    const f0 = [...wb.document.querySelectorAll('#world .fr')].find((t) => { const tb = box(t); return tb.x >= b0.x && tb.x + tb.w <= b0.x + b0.w && tb.y >= b0.y && tb.y <= b0.y + b0.h })
    const fid = f0.dataset.id
    pointer(wb, 'pointerdown', f0, pt(box(f0), 0.5, 0.5))
    pointer(wb, 'pointermove', $(wb, '#viewport'), pt(bL, 0.5, 0.5))
    pointer(wb, 'pointerup', $(wb, '#viewport'), pt(bL, 0.5, 0.5)); await tick(150)
    const nb0 = sBox(secs()[0]), nf = box(wb.document.querySelector('.fr[data-id="' + cssEscT(fid) + '"]'))
    check('a frame dragged into another section stays in its own section', JSON.stringify(names()) === JSON.stringify(before3) && nf.x >= nb0.x && nf.x + nf.w <= nb0.x + nb0.w + 1, names().join(', '))
    // drag the first section by its name to the end of the row
    const t0 = secs()[0].querySelector('.sec-t')
    pointer(wb, 'pointerdown', t0, pt(sBox(secs()[0]), 0.05, 0))
    pointer(wb, 'pointermove', $(wb, '#viewport'), pt(sBox(secs()[secs().length - 1]), 0.9, 0.5))
    check('dragging a section shows where it will land', !!wb.document.querySelector('#world .drop-line') && secs()[0].classList.contains('dragging'))
    pointer(wb, 'pointerup', $(wb, '#viewport'), pt(sBox(secs()[secs().length - 1]), 0.9, 0.5)); await tick(150)
    check('dropping a section moves it, with its frames, in the row', names()[names().length - 1] === before3[0] && names().length === before3.length, before3.join(', ') + ' → ' + names().join(', '))
    click(wb, '#view-opts'); await tick(10)
    click(wb, '#viewopts [data-vo="group"][data-val="channel"]'); await tick(60)
    await key('Escape')
  }
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

  // ===== FigJam board: send a campaign, then sync it =====
  {
    const board = makeEnv({ fileKey: 'BOARDFILE001', fileName: 'Holiday review board', user: 'Bryce', store: new Map() })
    api.files.BOARDFILE001 = { name: 'Holiday review board', version: 1, touched: new Date().toISOString(), nodes: {}, env: board }
    // A tiny FigJam canvas: sections, rectangles, text, embeds, plugin data.
    let seq = 0
    const mkNode = (type, extra) => Object.assign({ id: 'b:' + (++seq), type, x: 0, y: 0, width: 100, height: 100, opacity: 1, name: '', fills: [], children: [], parent: null, _d: {},
      getSharedPluginData(ns, k) { return this._d[ns + '/' + k] || '' }, setSharedPluginData(ns, k, v) { this._d[ns + '/' + k] = v },
      resize(w, h) { this.width = w; this.height = h }, resizeWithoutConstraints(w, h) { this.width = w; this.height = h },
      appendChild(n) { if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n); n.parent = this; this.children.push(n) },
      setRangeFills() {} }, extra || {})
    const pg = board.page
    Object.assign(pg, { children: [], appendChild(n) { if (n.parent) n.parent.children = n.parent.children.filter((x) => x !== n); n.parent = pg; pg.children.push(n) },
      findAllWithCriteria({ sharedPluginData: { namespace, keys } }) { const out = []; const walk = (n) => { for (const c of n.children || []) { if (keys.some((k) => c.getSharedPluginData(namespace, k))) out.push(c); walk(c) } }; walk(pg); return out } })
    const add = (n) => { pg.appendChild(n); return n }
    Object.assign(board.figma, { editorType: 'figjam', currentPage: Object.assign(pg, { get selection() { return [] }, set selection(v) {} }),
      createSection: () => add(mkNode('SECTION')), createRectangle: () => add(mkNode('RECTANGLE')), createFrame: () => add(mkNode('FRAME')),
      createText: () => { const t = add(mkNode('TEXT', { characters: '', fontSize: 12 })); Object.defineProperty(t, 'width', { get() { return (t.characters || '').length * t.fontSize * 0.5 }, set() {} }); return t },
      loadFontAsync: async () => {}, createImageAsync: async (url) => ({ hash: 'img:' + url }),
      createLinkPreviewAsync: async (url) => add(mkNode('EMBED', { url, width: 420, height: 300 })) })
    board.figma.root.children = [pg]
    const wj = await boot(board, api)
    await connect(wj)
    click(wj, '#settings'); await tick(10)
    $(wj, '#index-link').value = 'https://www.figma.com/design/INDEXFILE0099/Showroom-Index'
    click(wj, '#add-index'); await tick(300)
    click(wj, '#back'); await tick(20)
    check('on a FigJam board, the panel offers Send to board instead of adding a selection', !!$(wj, '#board-send') && !$(wj, '#add') && /Send Holiday 2026 to this board/.test(text(wj)), text(wj).slice(0, 300))
    const frameCount = Number((text(wj).match(/(\d+)\s*frames from/) || [])[1] || 0)
    click(wj, '#board-send'); await tick(2200)
    const all = (n, out = []) => { for (const c of n.children || []) { out.push(c); all(c, out) } return out }
    const nodes = all(pg)
    const rects = nodes.filter((n) => n.type === 'RECTANGLE' && n.getSharedPluginData('showroom', 'boardItem'))
    const outer = nodes.find((n) => n.getSharedPluginData('showroom', 'board'))
    check('Send to board places every frame as an image, grouped in channel sections', outer && rects.length === frameCount && frameCount > 0 && rects.every((r) => (r.fills[0] && r.fills[0].type === 'IMAGE') || /7:2"/.test(r.getSharedPluginData('showroom', 'boardItem'))) && nodes.filter((n) => n.type === 'SECTION').length >= 3, rects.length + ' of ' + frameCount + ' fills:' + rects.map((r) => r.fills[0] && r.fills[0].type).join(',') + ' sections:' + nodes.filter((n) => n.type === 'SECTION').length)
    check('each frame gets a label with a live link', nodes.filter((n) => n.type === 'TEXT' && n.hyperlink && /node-id=/.test(n.hyperlink.value)).length === frameCount)
    const embeds = nodes.filter((n) => n.type === 'EMBED')
    check('embeds sit side by side without overlapping', embeds.length < 2 || embeds.every((e, i) => i === 0 || e.x >= embeds[i - 1].x + embeds[i - 1].width), embeds.map((e) => e.x + '/' + e.width).join(' '))
    check('one live embed per source file', nodes.filter((n) => n.type === 'EMBED').length === new Set(rects.map((r) => JSON.parse(r.getSharedPluginData('showroom', 'boardItem')).fileKey)).size)
    check('panel now offers Sync board', !!$(wj, '#board-sync') && /is on this board/.test(text(wj)), text(wj).slice(0, 300))
    // Someone rearranges a frame on the board; then that frame changes in its file.
    const target = rects.find((r) => /EMAILFILE0001\|1:3/.test(r.getSharedPluginData('showroom', 'boardItem')))
    target.x = 5000; target.y = 7000
    const oldFill = target.fills[0].imageHash
    api.files.EMAILFILE0001.nodes['1:3'] = { id: '1:3', name: 'Homepage hero', absoluteBoundingBox: { x: 0, y: 0, width: 1440, height: 900 } }
    api.files.EMAILFILE0001.version += 1
    api.files.EMAILFILE0001.touched = new Date(Date.now() + 60000).toISOString()
    // …and Sam adds a new frame to the campaign.
    api.files.ADFILE00002.nodes['7:9'] = { id: '7:9', name: 'Skyscraper 2', absoluteBoundingBox: { x: 0, y: 0, width: 160, height: 600 } }
    sam.setSel([sam.mk('7:9', 'Skyscraper 2', 'FRAME', 160, 600)]); await tick(150)
    click(ws, '#add'); await tick(1600)
    await wj.showroomTest.pollIndex(); await tick(50)
    click(wj, '#board-sync'); await tick(900)
    check('Sync swaps in the new image but leaves the frame where people put it', target.fills[0].imageHash !== oldFill && target.x === 5000 && target.y === 7000 && target.height === 900, target.fills[0].imageHash + ' ' + target.x + ',' + target.y + ' h' + target.height)
    const inbox = all(pg).find((n) => n.type === 'SECTION' && /Inbox/.test(n.name))
    check('new frames land in an Inbox section', inbox && inbox.children.some((n) => n.type === 'RECTANGLE' && /7:9/.test(n.getSharedPluginData('showroom', 'boardItem'))))
    check('Sync reports what changed', /Board synced/.test(wj.document.getElementById('toast').textContent), wj.document.getElementById('toast').textContent)
  }

  // ===== a new computer with Team sync: no big search =====
  {
    api.files.MIDFILE00008 = { name: 'Old site work', version: 1, touched: new Date(Date.now() - 10 * 86400e3).toISOString(), nodes: {} }
    api.folders['333'] = ['PLAINFILE0004', 'OLDFILE00005', 'MIDFILE00008']
    api.files.PLAINFILE0004.touched = new Date(Date.now() + 20000).toISOString()
    const mac = makeEnv({ fileKey: 'MACFILE00009', fileName: 'Scratch', user: 'Bryce', store: new Map() })
    api.files.MACFILE00009 = { name: 'Scratch', version: 1, touched: new Date().toISOString(), nodes: {}, env: mac }
    const wm = await boot(mac, api)
    await connect(wm)
    click(wm, '#settings'); await tick(10)
    $(wm, '#index-link').value = 'https://www.figma.com/design/INDEXFILE0099/Showroom-Index'
    click(wm, '#add-index'); await tick(300)
    let mark2 = api.calls.length
    const reads2 = (key) => api.calls.slice(mark2).filter((x) => x.indexOf('/v1/files/' + key + '?depth') === 0).length
    $(wm, '#folder-link').value = 'https://www.figma.com/files/team/1/project/333/Misc'
    click(wm, '#add-folder'); await tick(400)
    check('with Team sync on, a new computer only opens recently edited files', reads2('PLAINFILE0004') === 1 && reads2('MIDFILE00008') === 0 && reads2('OLDFILE00005') === 0, api.calls.slice(mark2).join(' | '))
    mark2 = api.calls.length
    click(wm, '#back'); await tick(20)
    click(wm, '#search-now'); await tick(400)
    check('…while the refresh button still searches the full Look back', reads2('MIDFILE00008') === 1, api.calls.slice(mark2).join(' | '))
    // Stop a running search
    api.files.MIDFILE00008.touched = new Date(Date.now() + 30000).toISOString()
    wm.showroomTest.discover({ manual: true }); await tick(1)
    check('a running search shows a Stop button', !!$(wm, '#search-stop'))
    click(wm, '#search-stop'); await tick(300)
    check('Stop ends the search and keeps what it found', !$(wm, '#search-stop') && /Search stopped/.test(wm.document.getElementById('toast').textContent), wm.document.getElementById('toast').textContent)
  }

  // ===== team settings saved in the Team sync file, and team presets =====
  {
    click(wl, '#settings'); await tick(10)
    $(wl, '#index-link').value = 'https://www.figma.com/design/INDEXFILE0099/Showroom-Index'
    click(wl, '#add-index'); await tick(300)
    check('Settings offers to save team settings into the Team sync file', !!$(wl, '#save-team-settings') && /aren’t stored in this file yet/.test(text(wl)))
    click(wl, '#save-team-settings'); await tick(300)
    const cfgVar = Object.values(api.vars.INDEXFILE0099.variables).find((v) => v.name === 'config')
    const cfg = cfgVar && JSON.parse(Object.values(cfgVar.valuesByMode)[0])
    check('team settings are saved as a “config” variable', cfg && cfg.team && cfg.team.id === '9001' && cfg.lookBackDays === 90 && cfg.folders.length >= 1, JSON.stringify(cfg))
    check('Settings shows what’s saved', /Team settings in this file:/.test(text(wl)) && !!$(wl, '#save-team-settings') && /Update/.test($(wl, '#save-team-settings').textContent))
    check('the channel list is saved with the team settings', Array.isArray(cfg.channels) && cfg.channels.indexOf('Email') >= 0)
    const em = [...wl.document.querySelectorAll('[data-ch-name]')].find((el) => el.value === 'Email')
    em.value = 'CRM'; em.dispatchEvent(new wl.Event('change')); await tick(300)
    const cfg2 = JSON.parse(Object.values(Object.values(api.vars.INDEXFILE0099.variables).find((v) => v.name === 'config').valuesByMode)[0])
    check('editing the team’s channel list updates it in Team sync for everyone', cfg2.channels.indexOf('CRM') >= 0 && cfg2.channelRenames.Email === 'CRM' && /Your team’s list/.test(text(wl)), JSON.stringify(cfg2.channels))
    const crm = [...wl.document.querySelectorAll('[data-ch-name]')].find((el) => el.value === 'CRM')
    crm.value = 'Email'; crm.dispatchEvent(new wl.Event('change')); await tick(300)
    click(wl, '#back'); await tick(10)

    // Nia: new, the plugin has the team listed as a preset.
    const nia = makeEnv({ fileKey: 'NIAFILE00011', fileName: 'Nia scratch', user: 'Nia', store: new Map() })
    api.files.NIAFILE00011 = { name: 'Nia scratch', version: 1, touched: new Date().toISOString(), nodes: {}, env: nia }
    const wn = await boot(nia, api, { welcome: true, presets: [{ name: 'Merrell Digital', indexFile: 'INDEXFILE0099' }] })
    check('the setup guide asks which team you’re on', /Which team are you on\?/.test(text(wn)) && !!$(wn, '#ob-preset-0') && /Don’t have one\?/.test(text(wn)))
    $(wn, '#ob-token').value = 'figd_nia'
    click(wn, '#ob-connect'); await tick(300)
    click(wn, '#ob-preset-0'); await tick(400)
    check('picking a team links its Team sync file', (nia.store.get('showroom.prefs').index || {}).key === 'INDEXFILE0099')
    check('…and the team step fills in from the saved team settings', /Set up from your Team sync file/.test(text(wn)), text(wn).slice(0, 600))
    click(wn, '#ob-start'); await tick(100)
    click(wn, '#settings'); await tick(20)
    check('Settings shows the team and folders as coming from Team sync, with Look back 90', /from Team sync/.test(text(wn)) && $(wn, '#look-back').value === '90', text(wn).slice(0, 900))
    click(wn, '#back'); await tick(10)
  }

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
    check('finishing setup goes to the panel and is remembered', /Start with a tag/.test(text(wn)) && newbie.store.get('showroom.prefs').onboarded === true)
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
  check('starts fresh', /Start with a tag/.test(text(wf)))

  // ===== two windows on one computer =====
  const winA = makeEnv({ fileKey: 'EMAILFILE0001', store: new Map() })
  const winB = makeEnv({ fileKey: 'ADFILE00002', store: winA.store })
  const wA = await boot(winA, api)
  $(wA, '#campaign-name').value = 'Shared'; click(wA, '#create'); await tick(80)
  const wB = await boot(winB, api)
  await tick(3300)
  check('window B picks up a campaign created in window A', /Shared/.test(($(wB, '#view-pick') || {}).textContent || ''))

  // ===== editable channel list =====
  {
    if ($(wb, '#wall-back')) { click(wb, '#wall-back'); await tick(40) }
    if ($(wb, '#back')) { click(wb, '#back'); await tick(40) }
    click(wb, '#settings'); await tick(40)
    const nameInputs = () => [...wb.document.querySelectorAll('[data-ch-name]')]
    const site = nameInputs().find((el) => el.value === 'Site')
    check('Settings lists the channels', !!site && nameInputs().length >= 5)
    site.value = 'Web'; site.dispatchEvent(new wb.Event('change')); await tick(200)
    const cfgVar = Object.values((api.vars.INDEXFILE0099 || {}).variables || {}).find((v) => v.name === 'config')
    const cfg = cfgVar ? JSON.parse(Object.values(cfgVar.valuesByMode)[0]) : {}
    const local = bryce.store.get('showroom.data')
    check('renaming a channel saves it, with the old name remembered (for the team when Team sync has a list)', ((cfg.channels || []).indexOf('Web') >= 0 && cfg.channelRenames && cfg.channelRenames.Site === 'Web') || ((local.channels || []).indexOf('Web') >= 0 && local.channelRenames.Site === 'Web'), JSON.stringify(cfg).slice(0, 300))
    $(wb, '#ch-add').value = 'Paid social'; click(wb, '#ch-add-btn'); await tick(200)
    const list = nameInputs().map((el) => el.value)
    check('a new channel goes in before “Other”', list.indexOf('Paid social') >= 0 && list.indexOf('Paid social') < list.indexOf('Other'), list.join(', '))
    click(wb, '#back'); await tick(40)
    click(wb, '#open-wall'); await tick(300)
    const heads3 = [...wb.document.querySelectorAll('#world .ch')].map((h) => h.firstChild.textContent)
    check('frames saved as “Site” now show under “Web”', heads3.indexOf('Web') >= 0 && heads3.indexOf('Site') < 0, heads3.join(', '))
    check('the sandbox’s copy of the list follows (for guessing channels)', (bryce.store.get('showroom.data').channels || []).indexOf('Web') >= 0 && bryce.store.get('showroom.data').channelRenames.Site === 'Web')
    click(wb, '#wall-back'); await tick(40)
  }

  // ===== network failure =====
  api.fail = 'network'
  click(wb, '#open-wall'); await tick(200)
  check('network error banner', /Couldn’t reach Figma’s API/.test($(wb, '#banner').textContent))

  // ===== “Open in Showroom” / “Edit tags” from Figma's properties panel =====
  api.fail = null
  bryce.setSel([a]); bryce.figma.command = 'open'
  const wOpen = await boot(bryce, api); await tick(500)
  check('“Open in Showroom” opens the wall at that frame, selected', wOpen.document.body.classList.contains("walling") && !!wOpen.document.querySelector('#world .fr.sel[data-id="EMAILFILE0001|1:2"]'))
  {
    // The window grows (and the layout can shift) after the wall opens: the zoom keeps the frame centred
    // until you move the wall yourself.
    const vpO = wOpen.document.getElementById('viewport')
    const setSize = (w, h) => { Object.defineProperty(vpO, 'clientWidth', { value: w, configurable: true }); Object.defineProperty(vpO, 'clientHeight', { value: h, configurable: true }); wOpen.dispatchEvent(new wOpen.Event('resize')) }
    const centre = () => {
      const m = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\) scale\(([\d.]+)\)/.exec(wOpen.document.getElementById('world').style.transform)
      const p = wOpen.showroomTest.placementOf('EMAILFILE0001|1:2'), z = Number(m[3])
      return [(p.x + p.w / 2) * z + Number(m[1]), (p.y + p.h / 2) * z + Number(m[2])]
    }
    setSize(1200, 800); await tick(350)
    let cc = centre()
    check('…and keeps it centred while the window grows to wall size', Math.abs(cc[0] - 600) < 2 && Math.abs(cc[1] - 400) < 2, cc.join(','))
    vpO.dispatchEvent(new wOpen.WheelEvent('wheel', { bubbles: true, deltaY: 40, cancelable: true })); await tick(20)
    setSize(1000, 700); await tick(350)
    cc = centre()
    check('…until you move the wall yourself', !(Math.abs(cc[0] - 500) < 2 && Math.abs(cc[1] - 350) < 2), cc.join(','))
    // Resizing from the corner ends when the button is no longer held, even if the release was missed.
    const grip = wOpen.document.getElementById('grip')
    bryce.size = null
    pointer(wOpen, 'pointerdown', grip, { screenX: 100, screenY: 100, buttons: 1 })
    pointer(wOpen, 'pointermove', grip, { screenX: 160, screenY: 140, buttons: 1 }); await tick(30)
    const during = bryce.size && bryce.size.slice()
    pointer(wOpen, 'pointermove', grip, { screenX: 170, screenY: 150, buttons: 0 }); await tick(30)
    pointer(wOpen, 'pointermove', grip, { screenX: 400, screenY: 400, buttons: 0 }); await tick(30)
    check('resizing from the corner stops when the mouse button is up, even if the release was missed', during && bryce.size && bryce.size[0] === during[0] && bryce.size[1] === during[1], JSON.stringify([during, bryce.size]))
  }
  bryce.figma.command = 'tags'
  const wt = await boot(bryce, api)
  // Wait (up to 2 s) for the panel to settle: on a busy machine the first state can arrive late.
  for (let i = 0; i < 40 && !(wt.document.activeElement && wt.document.activeElement.id === 'tag-add'); i++) await tick(50)
  check('“Edit tags” opens the panel ready to add a tag', !wt.document.body.classList.contains('walling') && wt.document.activeElement && wt.document.activeElement.id === 'tag-add')

  // ===== quick actions (Figma's Quick Actions bar), run without Showroom's window =====
  {
    const runCode = (env) => { const ctx = vm.createContext({ figma: env.figma, __html__: '', setTimeout, clearTimeout, setInterval, clearInterval, console, JSON, Promise, Date, Math, String, Object, Array, Error, encodeURIComponent }); vm.runInContext(fs.readFileSync(path.join(ROOT, 'code.js'), 'utf8'), ctx) }
    const suggest = async (query, key) => { let out = null, err = null; bryce.qaInput({ key: key || 'tag', query: query, parameters: {}, result: { setSuggestions(x) { out = x }, setError(e) { err = e }, setLoadingMessage() {} } }); await tick(30); return { out: out, err: err } }
    bryce.figma.parameters = { on(ev, fn) { bryce.qaInput = fn } }
    bryce.figma.ui.postMessage = () => {}
    bryce.shown = null; bryce.notes = []; bryce.closed = false
    bryce.figma.command = 'qa-tag'
    runCode(bryce)
    check('a quick action doesn’t open Showroom’s window', !bryce.shown)
    bryce.setSel([]); let r = await suggest('')
    check('Tag selection… asks for a selection first', /Select frames/.test(r.err || ''))
    bryce.setSel([a])
    r = await suggest('holi')
    check('Tag selection… suggests existing tags first as you type', r.out && r.out[0].name === 'Holiday 2026' && /New tag/.test(r.out[r.out.length - 1].name), JSON.stringify(r.out))
    r = await suggest('holiday-2026 ')
    check('…and won’t offer a near-duplicate as a new tag', r.out && !r.out.some((x) => /New tag/.test(x.name)), JSON.stringify(r.out))
    r = await suggest('Summer')
    const nt = r.out && r.out[r.out.length - 1]
    check('a new tag is offered last, as “+ New tag”', nt && nt.name === '+ New tag “Summer”' && nt.data.id === '' && nt.data.name === 'Summer', JSON.stringify(r.out))
    bryce.handlers.run({ command: 'qa-tag', parameters: { tag: nt.data } }); await tick(150)
    let mq = JSON.parse(bryce.root._d['showroom/manifest'])
    const sumId = Object.keys(mq.campaigns).find((k) => mq.campaigns[k].name === 'Summer')
    check('…picking it tags the selection, says so, and publishes invisibly', sumId && mq.campaigns[sumId].items['1:2'] && bryce.notes.some((n) => /Summer/.test(n)) && bryce.shown && bryce.shown.visible === false, JSON.stringify(bryce.notes))
    bryce.shown = null; bryce.figma.command = 'qa-untag'; runCode(bryce)
    r = await suggest('')
    check('Remove tag… only suggests the selection’s tags', r.out && r.out.some((x) => x.name === 'Summer') && r.out.every((x) => ['Summer', 'Holiday 2026'].indexOf(x.name) >= 0), JSON.stringify(r.out))
    bryce.handlers.run({ command: 'qa-untag', parameters: { tag: { id: sumId, name: 'Summer' } } }); await tick(150)
    mq = JSON.parse(bryce.root._d['showroom/manifest'])
    check('…and takes it off', !mq.campaigns[sumId] || !mq.campaigns[sumId].items['1:2'])
    bryce.figma.command = 'qa-status'; runCode(bryce)
    r = await suggest('app', 'status')
    check('Set status… suggests statuses', r.out && r.out.length === 1 && r.out[0].data === 'approved')
    bryce.handlers.run({ command: 'qa-status', parameters: { status: 'approved' } }); await tick(150)
    mq = JSON.parse(bryce.root._d['showroom/manifest'])
    check('…and sets it on the selected tagged frames', mq.statuses.__all && mq.statuses.__all['EMAILFILE0001|1:2'].s === 'approved')
    bryce.figma.command = 'qa-wall'; runCode(bryce)
    r = await suggest('')
    check('Open wall… offers All tagged frames first', r.out && r.out[0].data.id === '__all')
    // The invisible window: publishes to Team sync, then closes.
    bryce.closed = false; bryce.figma.command = 'publish'
    const wp = await boot(bryce, api); await tick(400)
    check('the invisible run closes itself once it has published', bryce.closed === true && wp)
  }
  api.fail = null

  console.log(`\n${pass}/${pass + fail} passed`)
  process.exit(fail ? 1 : 0)
})().catch((e) => { console.error(e); process.exit(1) })
