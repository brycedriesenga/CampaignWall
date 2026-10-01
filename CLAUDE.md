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
- **Manifest shape:** `{ v:1, fileKey, fileName, updatedAt, campaigns: { [campaignId]: { name, updatedAt, items: { [nodeId]: { name, w, h, pageName, channel, addedBy, addedAt, updatedAt } } } }, links: { [fileKey]: fileName }, layouts: { [campaignId]: { order: [itemId], at, by } } }`. Size limit about 95 kB; empty campaigns are dropped. `links` (up to 300) is dropped first if the manifest gets too big.
- **Links (v0.3):** each campaign file's manifest lists the other campaign files known to whoever last opened the plugin there.
  - `campaignFiles()` = scanned files with campaigns, plus keys from any manifest's `links` (unless this computer read that file after the link was written and found no manifest).
  - `syncLinks()` sends `save-links` when that set differs from this file's `links`; code.js writes only if the file has campaigns and the key set changed (read-only files are skipped silently). `S.linksSent` stops repeat sends.
  - `rememberThisFile()` copies the current file's live manifest into `scan.files`, so other files learn about it.
- **Discovery** (`discover(opts)` in ui.html), in order:
  1. Team (optional, `TEAM.teamId` or `prefs.team`): `GET /v2/teams/:id/folders` plus `/v2/folders/:id/folders` up to 3 levels (tier 2), falling back to `/v1/teams/:id/projects`. Cached in `scan.team`, refreshed daily or on manual search.
  2. Folders (built-in + `prefs.folders` + team's): `GET /v2/folders/:id/files`, falling back to `/v1/projects/:id/files` (tier 2), every search. The per-folder `GET /v2/folders/:id/meta` check was removed: it needs `folder_metadata:read`, which personal access tokens don't offer (they 401). Folder names come from the team's folder list or the listing; the team's name only from the pasted link (`folders:read` doesn't return it), else "Your team".
     - New files are read if edited within Look back (`prefs.lookBackDays`, default `TEAM.lookBackDays` = 30).
     - Edited campaign files are read right away; edited files without campaigns at most once a day (manual search ignores that).
  3. Linked files not seen in a listing: `GET /v1/files/:key/meta` (tier 3; reuses the wall's `cache.lastTouchedAt` if under 5 min old). Read only if `last_touched_at` differs from `scan.files[key].touched`. Up to 4 rounds, since newly read files can add links.
  - Reading = `GET /v1/files/:key?depth=1&plugin_data=shared` (tier 1), preceded by a meta call to record `touched`. Campaign files are read first, then newest-first.
  - `opts.manual` (refresh buttons): refresh the team list, bypass the daily rule and the meta cache.
  - Runs on open if the last search is over 5 minutes old, on wall open, and from the refresh buttons. `canSearch()` is true with folders, a team, or any known campaign file.
- **Team sync (v0.4, Enterprise):** a shared index in one file's variables. Config: `TEAM.indexFile` or `prefs.index {key,name}`.
  - Hidden collection named `Showroom index` (constant `INDEX_COLLECTION`), one mode, one STRING variable per design file named `f/<fileKey>`. Its value is that file's manifest JSON without `links`.
  - `pollIndex()` runs on open, after connecting, and every 45 s (`INDEX_POLL`): `GET /v1/files/:index/variables/local` (tier 2), then `mergeIndex()` copies entries newer (by manifest `updatedAt`) into `scan.files` (marked `indexAt`), so everything else works unchanged.
  - Writes: `POST /v1/files/:index/variables` (tier 3) via `writeIndex(list)`, batching up to 100 files. It creates the collection if missing, and maps temp IDs with `tempIdToRealId`. `indexChanges()` lists this file's manifest when newer than the index entry, any scanned manifest newer than its entry (self-repair), and gone files (written as empty). Runs after each poll, after `discover()` (`healIndex()`), and 1.2 s after this file's manifest changes (`queueIndexPublish()`).
  - 403 on write → `S.index.canWrite = false` (Settings shows "Read-only"); 403/404 on read → `S.index.error`; 429 pauses polling for 2 min. Reads and writes run one at a time (`indexTask`).
  - While the index is healthy (read OK in the last 5 min): the full search is due every 30 min instead of 5, link-following skips files the index covers, and a folder file known only from the index gets its `lastModified` recorded instead of being read.
  - The design files stay the source of truth. People who can't write the index still see everyone's changes, but theirs only spread through other people's searches.
  - Needs Enterprise, a Full seat, File variables read (and write to publish), and edit access to the index file. Tested on 2026-09-30 with `tools/test-variables-index.mjs`: all checks passed, about 1–2 s per call, and values of 100k+ characters were accepted.
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
- `showroom.scan`: `{ savedAt, checkedAt, team: { id, name, checkedAt, folders: [{ id, name }], error }, folders: { id: { name, checkedAt, listedAt, count, error } }, files: { key: { name, lastModified, touched, scannedAt, indexAt, manifest|null, error, gone } } }`
- `showroom.prefs`: `{ me, wallSize, folders: [{ id, name }], team: { id, name }, index: { key, name }, lookBackDays, wallView, wallPos: { [cid]: {zoom, tx, ty, at} }, layouts: { [cid]: {order, at, by} } }`
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

**Loading states (v0.4.1):** tiles without an image show a skeleton (`.sk`: sweep, spinner, step text) instead of a striped box.
- `setPhase(fileKey, nodeIds, phase)` updates the step text in place (queued → "Waiting…", reading, rendering) without redrawing the wall.
- Once a render URL exists, the `<img>` starts with class `ld` (transparent) over the skeleton; a capture-phase `load` listener on `#world` (`bindImageEvents`) fades it in, removes the skeleton and records the URL in `S.wall.loaded` so redraws don't fade again.
- On image `error` (usually an expired URL), the URL is cleared and the frame re-rendered once per wall visit (`S.wall.retried`).
- `loadMissing()` loads only frames that have no image yet (`needsImage`), once per frame per visit (`S.wall.tried`), and `renderWall()` calls it after the first sync (`S.wall.synced`). So frames arriving from Team sync, another window or a teammate load by themselves. The index poll no longer runs a full `refreshWall`.
- `syncItems` called while busy sets `S.wall.pending`, and `loadMissing` runs when the current round ends (it used to be silently dropped).
- `tier1Gate` shows "Pausing for Figma's rate limit (N s)…" in the wall bar while it waits.

**View options (v0.5):** the sliders button at the right of the wall bar opens `#viewopts`. Settings are saved per person in `prefs.wallView` (`wallView()` merges them over `WALL_VIEW_DEFAULTS`).
- **Settings:** background `bg` (auto, light, gray, dark, black), `frame` (border, shadow, none), `group` (channel, file, none), `spacing` (tight, normal, roomy, mapped through `SPACING`), and the toggles `grid`, `names`, `meta`, `headings` and `edges`.
- **Canvas colours** are CSS vars on `#viewport`: `--cv-bg`, `--cv-ink`, `--cv-sub` and `--cv-line`, set by `data-bg`. The other settings are `data-frame` and `no-*` classes, applied by `applyWallView()`.
- **Layout:** spacing, grouping and names change the layout, so they re-render. If you haven't panned or zoomed, the wall also re-fits. `wallGroups()` builds the rows. Headings carry `data-group` (an index into `S.wall.bounds.groups`), and clicking one selects that group.
- **Closing:** Esc or a click outside closes the box.

**Rounded frames:** `.fr` has no background, so transparent corners show the canvas. `frameGeometry` stores `radius` from `cornerRadius` or `rectangleCornerRadii`. The tile gets that `border-radius` unless content overflows the frame; the border and shadow follow it. Old cache entries only get `radius` after a re-read, for example from Refresh.

**Navigation and shortcuts (v0.6):** `wallKey(e)` handles keys on the wall.
- Shift+1 fit, Shift+2 `zoomToSelection`, Shift+0 100%, +/- zoom.
- Arrow keys call `stepSelection` (←/→ in reading order, ↑/↓ nearest frame in the row above or below), then `reveal` brings it into view. `?` toggles `#shortcuts`.
- Space+drag or the middle button pans. Key codes are used for Shift+digits.
- Figma's own app menu may also react to Shift+1 on its canvas behind the plugin, which is harmless.
- `zoomToRect` and `glide()` handle animated zooms (`#world.glide` transition).
- `orderedPlacements()` gives the frames in layout order, skipping filtered-out ones.

**Filters (v0.6):** `S.wall.filter {campaignId, channels[], people[], updated}`, per session.
- `matchesFilter(it)`; frames that don't match get `.dim`.
- Ctrl+A, the marquee, heading clicks, arrow keys and Present all skip dimmed frames.
- `#filters` is the popover; `#filterpill` shows "Showing N of M · Edit · Clear" plus a badge on the filter button.

**Present (v0.6):** `startPresent()`, triggered by P or the Present button.
- `body.presenting` hides the chrome and labels and dims every frame except `.cur`.
- `presentGo(i)` zooms to each frame (up to 2×, with room for the `#hud`). The HUD auto-hides after 2.5 s.
- Keys: arrows, Space, PageUp/PageDown, Home/End. Esc returns to the previous view, with the last frame selected.
- Controls floating over the canvas (`#hud`, `#filterpill`, `#banner`) are excluded from the viewport's pointerdown, so pointer capture doesn't swallow their clicks.

**Remembered position (v0.6):** `prefs.wallPos[campaignId] = {zoom, tx, ty, at}`, saved with a 700 ms debounce from `applyTransform` once you've panned or zoomed, and not during Present. It keeps the 30 most recent campaigns. `restorePosition()` on open, otherwise `fit()`.

**Arranging (v0.6):** dragging a frame (no modifier keys) reorders it within its row group; dragging empty space pans.
- `startArrange`, `moveArrange` (drop line) and `endArrange` → `saveOrder(full)`.
- The order goes to `prefs.layouts[cid]` (a local copy) and `save-layout` → manifest `layouts[cid] = {order: [itemIds], at, by}`, keeping the 50 newest.
- `campaignOrder()` takes the newest `at` across all manifests and the local copy. `orderItems()` sorts before grouping, and unknown items go last.
- `hasShared(m)` (campaigns or layouts) decides publishing to Team sync and `rememberThisFile`. `writeManifest` drops `layouts` after `links` if the manifest is too big.

Wall selection is `S.wall.selected` (an array):
- Shift, Ctrl or ⌘-click toggles a frame.
- Shift-drag on the background draws a selection box.
- Clicking a channel heading selects that row.
- Ctrl/⌘+A selects all, and Esc clears.
- The code.js actions `remove-item` and `set-channel` accept `itemIds`.

Double-click is detected manually in `pointerup`. Pointer capture retargets native `dblclick` to the viewport, so the native event can't be used.

Rate limits: tier 1 is about 15 requests/min on an Organization plan with a Full or Dev seat. View and Collab seats are nearly unusable.

## Messages (UI → code)

`init`, `save-token`, `create-campaign`, `rename-campaign`, `hide-campaign {shared}`, `unhide-campaign`, `unhide-items`, `set-active {campaignId, campaignName}`, `add-selection {campaignId, campaignName, channel|'auto'}`, `remove-item {itemIds}`, `set-channel {itemIds, channel}`, `mark-seen {seen}`, `set-file-key {url}`, `save-links {links}`, `save-layout {campaignId, layout}`, `save-cache`, `save-scan`, `save-prefs`, `resize`, `open-item {fileKey, nodeId, versionId?}`, `notify`.

Code → UI: `state` (full), `selection`, `error`.

## Status and open questions

- v0.1 was tested in real Figma on 2026-09-29. The API and images load fine from the plugin iframe, and `figma.fileKey` works in development.
- v0.2 adds team sharing and history. It was tested with `npm test` (46 checks) and screenshots, but not yet in real Figma. Things to confirm there:
  - that `plugin_data=shared` returns the root or page manifest;
  - that the v2 folders endpoint's response fields match what the code parses;
  - that the image render for a version works for old versions.
- v0.3 adds links between campaign files, the daily re-check, Look back and team folder discovery. `npm test` has 59 checks. Also to confirm in real Figma: the team folders response and folder `meta` `updated_at` behaviour.
- v0.4 adds Team sync (the variables index). `npm test` has 95 checks. First real test on 2026-09-30 worked: team link found 21 folders, a folder listed 4 files, the index filled with 2 files, and the wall showed both. Personal tokens offer these scopes: current_user, file_content, file_metadata, file_versions, file_variables read/write, folders:read (no projects or folder_metadata).

## Next steps (not built)

1. Editable channel list and statuses.
2. Review notes posted as real Figma comments (`POST /v1/files/:key/comments` with `client_meta` for the node).
3. Export the wall (PNG or PDF) for stakeholders without Full seats.
4. Show "this frame changed in this version" in History. That needs node reads per version, which is expensive, so it's opt-in at most.
