# Showroom

*Formerly Campaign Wall.*

A Figma plugin for reviewing a campaign across channels. Add frames from any file, in any channel folder, to a campaign. Then see every frame together, at real size, on one zoomable wall inside the plugin.

The wall reads frames straight from their files through Figma's API, so it's always current. It shows which frames changed since you last looked and lets you step back through each frame's version history. Campaigns are shared: everyone on the team sees the same campaign, whoever added the frames.

## How it works

- **Adding frames:** select frames in a design file and click **Add to …**. The campaign list is saved **inside that file** as hidden plugin data, so it travels with the file and anyone can read it.
- **Team sync (optional, Enterprise):** one shared "Showroom Index" file keeps a copy of every file's campaign list in hidden variables. Everyone's plugin checks it every 45 seconds, so a frame added anywhere shows up for the team within about a minute. The copy repairs itself from the files, which stay the source of truth.
- **Finding the team's frames:**
  - **Links:** every file with campaign frames also stores links to the other campaign files it knows of. Opening the plugin in any campaign file is enough to find the rest. A linked file is only read again after it has been edited, which is checked with a quick, cheap request.
  - **Folders:** the plugin also searches your team's folders, so brand-new campaign files get found. Add the team's link in Settings and it finds every folder itself, or add folders one at a time.
  - A file is only opened the first time it's seen, or after it has been edited. Files without campaign frames are re-checked at most once a day. The refresh button checks everything now.
  - **Look back** (in Settings, 30 days by default): files nobody has edited for longer than this aren't searched.
- **Showing the frames:** Figma renders the images. Only frames whose contents changed are re-rendered.
- **What's stored on your computer:** your token, a cache, which changes you've already seen, and anything you've hidden. None of it is team data.

## Set up (each person, once)

1. **Get the plugin:** download or clone this repo. If the team has a published copy, see "Rolling it out to the team" below.
2. **Import it:** in the **Figma desktop app**, go to **Plugins › Development › Import plugin from manifest…** and choose `manifest.json`.
3. **Make a personal access token:** in Figma, go to **Settings › Security › Personal access tokens** and tick these scopes:
   - `current_user:read`
   - `file_content:read`
   - `file_metadata:read`
   - `file_versions:read` (for History)
   - `folders:read` (for searching team folders)
   - For Team sync: `file_variables:read` and `file_variables:write`
4. **Connect:** run the plugin, open **Settings**, paste the token and click **Test and save**.
5. **Team:** if the team isn't built in (see below), paste your team's link under **Finding team campaigns** in Settings, or paste each channel folder's link.

## Using it

- **Add frames:** select frames, pick a campaign, then click **Add**.
  - The channel is guessed from the frame's size: 600 px wide → Email, 1080 × 1080 → Social, 300 × 250 → Display ads, 1200 px+ → Site.
  - Creating a campaign with the same name as an existing team campaign joins it instead of making a copy.
- **Open the wall:** click **Open wall**, and drag the bottom-right corner to resize the window.
  - Pan by dragging or scrolling. Zoom by pinching, or hold ⌘/Ctrl and scroll.
  - Click a frame for details. Double-click it to jump to the real frame.
- **Campaign home:** the grid button at the top left shows every campaign as a card, with a preview collage, who's contributed, when it was last active, and review progress.
- **Review statuses:** select frames on the wall and set them to Draft, In review or Approved. Statuses are shared with the team, show on each frame, and add up to a progress bar per campaign. You can filter by them too.
- **Live:** when a teammate adds frames while your wall is open, they glide in with a glow and a "Sam added …" note. Click **Show** to jump to them. The panel lists recent activity.
- **Setup guide:** the first time someone opens Showroom, it walks them through connecting their token (each permission is checked, with a plain fix if one's missing), adding the team, and turning on Team sync. Reopen it from Settings › Setup guide.
- **FigJam boards (prototype):** Showroom also runs in FigJam. Open it on a board and click **Send to board**. Every campaign frame is placed as an image, at real or half size, in a section per channel. Each image gets a label with its status and an "Open live ↗" link, plus optional live Figma embeds per file or per frame. Arrange, sticky and stamp them like anything else. **Sync board** later swaps in new versions where they sit, updates names and statuses, fades frames that left the campaign, and puts new ones in an Inbox section. Board images are copies, so they're only as fresh as the last Sync.
- **Keyboard:**
  - Shift+1 fits everything, Shift+2 zooms to the selection, and Shift+0 goes to 100%.
  - Arrow keys step from frame to frame.
  - Space+drag pans.
  - Press ? on the wall for the full list.
- **Arrange:** drag a frame to move it within its row. The new order is saved in the file and synced to the team. Dragging empty space still pans.
- **Filter:** the funnel button shows only certain channels, people, or frames updated since you last looked. The other frames fade out.
- **Present:** press P or click **Present**. Use the arrow keys to step through frames, shown as large as fits but never bigger than their real size, and Esc to go back.
- **Device frames:** Site pages show inside a browser window or a phone.
  - **In Present:** long pages scroll inside the device. Use the mouse wheel or trackpad (anywhere on screen), or ↓/Space to scroll and → to move on. The phone and browser are a real screen size (a 390 px phone is 844 tall; a browser window is 16:9), and everything below scrolls, including content spilling out below a screen-sized frame. View options › Screen-sized frames › **Whole frame** grows the device instead, so a screen-sized frame shows whole. Prototype frames play live inside the device, showing the whole frame.
  - **On the wall too:** View options › Present › Wall too puts a real-size browser window or phone on each page. Longer pages follow View options › Look › Content outside a frame: they run on below the device (Show), fade (Fade), or are cropped to the screen (Hide). With Hide, select the frame and scroll over it to scroll its page right on the wall.
  - Pages in a device get square corners, and see-through or rounded corners show the frame's own background colour.
  - **Which device:** Showroom picks it from the frame's size, name and contents (a header or footer layer means it's a whole page; banners, tiles and ads stay as they are). Change it for any frame in its details (Auto, Browser, Phone, None); the choice is shared with the team.
  - Set the address shown in the browser bar, or turn device frames off, in View options.
