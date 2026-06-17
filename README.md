# New Tab Photo Gallery

A Chrome Manifest V3 new-tab extension that replaces the default new tab page with a full-screen clock, date, battery/network status, and an animated local photo plane.

## Features

- Full-screen new tab page with time, date, battery, and network status.
- Animated canvas photo plane with hover zoom.
- Photo controls for speed, density, size variation, and travel direction.
- Local photo controls inside settings for reading one folder and saving an editable reference path.
- Bundled fallback images from `photos/`.

## Project Structure

- `manifest.json` - Chrome extension manifest, storage permission, new-tab override, and icons.
- `newpage.html` - New tab markup and styles.
- `index.js` - Clock, date, battery/network display, and favicon handling.
- `photos.js` - Animated photo canvas, bundled fallback loader, and local folder source switching.
- `localphotos.js` - Local settings controls for folder selection, editable reference paths, and saved folder access handles.
- `icons/` - Extension icons.
- `photos/` - Bundled fallback photo folder expected by `photos.js`.

## Local Installation

1. Open `chrome://extensions`.
2. Turn on Developer mode.
3. Click Load unpacked.
4. Select this project folder.
5. Open a new tab to view the extension.

After changing files, return to `chrome://extensions` and reload the extension.

## Local Photos

The page starts with the bundled fallback images from:

```js
chrome.runtime.getURL("photos/" + index + ".jpg")
```

The settings panel can replace that set with images read from one selected folder. Folder mode keeps a browser-granted access handle and reads the original files from the computer when the photo plane needs them; it does not copy the folder into the extension. The path field next to the folder button is editable reference metadata and updates when a new folder is selected. Chrome exposes the selected folder's handle name, not an absolute macOS path like `/Users/name/Folder`. Chrome does not allow a new-tab page to read an arbitrary typed filesystem path by itself, so folder access comes from the browser picker; when supported, Chrome can refresh that access on reload.

## Troubleshooting

- No bundled photos appear - Confirm images exist under `photos/` and use numbered `.jpg` names.
- Selected folder photos do not load - Confirm the folder contains image files such as `.jpg`, `.png`, `.webp`, `.gif`, or `.avif`.
- Last source is listed after reload but not active - Select the folder again so Chrome grants fresh file access for the tab.
