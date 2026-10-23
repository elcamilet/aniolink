# AGENTS.md

AnioLink is a P2P file-transfer app. The FastAPI server is only a rendezvous/signaling point and HTTP relay; file bytes are never written to disk. The backend is one module, the frontend is one component, and the root `Dockerfile` is the production build.

## Layout

- `backend/aniolink.py` — all backend logic: routes, `P2PBridge`, in-memory `active_bridges`, WebSocket signaling, cleanup task.
- `backend/templates/download.html` — standalone receiver page served for browser `GET /{token}`. It is not part of the React build and duplicates the SPA's WebRTC receiver logic.
- `frontend/src/App.jsx` — entire SPA; `main.jsx` only mounts it. No router: `/{token}` is server-rendered, not a client route.
- `static/` — production frontend, created in the Docker image from `frontend/dist`; served only when present in the process CWD.
- `Dockerfile` — builds the frontend on Node 22, runs Python 3.9 + uvicorn. Only `backend/aniolink.py` and `backend/templates/` are copied as backend source; add new backend files to the Dockerfile.

## Commands

```bash
# Backend (API only; does not serve the SPA)
cd backend
pip install -r requirements.txt
python aniolink.py                 # PORT default 3000

# Frontend (UI only; no API proxy)
cd frontend
npm install                        # package-lock.json is gitignored; fresh clones have no lockfile
npm run dev                        # 5173
npm run build                      # dist/

# Full app, same origin (recommended for end-to-end checks)
docker build -t aniolink .
docker run --rm -p 3000:3000 -e PUBLIC_HOST=localhost aniolink
```

No linter or typechecker is configured. Minimum verification: `python -m py_compile backend/aniolink.py` and `npm run build`. Integration tests live in `backend/tests/` and need `pip install -r backend/requirements-dev.txt` (or a venv) before `pytest backend/tests -q`.

HTTP-relay smoke test (curl → curl, no browser):

```bash
cd backend && PORT=3000 python aniolink.py &
sleep 1
TOKEN=$(curl -s http://localhost:3000/token | sed -n 's/.*TOKEN: \([a-z0-9]*\).*/\1/p')
curl --upload-file FILE "http://localhost:3000/$TOKEN/" &
curl -OJ "http://localhost:3000/$TOKEN"
```

The server stays in the background; stop it when finished.

## Constraints and gotchas

- **Single process only.** `active_bridges` and WebSocket peers are in memory; `uvicorn --workers N` or multiple replicas split tokens and break transfers.
- **No server-side file storage or full-body buffering.** Use `request.stream()` and relay chunks directly; never read an upload with `await request.body()`.
- **Browser receivers stream to disk when the browser supports `showSaveFilePicker`.** Without FSA, `download.html` skips WebRTC and downloads through the HTTP relay (`?dl=1`) with the browser's download manager, so it never buffers a large file. If FSA exists but the picker fails for a file over 1 GB, the DataChannel sends `http_fallback` and the page offers a native-download button. The SPA's `handleDownload` is unreachable from the UI; `download.html` is the receiver that ships. Keep both copies in sync. Server-side relay streaming is unbounded.
- **Python 3.9** in the image: no `X | Y` unions, `match`, or other 3.10+ syntax.
- **No Vite proxy.** `App.jsx` uses `window.location.origin` as the API base, so `npm run dev` on :5173 cannot reach the backend. Use Docker, or place a built `frontend/dist` in `static/` at the repo root (don't commit it) and run `uvicorn backend.aniolink:app` from there.
- `python aniolink.py` calls `uvicorn.run()` before the bottom `StaticFiles` mount, so that entrypoint never serves the SPA; the mount only runs when an ASGI server imports the module (uvicorn/Docker). Put any new import-time setup above the `if __name__ == "__main__"` block, and declare API routes before the mount.
- `download.html` is read once at import; restart the backend after editing it.
- `GET /token` is plain text and the SPA extracts it with `/TOKEN: (\w+)/`. Preserve the `TOKEN: <token>` line.
- Browser vs curl on `GET /{token}` is decided by `Accept`: `text/html` renders `download.html`; curl's `*/*` gets the raw stream. `?dl=1` forces the raw stream from the SPA. Do not collapse these into one response.
- `PUBLIC_HOST` only affects the curl instructions printed by `/token` (and the startup log), not binding or app URLs.
- Env defaults: `PORT=3000`, `PUBLIC_HOST=io.example.com`, `TOKEN_LENGTH=4` (lowercase letters/digits), `TIMEOUT_SECONDS=600`. `load_dotenv()` walks up from `backend/`, so the root `.env` is found.
- The SPA receiver (`App.jsx`) and page receiver (`download.html`) are duplicated; apply protocol changes to both.

## Transfer protocol

- Four modes: browser↔browser (WebRTC DataChannel), curl↔curl (HTTP streaming), browser→curl, curl→browser.
- `WS /{token}/signal`: first socket is assigned `up`, second `down` (connection order, not always sender/receiver when the other side uses curl). It relays `offer`, `answer`, `ice`; the server sends `peer_connected`, `peer_disconnected`, `curl_download_connected` (to both sockets), `http_upload_available`. `metadata` is relayed and stored for `/info`.
- DataChannel messages: `metadata`, `ready`, binary chunks, `progress`, `eof`, `ack`; `http_fallback` asks the sender to switch to the HTTP relay when the receiver cannot write to disk.
- `PUT /{token}/{filename}` always reads `request.stream()`. The SPA sends the raw `File` body, not `FormData`; curl sends the file body. Keep that contract.
- `GET /{token}` waits for the upload then streams. Auxiliary endpoints: `GET /{token}/status`, `GET /status/`, `GET /{token}/info`.
- Tokens expire via a 10-second cleanup task, and eagerly on `/token` and `/status/`.

## Conventions

- User-facing strings and comments are Spanish; keep new ones Spanish.
- Keep the backend in one file and the SPA in `App.jsx` unless the task explicitly asks to split them.
- `.agents/copilot-instructions.md` (local, gitignored) is legacy and partly stale (build-time API URL, 3600s timeout, separate backend/frontend Docker files). Trust this file and the code.
