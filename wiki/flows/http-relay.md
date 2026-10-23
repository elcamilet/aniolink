---
title: HTTP relay flow
type: flow
responsibility: Follows a token through PUT and GET when at least one peer is a terminal, including the cross-notifications, claims and integrity checks.
trigger: PUT /{token}/{filename} plus GET /{token}
sources:
  - backend/aniolink.py
  - frontend/src/App.jsx
  - backend/templates/download.html
  - backend/tests/test_transfer.py
synced: 72f38a0
confidence: high
related:
  - ../architecture.md
  - ../components/backend-relay.md
  - ../decisions/transfer-integrity.md
---

# HTTP relay flow

A terminal transfer is a rendezvous between two HTTP requests. The uploader's `PUT` registers a stream and waits; the downloader's `GET` claims the other side and starts pulling. The server never sees a complete file, only the chunks it forwards.

```
curl/browser          server                         curl/browser
    │ PUT /t/file         │                                │
    │────────────────────>│ claim uploader                 │
    │                     │ notify WS: http_upload_available
    │                     │ wait download_ready            │
    │                     │<──────────────── GET /t ───────│
    │                     │ claim downloader               │
    │                     │ notify WS: curl_download_connected
    │                     │ wait upload_ready (already set)│
    │<── read request.stream() ── yield chunks ──────────>│
    │ 200 éxito / 502      │                                │ 200 stream
```

## Upload side

`PUT /{token}/{filename}` first rejects an unknown token with `404` and a token that already has an uploader with `409` (`aniolink.py:279`). The claim is set synchronously before the first `await` (`aniolink.py:283`), so two concurrent uploads cannot both pass the check. The handler stores the request stream, filename, content type and `Content-Length` in the bridge (`aniolink.py:88`), marks `transfer_active`, and sends `http_upload_available` to any browser WebSocket already waiting (`aniolink.py:303`).

The upload handler then waits up to `TIMEOUT_SECONDS` for `download_ready` and, once a downloader starts, for `transfer_complete`. This is why an uploader can sit waiting with the file body not yet consumed: backpressure starts at the socket. If no downloader arrives, `408`; if the stream fails or the byte count is short, `502` with the bridge's error (`aniolink.py:308`).

## Download side

A browser page load sends `Accept: text/html` and receives the receiver template, not the stream. The raw download is a GET without that header, or with `?dl=1` to force it from the SPA. The handler claims the downloader with `409` on a second concurrent GET (`aniolink.py:348`), sets `download_connected`, and tells **both** WebSocket peers that a raw receiver appeared (`aniolink.py:359`) so a browser uploader can switch from WebRTC to `fetch` PUT. Notifying both matters when the sender is the `down` socket.

The GET waits for `upload_ready`, then returns a `StreamingResponse` with `Content-Disposition` and, when known, `Content-Length`. The first iteration of `stream_direct_p2p` sets `download_ready`, which releases the uploader. The generator reads `request.stream()` in 64 KB chunks, increments `bytes_transferred`, touches `last_activity` every 16 chunks, and in its `finally` compares the total against `Content-Length` (`aniolink.py:136`). A mismatch, a receiver disconnect (`CancelledError`) or a stream error sets `transfer_error`; the waiting PUT becomes `502` (`aniolink.py:310`).

## How each frontend enters the flow

A browser sender that sees `curl_download_connected` sends its file metadata over the WebSocket and does a raw-body `PUT` (`App.jsx:274`); it does not build a `FormData`. A browser receiver that sees `http_upload_available` fetches `/{token}?dl=1`; with FSA it feeds the reader into `showSaveFilePicker`, otherwise it goes through a native download for files over 1 GB (`download.html:279`).

The standalone page takes this flow directly when the browser has no File System Access API: its click opens `/{token}?dl=1` and skips the signaling WebSocket entirely. The server notifies the sender, the sender PUTs, and the browser's download manager saves the file without loading it into memory. If FSA exists but the picker fails for a file over 1 GB, the DataChannel sends `http_fallback`; the page shows a "Guardar con el navegador" button and the same HTTP path starts on that click. The sender ignores the later DataChannel close and `peer_disconnected` once it has seen the fallback.

## Failure boundaries

A token with an uploader but no downloader times out with `408`; a downloader with no uploader does the same in the other direction. The PUT's `finally` removes the token, and the cleanup task removes idle tokens that never acquired a peer. The upload claim is released in `finally`; a download claim is cleared on timeout, and the bridge is removed when the upload ends. The tests in `backend/tests/test_transfer.py` exercise zero-byte, 1 KB, 64 MB, both 409 cases and the activity-based expiry.
