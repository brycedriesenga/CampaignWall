// Showroom — code.js
// Runs in Figma's plugin sandbox. It owns this computer's storage, the current selection,
// this file's identity, the campaign list stored inside this file, and navigation.
// All calls to Figma's REST API happen in ui.html, because only the UI window can use the network.
//
// Where campaign membership lives (so the whole team sees the same campaigns):
//   Every design file that has campaign frames carries a small "manifest" in its own shared
//   plugin data: which campaigns, which frames, which channel, plus links to the other campaign
//   files it knows of. Teammates' plugins find those manifests by following the links and by
//   searching the team's folders through the API (see discover() in ui.html).
//   This computer's storage only keeps personal things: token, cache, what you've seen, hidden items.

const NS = 'showroom';                     // shared plugin data namespace
const MANIFEST_KEY = 'manifest';           // file root (+ first page, as a backup copy)
const DATA_KEY = 'showroom.data';          // personal: active campaign, drafts, seen, hidden
const TOKEN_KEY = 'showroom.token';        // personal access token (this computer only)
const CACHE_KEY = 'showroom.cache';        // what the wall last saw from the API
const SCAN_KEY = 'showroom.scan';          // what the folder search found
const PREFS_KEY = 'showroom.prefs';        // window size, extra folders, etc.
// Storage from the "Campaign Wall" test builds. The token and a few preferences carry over
// once; everything else is cleared, since the team starts fresh with Showroom.
const OLD_KEYS = ['cw.data.v1', 'cw.token', 'cw.cache.v1', 'cw.scan.v1', 'cw.prefs.v1'];
const PANEL_SIZE = { width: 360, height: 640 };
const MANIFEST_LIMIT = 95000;              // Figma allows 100 kB per plugin data entry
const LINK_LIMIT = 300;                    // most other campaign files one manifest links to
const ELIGIBLE = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION'];
const DEFAULT_CHANNELS = ['Site', 'Email', 'Social', 'Display ads', 'Amazon', 'Retail', 'Other'];
const AD_SIZES = ['300x250', '728x90', '160x600', '300x600', '320x50', '320x100', '970x250', '970x90',
  '336x280', '468x60', '250x250', '200x200', '300x50', '120x600'];

// ---------- personal storage ----------
function emptyData() {
  return { version: 1, campaigns: [], activeCampaignId: '', channels: DEFAULT_CHANNELS.slice(), seen: {}, hidden: [], hiddenItems: {} };
}
async function loadData() {
  const d = await figma.clientStorage.getAsync(DATA_KEY);
  if (!d || !Array.isArray(d.campaigns)) return emptyData();
  if (!Array.isArray(d.channels) || !d.channels.length) d.channels = DEFAULT_CHANNELS.slice();
  if (!d.seen) d.seen = {};
  if (!Array.isArray(d.hidden)) d.hidden = [];
  if (!d.hiddenItems) d.hiddenItems = {};
  return d;
}
async function saveData(d) {
  d.rev = (d.rev || 0) + 1;            // lets other open copies of the plugin notice the change
  d.savedAt = Date.now();
  await figma.clientStorage.setAsync(DATA_KEY, d);
}
async function loadPrefs() { return (await figma.clientStorage.getAsync(PREFS_KEY)) || {}; }

