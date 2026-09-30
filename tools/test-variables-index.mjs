// Showroom — variables index test
// ------------------------------------------------------------
// Checks whether a Figma file's variables can work as Showroom's shared index,
// using Figma's REST API with your personal access token.
//
// It creates a small hidden test collection in the file you give it, writes a few
// entries, reads them back, updates one, measures timing and limits, and then
// deletes the test collection (unless you pass --keep).
//
// Needs Node 18 or newer (check with: node -v).
//
// Run (PowerShell):
//   $env:FIGMA_TOKEN = "figd_your_token_here"
//   node tools/test-variables-index.mjs "https://www.figma.com/design/FILEKEY/Showroom-Index"
//
// Run (macOS / Git Bash):
//   FIGMA_TOKEN=figd_your_token_here node tools/test-variables-index.mjs "https://www.figma.com/design/FILEKEY/Showroom-Index"
//
// The token needs these scopes: File variables (read AND write), Current user (read).
// Use a new, empty design file you can edit, e.g. "Showroom Index (test)".
// ------------------------------------------------------------

const API = process.env.FIGMA_API || 'https://api.figma.com' // FIGMA_API is only for offline testing
const token = process.env.FIGMA_TOKEN || ''
const link = process.argv[2] || ''
const keep = process.argv.includes('--keep')

const results = []
function report(ok, label, detail) {
  results.push({ ok, label })
  console.log((ok ? 'PASS ' : 'FAIL ') + label + (detail ? '\n     ' + detail : ''))
}
function info(text) { console.log('     ' + text) }

function fileKeyFrom(text) {
  const branch = text.match(/figma\.com\/(?:design|file)\/[A-Za-z0-9]+\/branch\/([A-Za-z0-9]+)/)
  if (branch) return { key: branch[1], branch: true }
  const m = text.match(/figma\.com\/(?:design|file)\/([A-Za-z0-9]{10,})/) || text.match(/^([A-Za-z0-9]{10,})$/)
  return m ? { key: m[1], branch: false } : null
}

async function call(method, path, body) {
  const started = Date.now()
  const res = await fetch(API + path, {
    method,
    headers: Object.assign({ 'X-Figma-Token': token }, body ? { 'Content-Type': 'application/json' } : {}),
    body: body ? JSON.stringify(body) : undefined,
  })
  let json = null
  try { json = await res.json() } catch (e) { /* empty body */ }
  return { status: res.status, ok: res.ok, json, ms: Date.now() - started, retryAfter: res.headers.get('retry-after') }
}

function explain(r) {
  const msg = (r.json && (r.json.message || r.json.err || (r.json.error === true && r.json.message))) || ''
  return 'HTTP ' + r.status + (msg ? ' — ' + msg : '') + (r.retryAfter ? ' (retry after ' + r.retryAfter + ' s)' : '')
}

async function readCollection(key, name) {
  const r = await call('GET', '/v1/files/' + key + '/variables/local')
  if (!r.ok) return { r }
  const meta = r.json.meta || {}
  const collections = Object.values(meta.variableCollections || {})
  const col = collections.find((c) => c.name === name)
  const vars = Object.values(meta.variables || {}).filter((v) => col && v.variableCollectionId === col.id)
  return { r, col, vars, collections }
}

