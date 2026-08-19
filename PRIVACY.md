# Privacy Policy — WebRTC Inspector

WebRTC Inspector does not collect, store, or transmit any user data. There is no backend, no analytics, no telemetry, and no account system.

## What the extension does

- Injects a script into the active tab that reads/calls standard browser APIs (`RTCPeerConnection`, `RTCDataChannel`, `WebSocket`, `getUserMedia`/`getDisplayMedia`) so the DevTools panel can display live connection, track, data-channel, and WebSocket state.
- Displays this information only inside your local Chrome DevTools panel, on your machine. Nothing is sent to any server operated by the developer or anyone else.
- Optionally, if you explicitly click "Record screenshots" in the panel, captures a screenshot of the inspected tab (using the `tabs` permission) and shows it inline in the panel. This image stays in the DevTools panel's memory for that session and is never uploaded or transmitted anywhere.

## Permissions

- **`host_permissions: ["<all_urls>"]`** — required so the content script can patch the WebRTC/WebSocket APIs before a page's own scripts run, on whatever site you're currently debugging. It does not read page content, form data, cookies, or other site data.
- **`tabs`** — used only for the opt-in screenshot capture described above.
- **`contextMenus`** — adds a single "Test this stream" right-click entry on `<video>`/`<audio>` elements, which overlays live status on that element. No data leaves the page.

## Third parties

None. No data is sold, shared, or transferred to any third party, because none is collected in the first place.

## Changes

Any future change to this policy will be made in this same file, in the same GitHub repository, alongside the code it describes.

## Contact

Issues: https://github.com/zoharbabin/webrtc-inspector/issues
