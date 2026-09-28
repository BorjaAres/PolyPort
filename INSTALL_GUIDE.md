# PolyPort 3D — Installation guide

PolyPort 3D is one extension with separate Chromium and Firefox packages. It supports Meshy and Tripo Studio and automatically selects the matching workspace from the active tab.

## Install in Chrome, Edge, or Brave

1. Extract `PolyPort-3D-1.0.5-Chromium.zip` to a folder that you will keep.
2. Open the browser's extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
   - Brave: `brave://extensions`
3. Turn on **Developer mode**.
4. Select **Load unpacked** and choose the extracted `PolyPort-3D` folder — the folder containing `manifest.json`.
5. Open or reload the Meshy or Tripo Studio tab. Pin PolyPort to the toolbar if you want quick access.

## Load in Firefox

The Firefox build targets Firefox 128 or newer, which supports the page execution world used to connect to Tripo's viewer.

1. Extract `PolyPort-3D-1.0.5-Firefox.zip`.
2. Open `about:debugging#/runtime/this-firefox`.
3. Select **This Firefox**, then **Load Temporary Add-on…**.
4. Select the `manifest.json` file in the extracted `PolyPort-3D` folder.
5. Open or reload the Meshy or Tripo Studio tab.

Firefox removes temporary add-ons when it restarts. For a normal persistent installation, the XPI must be signed by Mozilla; the included XPI is unsigned.

## Meshy

1. Sign in to Meshy and open its model workspace.
2. Open PolyPort from the browser toolbar and select **Find my models**.
3. Preview a model thumbnail, then choose the filename, GLB or STL format, and (for STL) target height.
4. Use **Download Textures** when that option is available on a model.

## Tripo Studio

1. Open a model in the Tripo Studio viewer and wait for it to load.
2. Open PolyPort. When a model is ready, its viewer preview and **Download** action appear together in the ready-to-download card. If no file is listed, select **Find models in viewer**.
3. Select **Preview** to open a larger snapshot, or **Download** to choose the original file or STL.
4. For STL, choose a target height and, when available, a model part. GLB preserves textures; STL contains geometry only.

If PolyPort was installed while a studio tab was already open, reload that tab once so the page adapter can start.

## Privacy and troubleshooting

- Tripo's captured resources are held in the current page while it is open; close or reload the tab to clear them.
- Meshy functionality uses your active Meshy session and the existing Meshy adapter's browser storage and download flow.
- If the popup says to reload a tab, refresh the relevant studio page and reopen PolyPort.
- If Tripo preview is blank, make sure the 3D model is visible in the viewer and try **Preview** again.
- PolyPort does not add usage quotas, but it cannot remove sign-in or access requirements imposed by the studio itself.

PolyPort is an independent project and is not affiliated with Meshy or Tripo. Donations are optional and are handled by [Ko-fi](https://ko-fi.com/poleroso).
