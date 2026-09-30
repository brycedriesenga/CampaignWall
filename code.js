// Campaign Wall — test build.
// This file runs in Figma's plugin sandbox. It owns local storage, the current
// selection, this file's identity, and navigation. All calls to Figma's REST API
// happen in ui.html, because only the UI window can make network requests.

const NS = 'campaignwall';                 // shared plugin data namespace (tags on frames)
const DATA_KEY = 'cw.data.v1';             // campaigns and their frames (this computer)
const TOKEN_KEY = 'cw.token';              // personal access token (this computer)
const CACHE_KEY = 'cw.cache.v1';           // what the wall last saw from the API
const PREFS_KEY = 'cw.prefs.v1';           // window size etc.
const PANEL_SIZE = { width: 360, height: 620 };
const ELIGIBLE = ['FRAME', 'COMPONENT', 'COMPONENT_SET', 'INSTANCE', 'GROUP', 'SECTION'];
const DEFAULT_CHANNELS = ['Site', 'Email', 'Social', 'Display ads', 'Amazon', 'Retail', 'Other'];
const AD_SIZES = ['300x250', '728x90', '160x600', '300x600', '320x50', '320x100', '970x250', '970x90',
  '336x280', '468x60', '250x250', '200x200', '300x50', '120x600'];

