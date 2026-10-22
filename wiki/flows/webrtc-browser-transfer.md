---
title: WebRTC browser transfer
type: flow
responsibility: Follows a browser-to-browser transfer from token and signaling through metadata, backpressure, eof/ack and disk streaming.
trigger: WebSocket /{token}/signal plus RTCDataChannel "file"
sources:
  - backend/aniolink.py
  - frontend/src/App.jsx
  - backend/templates/download.html
synced: bf672cf
confidence: high
related:
  - ../architecture.md
  - ../components/browser-clients.md
  - ../decisions/large-file-strategy.md
---

# WebRTC browser transfer

Browser-to-browser is the only mode where file bytes never touch the server. The server relays SDP and ICE, then steps out of the path.

```
sender                         server                        receiver
  │ WS /t/signal ───────────────>│<─────────────── WS /t/signal │
  │<──────── peer_connected ─────│──── peer_connected ─────────>│
  │── offer ────────────────────>│─────────────────── offer ───>│
  │<───────────────── answer ─────│<────────────────── answer ───│
  │<─────────────── ice ─────────>│<────────────────── ice ─────>│
  │<══════════ RTCDataChannel (metadata, ready, bytes, eof, ack) ═>│
```

## Signaling

`WS /{token}/signal` (`aniolink.py:418`) assigns roles by connection order: the first socket is `up`, the second `down` (`aniolink.py:434`). The names are historical; a browser receiver can be `up` if it arrives first. When the second socket connects, the server sends `peer_connected` to both (`aniolink.py:448`). Every subsequent text frame is relayed verbatim to the other socket; the sender creates the offer on `peer_connected`, the receiver answers, and ICE candidates trickle through the same socket.

The server also inspects frames: a `metadata` message is stored on the bridge regardless of the sender's role (`aniolink.py:472`), which is what `GET /{token}/info` serves. The relay does not parse SDP or binary frames; it only forwards text.

## DataChannel protocol

The sender opens a reliable, ordered channel named `file` and sets `binaryType = "arraybuffer"` on both ends (`download.html:333`). The sequence is:

1. Sender sends a `metadata` JSON frame with name, size and MIME.
2. Receiver opens the save target. With File System Access it calls `showSaveFilePicker`; otherwise it warns for files above 1 GB and keeps a Blob target.
3. Receiver replies `{"type":"ready"}` (`download.html:363`). The sender waits up to five minutes for this before sending bytes.
4. Sender slices the file in 16 KB chunks (`App.jsx:261`), sending while `bufferedAmount` is under 2 MB and pausing until `bufferedamountlow` (512 KB) or a periodic re-check confirms the buffer drained (`App.jsx:202`).
5. Sender sends `{"type":"eof","size":N}` (`App.jsx:279`).
6. Receiver waits for the pending writes, closes the disk file (or builds the Blob), validates the size, and sends `{"type":"ack","size":N}` (`download.html:217`).
7. Only after the ack does the sender show success. The ack timeout is two minutes; the sender no longer treats "all chunks queued" as delivered.

A zero-byte file is metadata, ready, eof, ack: no binary chunks. A 1 KB file is metadata, ready, one chunk, eof, ack. Completion is driven by eof or by reaching the announced size, never by the channel closing.

## Receiver discipline

The standalone page (`download.html:113`) is the receiver that ships; the SPA's `handleDownload` (`App.jsx:321`) mirrors it but is not reachable from the SPA UI. Both enforce the same rules:

- `binaryType` is set before any data arrives.
- An idle timer of 60 seconds is reset by every chunk or control frame; there is no absolute transfer timeout (`download.html:177`).
- A close without eof or a complete size aborts the writable file and reports an error; it does not offer a truncated file.
- Progress updates are throttled to roughly one per 120 ms.

The receiver's file handle is opened when metadata arrives, which is why the `ready` frame exists: the sender must not fill the SCTP buffer while the user is choosing a destination.

## What the server does not see

ICE relay means the server may learn addresses, but file bytes never cross it. If the DataChannel cannot connect, the peers stay in "estableciendo conexión" and eventually fail; there is no server-side fallback to the HTTP relay in browser-to-browser mode. The HTTP path is selected earlier, when a curl peer connects and the server emits `curl_download_connected` or `http_upload_available`.
