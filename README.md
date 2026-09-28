# PolyPort 3D

PolyPort brings the Meshy Model Desk and Tripo Companion workflows together in one browser extension. It detects which supported studio is active and opens the matching workspace automatically. Separate Chromium and Firefox builds are provided.

## What it does

- **Meshy:** find model tasks, preview available thumbnails, download models as GLB or STL, set a target STL height, and download available textures.
- **Tripo Studio:** detect loaded model resources, scan the current viewer when needed, preview the visible scene, download the captured original, or convert GLB geometry to STL with optional part selection and sizing.
- **One interface:** English-language UI, a shared PolyPort design, and a direct Ko-fi support button.

PolyPort does not add usage quotas. Any sign-in or access requirements imposed by Meshy or Tripo still apply. Meshy downloads use the active Meshy session; Tripo captures and converts the model in the open browser tab. The extension is independent and is not affiliated with either service.

## Install

See [INSTALL_GUIDE.md](INSTALL_GUIDE.md) for Chrome, Edge, Brave, and Firefox installation.

## Permissions

- `tabs` and `activeTab`: detect the active studio and communicate with its open tab.
- `storage`: temporarily keep Meshy session data needed by its existing download workflow.
- `downloads`: save Meshy files through the browser download manager.
- `scripting`: reconnect Meshy page scripts when a browser session starts.
- Site access: run the matching adapter on Meshy and Tripo Studio and retrieve Meshy model assets.
The Ko-fi button opens `https://ko-fi.com/poleroso` in a new tab.