// ---------- helpers ----------
function randomId(prefix) {
  return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

// figma.fileKey needs "enablePrivatePluginApi" (dev or org-private plugins). If it's
// missing, the user pastes the file's link once and we keep the key on the file itself.
function currentFileKey() {
  if (figma.fileKey) return figma.fileKey;
  return figma.root.getSharedPluginData(NS, 'fileKey') || '';
}

function parseFileKey(url) {
  const text = String(url || '').trim();
  const branch = text.match(/figma\.com\/(?:design|file)\/[A-Za-z0-9]+\/branch\/([A-Za-z0-9]+)/);
  if (branch) return branch[1];
  const main = text.match(/figma\.com\/(?:design|file|proto)\/([A-Za-z0-9]{10,})/);
  return main ? main[1] : '';
}

function guessChannel(width, height) {
  const w = Math.round(width);
  const h = Math.round(height);
  if (AD_SIZES.indexOf(w + 'x' + h) >= 0) return 'Display ads';
  if ((w === 1080 && (h === 1080 || h === 1350 || h === 1920 || h === 566)) || (w === 1200 && h === 628) ||
      (w === 1000 && h === 1500)) return 'Social';
  if (w >= 560 && w <= 700 && h > w) return 'Email';
  if (w >= 1200) return 'Site';
  if (w >= 360 && w <= 430 && h > w) return 'Site';
  return 'Other';
}

function isEligible(node) {
  return ELIGIBLE.indexOf(node.type) >= 0 && node.id.indexOf('I') !== 0;
}

function findPage(node) {
  let current = node;
  while (current && current.type !== 'PAGE') current = current.parent;
  return current;
}

function whoAmI() {
  try { return figma.currentUser ? figma.currentUser.name : ''; } catch (e) { return ''; }
}
// Your Figma profile picture, saved with frames you add so teammates see your face, not initials.
function myPhoto() {
  try { return figma.currentUser ? figma.currentUser.photoUrl || '' : ''; } catch (e) { return ''; }
}

// ---------- the manifest stored inside this file ----------
function parseManifest(raw) {
  try {
    const m = raw ? JSON.parse(raw) : null;
    return m && m.campaigns && typeof m.campaigns === 'object' ? m : null;
  } catch (e) { return null; }
}

function readManifest() {
  // Root copy is the main one; the first page holds a backup copy. Use whichever is newer.
  const fromRoot = parseManifest(figma.root.getSharedPluginData(NS, MANIFEST_KEY));
  const page = figma.root.children[0];
  const fromPage = page ? parseManifest(page.getSharedPluginData(NS, MANIFEST_KEY)) : null;
  let best = fromRoot;
  if (fromPage && (!best || (fromPage.updatedAt || 0) > (best.updatedAt || 0))) best = fromPage;
  return best || { v: 1, campaigns: {} };
}

function writeManifest(manifest) {
  manifest.v = 1;
  manifest.fileKey = currentFileKey();
  manifest.fileName = figma.root.name;
  manifest.updatedAt = Date.now();
  for (const id of Object.keys(manifest.campaigns)) {
    const c = manifest.campaigns[id];
    if (!c.items || !Object.keys(c.items).length) delete manifest.campaigns[id];
  }
  let json = JSON.stringify(manifest);
  // Links to other files are only a shortcut for finding them, so drop them before refusing.
  if (json.length > MANIFEST_LIMIT && manifest.links) { delete manifest.links; json = JSON.stringify(manifest); }
  if (json.length > MANIFEST_LIMIT && manifest.layouts) { delete manifest.layouts; json = JSON.stringify(manifest); }
  if (json.length > MANIFEST_LIMIT) throw new Error('This file has too many campaign frames for one file’s storage. Remove some older campaigns from it first.');
  figma.root.setSharedPluginData(NS, MANIFEST_KEY, json);
  const page = figma.root.children[0];
  if (page) page.setSharedPluginData(NS, MANIFEST_KEY, json);
}

function readTags(node) {
  try {
    const raw = node.getSharedPluginData(NS, 'campaigns');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

// A tag on the frame too, so Figma shows a relaunch button for it in the right sidebar.
function tagNode(node, campaignId, add) {
  const tags = readTags(node).filter((id) => id !== campaignId);
  if (add) tags.push(campaignId);
  node.setSharedPluginData(NS, 'campaigns', tags.length ? JSON.stringify(tags) : '');
  if (tags.length) node.setRelaunchData({ open: 'In ' + tags.length + ' campaign' + (tags.length === 1 ? '' : 's') });
  else node.setRelaunchData({});
}

function selectionInfo(manifest) {
  const items = [];
  let skipped = 0;
  for (const node of figma.currentPage.selection) {
    if (!isEligible(node)) { skipped += 1; continue; }
    const inCampaigns = Object.keys(manifest.campaigns).filter((cid) => manifest.campaigns[cid].items[node.id]);
    items.push({
      id: node.id, name: node.name, type: node.type,
      width: Math.round(node.width), height: Math.round(node.height),
      guess: guessChannel(node.width, node.height), inCampaigns: inCampaigns,
    });
  }
  return { items: items, skipped: skipped, total: figma.currentPage.selection.length };
}

async function sendState(extra) {
  const data = await loadData();
  const token = (await figma.clientStorage.getAsync(TOKEN_KEY)) || '';
  const cache = (await figma.clientStorage.getAsync(CACHE_KEY)) || { files: {} };
  const scan = (await figma.clientStorage.getAsync(SCAN_KEY)) || { files: {} };
  const prefs = await loadPrefs();
  const manifest = readManifest();
  watched.rev = data.rev || 0;
  watched.cacheAt = cache.savedAt || 0;
  watched.scanAt = scan.savedAt || 0;
  watched.manifestAt = manifest.updatedAt || 0;
  figma.ui.postMessage(Object.assign({
    type: 'state', data: data, token: token, cache: cache, scan: scan, prefs: prefs,
    selection: selectionInfo(manifest),
    file: { key: currentFileKey(), name: figma.root.name, keyFromApi: !!figma.fileKey, manifest: manifest },
    editor: figma.editorType, board: figma.editorType === 'figjam' ? boardSummary() : null,
  }, extra || {}));
}

async function sendSelection() {
  figma.ui.postMessage({ type: 'selection', selection: selectionInfo(readManifest()) });
}

function localCampaign(data, id, name) {
  let c = data.campaigns.find((x) => x.id === id);
  if (!c && name) { c = { id: id, name: name, createdAt: Date.now(), items: [] }; data.campaigns.push(c); }
  return c;
}

// One-time move from the "Campaign Wall" test builds: keep the token and window/folder
// preferences, drop the old campaigns and caches.
async function carryOverOldStorage() {
  const keys = await figma.clientStorage.keysAsync();
  if (!OLD_KEYS.some((k) => keys.indexOf(k) >= 0)) return;
  if (keys.indexOf(TOKEN_KEY) < 0) {
    const token = await figma.clientStorage.getAsync('cw.token');
    if (token) await figma.clientStorage.setAsync(TOKEN_KEY, token);
  }
  if (keys.indexOf(PREFS_KEY) < 0) {
    const prefs = await figma.clientStorage.getAsync('cw.prefs.v1');
    if (prefs) await figma.clientStorage.setAsync(PREFS_KEY, prefs);
  }
  for (const k of OLD_KEYS) if (keys.indexOf(k) >= 0) await figma.clientStorage.deleteAsync(k);
}

// ---------- actions ----------
async function addSelection(msg) {
  if (figma.editorType === 'figjam') return { message: 'Frames are added from design files. On a board, use Send to board.' };
  const data = await loadData();
  const fileKey = currentFileKey();
  if (!fileKey) return { needFileKey: true };
  const name = String(msg.campaignName || '').trim();
  const local = localCampaign(data, msg.campaignId, name);
  const campaignName = name || (local && local.name) || 'Campaign';
  if (local) local.items = [];
  const manifest = readManifest();
  const camp = manifest.campaigns[msg.campaignId] || (manifest.campaigns[msg.campaignId] = { name: campaignName, updatedAt: Date.now(), items: {} });
  const page = figma.currentPage;
  let added = 0;
  let updated = 0;
  for (const node of page.selection) {
    if (!isEligible(node)) continue;
    const existing = camp.items[node.id];
    const channel = msg.channel && msg.channel !== 'auto'
      ? msg.channel
      : (existing ? existing.channel : guessChannel(node.width, node.height));
    camp.items[node.id] = {
      name: node.name, w: Math.round(node.width), h: Math.round(node.height), pageName: page.name, channel: channel,
      addedBy: existing ? existing.addedBy : whoAmI(), addedByPhoto: existing ? existing.addedByPhoto || '' : myPhoto(), addedAt: existing ? existing.addedAt : Date.now(), updatedAt: Date.now(),
    };
    if (existing) updated += 1; else added += 1;
    tagNode(node, msg.campaignId, true);
    const hiddenList = data.hiddenItems[msg.campaignId];
    if (hiddenList) data.hiddenItems[msg.campaignId] = hiddenList.filter((id) => id !== fileKey + '|' + node.id);
  }
  writeManifest(manifest);
  data.activeCampaignId = msg.campaignId;
  data.hidden = data.hidden.filter((id) => id !== msg.campaignId);
  await saveData(data);
  const parts = [];
  if (added) parts.push(added + ' added');
  if (updated) parts.push(updated + ' updated');
  return { message: (parts.join(', ') || 'Nothing to add') + ' in ' + campaignName + '. Your team will see ' + (added + updated === 1 ? 'it' : 'them') + ' too.' };
}

async function removeItems(msg) {
  const data = await loadData();
  const key = currentFileKey();
  const manifest = readManifest();
  const ids = Array.isArray(msg.itemIds) ? msg.itemIds : [msg.itemId];
  let removed = 0;
  let hidden = 0;
  let manifestChanged = false;
  for (const id of ids) {
    const bar = id.indexOf('|');
    const fileKey = id.slice(0, bar);
    const nodeId = id.slice(bar + 1);
    const camp = manifest.campaigns[msg.campaignId];
    if (fileKey === key && camp && camp.items[nodeId]) {
      delete camp.items[nodeId];
      manifestChanged = true;
      const node = await figma.getNodeByIdAsync(nodeId);
      if (node && 'setSharedPluginData' in node) tagNode(node, msg.campaignId, false);
      removed += 1;
      continue;
    }
    // It belongs to another file: only that file can change the team's list. Hide it for you.
    const list = data.hiddenItems[msg.campaignId] || (data.hiddenItems[msg.campaignId] = []);
    if (list.indexOf(id) < 0) list.push(id);
    hidden += 1;
  }
  if (manifestChanged) writeManifest(manifest);
  await saveData(data);
  const parts = [];
  if (removed) parts.push((removed === 1 ? 'Removed' : removed + ' removed') + ' for everyone');
  if (hidden) parts.push((hidden === 1 ? '1 frame lives' : hidden + ' frames live') + ' in other files, so ' + (hidden === 1 ? 'it’s' : 'they’re') + ' hidden on your wall only. Remove ' + (hidden === 1 ? 'it' : 'them') + ' from ' + (hidden === 1 ? 'its' : 'their') + ' file to remove for everyone');
  return { message: parts.join('. ') + '.' };
}

async function setChannel(msg) {
  const data = await loadData();
  const key = currentFileKey();
  const manifest = readManifest();
  const ids = Array.isArray(msg.itemIds) ? msg.itemIds : [msg.itemId];
  let changed = 0;
  let elsewhere = 0;
  let manifestChanged = false;
  for (const id of ids) {
    const bar = id.indexOf('|');
    const fileKey = id.slice(0, bar);
    const nodeId = id.slice(bar + 1);
    const camp = manifest.campaigns[msg.campaignId];
    if (fileKey === key && camp && camp.items[nodeId]) {
      camp.items[nodeId].channel = msg.channel;
      camp.items[nodeId].updatedAt = Date.now();
      manifestChanged = true; changed += 1; continue;
    }
    elsewhere += 1;
  }
  if (manifestChanged) writeManifest(manifest);
  await saveData(data);
  if (elsewhere) return { error: (elsewhere === 1 ? 'That frame lives' : elsewhere + ' frames live') + ' in another file. Open ' + (elsewhere === 1 ? 'it' : 'them') + ' there to change the channel for everyone.' + (changed ? ' ' + changed + ' changed.' : '') };
  return { message: 'Channel updated.' };
}

async function openItem(msg) {
  const fileKey = msg.fileKey;
  const nodeId = msg.nodeId;
  if (msg.proto) {
    const nid = encodeURIComponent(nodeId.replace(/:/g, '-'));
    figma.openExternal('https://www.figma.com/proto/' + fileKey + '/?node-id=' + nid + '&starting-point-node-id=' + nid);
    return { message: 'Opening the prototype in your browser…' };
  }
  if (fileKey && fileKey === currentFileKey() && !msg.versionId) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      const page = findPage(node);
      if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      return { message: 'Selected “' + node.name + '” in this file.' };
    }
  }
  let url = 'https://www.figma.com/design/' + fileKey + '/?node-id=' + encodeURIComponent(nodeId.replace(/:/g, '-'));
  if (msg.versionId) url += '&version-id=' + encodeURIComponent(msg.versionId);
  figma.openExternal(url);
  return { message: msg.versionId ? 'Opening that version in Figma…' : 'Opening the design in its file…' };
}

async function handle(msg) {
  switch (msg.type) {
    case 'init':
      await carryOverOldStorage();
      return sendState();
    case 'save-token':
      await figma.clientStorage.setAsync(TOKEN_KEY, String(msg.token || '').trim());
      return sendState({ message: msg.token ? 'Token saved on this computer.' : 'Token removed.' });
    case 'create-campaign': {
      const name = String(msg.name || '').trim();
      if (!name) throw new Error('Give the campaign a name.');
      const data = await loadData();
      const campaign = { id: randomId('c_'), name: name, createdAt: Date.now(), items: [] };
      data.campaigns.push(campaign);
      data.activeCampaignId = campaign.id;
      await saveData(data);
      return sendState({ message: 'Created “' + name + '”. It appears for your team once you add frames to it.' });
    }
    case 'rename-campaign': {
      const name = String(msg.name || '').trim();
      if (!name) throw new Error('Give the campaign a name.');
      const data = await loadData();
      const local = localCampaign(data, msg.campaignId, name);
      local.name = name;
      local.renamedAt = Date.now();
      const manifest = readManifest();
      if (manifest.campaigns[msg.campaignId]) {
        manifest.campaigns[msg.campaignId].name = name;
        manifest.campaigns[msg.campaignId].updatedAt = Date.now();
        writeManifest(manifest);
      }
      await saveData(data);
      return sendState({ message: 'Renamed. Other files pick up the new name as they’re edited.' });
    }
    case 'hide-campaign': {
      const data = await loadData();
      if (data.hidden.indexOf(msg.campaignId) < 0) data.hidden.push(msg.campaignId);
      const local = data.campaigns.find((c) => c.id === msg.campaignId);
      if (local && !(local.items || []).length && !msg.shared) data.campaigns = data.campaigns.filter((c) => c.id !== msg.campaignId);
      if (data.activeCampaignId === msg.campaignId) data.activeCampaignId = '';
      await saveData(data);
      return sendState({ message: msg.shared ? 'Hidden from your list. Frames in files and your team’s view aren’t changed.' : 'Campaign deleted.' });
    }
    case 'unhide-campaign': {
      const data = await loadData();
      data.hidden = data.hidden.filter((id) => id !== msg.campaignId);
      data.activeCampaignId = msg.campaignId;
      await saveData(data);
      return sendState({ message: 'Campaign shown again.' });
    }
    case 'unhide-items': {
      const data = await loadData();
      delete data.hiddenItems[msg.campaignId];
      await saveData(data);
      return sendState({ message: 'Hidden frames shown again.' });
    }
    case 'set-active': {
      const data = await loadData();
      data.activeCampaignId = msg.campaignId;
      localCampaign(data, msg.campaignId, msg.campaignName);
      await saveData(data);
      return sendState();
    }
    case 'add-selection':
      return sendState(await addSelection(msg));
    case 'remove-item':
      return sendState(await removeItems(msg));
    case 'set-channel': {
      const result = await setChannel(msg);
      if (result.error) { await sendState(); figma.ui.postMessage({ type: 'error', message: result.error }); return; }
      return sendState(result);
    }
    case 'mark-seen': {
      const data = await loadData();
      Object.assign(data.seen, msg.seen || {});
      await saveData(data);
      return sendState();
    }
    case 'set-file-key': {
      const key = parseFileKey(msg.url);
      if (!key) throw new Error('That doesn’t look like a Figma file link. Use Share › Copy link.');
      figma.root.setSharedPluginData(NS, 'fileKey', key);
      return sendState({ message: 'Link saved for this file.' });
    }
    case 'save-links': {
      // The UI sends every campaign file it knows of. Save that list in this file's manifest
      // (only if this file has campaign frames, and only if the list of files changed), so
      // anyone reading this file can go straight to the others.
      const manifest = readManifest();
      if (!Object.keys(manifest.campaigns).length) return;
      const here = currentFileKey();
      const links = {};
      let count = 0;
      for (const key of Object.keys(msg.links || {})) {
        if (key === here || !/^[A-Za-z0-9]{10,}$/.test(key)) continue;
        if (count++ >= LINK_LIMIT) break;
        links[key] = String(msg.links[key] || '').slice(0, 60);
      }
      const before = Object.keys(manifest.links || {}).sort().join(',');
      if (Object.keys(links).sort().join(',') === before) return;
      manifest.links = links;
      try { writeManifest(manifest); } catch (e) { return; }   // e.g. a file you can only view
      return sendState({ external: true });
    }
    case 'board-place':
      return sendState(await boardPlace(msg));
    case 'board-sync':
      return sendState(await boardSync(msg));
    case 'save-status': {
      // Review statuses for frames in a campaign (from any file). Saved in this file's manifest;
      // the newest change per frame wins across files. Keeps the 50 most recent campaigns.
      const manifest = readManifest();
      const statuses = Object.assign({}, manifest.statuses || {});
      statuses[msg.campaignId] = Object.assign({}, statuses[msg.campaignId] || {}, msg.changes || {});
      const newest = (cid) => Math.max.apply(null, [0].concat(Object.values(statuses[cid] || {}).map((e) => (e && e.at) || 0)));
      Object.keys(statuses).sort((a, b) => newest(b) - newest(a)).slice(50).forEach((k) => { delete statuses[k]; });
      manifest.statuses = statuses;
      try { writeManifest(manifest); } catch (e) { return sendState({ message: 'Status saved for you only: this file can’t be edited.' }); }
      return sendState({ external: true });
    }
    case 'save-layout': {
      // A campaign's frame order (from dragging frames on the wall). Saved in this file's
      // manifest so it travels to the team; newest wins. Keeps the 50 most recent campaigns.
      const manifest = readManifest();
      const layouts = Object.assign({}, manifest.layouts || {});
      layouts[msg.campaignId] = msg.layout;
      const keys = Object.keys(layouts).sort((a, b) => ((layouts[b] && layouts[b].at) || 0) - ((layouts[a] && layouts[a].at) || 0));
      keys.slice(50).forEach((k) => { delete layouts[k]; });
      manifest.layouts = layouts;
      try { writeManifest(manifest); } catch (e) { return sendState({ message: 'Order saved for you only: this file can’t be edited.' }); }
      return sendState({ external: true });
    }
    case 'save-cache':
      await figma.clientStorage.setAsync(CACHE_KEY, msg.cache || { files: {} });
      watched.cacheAt = (msg.cache && msg.cache.savedAt) || watched.cacheAt;
      return;
    case 'save-scan':
      await figma.clientStorage.setAsync(SCAN_KEY, msg.scan || { files: {} });
      watched.scanAt = (msg.scan && msg.scan.savedAt) || watched.scanAt;
      return;
    case 'save-prefs': {
      const prefs = Object.assign(await loadPrefs(), msg.prefs || {});
      await figma.clientStorage.setAsync(PREFS_KEY, prefs);
      return;
    }
    case 'resize': {
      const w = Math.max(320, Math.min(4000, Math.round(msg.width || PANEL_SIZE.width)));
      const h = Math.max(360, Math.min(3000, Math.round(msg.height || PANEL_SIZE.height)));
      figma.ui.resize(w, h);
      return;
    }
    case 'open-item':
      return sendState(await openItem(msg));
    case 'notify':
      figma.notify(String(msg.text || '').slice(0, 140), { error: !!msg.error });
      return;
    default:
      throw new Error('Unknown action: ' + msg.type);
  }
}

// ---------- FigJam boards: place a campaign's frames, then keep them in sync ----------
// Each placed image is a rectangle with an image fill, tagged (shared plugin data "showroom/boardItem")
// with the frame it shows. Sync swaps in new renders in place, so anything people arranged, drew or
// stuck around them stays put. New frames land in an "Inbox" section.
const BOARD = { gap: 120, labelH: 92, pad: 96, rowMax: 12000, titleH: 140 };
const STATUS_COLORS = { approved: { r: 0.08, g: 0.68, b: 0.36 }, review: { r: 0.79, g: 0.54, b: 0 }, draft: { r: 0.5, g: 0.5, b: 0.5 } };
const STATUS_NAMES = { approved: 'Approved', review: 'In review', draft: 'Draft' };

function frameLink(item) { return 'https://www.figma.com/design/' + item.fileKey + '/?node-id=' + encodeURIComponent(String(item.nodeId).replace(':', '-')); }
function fileLink(item) { return 'https://www.figma.com/design/' + item.fileKey + '/'; }

async function boardFonts() {
  const fonts = [{ family: 'Inter', style: 'Bold' }, { family: 'Inter', style: 'Regular' }];
  for (const f of fonts) { try { await figma.loadFontAsync(f); } catch (e) { /* fall back to whatever loads */ } }
}
function boardText(chars, size, bold, color) {
  const t = figma.createText();
  try { t.fontName = { family: 'Inter', style: bold ? 'Bold' : 'Regular' }; } catch (e) {}
  t.characters = chars;
  t.fontSize = size;
  if (color) t.fills = [{ type: 'SOLID', color: color }];
  return t;
}
function makeSection(name) {
  // Sections group the board neatly; if this editor can't make one, a plain frame does the job.
  try { const s = figma.createSection(); s.name = name; return s; } catch (e) {
    const f = figma.createFrame(); f.name = name; f.fills = []; return f;
  }
}
function sizeSection(sec, w, h) {
  if (sec.resizeWithoutConstraints) sec.resizeWithoutConstraints(Math.max(200, w), Math.max(200, h));
  else sec.resize(Math.max(200, w), Math.max(200, h));
}
// The label above a frame: name, then "Status · Channel · File", then a live link to the frame.
function itemLabel(item) {
  const name = boardText(item.name || 'Frame', 28, true);
  const metaText = (item.status ? STATUS_NAMES[item.status] + ' · ' : '') + item.channel + ' · ' + (item.fileName || 'File');
  const meta = boardText(metaText, 18, false, { r: 0.42, g: 0.42, b: 0.42 });
  if (item.status && STATUS_COLORS[item.status]) meta.setRangeFills(0, STATUS_NAMES[item.status].length, [{ type: 'SOLID', color: STATUS_COLORS[item.status] }]);
  const link = boardText('Open live ↗', 18, false, { r: 0.05, g: 0.6, b: 1 });
  try { link.hyperlink = { type: 'URL', value: frameLink(item) }; } catch (e) {}
  return [name, meta, link];
}
async function placeImage(item, scale) {
  const rect = figma.createRectangle();
  rect.name = item.name || 'Frame';
  const w = Math.max(40, Math.round((item.w || 400) * scale)), h = Math.max(40, Math.round((item.h || 300) * scale));
  rect.resize(w, h);
  rect.fills = [{ type: 'SOLID', color: { r: 0.93, g: 0.93, b: 0.93 } }];
  if (item.url) {
    try { const img = await figma.createImageAsync(item.url); rect.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }]; } catch (e) { rect.name += ' (image didn’t load)'; }
  }
  rect.setSharedPluginData(NS, 'boardItem', JSON.stringify({ campaignId: item.campaignId, itemId: item.id, fileKey: item.fileKey, nodeId: item.nodeId, hash: item.hash || '', status: item.status || '', scale: scale, syncedAt: Date.now() }));
  return rect;
}
// Places a list of frames in rows inside a section, each with its label. Returns the content size.
async function layOut(sec, items, scale, x0, y0) {
  let x = x0, y = y0, rowH = 0, maxX = x0, placed = 0;
  for (const item of items) {
    const w = Math.max(40, Math.round((item.w || 400) * scale)), h = Math.max(40, Math.round((item.h || 300) * scale));
    if (x > x0 && x + w > x0 + BOARD.rowMax) { x = x0; y += rowH + BOARD.labelH + BOARD.gap; rowH = 0; }
    const [name, meta, link] = itemLabel(item)
    const rect = await placeImage(item, scale)
    sec.appendChild(name); sec.appendChild(meta); sec.appendChild(link); sec.appendChild(rect)
    name.x = x; name.y = y; meta.x = x; meta.y = y + 36; link.x = x + Math.max(meta.width + 16, 0); link.y = y + 36
    rect.x = x; rect.y = y + BOARD.labelH
    for (const t of [name, meta, link]) t.setSharedPluginData(NS, 'boardLabel', JSON.stringify({ itemId: item.id, part: t === name ? 'name' : t === meta ? 'meta' : 'link' }))
    x += w + BOARD.gap; rowH = Math.max(rowH, h); maxX = Math.max(maxX, x - BOARD.gap); placed += 1
  }
  return { w: maxX - x0, h: (y - y0) + BOARD.labelH + rowH, placed: placed }
}
async function addEmbeds(sec, items, mode, x0, y0) {
  if (mode === 'none' || !figma.createLinkPreviewAsync) return 0;
  const urls = [];
  const seen = {};
  for (const it of items) {
    const url = mode === 'frame' ? frameLink(it) : fileLink(it);
    if (!seen[url]) { seen[url] = true; urls.push(url); }
  }
  // Embeds report a placeholder size until they've loaded, so make them all, ask for a uniform
  // size, give them a moment, then measure and space them out in a row.
  const nodes = [];
  for (const url of urls) {
    try {
      const node = await figma.createLinkPreviewAsync(url);
      sec.appendChild(node);
      try { node.resize(960, 540); } catch (e) { /* this embed keeps its own size */ }
      nodes.push(node);
    } catch (e) { /* Figma couldn't make an embed for this link; the "Open live" links still work */ }
  }
  if (!nodes.length) return 0;
  await new Promise((r) => setTimeout(r, 1200));
  let x = x0, h = 0;
  for (const node of nodes) {
    const w = node.width >= 300 ? node.width : 1152, nh = node.height >= 150 ? node.height : 648;
    node.x = x; node.y = y0;
    x += w + 80; h = Math.max(h, nh);
  }
  return h;
}
function boardNodes(campaignId) {
  const page = figma.currentPage
  const find = (key) => page.findAllWithCriteria ? page.findAllWithCriteria({ sharedPluginData: { namespace: NS, keys: [key] } }) : page.findAll((n) => !!n.getSharedPluginData(NS, key))
  const items = find('boardItem').map((n) => { let d = {}; try { d = JSON.parse(n.getSharedPluginData(NS, 'boardItem')) } catch (e) {} return { node: n, data: d } }).filter((x) => !campaignId || x.data.campaignId === campaignId)
  const boards = find('board').map((n) => { let d = {}; try { d = JSON.parse(n.getSharedPluginData(NS, 'board')) } catch (e) {} return { node: n, data: d } }).filter((x) => !campaignId || x.data.campaignId === campaignId)
  return { items: items, boards: boards }
}
// What's on this board, per campaign: shown in the panel.
function boardSummary() {
  try {
    const found = boardNodes('')
    const out = {}
    for (const b of found.boards) out[b.data.campaignId] = { campaignId: b.data.campaignId, name: b.data.name, placedAt: b.data.placedAt, syncedAt: b.data.syncedAt || b.data.placedAt, count: 0 }
    for (const it of found.items) { const o = out[it.data.campaignId] || (out[it.data.campaignId] = { campaignId: it.data.campaignId, count: 0 }); o.count += 1 }
    return out
  } catch (e) { return {} }
}
function emptySpot() {
  const kids = figma.currentPage.children
  if (!kids.length) return { x: 0, y: 0 }
  let maxX = -Infinity, minY = Infinity
  for (const n of kids) { maxX = Math.max(maxX, n.x + n.width); minY = Math.min(minY, n.y) }
  return { x: Math.round(maxX + 600), y: Math.round(minY) }
}

