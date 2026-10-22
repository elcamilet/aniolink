---
title: Architecture
type: architecture
responsibility: Maps AnioLink's single-process signaling and relay server, its sender SPA, and the standalone browser receiver.
sources:
  - backend/aniolink.py
  - frontend/src/App.jsx
  - backend/templates/download.html
  - frontend/src/main.jsx
  - Dockerfile
synced: bf672cf
confidence: high
related:
  - ./flows/http-relay.md
  - ./flows/webrtc-browser-transfer.md
  - ./components/backend-relay.md
  - ./components/browser-clients.md
  - ./decisions/transfer-integrity.md
  - ./decisions/large-file-strategy.md
---

# Architecture

AnioLink moves bytes between two peers and keeps the server out of the data path whenever WebRTC is available. The server is a rendezvous point and, for terminals, an HTTP relay. It never writes file content to disk: the only global state is the in-memory `active_bridges` map in `backend/aniolink.py:45`.

## The four transfer modes

The mode is chosen by what each side speaks, not by a setting:

```
browser sender ── WebRTC DataChannel ── browser receiver
curl sender    ── PUT /{token}/file ── relaying server ── GET /{token} ── curl receiver
browser sender ── HTTP PUT ── relaying server ── GET ── curl receiver
curl sender    ── PUT ── relaying server ── GET ?dl=1 ── browser receiver
```

Browser-to-browser traffic bypasses the server after signaling. The other three modes share the same `P2PBridge` upload/download events, so a browser that discovers a terminal peer switches to `fetch` instead of WebRTC. The two flows are documented in [http-relay](./flows/http-relay.md) and [webrtc-browser-transfer](./flows/webrtc-browser-transfer.md).

## Components

| piece | responsibility |
| --- | --- |
| `backend/aniolink.py` | FastAPI app: token creation, signaling WebSocket, HTTP PUT/GET relay, cleanup task, `/info` and `/status` |
| `P2PBridge` (`aniolink.py:88`) | per-token state: events, roles, claims, byte count, error, activity timestamp |
| `frontend/src/App.jsx` | the SPA: sender UI and WebRTC/HTTP client logic |
| `backend/templates/download.html` | server-rendered receiver for `GET /{token}` with `Accept: text/html` |
| `Dockerfile` | multi-stage production image: Vite build on Node 22, runtime on Python 3.9 + uvicorn |

The SPA mounts once through `frontend/src/main.jsx:6`; there is no client-side router. `/` is the SPA, while `GET /{token}` is answered by the backend and renders the standalone receiver template. The receiver logic is duplicated in `App.jsx:321` and `download.html:113`; protocol changes must reach both.

In production the Docker image copies the built SPA to `/app/static`, and the module mounts it only when that directory exists relative to the process working directory (`aniolink.py:510`). API routes are declared before the mount so they win. Running `python aniolink.py` calls `uvicorn.run` at `aniolink.py:501` before the mount line is reached, so that entrypoint serves the API but not the SPA.

## Invariants that shape the code

**One process.** `active_bridges` and the WebSocket peers live in memory. Two uvicorn workers or two replicas would split tokens and break transfers.

**Streaming, not buffering.** The relay reads `request.stream()` and yields chunks; nothing calls `await request.body()`, and the server writes no file content. Browser receivers stream to disk when File System Access is available, otherwise they fall back to Blob (see [large-file-strategy](./decisions/large-file-strategy.md)).

**Time is activity, not creation.** `cleanup_expired()` (`aniolink.py:199`) skips bridges with connected peers or an active transfer, and otherwise expires them after `TIMEOUT_SECONDS`. A long transfer is not cut because its token is old.

**Claims are exclusive.** A second `PUT` or raw `GET` on a token gets `409`; the first stream is not replaced or read twice. Details are in [transfer-integrity](./decisions/transfer-integrity.md).

## Deploy shape

`Dockerfile:2` builds the frontend in a Node stage, then `Dockerfile:10` starts from `python:3.9-slim`, installs `backend/requirements.txt`, and copies `aniolink.py` plus `templates/`. The container runs `uvicorn aniolink:app` (`Dockerfile:22`) so the static mount is active. The runtime keeps one process and a long keep-alive for slow transfers.
