# Privacy Policy — WebRTC Inspector

WebRTC Inspector does not collect, store, or transmit any user data. There is no backend, no analytics, no telemetry, and no account system.

## What the extension does

- Injects a script into the active tab that reads/calls standard browser APIs (`RTCPeerConnection`, `RTCDataChannel`, `WebSocket`, `fetch`/`XMLHttpRequest`, `getUserMedia`/`getDisplayMedia`) so the DevTools panel can display live connection, track, data-channel, WebSocket, and HTTP-signaling (e.g. WHIP/WHEP) state.
- To do this, it captures short previews of message and request/response content: WebSocket and data-channel messages (both directions), and `fetch`/`XMLHttpRequest` request and response bodies for network calls the inspected page makes. Text previews are truncated to 200 characters; binary/blob payloads are shown only as a size (e.g. `<binary 512 bytes>`), never as content. Because this patches `fetch`/`XMLHttpRequest` site-wide (needed to catch HTTP-based signaling), these previews can include non-WebRTC page/application data, such as API request or response payloads, if the page happens to make other network calls while you have DevTools open.
- All of this — connection/track state and the message/request previews above — stays in the page's own JavaScript memory and your local DevTools panel. It is bounded (oldest entries are dropped past a fixed cap) and cleared on page reload or tab close. None of it is written to disk, `chrome.storage`, or any other persistent store, and none of it is sent to any server operated by the developer or anyone else.
- Optionally, if you explicitly click "Record screenshots" in the panel, captures a screenshot of the inspected tab (using the `tabs` permission) and shows it inline in the panel. This image stays in the DevTools panel's memory for that session and is never uploaded or transmitted anywhere.

## Permissions

- **`host_permissions: ["<all_urls>"]`** — required so the content script can patch the WebRTC/WebSocket/fetch/XHR APIs before a page's own scripts run, on whatever site you're currently debugging. As described above, this means truncated previews of network and messaging activity on that page are visible in your local DevTools panel while you're inspecting it — never transmitted anywhere.
- **`tabs`** — used only for the opt-in screenshot capture described above.
- **`contextMenus`** — adds a single "Test this stream" right-click entry on `<video>`/`<audio>` elements, which overlays live status on that element. No data leaves the page.

## Third parties

None. No data is sold, shared, or transferred to any third party, because none is collected in the first place.

## Changes

Any future change to this policy will be made in this same file, in the same GitHub repository, alongside the code it describes.

## Contact

Issues: https://github.com/zoharbabin/webrtc-inspector/issues