async function boardPlace(msg) {
  if (figma.editorType !== 'figjam') return { message: 'Open a FigJam board to send a campaign to it.' }
  await boardFonts()
  const scale = msg.scale === 0.5 ? 0.5 : 1
  const items = (msg.items || []).map((it) => Object.assign({ campaignId: msg.campaignId }, it))
  const spot = emptySpot()
  const outer = makeSection(msg.campaignName + ' · Showroom')
  figma.currentPage.appendChild(outer)
  outer.x = spot.x; outer.y = spot.y
  const title = boardText(msg.campaignName, 64, true)
  const sub = boardText(items.length + ' frames · placed by ' + whoAmI() + ' · ' + new Date().toLocaleDateString(), 22, false, { r: 0.42, g: 0.42, b: 0.42 })
  outer.appendChild(title); outer.appendChild(sub)
  title.x = BOARD.pad; title.y = BOARD.pad; sub.x = BOARD.pad; sub.y = BOARD.pad + 82
  let y = BOARD.pad + BOARD.titleH
  const embedH = await addEmbeds(outer, items, msg.embeds || 'file', BOARD.pad, y)
  if (embedH) y += embedH + BOARD.gap
  // One section per channel, in the campaign's channel order.
  const channels = []
  items.forEach((it) => { if (channels.indexOf(it.channel) < 0) channels.push(it.channel) })
  let maxW = 1200
  for (const ch of channels) {
    const list = items.filter((it) => it.channel === ch)
    const sec = makeSection(ch)
    outer.appendChild(sec)
    sec.x = BOARD.pad; sec.y = y
    const size = await layOut(sec, list, scale, BOARD.pad, BOARD.pad)
    sizeSection(sec, size.w + BOARD.pad * 2, size.h + BOARD.pad * 2)
    sec.setSharedPluginData(NS, 'channel', JSON.stringify({ campaignId: msg.campaignId, channel: ch }))
    y += sec.height + BOARD.gap
    maxW = Math.max(maxW, sec.width)
  }
  sizeSection(outer, maxW + BOARD.pad * 2, y + BOARD.pad - BOARD.gap)
  outer.setSharedPluginData(NS, 'board', JSON.stringify({ campaignId: msg.campaignId, name: msg.campaignName, placedAt: Date.now(), syncedAt: Date.now(), scale: scale }))
  figma.viewport.scrollAndZoomIntoView([outer])
  return { message: 'Placed ' + items.length + ' frame' + (items.length === 1 ? '' : 's') + ' on this board.', boardResult: { placed: items.length } }
}

