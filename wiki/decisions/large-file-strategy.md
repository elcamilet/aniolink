---
title: Large-file strategy
type: decision
responsibility: Explains disk streaming, the Blob and native-download fallbacks, idle timeouts, 16 KB chunks and the ready/ack handshake.
sources:
  - frontend/src/App.jsx
  - backend/templates/download.html
synced: bf672cf
confidence: high
related:
  - ../architecture.md
  - ../flows/webrtc-browser-transfer.md
  - ../components/browser-clients.md
---

# Large-file strategy

The receiver's memory is the limit, not the server's relay. Three browser strategies coexist, chosen by capability and file size; the sender's timeout and chunk size are tuned to let them work.

## Disk streaming first

When `showSaveFilePicker` exists, the receiver opens a writable before it tells the sender it is ready and writes every chunk through it (`download.html:351`, `App.jsx:544`). The file is closed only after the write chain drains, and aborted if the transfer fails. The alternative — collect `ArrayBuffer`s and build a Blob — was the old behavior and is what made a 15 GB download consume 15 GB of RAM. The picker must run inside a user gesture; if the browser rejects it after activation expires, `openDiskWriter` returns `null` and the code falls back instead of failing the transfer.

## Blob and native fallbacks

For WebRTC without File System Access, the receiver accepts small files into a Blob but warns before a file above 1 GB (`download.html:357`). In the HTTP relay, a file above 1 GB without a writable takes a different route: the page clicks a hidden link to `/{token}?dl=1`, and the browser's download manager streams the response to disk (`download.html:266`). The native route has no progress UI and no checksum, but it does not exhaust memory. For WebRTC there is no native route; the DataChannel has to be read by JavaScript.

## Idle timeout instead of a total budget

Both receivers use a 60-second timer reset by each chunk or control frame (`download.html:177`). The old absolute 600-second timer cancelled any transfer that lasted longer, which is normal for a multi-gigabyte file on a residential link. A stalled transfer now fails; a slow but moving one does not. The trade-off is that a transfer can run indefinitely as long as bytes keep arriving, which is the intended behavior.

## 16 KB chunks and real backpressure

The sender uses 16 KB DataChannel messages (`App.jsx:261`) rather than 64 KB. The larger size is near the SCTP message limit of some browsers and produces a failure that looks like a network problem. The send loop caps `bufferedAmount` at 2 MB and waits for `bufferedamountlow`; the old fallback resolved after 1.5 seconds without checking the buffer, which let the buffer grow without bound on a slow receiver. The current fallback re-checks the buffer every 250 ms and only resolves when it is actually below the watermark (`App.jsx:181`).

## Ready and ack

The sender sends metadata, then waits for `ready` before the first chunk (`App.jsx:254`). This keeps the SCTP receive buffer empty while the receiver is still in the file picker. At the end it sends `eof` and waits for `ack` with a two-minute timeout (`App.jsx:281`). Without the ack, a sender could report success while the receiver was still writing or had failed; the old code relied on a delayed close as a proxy. The cost is a new protocol message that both browser clients must implement; they are deployed together.

A zero-byte file takes the same path with no binary chunks, and completion is driven by eof or by reaching the announced size, never by `onclose` alone.