// ---------- storage ----------
function emptyData() {
  return { version: 1, campaigns: [], activeCampaignId: '', channels: DEFAULT_CHANNELS.slice() };
}
async function loadData() {
  const d = await figma.clientStorage.getAsync(DATA_KEY);
  if (!d || !Array.isArray(d.campaigns)) return emptyData();
  if (!Array.isArray(d.channels) || !d.channels.length) d.channels = DEFAULT_CHANNELS.slice();
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

function readTags(node) {
  try {
    const raw = node.getSharedPluginData(NS, 'campaigns');
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch (e) { return []; }
}

// Tags live on the frame too, so a future version can discover campaign frames
// straight from files. The local campaign list is what the wall uses today.
function tagNode(node, campaignId, add) {
  const tags = readTags(node).filter((id) => id !== campaignId);
  if (add) tags.push(campaignId);
  node.setSharedPluginData(NS, 'campaigns', tags.length ? JSON.stringify(tags) : '');
  if (tags.length) node.setRelaunchData({ open: 'In ' + tags.length + ' campaign' + (tags.length === 1 ? '' : 's') });
  else node.setRelaunchData({});
}

function selectionInfo(data) {
  const key = currentFileKey();
  const items = [];
  let skipped = 0;
  for (const node of figma.currentPage.selection) {
    if (!isEligible(node)) { skipped += 1; continue; }
    const inCampaigns = data.campaigns
      .filter((c) => c.items.some((i) => i.nodeId === node.id && i.fileKey === key))
      .map((c) => c.id);
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
  const prefs = await loadPrefs();
  seen.rev = data.rev || 0;
  seen.cacheAt = cache.savedAt || 0;
  figma.ui.postMessage(Object.assign({
    type: 'state', data: data, token: token, cache: cache, prefs: prefs,
    selection: selectionInfo(data),
    file: { key: currentFileKey(), name: figma.root.name, keyFromApi: !!figma.fileKey },
  }, extra || {}));
}

async function sendSelection() {
  const data = await loadData();
  figma.ui.postMessage({ type: 'selection', selection: selectionInfo(data) });
}

function findCampaign(data, id) {
  const campaign = data.campaigns.find((c) => c.id === id);
  if (!campaign) throw new Error('That campaign no longer exists.');
  return campaign;
}

// ---------- actions ----------
async function addSelection(msg) {
  const data = await loadData();
  const campaign = findCampaign(data, msg.campaignId);
  const fileKey = currentFileKey();
  if (!fileKey) return { needFileKey: true };
  const page = figma.currentPage;
  let added = 0;
  let updated = 0;
  for (const node of page.selection) {
    if (!isEligible(node)) continue;
    const id = fileKey + '|' + node.id;
    const existing = campaign.items.find((i) => i.id === id);
    const channel = msg.channel && msg.channel !== 'auto'
      ? msg.channel
      : (existing ? existing.channel : guessChannel(node.width, node.height));
    const base = {
      id: id, fileKey: fileKey, fileName: figma.root.name, nodeId: node.id, name: node.name,
      width: Math.round(node.width), height: Math.round(node.height), pageName: page.name, channel: channel,
    };
    if (existing) { Object.assign(existing, base); updated += 1; }
    else { base.addedAt = Date.now(); campaign.items.push(base); added += 1; }
    tagNode(node, campaign.id, true);
  }
  data.activeCampaignId = campaign.id;
  await saveData(data);
  const parts = [];
  if (added) parts.push(added + ' added');
  if (updated) parts.push(updated + ' updated');
  return { message: (parts.join(', ') || 'Nothing to add') + ' in ' + campaign.name + '.' };
}

async function removeItem(msg) {
  const data = await loadData();
  const campaign = findCampaign(data, msg.campaignId);
  const ids = Array.isArray(msg.itemIds) ? msg.itemIds : [msg.itemId];
  const removed = campaign.items.filter((i) => ids.indexOf(i.id) >= 0);
  campaign.items = campaign.items.filter((i) => ids.indexOf(i.id) < 0);
  await saveData(data);
  const key = currentFileKey();
  for (const item of removed) {
    if (item.fileKey !== key) continue;
    const node = await figma.getNodeByIdAsync(item.nodeId);
    if (node && 'setSharedPluginData' in node) tagNode(node, campaign.id, false);
  }
  return { message: (removed.length === 1 ? 'Removed' : removed.length + ' frames removed') + ' from ' + campaign.name + '.' };
}

async function openItem(msg) {
  const fileKey = msg.fileKey;
  const nodeId = msg.nodeId;
  if (fileKey && fileKey === currentFileKey()) {
    const node = await figma.getNodeByIdAsync(nodeId);
    if (node && node.type !== 'PAGE' && node.type !== 'DOCUMENT') {
      const page = findPage(node);
      if (page && page !== figma.currentPage) await figma.setCurrentPageAsync(page);
      figma.currentPage.selection = [node];
      figma.viewport.scrollAndZoomIntoView([node]);
      return { message: 'Selected “' + node.name + '” in this file.' };
    }
  }
  const url = 'https://www.figma.com/design/' + fileKey + '/?node-id=' + encodeURIComponent(nodeId.replace(/:/g, '-'));
  figma.openExternal(url);
  return { message: 'Opening the design in its file…' };
}

async function handle(msg) {
  switch (msg.type) {
    case 'init':
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
      return sendState({ message: 'Created “' + name + '”.' });
    }
    case 'rename-campaign': {
      const data = await loadData();
      const campaign = findCampaign(data, msg.campaignId);
      const name = String(msg.name || '').trim();
      if (!name) throw new Error('Give the campaign a name.');
      campaign.name = name;
      await saveData(data);
      return sendState({ message: 'Renamed.' });
    }
    case 'delete-campaign': {
      const data = await loadData();
      data.campaigns = data.campaigns.filter((c) => c.id !== msg.campaignId);
      if (data.activeCampaignId === msg.campaignId) data.activeCampaignId = data.campaigns.length ? data.campaigns[0].id : '';
      await saveData(data);
      return sendState({ message: 'Campaign deleted. Frames in files were not changed.' });
    }
    case 'set-active': {
      const data = await loadData();
      data.activeCampaignId = msg.campaignId;
      await saveData(data);
      return sendState();
    }
    case 'add-selection': {
      const result = await addSelection(msg);
      return sendState(result);
    }
    case 'remove-item':
      return sendState(await removeItem(msg));
    case 'set-channel': {
      const data = await loadData();
      const campaign = findCampaign(data, msg.campaignId);
      const ids = Array.isArray(msg.itemIds) ? msg.itemIds : [msg.itemId];
      for (const item of campaign.items) if (ids.indexOf(item.id) >= 0) item.channel = msg.channel;
      await saveData(data);
      return sendState();
    }
    case 'mark-seen': {
      const data = await loadData();
      const campaign = findCampaign(data, msg.campaignId);
      const seen = msg.seen || {};
      for (const item of campaign.items) if (seen[item.id]) item.seenHash = seen[item.id];
      await saveData(data);
      return sendState();
    }
    case 'set-file-key': {
      const key = parseFileKey(msg.url);
      if (!key) throw new Error('That doesn’t look like a Figma file link. Use Share › Copy link.');
      figma.root.setSharedPluginData(NS, 'fileKey', key);
      return sendState({ message: 'Link saved for this file.' });
    }
    case 'save-cache':
      await figma.clientStorage.setAsync(CACHE_KEY, msg.cache || { files: {} });
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
    case 'import-campaign': {
      let parsed;
      try { parsed = JSON.parse(msg.json); } catch (e) { throw new Error('That isn’t valid campaign data.'); }
      const incoming = parsed && parsed.type === 'campaign-wall' ? parsed.campaign : null;
      if (!incoming || !incoming.id || !incoming.name || !Array.isArray(incoming.items)) throw new Error('That isn’t valid campaign data.');
      const data = await loadData();
      const existing = data.campaigns.find((c) => c.id === incoming.id);
      if (existing) {
        for (const item of incoming.items) if (!existing.items.some((i) => i.id === item.id)) existing.items.push(item);
      } else {
        data.campaigns.push({ id: incoming.id, name: incoming.name, createdAt: incoming.createdAt || Date.now(), items: incoming.items });
      }
      data.activeCampaignId = incoming.id;
      await saveData(data);
      return sendState({ message: 'Imported “' + incoming.name + '”.' });
    }
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
const seen = { rev: -1, cacheAt: 0 };
setInterval(() => {
  queue = queue.then(async () => {
    const data = await loadData();
    const cache = (await figma.clientStorage.getAsync(CACHE_KEY)) || {};
    if ((data.rev || 0) !== seen.rev || (cache.savedAt || 0) > seen.cacheAt) await sendState({ external: true });
  }).catch(() => {});
}, 3000);

figma.showUI(__html__, { width: PANEL_SIZE.width, height: PANEL_SIZE.height, themeColors: true, title: 'Campaign Wall' });