async function boardSync(msg) {
  if (figma.editorType !== 'figjam') return { message: 'Open the FigJam board to sync it.' }
  await boardFonts()
  const found = boardNodes(msg.campaignId)
  const byId = {}
  ;(msg.items || []).forEach((it) => { byId[it.id] = Object.assign({ campaignId: msg.campaignId }, it) })
  let updated = 0, removed = 0, restatused = 0
  const onBoard = {}
  for (const entry of found.items) {
    const d = entry.data, node = entry.node
    onBoard[d.itemId] = true
    const item = byId[d.itemId]
    if (!item) {
      // No longer in the campaign: fade it and say so, but leave it for people to tidy up.
      if (node.opacity !== 0.35) { node.opacity = 0.35; removed += 1 }
      continue
    }
    if (node.opacity !== 1) node.opacity = 1
    if (item.hash && item.hash !== d.hash && item.url) {
      try {
        const img = await figma.createImageAsync(item.url)
        node.fills = [{ type: 'IMAGE', imageHash: img.hash, scaleMode: 'FILL' }]
        const sc = d.scale || 1
        // Keep the top-left corner where people put it; follow the frame's new size if it changed.
        const w = Math.round((item.w || node.width / sc) * sc), h = Math.round((item.h || node.height / sc) * sc)
        if (Math.abs(w - node.width) > 1 || Math.abs(h - node.height) > 1) node.resize(Math.max(40, w), Math.max(40, h))
        updated += 1
      } catch (e) { /* keep the old image */ }
    }
    if ((item.status || '') !== (d.status || '')) restatused += 1
    node.setSharedPluginData(NS, 'boardItem', JSON.stringify(Object.assign({}, d, { hash: item.hash || d.hash, status: item.status || '', syncedAt: Date.now() })))
  }
  // Refresh label text (names and statuses) for everything that's still in the campaign.
  const labels = figma.currentPage.findAllWithCriteria ? figma.currentPage.findAllWithCriteria({ sharedPluginData: { namespace: NS, keys: ['boardLabel'] } }) : []
  for (const t of labels) {
    let d = {}; try { d = JSON.parse(t.getSharedPluginData(NS, 'boardLabel')) } catch (e) {}
    const item = byId[d.itemId]; if (!item || t.type !== 'TEXT') continue
    try {
      if (d.part === 'name' && t.characters !== item.name) t.characters = item.name
      if (d.part === 'meta') {
        const text = (item.status ? STATUS_NAMES[item.status] + ' · ' : '') + item.channel + ' · ' + (item.fileName || 'File')
        if (t.characters !== text) {
          t.characters = text
          t.fills = [{ type: 'SOLID', color: { r: 0.42, g: 0.42, b: 0.42 } }]
          if (item.status && STATUS_COLORS[item.status]) t.setRangeFills(0, STATUS_NAMES[item.status].length, [{ type: 'SOLID', color: STATUS_COLORS[item.status] }])
        }
      }
    } catch (e) { /* font missing: leave the label */ }
  }
  // New frames go into an Inbox section beside the board.
  const fresh = Object.keys(byId).filter((id) => !onBoard[id]).map((id) => byId[id])
  const board = found.boards[0] && found.boards[0].node
  if (fresh.length) {
    let inbox = found.boards.length ? board.children.find((n) => n.name === 'Inbox · new frames') : null
    const spot = board ? { x: board.x + board.width + 400, y: board.y } : emptySpot()
    if (!inbox) { inbox = makeSection('Inbox · new frames'); figma.currentPage.appendChild(inbox); inbox.x = spot.x; inbox.y = spot.y }
    const scale = (found.boards[0] && found.boards[0].data.scale) || 1
    const startY = inbox.children.length ? Math.max.apply(null, inbox.children.map((n) => n.y + n.height)) + BOARD.gap : BOARD.pad
    const size = await layOut(inbox, fresh, scale, BOARD.pad, startY)
    sizeSection(inbox, Math.max(inbox.width, size.w + BOARD.pad * 2), startY + size.h + BOARD.pad)
  }
  if (board) {
    let d = {}; try { d = JSON.parse(board.getSharedPluginData(NS, 'board')) } catch (e) {}
    board.setSharedPluginData(NS, 'board', JSON.stringify(Object.assign({}, d, { syncedAt: Date.now() })))
  }
  const parts = []
  if (updated) parts.push(updated + ' updated')
  if (fresh.length) parts.push(fresh.length + ' new in Inbox')
  if (removed) parts.push(removed + ' no longer in the campaign (faded)')
  if (restatused) parts.push(restatused + ' status change' + (restatused === 1 ? '' : 's'))
  return { message: parts.length ? 'Board synced: ' + parts.join(', ') + '.' : 'Board is up to date.', boardResult: { updated: updated, added: fresh.length, removed: removed } }
}

