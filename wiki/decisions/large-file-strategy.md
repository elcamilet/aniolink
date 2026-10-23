---
title: Large-file strategy
type: decision
responsibility: Explains disk streaming, the no-FSA HTTP/native-download fallback, idle timeouts, the receiver progress window, 16 KB chunks and the ready/ack handshake.
sources:
  - frontend/src/App.jsx
  - backend/templates/download.html
synced: 72f38a0
confidence: high
related:
  - ../architecture.md
  - ../flows/webrtc-browser-transfer.md
  - ../components/browser-clients.md
---

# Large-file strategy

The receiver's memory is the limit, not the server's relay. Three browser strategies coexist, chosen by capability and file size; the sender's timeout and chunk size are tuned to let them work.

## Disk streaming first

When `showSaveFilePicker` exists, the receiver opens a writable before it tells the sender it is ready and writes every chunk through it (`download.html:385`, `App.jsx:609`). The file is closed only after the write chain drains, and aborted if the transfer fails. The alternative — collect `ArrayBuffer`s and build a Blob — was the old behavior and is what made a 15 GB download consume 15 GB of RAM. The picker must run inside a user gesture; if the browser rejects it after activation expires, `openDiskWriter` returns `null` and the code falls back instead of failing the transfer.

## No-FSA goes through the relay

A browser without File System Access has no way to write a `File` stream to disk from JavaScript. The receiver page therefore skips WebRTC entirely and opens `/{token}?dl=1` with the browser's native download manager (`download.html:147`). The server sees the bytes, but the file never accumulates in the tab. Small files take the same route; the cost is server bandwidth, not memory.

If FSA exists but the picker fails for a file over 1 GB, the receiver sends `http_fallback` over the DataChannel and shows a "Guardar con el navegador" button. The button starts the same native download, and the sender switches to the raw-body PUT. Blob remains only for a small file whose picker failed, where memory is not a concern.

## Progress window

The receiver acknowledges bytes it has actually written, about every 1 MB, with a `progress` frame. The sender keeps at most a 4 MB lead over that number and waits for the next frame; a two-minute silence is a stall error. This is the fix for the failure where a large transfer died after a few seconds: `bufferedAmount` only measures the sender's SCTP queue, not the receiver's JavaScript write queue, so the sender could outrun the disk and fill the tab.

## Idle timeout instead of a total budget

Both receivers use a 60-second timer reset by each chunk or control frame (`download.html:212`). The old absolute 600-second timer cancelled any transfer that lasted longer, which is normal for a multi-gigabyte file on a residential link. A stalled transfer now fails; a slow but moving one does not. The trade-off is that a transfer can run indefinitely as long as bytes keep arriving, which is the intended behavior.

## 16 KB chunks and real backpressure

The sender uses 16 KB DataChannel messages (`App.jsx:317`) rather than 64 KB. The larger size is near the SCTP message limit of some browsers and produces a failure that looks like a network problem. The send loop caps `bufferedAmount` at 2 MB and waits for `bufferedamountlow`; the old fallback resolved after 1.5 seconds without checking the buffer, which let the buffer grow without bound on a slow receiver. The current fallback re-checks the buffer every 250 ms and only resolves when it is actually below the watermark (`App.jsx:167`).

## Ready and ack

The sender sends metadata, then waits for `ready` before the first chunk (`App.jsx:307`). This keeps the SCTP receive buffer empty while the receiver is still in the file picker. At the end it sends `eof` and waits for `ack` with a two-minute timeout (`App.jsx:344`). Without the ack, a sender could report success while the receiver was still writing or had failed; the old code relied on a delayed close as a proxy. The cost is a new protocol message that both browser clients must implement; they are deployed together.

A zero-byte file takes the same path with no binary chunks, and completion is driven by eof or by reaching the announced size, never by `onclose` alone.
