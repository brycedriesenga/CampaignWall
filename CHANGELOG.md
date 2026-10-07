# Showroom versions

Newest first. Each line is one build on GitHub, with its commit ID.

**To try an older build:** in the plugin's folder, run `git checkout <commit ID>`, then re-run Showroom in Figma (no re-import needed unless `manifest.json` changed; if Figma complains, re-import it). **To come back to the newest:** `git checkout main`. Your campaigns, statuses and settings live in your Figma files and on your computer, so switching builds doesn't lose them.

| Version | Commit | What changed |
| --- | --- | --- |
| 0.15.1 | latest on `main` | Group wall rows by tag; Open in Showroom stays centred on the frame while the window grows |
| 0.15.0 | `74de2e1` | Tags: frames can have any number of tags (campaigns become plain tags); tag and untag from the panel or the wall's details; All tagged frames + filter by tag; Open in Showroom / Edit tags in Figma's properties panel |
| 0.14.2 | `4bdec90` | Scrolling a frame on the wall no longer pans at the ends; its scrollbar fades; prototypes on the wall play inside their device's screen; cleaner Large window |
| 0.14.1 | `f3f3f01` | Play controls only on real prototypes; devices on the wall are a real screen and count as the frame for Show/Fade/Hide; scroll a selected frame's hidden page on the wall |
| 0.14.0 | `b0e55a1` | View options in three tabs (Look, Layout, Present); Hide content outside a frame; ▶ in Present on any frame; prototypes also detected from scrolling and flow starting points |
| 0.13.1 | `ec10645` | Device frames in Present are a real screen size by default (option: Whole frame for screen-sized frames); sticky header removed |
| 0.13.0 | `91e1932` | Play/stop button for prototypes in Present (▶ on the toolbar, or K); Shift-drag box highlights frames as it goes; device frames: mouse-wheel scrolling anywhere in Present, pages that spill out below a screen-sized frame scroll, whole frame shown for prototypes in a device, phone on the wall is a normal height lying over the page, no more rounded/cropped corners |
| 0.12.0 | `d27794b` | Device frames: on the wall too ("Wall too"), sticky header while scrolling in Present, prototypes play inside the device, header/footer layers detect whole pages |
| (0.12 work) | `5f9f877` | Prototypes play inside the device in Present |
| (0.12 work) | `6e2a061` | Sticky header in Present |
| (0.12 work) | `b35321d` | Device frames on the wall |
| (0.12 work) | `259c14d` | Header/footer layers mark whole pages |
| 0.11.0 | `015ffb6` | Device frames in Present: browser window and phone, scrolling long pages, per-frame choice shared with the team |
| 0.10.2 | `dcce6cf` | Smoother zooming, flicker fixes |
| 0.10.1 | `44519cd` | Figma-style sections, moving dot grid, real-size prototypes, Present capped at 100% |
| 0.10.0 | `f3187b4` | Live prototypes on the wall and in Present |
| 0.9.1 | `8c1c9b9` | Prototype embed test |
| 0.9.0 | `158ab3f` | Clusters within rows, team settings in the Team sync file, team presets |
| 0.8 | `dccf601` | Edge line and fade, profile pictures, FigJam embed spacing |
| 0.8 | `2c8bda7` | FigJam board prototype |
| 0.7 | `66c67dc` | First-run setup guide, statuses, campaign home, live arrivals |
| 0.6 | `6687407` | Shortcuts, filters, Present, remembered position, drag to arrange |
