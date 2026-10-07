# Showroom — project notes

Classic (non-generative) Figma plugin. Bryce's team keeps design files in per-channel Figma folders (Site, Email, Social, Ads…). Showroom is another way to organise that work: frames from any file get **tags** (a campaign, promo, seasonal push…; any number per frame), and you view every frame with a tag together at real size on a pan/zoom wall inside the plugin window, or all tagged frames filtered by tags. It replaces an earlier generative plugin ("Campaign Hub") that copied snapshots between files. Copies went stale and the wall file couldn't see source changes.

**Name:** the plugin was renamed from "Campaign Wall" to **Showroom** on 2026-09-30, and the team started fresh.
- Internal names now use `showroom`: the plugin data namespace `showroom`, and clientStorage keys `showroom.*`.
- On first run, `carryOverOldStorage()` copies `cw.token` and `cw.prefs.v1`, then deletes the old `cw.*` keys.
- Old `campaignwall/*` tags left in files are ignored.
- The manifest `id` is unchanged. clientStorage is scoped to it, and a new ID would need registering with Figma.

The owner is a designer who vibe-codes. Keep the code plain JavaScript with no build step, explain changes in plain language, and keep files readable.

## Tags (v0.15)

- **Model:** frames belong to tags; that's all. A tag is just a name (no types, no nesting). A frame can have any number of tags.
- **Naming in code:** internally a tag is still a **campaign**: manifest key `campaigns`, `campaignId`, `allCampaigns()`, `campaign()`, messages like `create-campaign`. Kept so files tagged by earlier builds keep working with no migration. Everything the user sees says "tag".
- **Per frame, not per tag:** `allCampaigns()` gives every item `it.tags` (ids of all its tags). `statusMap()` and `deviceMap()` merge every tag's entries (newest `at` wins), so a frame's status and device are the same in every tag; they're still saved under the tag you set them from. code.js keeps a frame's **channel** the same in all its tags (`addSelection` reuses it; `setChannel` changes it everywhere).
- **All tagged frames:** `ALL_TAGS = '__all'` as the active "tag" (in both files). `campaign()` returns `allFramesView(list)`: every tagged item once, `all: true`. Statuses, layouts and hidden frames for it are kept under `'__all'`; `remove-item` with `'__all'` takes every tag off the frame. Rename/delete don't apply to it (Settings hides them). The panel's tag picker lists it first when there are 2+ tags, and home shows it as the first card.
- **Rows by tag (v0.15.1):** View options › Layout › Group rows by › Tag (`group: 'tag'`, clusters `subTag`: channel default, file, off). `wallGroupsRaw` makes a row per tag (in a tag's own wall, per *other* tag; frames without one go last in "Only <tag>" / "No tag"). A frame with several tags appears in each row, so tiles can share a `data-id`: selection highlights every copy, `placementOf` returns the first, Present dedupes its list, `saveOrder` dedupes, and dragging to arrange is off in this grouping.
- **Filter by tag:** `S.wall.filter.tags` (ids); a frame matches when it has every picked tag. Filters shows them as "Also tagged" (or "Tagged" in All).
- **Panel (`selectionCard`):** the selected frames' tags as `.tagchip`s with counts (`2/3 +` adds to all), × removes the tag from the selected frames that have it, `#tag-add` (with a `<datalist>` of tags) adds by name: `addTagByName` reuses an existing tag (any case) or sends `add-selection` with no `campaignId`, so code.js makes a new one. `keepActive` keeps the tag you're looking at. **Update** sends `update-selection` (names, sizes, page and picked channel saved in every tag the frames have). **Add to …** stays for the active tag.
- **Wall details (`inspectorTags`):** chips with × and an add field for frames in the current file (`add-selection` with `nodeIds`, so it works from the wall's selection, not Figma's); read-only chips for other files' frames.
- **Figma's properties panel:** `manifest.json` `relaunchButtons`: `open` "Open in Showroom" and `tags` "Edit tags" (multipleSelection). code.js `setRelaunch(node, tagIds)` sets `{open: '<tag names>', tags: ''}` (names shown under the button). `figma.command` is sent once as `state.command`; `handleLaunch` opens the wall at the frame (`S.wall.focusId`, selected and zoomed in `renderWall`; the window grows to wall size just after, so the `resize` handler re-zooms to the selection until `S.wall.refocusUntil`, 2.5 s) for `open`, or focuses the panel's tag field for `tags`.

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
- **Manifest shape:** `{ v:1, fileKey, fileName, updatedAt, flows: [nodeId] (campaign frames that start a prototype flow), campaigns: { [campaignId]: { name, updatedAt, items: { [nodeId]: { name, w, h, pageName, channel, addedBy, addedAt, updatedAt } } } }, links: { [fileKey]: fileName }, layouts: { [campaignId]: { order: [itemId], at, by } }, statuses: { [campaignId]: { [itemId]: { s, by, at } } }, devices: { [campaignId]: { [itemId]: { d, by, at } } } }`. Size limit about 95 kB; empty campaigns are dropped. `links` (up to 300) is dropped first if the manifest gets too big.
- **Links (v0.3):** each campaign file's manifest lists the other campaign files known to whoever last opened the plugin there.
  - `campaignFiles()` = scanned files with campaigns, plus keys from any manifest's `links` (unless this computer read that file after the link was written and found no manifest).
  - `syncLinks()` sends `save-links` when that set differs from this file's `links`; code.js writes only if the file has campaigns and the key set changed (read-only files are skipped silently). `S.linksSent` stops repeat sends.
  - `rememberThisFile()` copies the current file's live manifest into `scan.files`, so other files learn about it.
- **Discovery** (`discover(opts)` in ui.html), in order:
  1. Team (optional, `TEAM.teamId` or `prefs.team`): `GET /v2/teams/:id/folders` plus `/v2/folders/:id/folders` up to 3 levels (tier 2), falling back to `/v1/teams/:id/projects`. Cached in `scan.team`, refreshed daily or on manual search.
  2. Folders (built-in + `prefs.folders` + team's): `GET /v2/folders/:id/files`, falling back to `/v1/projects/:id/files` (tier 2), every search. The per-folder `GET /v2/folders/:id/meta` check was removed: it needs `folder_metadata:read`, which personal access tokens don't offer (they 401). Folder names come from the team's folder list or the listing; the team's name only from the pasted link (`folders:read` doesn't return it), else "Your team".
     - New files are read if edited within Look back (`prefs.lookBackDays`, default `TEAM.lookBackDays` = 30).
     - With Team sync healthy (and not a manual search), files never seen before are only read if edited in the last `SYNC_NEW_DAYS` (2). The index already lists every campaign file, so a new computer doesn't open every file in the team's folders.
  - `opts.teamOnly` (setup guide) only refreshes the team's folder list. A running search can be stopped (the footer's Stop sets `S.search.stop`; it's checked per folder and per file read; partial results are kept and the search counts as done).
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
  - **Team settings (v0.9):** a STRING variable named `config` in the same collection holds `{v, team:{id,name}|null, folders:[{id,name}], lookBackDays, by, at}`. `readIndex` puts it in `S.index.config` (`S.index.configVar` for updating). Settings › Team sync has Save/Update (`saveTeamSettings()`, built by `teamSettingsToShare()` from this person's team, folders and Look back).
    - Effective values: `teamInfo()` = prefs → `TEAM.teamId` → index config (`fromIndex: true`); `teamFolders()` also adds the config's folders; `lookBackDays()` = prefs → index config → `TEAM` → 30. Settings labels them "· from Team sync".
  - **Presets (v0.9):** `TEAM_PRESETS = [{ name, indexFile }]` near the top of ui.html, one per team, for the org release. When set, Settings and the setup guide's step 3 show "Which team are you on?" buttons (`presetPicker`, `bindPresets` → `joinIndex`). Everything else comes from that index's `config`. Step 3 also has a "Don't have one? How to set it up" section.
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
- `showroom.prefs`: `{ me, wallSize, boardOpts: { scale, embeds }, folders: [{ id, name }], team: { id, name }, index: { key, name }, lookBackDays, onboarded, wallView, wallPos: { [cid]: {zoom, tx, ty, at} }, layouts: { [cid]: {order, at, by} }, statuses: { [cid]: { [itemId]: {s, by, at} } } }`
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

Tiles are sized to `absoluteRenderBounds`, because `/images` renders content that spills outside non-clipping frames. The frame's own box (`absoluteBoundingBox`) is the `.edge` inside a clipping `.edgewrap` (z-index 2, above the image). View options `outside` (`show`, `fade` default, `hide`) and `edgeLine` (default true) give the derived `edge` (`both`, `fade`, `line`, `none` or `hide`) that sets `#viewport[data-edge]`; `wallView()` maps an older saved `edge`/`edges:false`. **Hide (v0.14):** `layout()` uses `wallGeo(n, view, dev)`, a copy of the node sized to a window: the frame's own box, or for a frame in a wall device (v0.14.1) the device's real screen (`devScreen(dev, W).full`), so devices count as "the frame". It carries `cropped {x, y, w, h}` (where the full render sits) and `scrollMax` (page left below the window). `renderWall` wraps the body in `.crop` (overflow hidden, radius inherited) with the image at `−x, −y − scrollY`, plus a `.wsb` scrollbar (visible when selected). **Scrolling on the wall:** the wheel over a *selected* frame with `scrollMax` scrolls its page (`wallScroll(tile, e)`, offsets in `S.wall.scrollY[itemId]`, per session); at either end it holds still (v0.14.2), and only sideways scrolls pan. The scrollbar (`.wsb.on`) shows while scrolling and briefly on selecting, via `flashScrollbar(tile)` (1.2 s). Present devices still use the full node (`nodeInfo`), so spilling content scrolls there. The fade is four `.fd` bands in the canvas colour around the frame's box (`fadeBands()`); it used to be a 100,000 px box-shadow, which made zooming flicker. The old `edges: false` setting maps to `none`. The cache stores `width/height` (the frame) and `viewW/viewH/offX/offY` (the render).

**Loading states (v0.4.1):** tiles without an image show a skeleton (`.sk`: sweep, spinner, step text) instead of a striped box.
- `setPhase(fileKey, nodeIds, phase)` updates the step text in place (queued → "Waiting…", reading, rendering) without redrawing the wall.
- Once a render URL exists, the `<img>` starts with class `ld` (transparent) over the skeleton; a capture-phase `load` listener on `#world` (`bindImageEvents`) fades it in, removes the skeleton and records the URL in `S.wall.loaded` so redraws don't fade again.
- On image `error` (usually an expired URL), the URL is cleared and the frame re-rendered once per wall visit (`S.wall.retried`).
- `loadMissing()` loads only frames that have no image yet (`needsImage`), once per frame per visit (`S.wall.tried`), and `renderWall()` calls it after the first sync (`S.wall.synced`). So frames arriving from Team sync, another window or a teammate load by themselves. The index poll no longer runs a full `refreshWall`.
- `syncItems` called while busy sets `S.wall.pending`, and `loadMissing` runs when the current round ends (it used to be silently dropped).
- `tier1Gate` shows "Pausing for Figma's rate limit (N s)…" in the wall bar while it waits.

**View options (v0.5):** the sliders button at the right of the wall bar opens `#viewopts`. Settings are saved per person in `prefs.wallView` (`wallView()` merges them over `WALL_VIEW_DEFAULTS`).
- **Panel (v0.14):** three tabs (`S.voTab`, per session; every pane is rendered, inactive ones `.hidden`): **Look** (background, frames, content outside a frame + edge line, Show: names/file info/headings/grid), **Layout** (group rows by, cluster within, spacing), **Present** (device frames, screen-sized frames, address, prototype style, "Play automatically in Present" = `protoPresent` auto/click). Reset and Shortcuts sit in a footer.
- **Settings:** background `bg` (auto, light, gray, dark, black), `frame` (border, shadow, none), `group` (channel, file, tag, none), `spacing` (tight, normal, roomy, mapped through `SPACING`), `outside` + `edgeLine` (see above), and the toggles `grid`, `names`, `meta` and `headings`.
- **Clusters within rows (v0.9):** one setting per grouping, chosen by `SUB_OPTIONS`: `subChannel` (file, filepage, off; default file), `subFile` (channel, page, off; default channel), `subNone` (channel, file, off; default off).
  - `wallGroups()` wraps `wallGroupsRaw()` and reorders each row's items into clusters (`clusterOf(it, mode)`), in order of first appearance. Only rows with 2+ clusters are `clustered` (get sections); single-file rows stay plain to keep the wall compact (v0.10.1; before that every row got sections, which shrank the fit zoom a lot).
  - **Zoom-aware layout (v0.10.1):** labels and section names are screen-sized, so `layout(c, zRef)` sizes the room they need in wall units for a reference zoom (`px(n) = n / zRef`). `wallLayout(c)` finds zRef by laying out, taking `fitZoomFor(L)` (the zoom `fit()` would use), and repeating up to 3 times until it settles. `renderWall` uses `wallLayout`.
  - **Sections look like Figma's:** a box in wall units (`sg.box`): `SEC.pad` (16 px at zRef) around the frames, `SEC.top` (frame-name room, 40 px or 25 px when meta is hidden/far) above them, a 30 px title band above the box, and clusters `SEC.between` apart. `.sec` is a filled rectangle (ink 6% over the canvas, 1 px inset line, 3 px corners); `.sec-t` is the name, a screen-sized pill just above the box, aligned left (`bottom: 100%`), that selects the section's frames (`data-seg="g:s"`). Names hide with `no-headings`; sections hide in Present.
- **Dot grid (v0.10.1):** moves and scales with the wall. It's `#grid` (two `<i>` dot layers) inside `#viewport`; `moveGrid()` picks a spacing of 10 × 2ⁿ wall units that's 12–24 px on screen and sets each layer's `background-size`/`background-position` directly (fine layer fades in by opacity). Don't put changing custom properties on `#viewport`: they're inherited, so every frame's styles get recalculated on each zoom step (v0.10.2 flicker fix).
- **Zoom performance (v0.10.2):** `applyTransform()` writes the transform of `#world` and `#live` immediately, adds `.moving` (which sets `will-change: transform`) and removes it 180 ms after the last move so the layers re-rasterise sharp, and batches the zoom-dependent styles (`--inv`, `--z`, `.far`, the grid) into one `requestAnimationFrame` (`applyZoomStyles()`). `#viewport` has `contain: layout paint`.
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
- `presentGo(i)` zooms to each frame (never past 100%, so ads stay their real size; room for the `#hud`). The HUD auto-hides after 2.5 s.
- Keys: arrows, Space, PageUp/PageDown, Home/End. Esc returns to the previous view, with the last frame selected.
- Controls floating over the canvas (`#hud`, `#filterpill`, `#banner`) are excluded from the viewport's pointerdown, so pointer capture doesn't swallow their clicks.

**Remembered position (v0.6):** `prefs.wallPos[campaignId] = {zoom, tx, ty, at}`, saved with a 700 ms debounce from `applyTransform` once you've panned or zoomed, and not during Present. It keeps the 30 most recent campaigns. `restorePosition()` on open, otherwise `fit()`.

**Arranging (v0.6):** dragging a frame (no modifier keys) reorders it within its row group; dragging empty space pans.
- `startArrange`, `moveArrange` (drop line) and `endArrange` → `saveOrder(full)`.
- The order goes to `prefs.layouts[cid]` (a local copy) and `save-layout` → manifest `layouts[cid] = {order: [itemIds], at, by}`, keeping the 50 newest.
- `campaignOrder()` takes the newest `at` across all manifests and the local copy. `orderItems()` sorts before grouping, and unknown items go last.
- `hasShared(m)` (campaigns or layouts) decides publishing to Team sync and `rememberThisFile`. `writeManifest` drops `layouts` after `links` if the manifest is too big.

**Avatars:** `avatar(name)` draws initials with the person's Figma photo over them when known (`<img onerror=remove>`).
- Photos come from `PHOTOS`, filled from manifest items' `addedByPhoto` (code.js `myPhoto()` stores `figma.currentUser.photoUrl` when adding frames) and from status entries' `ph` (`prefs.me.img`, from `/v1/me` `img_url`).
- `s3-alpha.figma.com` was added to `allowedDomains` for profile pictures.

**Review statuses (v0.7):** `STATUSES` are `''`, draft, review and approved.
- Saved via `save-status {campaignId, changes}` → manifest `statuses[cid][itemId] = {s, by, at}` in the current file. Any file can set any frame's status, and there's a local copy in `prefs.statuses`.
- `statusMap(cid)` merges all manifests plus the local copy, newest `at` per frame. `allCampaigns()` adds `it.status`, `statusBy` and `statusAt`.
- **UI:** `statusBadge` on tiles and the panel list, `statusControl` in the inspector (one or many frames), `progressBar(items)` in the panel summary and home cards, a status chip group in Filters, and the status in the Present HUD.
- `hasShared` counts statuses, and code.js keeps the 50 most recent campaigns.

**Campaign home (v0.7):** the `home` view (`renderHome`) opens from the grid button in the panel header. It also opens on load when there's no active campaign and more than one campaign exists.
- Cards come from `campaignStats(c)`: up to 4 cached render URLs as a collage, contributors (`avatar(name)`, colour hashed from the name), last activity, channels and progress.
- Hovering a card shows a Wall button that opens the wall directly. A search field appears when there are more than 4 campaigns.

**Live and motion (v0.7):**
- `animateWall(L, c)` runs after each wall render.
  - **FLIP:** frames whose position changed since `S.wall.lastPos` glide to their new spot (`.flip`). A dropped frame glides from the drop point. Glides in progress are tracked in `S.wall.flights` (`{dx, dy, t0}`), so a redraw mid-glide (e.g. the state message after saving an order) continues from the remaining offset (ease-out estimate) instead of snapping.
  - **Arrivals:** frames not in `S.wall.known` get `.arrive`, a scale-in plus brand glow. `--ad` (a negative animation delay) keeps the animation going smoothly across re-renders.
  - `announceArrivals` shows "Name added X · Channel [Show]" pills in `#arrivals`, grouped per person, which auto-dismiss after 7 s.
- **Panel:** `noticeArrivals()` (called from `render()` for panel and home) toasts teammates' new frames, ignoring frames from the current file, and briefly highlights their rows (`.item.new`). `activityFeed(c)` lists the last 5 additions and status changes.
- **Other motion:** filters toggle `.dim` in place, so frames fade. Popovers animate with `pop`, and screens ease in when the view changes (`S.lastView`). Everything respects `prefers-reduced-motion`.

**First-run setup (v0.7):** the `welcome` view (`renderWelcome`) shows on load until `prefs.onboarded`, and can be reopened from Settings › Setup guide. It has three steps:
1. **Token:** shown when not connected, with the scope list.
2. **Team:** paste the team link, or "Set up for you" if `TEAM.teamId` or folders are built in.
3. **Team sync:** paste the index link, or built in through `TEAM.indexFile`.

`checkAccess()` tests each scope separately and stores the results in `S.ob.checks`:

| Scope | Request |
|---|---|
| `current_user` | `/v1/me` |
| `file_metadata` | `/files/:key/meta` |
| `file_content` | `/files/:key?depth=1` |
| `file_versions` | `/versions?page_size=1` |
| `folders` | team folders, or the first folder |
| `file_variables` | `/variables/local` on the index file |

Steps that can't be checked yet show "–" with a note. Tests skip the screen through `boot(..., {welcome: true})`.

**FigJam boards (v0.8, prototype):** `manifest.json` `editorType` is now `["figma","figjam"]`. code.js sends `editor` (`figma.editorType`) and, in FigJam, `board`: `boardSummary()` per campaign `{count, placedAt, syncedAt}`.
- In FigJam the panel's Selection area becomes `boardCard(c)`: Send to board (Size: real or half, `prefs.boardOpts.scale`; Live embeds: per file, per frame or none, `prefs.boardOpts.embeds`). Once the campaign is on the board, it offers Sync board. `add-selection` is refused on boards.
- `sendToBoard(mode)` runs `syncItems` first (Sync forces re-reads), then sends `board-place` or `board-sync` with items `{id, fileKey, nodeId, name, channel, fileName, w, h, url, hash, status}`. `S.boardJob` holds the button label while it runs and clears on the next state or error.
- **`boardPlace`:**
  - An outer section "<campaign> · Showroom" placed right of existing content (`emptySpot`), holding a title, then embeds, then one section per channel.
  - Each frame is a rectangle with an IMAGE fill (`figma.createImageAsync(url)`), at real or half size. A label sits above it: name, "Status · Channel · File" with the status word coloured, and "Open live ↗" hyperlinked to the frame.
  - Embeds come from `figma.createLinkPreviewAsync` (FigJam only): one per file or per frame, wrapped in try/catch. They report a placeholder size until loaded, so `addEmbeds` asks each for 960×540, waits 1.2 s, then measures and spaces them in a row (falling back to 1152×648 if still unmeasured). Embeds overlapped before this fix.
  - Tags (shared plugin data, ns `showroom`):
    - `board` on the outer section: `{campaignId, name, placedAt, syncedAt, scale}`;
    - `boardItem` on each image: `{campaignId, itemId, fileKey, nodeId, hash, status, scale, syncedAt}`;
    - `boardLabel` on each label text: `{itemId, part}`;
    - `channel` on each channel section.
  - `makeSection` falls back to a frame if `createSection` fails.
- **`boardSync`:**
  - Images whose `hash` changed get a new fill in place. The top-left stays where it is, and the size follows the frame's new size times scale.
  - Label names and statuses are rewritten. Frames no longer in the campaign fade to 35% opacity.
  - New frames go into an "Inbox · new frames" section right of the board.
  - It updates `board.syncedAt` and returns a summary message.
- **Unverified in real FigJam:**
  - `createSection` and `hyperlink` on text in FigJam plugins;
  - `createImageAsync` with the S3 render URLs (they're in `allowedDomains`);
  - whether `createLinkPreviewAsync` on a Figma design link makes an EmbedNode;
  - the 4096 px image cap on long frames.
- Tests build a small mock FigJam canvas inside `plugin.test.cjs`.

**Live prototypes (v0.10):** frames play their real Figma prototype on the wall.
- **Detection:** when frames are read (`/nodes`), `proto` is set on the cache node if its JSON has `"interactions":[{`, a `transitionNodeID` or a scrolling `overflowDirection`. Older cache entries only get it after a re-read (Refresh). `hasProto(it)` = that, or `isFlowStart(it)`: the frame is a prototype flow's starting point. Flow starts come from code.js (`flowStarts()` over every page's `flowStartingPoints`, sent as `file.flows`; `writeManifest` stores this file's campaign frames that start a flow as manifest `flows`, and `syncFlows()` on init rewrites the manifest when that list changed) and from folder-search reads (`scan.files[key].flows`). Interactions that come from components (instances) don't show in the REST JSON, so some prototypes are still missed. Every play control (wall ▶, the inspector's Play/Large, the Present ▶ and K) only shows for `hasProto` frames (v0.14.1): Figma's player, given a frame that isn't part of a flow, plays the file's first flow instead, which is confusing.
- **▶** (`.pb`) sits just above the frame's top-right corner on its name line, like Figma's prototype icon; the tile gets `.hasproto`, which shortens its label to make room. The viewport's pointerdown handles it before anything else (`playInPlace(id)`).
- **`playInPlace(id, {noZoom})`:** zooms to the frame's own box (`liveBox(p)`: placement + `offX/offY`, `width/height`, max 100%; in a wall device (v0.14.2) the device's screen: height `devScreen().full`, `top` = the bar height, which lifts `.lv-bar` above the chrome via `--lvt`; a taller frame's iframe is top-aligned, not centred), then adds `.lv` (`.lv-bar`: "Live · name", Restart, Large, Stop; and `.lv-crop` with the iframe) to `#live`.
  - **Same size as the image:** on the wall the embed uses `scaling=min-zoom` (Figma's "Actual size") and the iframe is `LIVE_MARGIN` (120 px) bigger on every side, offset by −120, inside `.lv-crop` (overflow hidden, the frame's exact box). So the prototype shows at 100% exactly where the image was, and any space Figma's viewer leaves around it is cropped away. With `scaling=contain` (still used by the Large window) the prototype was shrunk with black margins. Unverified in real Figma: that `min-zoom` means Actual size in both embed styles.
  - `#live` is a sibling of `#world` inside `#viewport`; `applyTransform` gives it the same transform and `--inv`, and `glide()` animates both. It's never redrawn, so wall redraws don't reload the iframe (moving an iframe in the DOM would). `syncLive()` (called from `renderWall`) repositions it, or stops it if the frame is gone or filtered out.
  - One at a time (`S.wall.live = {id}`); the tile gets `.playing` (hides its label and ▶). `#live` is excluded from the viewport's pointerdown; clicks inside the iframe never reach the parent anyway.
  - Stops on Esc, Stop, leaving the wall (`closeWall`), entering/leaving Present.
- **Play button (v0.13):** `#hud-play` (▶/■) shows on prototype frames (`hasProto`) in Present, whatever `protoPresent` is; `presentTogglePlay()` (also K) plays inside the device (`showDevice(p, {proto: true})`) or on the wall (`playInPlace`), or stops. `hudSync()` (called from `presentGo`, `showDevice`, `playInPlace`, `stopLive`) updates the button and the HUD's "Prototype / Live prototype" text.
- **Present:** `presentGo` stops a live prototype from another frame, and if `wallView().protoPresent === 'auto'` plays prototype frames 420 ms after the zoom (`S.wall.autoplayTimer`). The HUD shows "Prototype" / "Live prototype". Clicking into the iframe moves keyboard focus into it; a `window` blur listener toasts once how to get the keys back (click outside).
- **View options › Live prototypes:** `protoStyle` (`legacy` = Clean, default; `kit2` = With controls) and `protoPresent` (`auto`, `click`). Changing the style restarts a playing prototype.
- **Embeds** (`protoUrl(it, style)`):
  - `legacy`: `www.figma.com/embed?embed_host=showroom&url=<www.figma.com/proto/:key/?node-id&starting-point-node-id&hide-ui=1&hotspot-hints=0&scaling=contain>`, no Figma controls.
  - `kit2`: `embed.figma.com/proto/:key/?…&footer=false&viewport-controls=false&hotspot-hints=false&device-frame=false&scaling=contain&content-scaling=fixed`. Still shows a small ← → ↺ bar.
  - Tested 2026-10-05 in Figma desktop: both load private files signed in. `manifest.json` allows `embed.figma.com` and `www.figma.com`. The Embed API (events/controls) needs an OAuth client-id and allowed origin, which a plugin iframe can't provide, so it isn't used.
- **Large window:** `openPlayer(it, style)` fills `#player` (a full-window dark stage over everything, v0.14.2, like Present) with the same embed in `.pl-stage`, and a floating `.pl-hud` toolbar at the bottom (name · Live prototype, Clean/With controls, Restart, Open in browser via `open-item {proto:true}`, ✕); Esc/✕ closes. The toolbar sits at 70% opacity until hovered (it can't auto-hide: pointer moves inside the iframe never reach the plugin). The inspector has Play prototype (in place, or Stop) and Large.

**Device frames (v0.11–v0.12):** Site pages show inside a generic browser window or phone, in Present and optionally on the wall.
- **Which device:** `deviceFor(it)` = the frame's choice (`it.device`: auto, browser, phone, none) or `autoDevice(it)` → `{d, why}`:
  - only channels matching /site|web|landing|store|shop|ecom/;
  - a header or footer layer (`n.hdr`/`n.ftr`, see below) at a page width → browser (≥ 1000 × 600) or phone (320–500 wide, ≥ 560 tall), whatever the name;
  - otherwise names with banner, tile, promo, module, section, card, hero, nav, modal, component, iga, ad(s) or "in-gallery" → none;
  - otherwise ≥ 1000 × 600 → browser; 320–500 wide and ≥ 560 tall → phone; else none.
- **Page parts (v0.12):** when frames are read, `pageParts(doc)` looks at the frame's direct children (or the children of a single wrapper that fills it) for a header across the top (full width ±10%, within 40 px of the top, ≤ 420 px and ≤ 40% of the height, named /header|navigation|nav|masthead|top bar|menu bar|global/) and a footer along the bottom of the frame or of the content spilling below it (named /footer/). Used only for Auto's guess. Stored on the cache node as `hdr {id, h, y, x, w}` and `ftr`. Older cache entries get them after a re-read.
- **Choice is shared** like statuses: `setDevice(ids, d)` → `prefs.devices` (local copy) + `save-device {campaignId, changes}` → manifest `devices[cid][itemId] = {d, by, at}` (newest wins across files, 50 campaigns kept). `deviceMap(cid)` merges; `allCampaigns()` sets `it.device`/`it.deviceBy`; `hasShared` counts `devices`. The inspector's "Device frame" control (`deviceControl`) shows what Auto picks and why.
- **View options › Device frames:** `devicePresent` = `on` (In Present, default), `wall` (Wall too) or `off`; `deviceHeight` = `real` (default) or `frame` ("Screen-sized frames in Present"); `siteAddress`. (The v0.12 sticky header was removed in v0.13.1: prototypes cover that.)
- **Present:** `showDevice(p, {proto})` (from `presentGo`; `null` removes it) builds `#dev`, an opaque stage over the wall (z 5, under the HUD), with `deviceHTML(kind, it, n, W, H, VH, proto)` drawn at the design's own size and scaled to fit (`≤ 1`).
  - Browser: tab strip (42) + toolbar (46) with back/forward/reload, an address pill (`deviceAddress(it)`: the View options address, default www.example.com, plus a path slugged from the frame name, or the page name when the name is generic), star (≥ 1200 wide), avatar, menu. Phone: 14 px bezel, status bar (54) with island, bottom address bar + nav (112). Neutral designs, not any real browser or phone.
  - Page size: `pageBox(n, p)` = `{W, H, PH}`: PH is the content from the frame's top down (`viewH − offY`) when more than 40 px spills below the frame (a screen-sized frame with the page under it), else H.
  - Page-area height VH = `deviceView(kind, W, H, PH, proto, mode)`. A real screen is phone `W × 2.164` (390 × 844) or browser `W × 0.5625` (16:9, 1536 × 864), each including its bars (phone 54 + 112, browser 88); `full` = screen − bars. `real` (default): `min(PH, full)`, so the device is always a normal size and the rest scrolls. `frame`: a screen-sized frame (spilling content and H ≤ 2 screens, or H ≤ 1.15 × full) shows whole (VH = H), long pages still get `full`. Live prototypes: the whole frame if H ≤ 1.6 × full (unverified whether Figma's player scrolls past its window), else `full`. `max = PH − VH`.
  - Wheel: in Present with a device, the viewport's wheel handler sends every wheel to `devWheel` (pointer anywhere), which converts line/page `deltaMode`s. `S.wall.dev = {id, y, max, vh, h, s, proto}`; `devScroll(dir)` moves 85% of a screen (animated) and returns false at the end, so ↓/Space/PageDown and ↑/PageUp scroll first, then change frame; ←/→ always change frame. Trackpad: `devWheel`. A thin scrollbar shows the position.
  - **Prototypes in the device (v0.12):** a prototype frame that autoplays in Present (`protoPresent: auto`) and has a device plays inside the device's window (`.dv-live`) instead of on the wall: the embed at `scaling=min-zoom`, `LIVE_MARGIN` wider on each side and cropped; a frame that fits is cropped on all sides (centred), a taller one is top-aligned (only the sides cropped) and scrolls inside Figma's viewer. `dev.max = 0`, so the keys move between frames. Unverified in real Figma: whether a tall frame really starts at the top at Actual size. Without a device, prototypes play on the wall as before.
- **On the wall (v0.12, "Wall too"; reworked v0.13):** `wallDevBox(kind, n, w, h)` places the device in the tile's coordinates, following the frame's own box (`offX/offY/width`), not the render bounds: both are a real screen tall (`devScreen`, v0.14.1): browser = bar 88 above the frame and a window `full` tall; phone = a normal-height body (`68 + full + 126`) over the frame's top. A longer page runs on below the device and follows "Content outside a frame": shown, faded (`.wdv-fd`, a `.fd` band below the device) or hidden (cropped to the screen, scrollable when selected). It returns `{box, ins}` (`ins` = room needed outside the tile); `layout()` stores `p.db`, `p.ins`, `p.oy/p.oh` (block row top/height, used for sections).
  - `wallDeviceHTML(kind, it, n, db, w, h)` draws the chrome plus `.wdv-bg` (the frame's fill, `n.fill` from `solidFill()`, else white; at least a screen tall) behind the image, so rounded or see-through corners in Figma's render show the page colour. The browser (`.wdv-browser`) sits under the image; the phone (`.wdv-phone`, z 3) is a 14 px border with a see-through screen, on top of the image, its bars clipped by the screen's rounded corners.
  - The tile gets `.wdv-on dev-<kind>` (not `wdv-<kind>`: that clashed with the chrome's own class and clipped/rounded the tile in v0.12), `--dvt/--dvl/--dvr` to lift `.lbl` and `.pb`, `--w` including the insets, no `border-radius`, and no edge line/fade (the device shows the screen).
- **Not built yet:** tablets, content spilling out to the sides of a page (it shows outside the browser window), in-context previews for ads/social/email (see the ideas doc).

Wall selection is `S.wall.selected` (an array):
- Shift, Ctrl or ⌘-click toggles a frame.
- Shift-drag on the background draws a selection box. Tiles it touches get `.willsel` (outline + tint) while dragging (`marqueeHits(d, e)`, device insets count); cleared on release.
- Clicking a channel heading selects that row.
- Ctrl/⌘+A selects all, and Esc clears.
- The code.js actions `remove-item` and `set-channel` accept `itemIds`.

Double-click is detected manually in `pointerup`. Pointer capture retargets native `dblclick` to the viewport, so the native event can't be used.

Rate limits: tier 1 is about 15 requests/min on an Organization plan with a Full or Dev seat. View and Collab seats are nearly unusable.

## Messages (UI → code)

`init`, `save-token`, `add-selection {campaignId|'' (new tag), campaignName, channel, keepActive?, nodeIds?}`, `update-selection {channel}`, `create-campaign`, `rename-campaign`, `hide-campaign {shared}`, `unhide-campaign`, `unhide-items`, `set-active {campaignId, campaignName}`, `remove-item {campaignId|'__all', itemIds}`, `set-channel {itemIds, channel}`, `mark-seen {seen}`, `set-file-key {url}`, `save-links {links}`, `save-layout {campaignId, layout}`, `save-status {campaignId, changes}`, `save-device {campaignId, changes}`, `board-place {campaignId, campaignName, items, embeds, scale}`, `board-sync {campaignId, items}`, `save-cache`, `save-scan`, `save-prefs`, `resize`, `open-item {fileKey, nodeId, versionId?}`, `notify`.

Code → UI: `state` (full), `selection`, `error`.

## Status and open questions

- v0.1 was tested in real Figma on 2026-09-29. The API and images load fine from the plugin iframe, and `figma.fileKey` works in development.
- v0.2 adds team sharing and history. It was tested with `npm test` (46 checks) and screenshots, but not yet in real Figma. Things to confirm there:
  - that `plugin_data=shared` returns the root or page manifest;
  - that the v2 folders endpoint's response fields match what the code parses;
  - that the image render for a version works for old versions.
- v0.3 adds links between campaign files, the daily re-check, Look back and team folder discovery. `npm test` has 59 checks. Also to confirm in real Figma: the team folders response and folder `meta` `updated_at` behaviour.
- v0.4 adds Team sync (the variables index). `npm test` has 126 checks. First real test on 2026-09-30 worked: team link found 21 folders, a folder listed 4 files, the index filled with 2 files, and the wall showed both. Personal tokens offer these scopes: current_user, file_content, file_metadata, file_versions, file_variables read/write, folders:read (no projects or folder_metadata).

## Next steps (not built)

1. Editable channel list and statuses.
2. Review notes posted as real Figma comments (`POST /v1/files/:key/comments` with `client_meta` for the node).
3. Export the wall (PNG or PDF) for stakeholders without Full seats.
4. Show "this frame changed in this version" in History. That needs node reads per version, which is expensive, so it's opt-in at most.
