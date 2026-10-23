---
title: Backend relay
type: entity
responsibility: Documents the FastAPI module that owns tokens, signaling, the in-memory bridge state and the HTTP relay.
sources:
  - backend/aniolink.py
  - backend/tests/conftest.py
  - backend/tests/test_transfer.py
  - backend/tests/test_unit.py
synced: 72f38a0
confidence: high
related:
  - ../architecture.md
  - ../flows/http-relay.md
  - ../flows/webrtc-browser-transfer.md
  - ../decisions/transfer-integrity.md
---

# Backend relay

`backend/aniolink.py` is the whole server. It exposes token creation, a WebSocket signaling relay, a raw-body HTTP relay, two status endpoints and a periodic cleanup task. Everything that varies per transfer lives on a `P2PBridge` in `active_bridges` (`aniolink.py:45`); there is no database and no disk write.

## The bridge

A bridge starts with several `asyncio.Event`s: `upload_ready`, `download_ready`, `download_connected`, `stream_started` and `transfer_complete` (`aniolink.py:88`). The ordering between them is the rendezvous protocol:

- `set_upload_info` stores the request stream, filename, MIME type and length, then sets `upload_ready` (`aniolink.py:118`). It does not read the body.
- `stream_direct_p2p` sets `download_ready`, waits for `upload_ready`, confirms `download_connected`, then yields chunks (`aniolink.py:136`).
- `PUT` waits for `download_ready` and then `transfer_complete` (`aniolink.py:308`); `GET` waits for `upload_ready` (`aniolink.py:363`).

The same object carries the WebSocket peers (`up_ws`, `down_ws`), `signal_lock`, `ws_metadata`, `http_upload`, the claims (`upload_claimed`, `download_claimed`), the activity clock (`last_activity`) and the integrity state (`bytes_transferred`, `content_length`, `transfer_error`). `touch()` is called on token creation, claims, WebSocket frames and every 16 relayed chunks.

## Routes

| route | role |
| --- | --- |
| `GET /token` | creates a unique token and returns the curl instructions; retries up to 100 times and returns `503` if it cannot find a free one (`aniolink.py:244`) |
| `GET /{token}/status` | lightweight readiness for the download page |
| `PUT /{token}/{filename:path}` | uploader side of the HTTP relay; `409` if already claimed (`aniolink.py:274`) |
| `GET /{token}` | HTML receiver when `Accept: text/html`; raw stream otherwise; `?dl=1` forces raw; `409` on a second concurrent downloader (`aniolink.py:325`) |
| `GET /status/` | plain-text count of active bridges; also runs cleanup |
| `GET /{token}/info` | metadata from the sender's WebSocket or from the HTTP upload (`aniolink.py:402`) |
| `WS /{token}/signal` | SDP/ICE relay and metadata capture (`aniolink.py:418`) |

When a raw GET claims a download, the server sends `curl_download_connected` to both sockets, so a browser sender that connected second still switches to the HTTP PUT. The catch-all `WS /{path:path}` at `aniolink.py:505` exists only to reject stray WebSocket upgrades before `StaticFiles` sees them. The SPA mount is last and conditional on a `static/` directory in the process CWD (`aniolink.py:510`).

## Error and lifecycle rules

A malformed `Content-Length` becomes `None`; the byte check is skipped rather than rejecting the upload. When a length is known, the `finally` in `stream_direct_p2p` compares sent and declared bytes and records a `transfer_error` (`aniolink.py:185`). A receiver disconnect is a `CancelledError` and is recorded explicitly (`aniolink.py:172`); a generic stream error keeps its message. The waiting PUT turns any recorded error into `502`.

`cleanup_expired` (`aniolink.py:199`) skips bridges with a peer socket or `transfer_active`, and otherwise compares `last_activity`, not `created`, against `TIMEOUT_SECONDS`. A token with no peers expires; a transfer that lasts longer than the TTL does not. The PUT's `finally` removes the token when the transfer ends, and the cleanup task runs every ten seconds (`aniolink.py:211`).

Filename handling is defensive: `sanitize_filename` strips paths, control characters and quotes, caps the length, and `content_disposition` emits an ASCII `filename` plus RFC 5987 `filename*` (`aniolink.py:58`, `aniolink.py:74`).

## Tests

`backend/tests/conftest.py` starts a real uvicorn subprocess on a free port with `TIMEOUT_SECONDS=3` (`conftest.py:27`), so the tests exercise actual streaming rather than an in-process transport. `test_transfer.py` covers 0 bytes, 1 KB, 64 MB with SHA-256, both `409` cases, idle expiry and an active transfer surviving the TTL. `test_unit.py` covers filename sanitizing, the RFC 5987 header, token-collision retry and metadata capture when the sender is the second socket. Run them with `python -m pytest backend/tests -q` after installing `backend/requirements-dev.txt`.

## Deployment traps

The module imports `backend/templates/download.html` at import time, so editing that template requires a restart. `python aniolink.py` runs uvicorn before the static mount, which is why the documented SPA path is Docker or `uvicorn aniolink:app` from a directory containing `static/`. The image is Python 3.9: no `X | Y` unions or `match`. One worker only; `active_bridges` is process-local.
