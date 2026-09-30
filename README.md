# Showroom

*Formerly Campaign Wall.*

A Figma plugin for reviewing a campaign across channels. Add frames from any file, in any channel folder, to a campaign. Then see every frame together, at real size, on one zoomable wall inside the plugin.

The wall reads frames straight from their files through Figma's API, so it's always current. It shows which frames changed since you last looked and lets you step back through each frame's version history. Campaigns are shared: everyone on the team sees the same campaign, whoever added the frames.

## How it works

- **Adding frames:** select frames in a design file and click **Add to …**. The campaign list is saved **inside that file** as hidden plugin data, so it travels with the file and anyone can read it.
- **Finding the team's frames:** the plugin searches your team's **channel folders** for files that contain campaign frames.
  - A file is only opened the first time it's seen, or after it has been edited.
  - The first search only looks at files edited in the last 120 days. Change this with `TEAM.searchDays` in `ui.html`.
- **Showing the frames:** Figma renders the images. Only frames whose contents changed are re-rendered.
- **What's stored on your computer:** your token, a cache, which changes you've already seen, and anything you've hidden. None of it is team data.

## Set up (each person, once)

1. **Get the plugin:** download or clone this repo. If the team has a published copy, see "Rolling it out to the team" below.
2. **Import it:** in the **Figma desktop app**, go to **Plugins › Development › Import plugin from manifest…** and choose `manifest.json`.
3. **Make a personal access token:** in Figma, go to **Settings › Security › Personal access tokens**. Set these to read-only:
   - File content
   - File metadata
   - File versions (for History)
   - Projects (for searching team folders)
   - Current user
4. **Connect:** run the plugin, open **Settings**, paste the token and click **Test and save**.
5. **Team folders:** if the folders aren't built in (see below), paste each channel folder's link under **Team folders**.

## Using it

- **Add frames:** select frames, pick a campaign, then click **Add**.
  - The channel is guessed from the frame's size: 600 px wide → Email, 1080 × 1080 → Social, 300 × 250 → Display ads, 1200 px+ → Site.
  - Creating a campaign with the same name as an existing team campaign joins it instead of making a copy.
- **Open the wall:** click **Open wall**, and drag the bottom-right corner to resize the window.
  - Pan by dragging or scrolling. Zoom by pinching, or hold ⌘/Ctrl and scroll.
  - Click a frame for details. Double-click it to jump to the real frame.
- **Select several frames:** Shift-click, or Shift-drag a box on empty space. Clicking a channel name selects that row, ⌘/Ctrl+A selects all, and Esc clears.
- **Refresh:**
  - The toolbar button re-checks every frame.
  - **Refresh** in the details panel reloads just the selected frames, plus anything else that changed in the same files. That costs the same number of requests.
- **History:** select a frame and click **History** to see the file's saved versions.
  - Pick a version to see the frame as it was then, and flip between **Then** and **Now**.
  - **Open** takes you to that version in Figma.
  - Figma saves versions periodically as people work, not after every edit.
- **Removing frames:**
  - Removing a frame from the file you're in removes it for everyone.
  - Frames that live in other files can only be removed from their own file. On your wall you can hide them for yourself.
- **Frames with content outside their edges:** the wall shows everything that's visible, like Figma does. A dashed line marks the frame's actual edge.

## Rolling it out to the team

**Build the team's folders in.** In `ui.html`, fill in `TEAM.folders` with your channel folders:

```js
const TEAM = {
  folders: [
    { id: '123456789', name: 'Site' },
    { id: '234567890', name: 'Email' },
  ],
  searchDays: 120,
}
```

A folder's ID is the number in its link: `figma.com/files/…/project/123456789/Site`.

Then share the plugin in one of two ways.

- **Option A: development plugin.** Each person imports `manifest.json` from a copy of this repo, as in the setup steps. It's simple, but everyone has to pull updates themselves.
- **Option B: private organization plugin** (needs an Organization or Enterprise plan). In the desktop app, go to **Plugins › Manage plugins › Publish** and choose to publish only to your organization. Teammates then install it from your org's plugins and get updates automatically when you publish again.
  - If Figma rejects the plugin ID when publishing: create a new plugin in **Plugins › Development › New plugin…**, copy its `id` into `manifest.json`, and publish again.
  - The first person to publish may need an admin to approve it, depending on your org's settings.

Each person uses their own token, so API limits are per person. Figma's heavier requests (reading a file, rendering images) are limited to roughly 10–15 a minute on Full and Dev seats. The plugin paces itself to stay under that. View and Collab seats get only a handful of requests a month, so they can't really use the wall.

## Development

- There's no build step. `code.js` and `ui.html` are plain JavaScript that Figma loads directly.
- Tests: `npm install`, then `npm test`. They run `code.js` in a mock Figma sandbox and `ui.html` in jsdom against a fake Figma API.
- `CLAUDE.md` has architecture notes, the storage layout, the API calls and the design decisions.

## Files

- `manifest.json`: plugin settings, including which Figma domains it may call.
- `code.js`: runs inside Figma. Handles the selection, the campaign list saved in each file, local storage and navigation.
- `ui.html`: the panel, the wall, the history view, the folder search and all Figma API calls.
- `tests/plugin.test.cjs`: end-to-end tests.
- `tools/test-variables-index.mjs`: a one-off check of whether a Figma file's variables can hold a shared team index (Enterprise only). Instructions are at the top of the file.
