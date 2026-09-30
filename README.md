# Campaign Wall (test build)

Add specific frames from any Figma file, in any channel folder, to a campaign, then see them all together at their real sizes on one zoomable wall inside the plugin. The wall reads frames straight from their files through Figma's API, so it's always current, and it tells you which frames changed.

## 1. Load it in Figma (one time)

1. Open the **Figma desktop app** (development plugins don't run in the browser).
2. Open any design file, then go to **Plugins › Development › Import plugin from manifest…**
3. Choose `manifest.json` in this folder.
4. Run it from **Plugins › Development › Campaign Wall (test)**.

If Figma complains about the plugin ID: use **Plugins › Development › New plugin…**, create a blank plugin, copy the `id` from the manifest it generates, paste it into this folder's `manifest.json`, and import again.

## 2. Connect to Figma's API (one time)

1. In Figma, open **Settings › Security › Personal access tokens** and generate a token.
2. Give it read-only access to **File content**, **File metadata** and **Current user**. Pick the longest expiry offered.
3. In the plugin, open **Settings** (the slider icon), paste the token and click **Test and save**.

The token is stored only on your computer, in the plugin's local storage.

## 3. Use it

- **Add frames:** select frames in any file, pick a campaign, and click **Add to …**. The channel is guessed from the frame size (600 px wide → Email, 1080 × 1080 → Social, 300 × 250 → Display ads, 1200 px+ → Site). You can override it before adding, or change it later on the wall.
- **Open the wall:** click **Open wall**. The window grows, and you can resize it from the bottom-right corner.
  - Drag or scroll to pan. Pinch, or hold ⌘/Ctrl and scroll, to zoom.
  - Click a frame to see its details. Double-click, or use **Open in Figma**, to jump to the real frame.
- **Select several frames:** Shift-click, or Shift-drag a box on empty space. Clicking a channel name selects that row, Ctrl/⌘+A selects everything, and Esc clears.
- **Refresh just some frames:** select them and click **Refresh** in the panel that appears. It reloads only those frames and always re-renders them. From there you can also move them to another channel or remove them from the campaign.
- **Frames with content outside their edges:** if a frame doesn't clip its content, the wall shows everything that's visible, like Figma does. A dashed line marks the frame's actual edge.
- **Updated badges:** when a frame changes in its file, it gets an **Updated** badge next time you open or refresh the wall. **Mark seen** clears them.

## What to test first

1. **Test and save** should say "Connected as …". If it shows a network error instead, that's the key thing this build is checking. Send a screenshot.
2. Add frames from **two different files**, then open the wall from a third file. All frames should appear.
3. Edit one of those frames, wait a minute, and click refresh on the wall. It should show **Updated**.
4. Adding frames shouldn't ask you to paste the file's link. If it does, Figma isn't giving development plugins the file ID. It still works, but it's a one-time step per file.

## How it knows what's current

- **Opening the wall** makes one light request per file to ask whether it changed. Frames are only re-read for files that did.
- **The refresh button** re-reads the frames of every file. That's one request per file, and it catches recent edits Figma hasn't flagged yet.
- Either way, the plugin fingerprints each frame and re-renders only the frames whose contents actually changed. That's what drives the **Updated** badge.

## Limits of this test build

- **Campaigns live on your computer.** To give a teammate the same campaign, use **Settings › Share** to copy it, and they paste it under **Import**. A shared, team-wide campaign list is the next step.
- **The wall shows rendered images, not live layers.** Editing happens in the real file, one click away.
- **Seat type matters.** Figma's API limits depend on your seat. Full and Dev seats are fine. View and Collab seats only get a handful of requests a month.
- **Access follows your permissions.** The token can only read files you can open.

## Files

- `manifest.json`: plugin settings, including which Figma domains it may call.
- `code.js`: runs inside Figma. Handles the selection, local storage and jumping to frames.
- `ui.html`: the panel and the wall. Makes the calls to Figma's API.
- `CLAUDE.md`: notes for Claude Code if you keep building this there.
