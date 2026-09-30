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
- **Manifest shape:** `{ v:1, fileKey, fileName, updatedAt, campaigns: { [campaignId]: { name, updatedAt, items: { [nodeId]: { name, w, h, pageName, channel, addedBy, addedAt, updatedAt } } } }, links: { [fileKey]: fileName } }`. Size limit about 95 kB; empty campaigns are dropped. `links` (up to 300) is dropped first if the manifest gets too big.
- **Links (v0.3):** each campaign file's manifest lists the other campaign files known to whoever last opened the plugin there.
  - `campaignFiles()` = scanned files with campaigns, plus keys from any manifest's `links` (unless this computer read that file after the link was written and found no manifest).
  - `syncLinks()` sends `save-links` when that set differs from this file's `links`; code.js writes only if the file has campaigns and the key set changed (read-only files are skipped silently). `S.linksSent` stops repeat sends.
  - `rememberThisFile()` copies the current file's live manifest into `scan.files`, so other files learn about it.
- **Discovery** (`discover(opts)` in ui.html), in order:
  1. Team (optional, `TEAM.teamId` or `prefs.team`): `GET /v2/teams/:id/folders` plus `/v2/folders/:id/folders` up to 3 levels (tier 2), falling back to `/v1/teams/:id/projects`. Cached in `scan.team`, refreshed daily or on manual search.
  2. Folders (built-in + `prefs.folders` + team's): `GET /v2/folders/:id/meta` (tier 3) first; if `updated_at` is unchanged and the folder was listed in the last 6 h, skip listing. Otherwise `GET /v2/folders/:id/files`, falling back to `/v1/projects/:id/files` (tier 2). If the meta call fails once, it's skipped for the session (`S.search.noFolderMeta`).
     - New files are read if edited within Look back (`prefs.lookBackDays`, default `TEAM.lookBackDays` = 30).
     - Edited campaign files are read right away; edited files without campaigns at most once a day (manual search ignores that).
  3. Linked files not seen in a listing: `GET /v1/files/:key/meta` (tier 3; reuses the wall's `cache.lastTouchedAt` if under 5 min old). Read only if `last_touched_at` differs from `scan.files[key].touched`. Up to 4 rounds, since newly read files can add links.
  - Reading = `GET /v1/files/:key?depth=1&plugin_data=shared` (tier 1), preceded by a meta call to record `touched`. Campaign files are read first, then newest-first.
  - `opts.manual` (refresh buttons): re-list every folder, refresh the team list, bypass the daily rule and the meta cache. `opts.relist` (Look back got longer): re-list every folder only.
  - Runs on open if the last search is over 5 minutes old, on wall open, and from the refresh buttons. `canSearch()` is true with folders, a team, or any known campaign file.
  - Unverified in real Figma: the v2 folder/team response fields, and whether a folder's `updated_at` moves when a file inside is edited (the 6 h re-list and daily re-check cover it if not).
- **Campaign list:** `allCampaigns()` merges the current file's live manifest (from code.js), the scanned manifests, and local data.
  - Local data only holds drafts (campaigns with no frames yet).
  - A campaign's name comes from the manifest entry with the newest `updatedAt`.
- **Edits:** only the file a frame lives in can change it (add, remove, channel).
  - From other files, "remove" hides the frame for this user (`data.hiddenItems`), and channel changes are refused with a message.
- **Name clashes:** creating a campaign with an existing name (case-insensitive) joins the existing one.
- **Team config:** `TEAM.teamId`, `TEAM.folders` and `TEAM.lookBackDays` at the top of ui.html are built in. Users can add a team (`prefs.team`), more folders (`prefs.folders`) and change Look back in Settings.

## History (v0.2)

- `GET /v1/files/:key/versions?page_size=30` (tier 2) returns the versions. Paging uses `pagination.next_page`.
- Picking a version runs `GET /v1/images/:key?ids=<node>&version=<id>` (tier 1). Renders are cached in `S.historyRenders` for the session.
- **Then/Now** flips between that render and the current wall image. **Open** uses `openExternal` with a `version-id` link.

## Storage (clientStorage, per user and machine)

- `showroom.data`: `{ activeCampaignId, channels[], campaigns: [{ id, name, createdAt, renamedAt }] (drafts and names), seen: { itemId: hash }, hidden: [campaignId], hiddenItems: { campaignId: [itemId] }, rev, savedAt }`
- `showroom.token`: the personal access token.
- `showroom.cache`: `{ savedAt, files: { [fileKey]: { name, version, stamp, lastTouchedAt, lastTouchedBy, checkedAt, error, nodes: { [nodeId]: { name, width, height, viewW, viewH, offX, offY, hash, url, urlAt, changedAt, missing, renderFailed } } } } }`
- `showroom.scan`: `{ savedAt, checkedAt, team: { id, checkedAt, folders: [{ id, name }], error }, folders: { id: { name, checkedAt, listedAt, updatedAt, count, error } }, files: { key: { name, lastModified, touched, scannedAt, manifest|null, error, gone } } }`
- `showroom.prefs`: `{ me, wallSize, folders: [{ id, name }], team: { id, name }, lookBackDays }`
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

`init`, `save-token`, `create-campaign`, `rename-campaign`, `hide-campaign {shared}`, `unhide-campaign`, `unhide-items`, `set-active {campaignId, campaignName}`, `add-selection {campaignId, campaignName, channel|'auto'}`, `remove-item {itemIds}`, `set-channel {itemIds, channel}`, `mark-seen {seen}`, `set-file-key {url}`, `save-links {links}`, `save-cache`, `save-scan`, `save-prefs`, `resize`, `open-item {fileKey, nodeId, versionId?}`, `notify`.

Code → UI: `state` (full), `selection`, `error`.

## Status and open questions

- v0.1 was tested in real Figma on 2026-09-29. The API and images load fine from the plugin iframe, and `figma.fileKey` works in development.
- v0.2 adds team sharing and history. It was tested with `npm test` (46 checks) and screenshots, but not yet in real Figma. Things to confirm there:
  - that `plugin_data=shared` returns the root or page manifest;
  - that the v2 folders endpoint's response fields match what the code parses;
  - that the image render for a version works for old versions.
- v0.3 adds links between campaign files, the daily re-check, Look back and team folder discovery. `npm test` has 59 checks. Also to confirm in real Figma: the team folders response and folder `meta` `updated_at` behaviour.
- A shared "Showroom Index" file using variables (Enterprise) is being considered for near-real-time sync. `tools/test-variables-index.mjs` checks whether the variables REST API works for the team; waiting on its results.

## Next steps (not built)

1. Editable channel list and statuses.
2. Review notes posted as real Figma comments (`POST /v1/files/:key/comments` with `client_meta` for the node).
3. Export the wall (PNG or PDF) for stakeholders without Full seats.
4. Show "this frame changed in this version" in History. That needs node reads per version, which is expensive, so it's opt-in at most.
