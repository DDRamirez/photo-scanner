# Photo Scanner (PWA)

Auto-captures printed photos with a phone on a stand: lay a print down, move your hand away, and it takes a full-resolution shot. Installs on Android as an app from Chrome. Photos stay on the phone until you save them; nothing is uploaded anywhere.

## Files

- `index.html`: the whole app (camera, change detection, zoom, preview, zip export)
- `manifest.webmanifest`: app name, icon and full-screen settings for installing
- `sw.js`: service worker that lets the app open offline
- `icons/`: app icons

## Publish with GitHub Pages

1. Create a new public repository, for example `photo-scanner`.
2. Upload every file in this folder, keeping the `icons` folder (Add file, then Upload files, then drag the contents in).
3. In the repository, open Settings, then Pages. Under Build and deployment, choose Deploy from a branch, branch `main`, folder `/ (root)`, and Save.
4. After a minute or two the app is live at `https://YOUR-USERNAME.github.io/photo-scanner/`.

## Install on the phone

Open that address in Chrome, allow the camera, then tap the three-dot menu and choose Install app (or Add to home screen, then Install). It opens full-screen from its own icon from then on, and works without a connection.

## Updating

Edit the files and push them, then change `VERSION` in `sw.js` (v1 to v2, and so on). The installed app picks up the new version on the next launch or the one after.

## Notes

Photos are stored in the app's own browser storage, separate from any copy of the page opened elsewhere (for example a localhost copy), so save photos out of an old copy before switching. Save downloads zip batches to the phone's Downloads folder.
