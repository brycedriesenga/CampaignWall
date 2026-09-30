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
      addedBy: existing ? existing.addedBy : whoAmI(), addedAt: existing ? existing.addedAt : Date.now(), updatedAt: Date.now(),
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
