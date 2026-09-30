# Campaign Wall — project notes

Classic (non-generative) Figma plugin. Bryce's team keeps design files in per-channel Figma folders (Site, Email, Social, Ads…). This plugin lets you add specific frames from any of those files to a campaign, then view every campaign frame together at real size on a pan/zoom wall inside the plugin window. It replaces an earlier generative plugin ("Campaign Hub") that copied snapshots between files. Copies went stale and the wall file couldn't see source changes.

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

## Storage (clientStorage, per user and machine)

- `cw.data.v1`: `{ version, activeCampaignId, channels[], campaigns: [{ id, name, createdAt, items[] }] }`
  - Each item: `{ id: fileKey|nodeId, fileKey, fileName, nodeId, name, width, height, pageName, channel, addedAt, seenHash }`
- `cw.token`: the personal access token.
- `cw.cache.v1`: `{ files: { [fileKey]: { name, version, lastTouchedAt, lastTouchedBy, checkedAt, error, nodes: { [nodeId]: { name, width, height, hash, url, urlAt, changedAt, missing, renderFailed } } } } }`
- `cw.prefs.v1`: `{ me: { handle, email }, wallSize }`
- On frames: shared plugin data `campaignwall/campaigns` holds a JSON array of campaign IDs. It isn't read yet; it's there for future discovery.
- On the file root: shared plugin data `campaignwall/fileKey` holds the key pasted by the user when `figma.fileKey` is unavailable.

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

`init`, `save-token`, `create-campaign`, `rename-campaign`, `delete-campaign`, `set-active`, `add-selection {campaignId, channel|'auto'}`, `remove-item`, `set-channel`, `mark-seen {seen: {itemId: hash}}`, `set-file-key {url}`, `save-cache`, `save-prefs`, `resize`, `open-item {fileKey, nodeId}`, `import-campaign {json}`, `notify`.

Code → UI: `state` (full), `selection`, `error`.

## Status and open questions

- Tested in real Figma on 2026-09-29. The API and images load fine from the plugin iframe, and `figma.fileKey` works in development. Two bugs from that test are fixed: edits not appearing on refresh, and double-click not opening the frame.

## Next steps (not built)

0. **Image history.** Idea discussed, not built:
   - Render past states on demand with `GET /v1/images/:key?version=<id>`, with versions from `GET /v1/files/:key/versions`. That needs the `file_versions:read` scope.
   - Optionally keep small local thumbnails of each detected change. clientStorage has about 5 MB, and it's unverified whether S3 image bytes can be read, given CORS and canvas tainting.

1. **Team-shared campaigns.** Candidate designs:
   - A "campaign file" whose root plugin data holds the list.
   - Discovery by scanning the channel projects for the `campaignwall/campaigns` tags.
2. Editable channel list and statuses.
3. Review notes posted as real Figma comments (`POST /v1/files/:key/comments` with `client_meta` for the node).
4. Version history per frame.
5. Export the wall (PNG or PDF) for stakeholders without Full seats.