async function main() {
  console.log('\nShowroom — variables index test\n')
  if (!token) { console.log('Set FIGMA_TOKEN first (see the top of this file).'); process.exit(1) }
  const parsed = fileKeyFrom(link)
  if (!parsed) { console.log('Pass the test file’s link as the first argument (see the top of this file).'); process.exit(1) }
  if (parsed.branch) info('Note: that’s a branch link. Variables writes need the main file, so use the main file’s link if this fails.')
  const key = parsed.key

  // 1. Token works
  const me = await call('GET', '/v1/me')
  report(me.ok, 'Token works', me.ok ? 'Signed in as ' + me.json.handle + (me.json.email ? ' (' + me.json.email + ')' : '') : explain(me))
  if (!me.ok) return finish()

  // 2. Can read variables (Enterprise + File variables: read)
  const before = await call('GET', '/v1/files/' + key + '/variables/local')
  report(before.ok, 'Can read variables in the file', before.ok
    ? 'Read in ' + before.ms + ' ms. Existing collections: ' + Object.keys((before.json.meta || {}).variableCollections || {}).length
    : explain(before) + '\n     403 usually means: not an Enterprise org, you aren’t a full member, or the token lacks File variables (read).')
  if (!before.ok) return finish()

  // 3. Create a hidden test collection with three entries
  const NAME = 'Showroom index test ' + new Date().toISOString().slice(0, 16).replace('T', ' ')
  const entry = (campaign, file, n) => JSON.stringify({ v: 1, campaign: campaign, file: file, fileName: 'Test file ' + n, frames: n, addedBy: me.json.handle, updatedAt: Date.now() })
  const create = await call('POST', '/v1/files/' + key + '/variables', {
    variableCollections: [{ action: 'CREATE', id: 'col_tmp', name: NAME, initialModeId: 'mode_tmp', hiddenFromPublishing: true }],
    variables: [
      { action: 'CREATE', id: 'v1_tmp', name: 'c_test_holiday/FILEKEYAAAA01', variableCollectionId: 'col_tmp', resolvedType: 'STRING', hiddenFromPublishing: true },
      { action: 'CREATE', id: 'v2_tmp', name: 'c_test_holiday/FILEKEYAAAA02', variableCollectionId: 'col_tmp', resolvedType: 'STRING', hiddenFromPublishing: true },
      { action: 'CREATE', id: 'v3_tmp', name: 'c_test_spring/FILEKEYAAAA03', variableCollectionId: 'col_tmp', resolvedType: 'STRING', hiddenFromPublishing: true },
    ],
    variableModeValues: [
      { variableId: 'v1_tmp', modeId: 'mode_tmp', value: entry('c_test_holiday', 'FILEKEYAAAA01', 1) },
      { variableId: 'v2_tmp', modeId: 'mode_tmp', value: entry('c_test_holiday', 'FILEKEYAAAA02', 2) },
      { variableId: 'v3_tmp', modeId: 'mode_tmp', value: entry('c_test_spring', 'FILEKEYAAAA03', 3) },
    ],
  })
  report(create.ok, 'Can write variables (create a test collection with 3 entries)', create.ok
    ? 'Wrote in ' + create.ms + ' ms'
    : explain(create) + '\n     403 usually means: the token lacks File variables (write), or you can’t edit this file.')
  if (!create.ok) return finish()
  const ids = (create.json.meta && create.json.meta.tempIdToRealId) || {}
  const colId = ids.col_tmp
  const modeId = ids.mode_tmp

  // 4. Read back
  const read1 = await readCollection(key, NAME)
  const ok4 = read1.r.ok && read1.col && read1.vars.length === 3
  report(ok4, 'Entries read back correctly', ok4 ? 'Read in ' + read1.r.ms + ' ms: ' + read1.vars.map((v) => v.name).join(', ') : explain(read1.r))
  if (ok4) {
    const v = read1.vars.find((x) => x.name === 'c_test_holiday/FILEKEYAAAA01')
    const value = v && v.valuesByMode ? v.valuesByMode[modeId || Object.keys(v.valuesByMode)[0]] : null
    let parsedValue = null
    try { parsedValue = JSON.parse(value) } catch (e) { /* not JSON */ }
    report(!!(parsedValue && parsedValue.campaign === 'c_test_holiday'), 'Stored JSON text survives the round trip', parsedValue ? 'Value: ' + value : 'Got: ' + JSON.stringify(value))
  }

  // 5. Update one entry (what happens when someone adds more frames to a file)
  const target = ok4 && read1.vars.find((x) => x.name === 'c_test_holiday/FILEKEYAAAA02')
  if (target) {
    const upd = await call('POST', '/v1/files/' + key + '/variables', {
      variableModeValues: [{ variableId: target.id, modeId: modeId, value: entry('c_test_holiday', 'FILEKEYAAAA02', 9) }],
    })
    const read2 = await readCollection(key, NAME)
    const after = read2.vars && read2.vars.find((x) => x.id === target.id)
    const val = after && after.valuesByMode ? after.valuesByMode[modeId] : ''
    report(upd.ok && /"frames":9/.test(String(val)), 'Can update an entry', upd.ok ? 'Updated in ' + upd.ms + ' ms' : explain(upd))
  }

  // 6. How long can one entry be?
  for (const size of [2000, 20000, 100000]) {
    const big = JSON.stringify({ v: 1, pad: 'x'.repeat(size) })
    const r = await call('POST', '/v1/files/' + key + '/variables', {
      variables: [{ action: 'CREATE', id: 'big_' + size, name: 'c_test_size/len_' + size, variableCollectionId: colId, resolvedType: 'STRING', hiddenFromPublishing: true }],
      variableModeValues: [{ variableId: 'big_' + size, modeId: modeId, value: big }],
    })
    // Informational only: Showroom entries are ~200 characters, so a limit here isn't a failure.
    console.log('INFO ' + 'An entry of ~' + size.toLocaleString() + ' characters ' + (r.ok ? 'is accepted (' + r.ms + ' ms)' : 'is refused: ' + explain(r) + ' (fine: Showroom entries are ~200 characters)'))
    if (!r.ok) break
  }

  // 7. Names with a campaign ID and file key are accepted as-is
  const odd = await call('POST', '/v1/files/' + key + '/variables', {
    variables: [{ action: 'CREATE', id: 'odd_tmp', name: 'c_mg5x2k9a_ab12c/Zq9XyW7vUt6SrQp5On4Ml3', variableCollectionId: colId, resolvedType: 'STRING', hiddenFromPublishing: true }],
    variableModeValues: [{ variableId: 'odd_tmp', modeId: modeId, value: '{}' }],
  })
  report(odd.ok, 'Realistic entry names are accepted (campaign ID / file key)', odd.ok ? '' : explain(odd))

  // 8. Quick polling cost check: 3 reads in a row
  const times = []
  for (let i = 0; i < 3; i++) { const r = await call('GET', '/v1/files/' + key + '/variables/local'); times.push(r.ok ? r.ms + ' ms' : explain(r)) }
  info('Three back-to-back reads: ' + times.join(', '))

  // 9. Clean up
  if (!keep && colId) {
    const del = await call('POST', '/v1/files/' + key + '/variables', { variableCollections: [{ action: 'DELETE', id: colId }] })
    report(del.ok, 'Test collection deleted', del.ok ? '' : explain(del) + ' (delete "' + NAME + '" from the file’s Variables panel by hand)')
  } else if (keep) {
    info('Kept the test collection "' + NAME + '". Open the file’s Variables panel to see it.')
  }
  finish()
}

function finish() {
  const failed = results.filter((r) => !r.ok)
  console.log('\n' + (results.length - failed.length) + ' of ' + results.length + ' checks passed.')
  console.log(failed.length ? 'Copy everything above and send it to Claude.' : 'Looks good. Send this output to Claude so the index can be built on it.')
  process.exit(0)
}

main().catch((e) => { console.error('\nThe script stopped unexpectedly:', e && e.message ? e.message : e); console.log('Copy everything above and send it to Claude.'); process.exit(1) })
