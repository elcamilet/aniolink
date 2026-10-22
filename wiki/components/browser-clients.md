---
title: Browser clients
type: entity
responsibility: Documents the sender SPA and the standalone receiver page, the protocol they share, and the dead receiver code in the SPA.
sources:
  - frontend/src/App.jsx
  - backend/templates/download.html
  - frontend/src/main.jsx
synced: bf672cf
confidence: high
related:
  - ../architecture.md
  - ../flows/webrtc-browser-transfer.md
  - ../flows/http-relay.md
  - ../decisions/large-file-strategy.md
---

# Browser clients

There are two browser scripts and only one of them is a receiver users can reach. `frontend/src/App.jsx` is the SPA: drag-and-drop file selection, token generation, WebRTC sender, and the HTTP fallback when the other side is curl. `backend/templates/download.html` is the server-rendered page at `GET /{token}`; it is the real receiver.

`frontend/src/main.jsx:6` only mounts `App` into `#root`. The SPA has no client router: `/{token}` is answered by FastAPI, which substitutes the token into the HTML template. The SPA's `downloadToken` state and its `handleDownload` function (`App.jsx:321`) exist, but the rendered UI never calls `handleDownload`; the only download surface is the standalone page. Changes to the DataChannel protocol still need to reach both copies.

## Sender path

`generateTokenAndUpload` (`App.jsx:115`) fetches a token, opens the signaling WebSocket, creates the peer connection and the `file` DataChannel, and waits for `peer_connected`. It sends metadata over both the WebSocket (for `/info`) and the DataChannel, then waits for the receiver's `ready` before slicing the file in 16 KB chunks. The backpressure loop compares `bufferedAmount` against 2 MB, waits for `bufferedamountlow`, and re-checks the buffer every 250 ms instead of releasing on a bare timer (`App.jsx:181`). It sends `eof`, waits for `ack`, and only then reports success.

If the server sends `curl_download_connected`, the same function switches modes: it sends metadata, then `fetch`es `PUT /{token}/{encoded-name}` with the raw `File` as the body (`App.jsx:225`). There is no `FormData`; the request body is the file itself, and the PUT response is the confirmation. That response waits on the server until the curl GET has consumed the stream.

## Receiver page

`download.html` receives a token in its template and starts on the button click (`download.html:113`). It opens the WebSocket, answers the offer, sets `binaryType` on the data channel, and on metadata tries `showSaveFilePicker` before replying `ready` (`download.html:351`). Chunks are queued into a write chain, so writes stay ordered even when the previous `write()` promise has not resolved; at eof or at the announced size it awaits the chain, closes the file (or builds a Blob), sends the ack (`download.html:198`), and only then marks the UI complete.

The page has two failure guards the SPA's copy also uses: a 60-second idle timer reset by data (`download.html:177`), and a close without eof or a complete size that aborts the writable and reports an error instead of offering a truncated file. When the peer is curl, the page handles `http_upload_available` instead of WebRTC: it fetches `?dl=1`, writes incrementally when FSA is available, falls back to the native download manager for files over 1 GB without FSA, and otherwise builds a Blob (`download.html:245`).

## UI and quirks

The SPA renders the sender card, the token/share block and three curl examples; the share URL is copied with a trailing space in `` `${API_BASE_URL}/${token} ` `` (`App.jsx:650`), which browsers tolerate but is easy to paste wrongly. The receiver page is styled inline, not with Tailwind, because it is served from a Python template. The page reads a fixed token from the template, so a stale open tab keeps pointing at an expired token by design.

Progress updates are throttled to roughly one per 120 ms in both scripts. The page's `supportsFsa` flag is computed once at load, so a browser without File System Access never attempts the picker, while a supported browser that loses user activation falls back through `openDiskWriter` and the large-file guard.
