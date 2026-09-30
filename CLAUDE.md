# Showroom — project notes

Classic (non-generative) Figma plugin. Bryce's team keeps design files in per-channel Figma folders (Site, Email, Social, Ads…). This plugin lets you add specific frames from any of those files to a campaign, then view every campaign frame together at real size on a pan/zoom wall inside the plugin window. It replaces an earlier generative plugin ("Campaign Hub") that copied snapshots between files. Copies went stale and the wall file couldn't see source changes.

**Name:** the plugin was renamed from "Campaign Wall" to **Showroom** on 2026-09-30, and the team started fresh.
- Internal names now use `showroom`: the plugin data namespace `showroom`, and clientStorage keys `showroom.*`.
- On first run, `carryOverOldStorage()` copies `cw.token` and `cw.prefs.v1`, then deletes the old `cw.*` keys.
- Old `campaignwall/*` tags left in files are ignored.
- The manifest `id` is unchanged. clientStorage is scoped to it, and a new ID would need registering with Figma.

The owner is a designer who vibe-codes. Keep the code plain JavaScript with no build step, explain changes in plain language, and keep files readable.

## Architecture

- `manifest.json`
  - `enablePrivatePluginApi: true` gives `figma.fileKey` in development and org-private plugins.
  - `networkAccess` allows `api.figma.com` plus the S3 domains that Figma's image renders are served from.
  - `documentAccess: dynamic-page`, so use the async node APIs.
- `code.js` (plugin sandbox)
  - Owns `figma.clientStorage`, the selection, file identity, tagging frames, navigation and window resizing.
  - Actions go through a promise queue so they run one at a time.
- `ui.html` (iframe)
  - Owns all REST API calls (`fetch` with an `X-Figma-Token` personal access token) and all rendering.
  - The wall is DOM, not canvas. `#world` is absolutely positioned and moved with a `translate() scale()` transform.
  - Labels and channel headings are counter-scaled with the CSS vars `--inv` and `--z`, so they stay screen-sized.

## Team sharing (v0.2)

Campaign membership lives **inside each design file**, so it's shared with no server.
- **Where it's stored:** shared plugin data `showroom/manifest` on the document root, with an identical backup copy on the first page.
  - The backup exists because it's unverified whether `GET /v1/files/:key?plugin_data=shared` returns plugin data on the DOCUMENT node.
  - Readers take whichever copy has the newest `updatedAt`.
- **Manifest shape:** `{ v:1, fileKey, fileName, updatedAt, campaigns: { [campaignId]: { name, updatedAt, items: { [nodeId]: { name, w, h, pageName, channel, addedBy, addedAt, updatedAt } } } } }`. Size limit about 95 kB; empty campaigns are dropped.
- **Discovery** (`discover()` in ui.html):
  - List files in the team folders: `GET /v2/folders/:id/files`, falling back to `/v1/projects/:id/files` (tier 2).
  - Read the manifest of each file that's new and edited in the last `TEAM.searchDays`, or edited since it was last seen: `GET /v1/files/:key?depth=1&plugin_data=shared` (tier 1).
  - Results are cached in `showroom.scan`. It runs on open if the last search is more than 5 minutes old, on wall open, and from the refresh button in the footer.
- **Campaign list:** `allCampaigns()` merges the current file's live manifest (from code.js), the scanned manifests, and local data.
  - Local data only holds drafts (campaigns with no frames yet).
  - A campaign's name comes from the manifest entry with the newest `updatedAt`.
- **Edits:** only the file a frame lives in can change it (add, remove, channel).
  - From other files, "remove" hides the frame for this user (`data.hiddenItems`), and channel changes are refused with a message.
- **Name clashes:** creating a campaign with an existing name (case-insensitive) joins the existing one.
- **Team folder config:** `TEAM.folders` at the top of ui.html is built in. Users can add more in Settings (`prefs.folders`).

## History (v0.2)

- `GET /v1/files/:key/versions?page_size=30` (tier 2) returns the versions. Paging uses `pagination.next_page`.
- Picking a version runs `GET /v1/images/:key?ids=<node>&version=<id>` (tier 1). Renders are cached in `S.historyRenders` for the session.
- **Then/Now** flips between that render and the current wall image. **Open** uses `openExternal` with a `version-id` link.

## Storage (clientStorage, per user and machine)

- `showroom.data`: `{ activeCampaignId, channels[], campaigns: [{ id, name, createdAt, renamedAt }] (drafts and names), seen: { itemId: hash }, hidden: [campaignId], hiddenItems: { campaignId: [itemId] }, rev, savedAt }`
- `showroom.token`: the personal access token.
- `showroom.cache`: `{ savedAt, files: { [fileKey]: { name, version, stamp, lastTouchedAt, lastTouchedBy, checkedAt, error, nodes: { [nodeId]: { name, width, height, viewW, viewH, offX, offY, hash, url, urlAt, changedAt, missing, renderFailed } } } } }`
- `showroom.scan`: `{ savedAt, checkedAt, folders: { id: { name, checkedAt, count, error } }, files: { key: { name, lastModified, scannedAt, manifest|null, error } } }`
- `showroom.prefs`: `{ me, wallSize, folders: [{ id, name }] }`
- On frames: `showroom/campaigns` holds a JSON array of campaign IDs. It's used for relaunch buttons.
- On the file root: `showroom/fileKey` holds a pasted file key when `figma.fileKey` is unavailable.

