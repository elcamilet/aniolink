# Log

## 2026-10-23 · wikipoke-ingest

- Seed at `bf672cf` (the archive commit): 7 pages, no prior wiki.
- Wrote `architecture.md`, two flows (`http-relay`, `webrtc-browser-transfer`), two components (`backend-relay`, `browser-clients`) and two decisions (`transfer-integrity`, `large-file-strategy`).
- Tailored `.wikipokeignore`: tests, frontend build plumbing/assets, dependency manifests, OpenSpec artifacts and legal files are ignored; the five code files in `backend/` and `frontend/src/` plus `Dockerfile` remain countable.
- Left for later passes: file-by-file coverage of the four front-end entry/config files that were intentionally ignored, and any flow around the `/status/` observability surface.
- The `webrtc-browser-transfer` page records the ready/ack protocol introduced by the 2026-10 refactor; the HTTP relay page records the claims and activity-based expiry from the same change.

## 2026-10-23 · wikipoke-ingest

- Reconciled with `72f38a0` (large-transfer fix).
- `flows/webrtc-browser-transfer.md`: receiver-driven progress window (1 MB reports, 4 MB lead), `http_fallback`, and the no-FSA shortcut.
- `flows/http-relay.md`, `components/browser-clients.md`, `decisions/large-file-strategy.md`: no-FSA browsers use the native HTTP download; FSA picker failure uses a button and the relay.
- `architecture.md`: P2P is conditional on File System Access.
- `.wikipokeignore` unchanged; coverage still 5/5 code files.
