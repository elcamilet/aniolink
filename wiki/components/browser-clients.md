---
title: Browser clients
type: entity
responsibility: Documents the sender SPA and the standalone receiver page, the protocol they share, and the dead receiver code in the SPA.
sources:
  - frontend/src/App.jsx
  - backend/templates/download.html
  - frontend/src/main.jsx
synced: 72f38a0
confidence: high
related:
  - ../architecture.md
  - ../flows/webrtc-browser-transfer.md
  - ../flows/http-relay.md
  - ../decisions/large-file-strategy.md
---

# Browser clients

There are two browser scripts and only one of them is a receiver users can reach. `frontend/src/App.jsx` is the SPA: drag-and-drop file selection, token generation, WebRTC sender, and the HTTP fallback when the other side is curl. `backend/templates/download.html` is the server-rendered page at `GET /{token}`; it is the real receiver.

`frontend/src/main.jsx:6` only mounts `App` into `#root`. The SPA has no client router: `/{token}` is answered by FastAPI, which substitutes the token into the HTML template. The SPA's `downloadToken` state and its `handleDownload` function (`App.jsx:384`) exist, but the rendered UI never calls `handleDownload`; the only download surface is the standalone page. Changes to the DataChannel protocol still need to reach both copies.

## Sender path

`generateTokenAndUpload` (`App.jsx:118`) fetches a token, opens the signaling WebSocket, creates the peer connection and the `file` DataChannel, and waits for `peer_connected`. It sends metadata over both the WebSocket (for `/info`) and the DataChannel, then waits for the receiver's `ready` before slicing the file in 16 KB chunks. The backpressure loop compares `bufferedAmount` against 2 MB, waits for `bufferedamountlow`, and re-checks the buffer every 250 ms instead of releasing on a bare timer (`App.jsx:167`). It tracks the receiver's `progress` frames and stops when it is more than 4 MB ahead of the bytes the receiver has written, so a slow disk cannot make the receiver queue grow without bound. It sends `eof`, waits for `ack`, and only then reports success. If the receiver sends `http_fallback`, the DataChannel path is abandoned and the sender waits for the native HTTP GET before doing a raw-body PUT.

If the server sends `curl_download_connected`, the same function switches modes: it sends metadata, then `fetch`es `PUT /{token}/{encoded-name}` with the raw `File` as the body (`App.jsx:274`). There is no `FormData`; the request body is the file itself, and the PUT response is the confirmation. That response waits on the server until the curl GET has consumed the stream.

## Receiver page

`download.html` receives a token in its template and starts on the button click (`download.html:133`). If the browser has no File System Access API, it skips the WebSocket and WebRTC entirely: it opens `/{token}?dl=1` with the browser's native download manager, and the server tells the sender to switch to the HTTP PUT. With FSA it opens the WebSocket, answers the offer, sets `binaryType`, and on metadata tries `showSaveFilePicker` before replying `ready` (`download.html:385`). If the picker fails for a file over 1 GB, it sends `http_fallback` and shows a "Guardar con el navegador" button. Chunks are queued into a write chain, so writes stay ordered even when the previous `write()` promise has not resolved; at eof or at the announced size it awaits the chain, closes the file (or builds a Blob), sends the ack (`download.html:251`), and only then marks the UI complete.

The page has two failure guards the SPA's copy also uses: a 60-second idle timer reset by data (`download.html:212`), and a close without eof or a complete size that aborts the writable and reports an error instead of offering a truncated file. When the peer is curl, the page handles `http_upload_available` instead of WebRTC: it fetches `?dl=1`, writes incrementally when FSA is available, uses the native download manager for files over 1 GB, and otherwise builds a Blob (`download.html:279`).

## UI and quirks

The SPA renders the sender card, the token/share block and three curl examples; the share URL is copied with a trailing space in `` `${API_BASE_URL}/${token} ` `` (`App.jsx:723`), which browsers tolerate but is easy to paste wrongly. The receiver page is styled inline, not with Tailwind, because it is served from a Python template. The page reads a fixed token from the template, so a stale open tab keeps pointing at an expired token by design.

Progress updates are throttled to roughly one per 120 ms in both scripts. The page's `supportsFsa` flag is computed once at load, so a browser without File System Access never attempts the picker, while a supported browser that loses user activation falls back through `openDiskWriter` and the large-file guard.