**Rate limiting:** `tier1Gate()` spaces tier-1 calls (file reads, renders) to 12 per minute. Tests raise the cap with `window.CW_TIER1_PER_MIN`.

## Freshness algorithm (`refreshWall(mode)` in ui.html)

For each file in the campaign:
1. `GET /v1/files/:key/meta` (tier 3, cheap) returns the file's version, last touched time and editor.
2. Decide whether to read the frames.
   - `auto` mode (opening the wall): re-read only if `version|last_touched_at` changed, or there are new frames.
   - `manual` mode (the refresh button): always re-read, one tier-1 call per file.
   - The manual rule exists because in the first real test, edits didn't show up. Figma's `version` probably only moves at version-history checkpoints.
3. Reading the frames means `GET /v1/files/:key/nodes?ids=…` (tier 1). Fingerprint each node's JSON with FNV-1a. An unchanged fingerprint keeps the cached image URL.
4. Frames with no URL, or a URL older than 20 days (render URLs expire), go through `GET /v1/images/:key?ids=…&format=png&scale=1`. Any that fail are retried at 0.5.
5. The first time a frame is seen, its fingerprint is stored as `seenHash`. Later mismatches show an **Updated** badge.

`refreshSelected()` re-reads every campaign frame in the selected frames' files. Rate limits count requests, not frames, so this costs the same as reading only the picked frames. It then force re-renders only the picked frames (`opts.forceRender` is a list of node IDs). Other frames re-render only if their fingerprint changed.

**Several windows open at once:** the plugin can be open in several files on the same machine, and they share clientStorage.
- `saveData` bumps `data.rev`.
- code.js checks storage every 3 s (through the action queue) and pushes `state {external:true}` when `rev` or `cache.savedAt` changes.
- The UI merges the incoming cache per file, keeping whichever has the newer `checkedAt`.

**Ctrl+A:** Figma desktop runs "select all" from its app menu, so `preventDefault` isn't enough. `body.walling` disables text selection while the wall is open, and a `selectionchange` guard clears any selection that still appears.

Tiles are sized to `absoluteRenderBounds`, because `/images` renders content that spills outside non-clipping frames. The frame's own box (`absoluteBoundingBox`) is drawn as a dashed `.edge` inside the tile. The cache stores `width/height` (the frame) and `viewW/viewH/offX/offY` (the render).

Wall selection is `S.wall.selected` (an array):
- Shift, Ctrl or ⌘-click toggles a frame.
- Shift-drag on the background draws a selection box.
- Clicking a channel heading selects that row.
- Ctrl/⌘+A selects all, and Esc clears.
- The code.js actions `remove-item` and `set-channel` accept `itemIds`.

Double-click is detected manually in `pointerup`. Pointer capture retargets native `dblclick` to the viewport, so the native event can't be used.

Rate limits: tier 1 is about 15 requests/min on an Organization plan with a Full or Dev seat. View and Collab seats are nearly unusable.

## Messages (UI → code)

`init`, `save-token`, `create-campaign`, `rename-campaign`, `hide-campaign {shared}`, `unhide-campaign`, `unhide-items`, `set-active {campaignId, campaignName}`, `add-selection {campaignId, campaignName, channel|'auto'}`, `remove-item {itemIds}`, `set-channel {itemIds, channel}`, `mark-seen {seen}`, `set-file-key {url}`, `save-cache`, `save-scan`, `save-prefs`, `resize`, `open-item {fileKey, nodeId, versionId?}`, `notify`.

Code → UI: `state` (full), `selection`, `error`.

## Status and open questions

- v0.1 was tested in real Figma on 2026-09-29. The API and images load fine from the plugin iframe, and `figma.fileKey` works in development.
- v0.2 adds team sharing and history. It's tested with `npm test` (46 checks) and screenshots, but not yet in real Figma. Things to confirm there:
  - that `plugin_data=shared` returns the root or page manifest;
  - that the v2 folders endpoint's response fields match what the code parses;
  - that the image render for a version works for old versions.

## Next steps (not built)

1. Editable channel list and statuses.
2. Review notes posted as real Figma comments (`POST /v1/files/:key/comments` with `client_meta` for the node).
3. Export the wall (PNG or PDF) for stakeholders without Full seats.
4. Show "this frame changed in this version" in History. That needs node reads per version, which is expensive, so it's opt-in at most.