- **Live prototypes:** frames with prototype connections, scrolling, or a flow starting point get a ▶ just above their top-right corner. Play controls only show on those frames. (Interactions that only come from components can't be seen through Figma's API; give such a frame a flow starting point in Figma and it gets a ▶.) Click it to play the real Figma prototype right on the wall, at the frame's exact size: click through it, scroll it, then press Esc or Stop. **Large** plays it in a big window. In Present, prototype frames start playing when you reach them (or only when you press ▶ on the floating toolbar or K, if you turn autoplay off); ■ or K stops them. Click outside the prototype to use the arrow keys again. View options › Live prototypes switches between a clean embed and one with Figma's back/forward/restart buttons, and can stop prototypes from playing automatically in Present. Prototypes need you to be signed in to Figma with access to the file.
- **Position:** each campaign reopens at the zoom and position you left it.
- **View options:** the sliders button at the top right of the wall changes how it looks, just for you, in three tabs. **Look:** background colour, frame borders or shadows, content outside a frame (show, fade or hide it, plus a dashed line on the frame's edge), and frame names, file info, row headings and the dot grid. **Layout:** grouping rows by channel, by file or not at all, clustering, and spacing. **Present:** device frames, their size, the browser address, and how prototypes play. **Cluster within rows** keeps frames from the same file (or file and page) together inside a channel row, each in a Figma-style section with its name just above it (only rows that mix files get sections). Click a section's name to select its frames. Grouped by file, it clusters by channel or page instead.
- **Select several frames:** Shift-click, or Shift-drag a box on empty space (frames light up as the box touches them). Clicking a channel name selects that row, ⌘/Ctrl+A selects all, and Esc clears.
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
- **Frames with content outside their edges:** the wall shows everything that's visible, like Figma does. By default the content outside fades and a dashed line marks the frame's actual edge. **View options** has fade only, line only, or show all.

## Rolling it out to the team

### Setting up a team (one person per team, once)

Each team gets its own Team sync file. That keeps each team's campaigns, folders and settings separate. Needs Enterprise and Full seats.

1. Make an empty design file called "Showroom Index – <team>" in a folder the whole team can edit.
2. Open Showroom, go to **Settings › Team sync** and paste the file's link.
3. In Settings, add the team's link (or its channel folders) and set Look back.
4. Under Team sync, click **Save** next to "No team settings saved in this file yet". The team, folders and Look back are now stored in the file.
5. Share the file's link with the team, or add it to `TEAM_PRESETS` (below). Teammates paste the link (or pick their team) and get everything else automatically.

People whose token can't write variables still see everyone's changes. The setup guide's "Don't have one? How to set it up" section has the same steps.

### Prefilling teams for an org-wide release

At the top of `ui.html`, list each team's Team sync file:

```js
const TEAM_PRESETS = [
  { name: 'Merrell Digital', indexFile: 'dyRO1Ym4WwBa1admKnSVQs' },
  { name: 'Saucony Digital', indexFile: '<that team’s index file key>' },
]
```

The file key is the part after `/design/` in the file's link. With presets set, the setup guide asks "Which team are you on?" and one click sets everything up. A new team only needs a preset added once its index file exists and has its team settings saved.

**Or build a single team in.** In `ui.html`, set the team's ID so everyone's plugin searches its folders, or list the channel folders by hand:

```js
const TEAM = {
  teamId: '1234567890123456789',   // the number after /team/ in the team's link
  folders: [
    { id: '123456789', name: 'Site' },
    { id: '234567890', name: 'Email' },
  ],
  lookBackDays: 30,
  indexFile: '',                    // Team sync file key, optional
}
```

A folder's ID is the number in its link: `figma.com/files/…/project/123456789/Site`. Either is optional, since links between campaign files work on their own. Folders are what catch the very first frames in a brand-new file.

Then share the plugin in one of two ways.

- **Option A: development plugin.** Each person imports `manifest.json` from a copy of this repo, as in the setup steps. It's simple, but everyone has to pull updates themselves.
- **Option B: private organization plugin** (needs an Organization or Enterprise plan). In the desktop app, go to **Plugins › Manage plugins › Publish** and choose to publish only to your organization. Teammates then install it from your org's plugins and get updates automatically when you publish again.
  - If Figma rejects the plugin ID when publishing: create a new plugin in **Plugins › Development › New plugin…**, copy its `id` into `manifest.json`, and publish again.
  - The first person to publish may need an admin to approve it, depending on your org's settings.

Each person uses their own token, so API limits are per person. Figma's heavier requests (reading a file, rendering images) are limited to roughly 10–15 a minute on Full and Dev seats. The plugin paces itself to stay under that. View and Collab seats get only a handful of requests a month, so they can't really use the wall.

## Going back to an earlier version

Every version is saved on GitHub, and `CHANGELOG.md` lists each one with its commit ID. To try an older build, run `git checkout <commit ID>` in the plugin's folder and re-run the plugin in Figma. Run `git checkout main` to come back to the newest.

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
