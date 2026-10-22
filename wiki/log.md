# Log

## 2026-10-23 · wikipoke-ingest

- Seed at `bf672cf` (the archive commit): 7 pages, no prior wiki.
- Wrote `architecture.md`, two flows (`http-relay`, `webrtc-browser-transfer`), two components (`backend-relay`, `browser-clients`) and two decisions (`transfer-integrity`, `large-file-strategy`).
- Tailored `.wikipokeignore`: tests, frontend build plumbing/assets, dependency manifests, OpenSpec artifacts and legal files are ignored; the five code files in `backend/` and `frontend/src/` plus `Dockerfile` remain countable.
- Left for later passes: file-by-file coverage of the four front-end entry/config files that were intentionally ignored, and any flow around the `/status/` observability surface.
- The `webrtc-browser-transfer` page records the ready/ack protocol introduced by the 2026-10 refactor; the HTTP relay page records the claims and activity-based expiry from the same change.