// One action at a time, so quick double-clicks can't overwrite each other's saves.
let queue = Promise.resolve();
figma.ui.onmessage = (msg) => {
  queue = queue.then(() => handle(msg)).catch((error) => {
    figma.ui.postMessage({ type: 'error', message: error && error.message ? error.message : String(error) });
  });
};

let selectionTimer = null;
function queueSelection() {
  if (selectionTimer) clearTimeout(selectionTimer);
  selectionTimer = setTimeout(() => { sendSelection().catch(() => {}); }, 80);
}
figma.on('selectionchange', queueSelection);
figma.on('currentpagechange', queueSelection);

// The plugin can be open in several files at once, each with its own window. They share this
// computer's storage but get no notice when another window saves, so check every few seconds.
// The same check notices a teammate editing this file's campaign list at the same time.
const watched = { rev: -1, cacheAt: 0, scanAt: 0, manifestAt: 0 };
setInterval(() => {
  queue = queue.then(async () => {
    const data = await loadData();
    const cache = (await figma.clientStorage.getAsync(CACHE_KEY)) || {};
    const scan = (await figma.clientStorage.getAsync(SCAN_KEY)) || {};
    const manifest = readManifest();
    if ((data.rev || 0) !== watched.rev || (cache.savedAt || 0) > watched.cacheAt ||
        (scan.savedAt || 0) > watched.scanAt || (manifest.updatedAt || 0) !== watched.manifestAt) {
      await sendState({ external: true });
    }
  }).catch(() => {});
}, 3000);

figma.showUI(__html__, { width: PANEL_SIZE.width, height: PANEL_SIZE.height, themeColors: true, title: 'Showroom' });
