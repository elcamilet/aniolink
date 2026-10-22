#!/usr/bin/env python3

import asyncio
import json
import logging
import secrets
import string as string_mod
import mimetypes
import os
from datetime import datetime, timedelta
from pathlib import Path
from string import Template
from typing import Annotated, Any, Dict, Optional
from urllib.parse import quote, unquote
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException, Query, WebSocket, WebSocketDisconnect
from fastapi.responses import StreamingResponse, PlainTextResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn
from dotenv import load_dotenv

load_dotenv()

HOST = '0.0.0.0'
PORT = int(os.getenv('PORT', 3000))
PUBLIC_HOST = os.getenv('PUBLIC_HOST', 'io.example.com')
TOKEN_LENGTH = int(os.getenv('TOKEN_LENGTH', 4))
TIMEOUT_SECONDS = int(os.getenv('TIMEOUT_SECONDS', 600))

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

TEMPLATES_DIR = Path(__file__).parent / "templates"
DOWNLOAD_TEMPLATE = Template((TEMPLATES_DIR / "download.html").read_text(encoding="utf-8"))

class TokenStatusResponse(BaseModel):
    ready: bool
    waiting_since: Optional[str] = None
    error: Optional[str] = None


active_bridges: Dict[str, "P2PBridge"] = {}


def parse_content_length(value: Optional[str]) -> Optional[int]:
    if value is None:
        return None
    try:
        parsed = int(value)
    except ValueError:
        return None
    return parsed if parsed >= 0 else None


def sanitize_filename(value: str) -> str:
    """Elimina rutas, controles y comillas de un nombre recibido por URL."""
    name = unquote(value).replace("\\", "/").split("/")[-1]
    name = "".join(ch for ch in name if ch >= " " and ch != "\x7f" and ch not in '"\r\n')
    name = name.strip().strip(".")
    if not name:
        return "file.bin"
    if len(name) > 200:
        stem, dot, ext = name.rpartition(".")
        if dot and len(ext) <= 20:
            name = stem[: 199 - len(ext)] + "." + ext
        else:
            name = name[:200]
    return name


def content_disposition(filename: str) -> str:
    safe = sanitize_filename(filename)
    ascii_name = safe.encode("ascii", "ignore").decode() or "file.bin"
    return f"attachment; filename=\"{ascii_name}\"; filename*=UTF-8''{quote(safe, safe='')}"


def generate_token() -> str:
    chars = string_mod.ascii_lowercase + string_mod.digits
    for _ in range(100):
        token = ''.join(secrets.choice(chars) for _ in range(TOKEN_LENGTH))
        if token not in active_bridges:
            return token
    raise RuntimeError("No se pudo generar un token único")

class P2PBridge:
    def __init__(self, token: str):
        self.token = token
        # HTTP relay (para curl)
        self.upload_ready = asyncio.Event()
        self.download_connected = asyncio.Event()
        self.download_ready = asyncio.Event()
        self.stream_started = asyncio.Event()
        self.upload_stream = None
        self.filename = "file.bin"
        self.content_type = 'application/octet-stream'
        self.content_length: Optional[int] = None
        self.created = datetime.now()
        self.last_activity = self.created
        self.transfer_complete = asyncio.Event()
        self.transfer_error: Optional[str] = None
        self.bytes_transferred = 0
        # WebRTC signaling
        self.up_ws: Optional[WebSocket] = None
        self.down_ws: Optional[WebSocket] = None
        self.signal_lock = asyncio.Lock()
        self.ws_metadata: Optional[dict] = None
        self.http_upload = False  # True si el emisor usa HTTP PUT (curl/terminal)
        self.transfer_active = False
        self.upload_claimed = False
        self.download_claimed = False

    def touch(self) -> None:
        self.last_activity = datetime.now()
        
    def set_upload_info(
        self,
        stream: Any,
        filename: str,
        content_type: str,
        content_length: Optional[int],
    ) -> None:
        self.upload_stream = stream
        self.filename = filename
        self.content_type = content_type
        self.content_length = content_length
        self.transfer_error = None
        self.bytes_transferred = 0
        self.touch()
        if hasattr(stream, 'seek'):
            stream.seek(0)
        self.upload_ready.set()
    
    async def stream_direct_p2p(self):
        logger.info(f"Download connecting: {self.filename}")
        self.touch()
        self.download_ready.set()
        await self.upload_ready.wait()
        self.touch()
        logger.info(f"Both peers ready, starting stream: {self.filename}")
        if not self.download_connected.is_set():
            logger.error("Download connection lost before transfer")
            raise HTTPException(status_code=408, detail="Conexión perdida antes de la transferencia")
        self.stream_started.set()
        chunks_since_touch = 0
        try:
            if hasattr(self.upload_stream, 'read'):
                chunk_size = 64 * 1024
                while True:
                    chunk = self.upload_stream.read(chunk_size)
                    if not chunk:
                        break
                    self.bytes_transferred += len(chunk)
                    chunks_since_touch += 1
                    if chunks_since_touch >= 16:
                        self.touch()
                        chunks_since_touch = 0
                    yield chunk
            else:
                async for chunk in self.upload_stream:
                    if not chunk:
                        continue
                    self.bytes_transferred += len(chunk)
                    chunks_since_touch += 1
                    if chunks_since_touch >= 16:
                        self.touch()
                        chunks_since_touch = 0
                    yield chunk
        except asyncio.CancelledError:
            self.transfer_error = "Receptor desconectado durante la transferencia"
            logger.error(self.transfer_error)
            raise
        except Exception as e:
            self.transfer_error = f"Error en la transferencia: {e}"
            logger.error(self.transfer_error)
            raise
        finally:
            self.transfer_active = False
            self.touch()
            if (
                self.transfer_error is None
                and self.content_length is not None
                and self.bytes_transferred != self.content_length
            ):
                self.transfer_error = (
                    f"Transferencia incompleta: esperados {self.content_length} bytes, "
                    f"enviados {self.bytes_transferred} bytes"
                )
                logger.error(self.transfer_error)
            self.transfer_complete.set()
            logger.info(f"P2P transfer complete: {self.filename}")


def extract_filename(path: str) -> str:
    return sanitize_filename(path.split('/')[-1])

def cleanup_expired():
    now = datetime.now()
    expired = []
    for token, bridge in list(active_bridges.items()):
        if bridge.transfer_active or bridge.up_ws is not None or bridge.down_ws is not None:
            continue
        if now - bridge.last_activity > timedelta(seconds=TIMEOUT_SECONDS):
            expired.append(token)
    for token in expired:
        logger.info(f"Cleaning expired token: {token}")
        active_bridges.pop(token, None)

async def cleanup_task():
    while True:
        await asyncio.sleep(10)
        cleanup_expired()

@asynccontextmanager
async def lifespan(app: FastAPI):
    cleanup_task_handle = asyncio.create_task(cleanup_task())
    logger.info("An I/O Link - STARTED")
    logger.info(f"Server: {PUBLIC_HOST}:{PORT}")
    yield
    cleanup_task_handle.cancel()
    try:
        await cleanup_task_handle
    except asyncio.CancelledError:
        pass

app = FastAPI(
    title="An I/O Link - io.elCamilet.com", 
    version="2.0.0",
    lifespan=lifespan
)

app.add_middleware(
  CORSMiddleware,
  allow_origins=["*"],
  allow_credentials=True,
  allow_methods=["*"],
  allow_headers=["*"],
  expose_headers=["Content-Disposition", "Content-Type", "Content-Length"]
)


@app.get("/token")
async def create_token() -> PlainTextResponse:
    cleanup_expired()
    try:
        token = generate_token()
    except RuntimeError:
        raise HTTPException(status_code=503, detail="No se pudo generar un token único. Inténtalo de nuevo.")
    active_bridges[token] = P2PBridge(token)
    logger.info(f"Token created: {token}")
    response_text = f"""
---------------------------------------------
Se ha generado el TOKEN: {token}
El token expira en {TIMEOUT_SECONDS // 60} minutos

ENVIAR: curl --upload-file FILE https://{PUBLIC_HOST}/{token}/
RECIBIR: curl -O -J https://{PUBLIC_HOST}/{token}
---------------------------------------------
"""
    return PlainTextResponse(content=response_text.strip())

@app.get("/{token}/status")
async def check_token_status(token: str) -> TokenStatusResponse:
    if token not in active_bridges:
        return TokenStatusResponse(ready=False, error="Token no encontrado")
    bridge = active_bridges[token]
    return TokenStatusResponse(
        ready=bridge.download_connected.is_set() and not bridge.stream_started.is_set(),
        waiting_since=bridge.created.isoformat(),
    )

@app.put("/{token}/{filename:path}")
async def upload_p2p(token: str, filename: str, request: Request):
    bridge = active_bridges.get(token)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Token inválido o expirado. Por favor, genera un nuevo token.")
    if bridge.upload_claimed:
        raise HTTPException(status_code=409, detail="Ya hay un emisor activo para este token")

    # Claim síncrono (sin await) para evitar dos emisores sobre el mismo stream
    bridge.upload_claimed = True
    bridge.transfer_active = True
    bridge.touch()

    try:
        original_filename = extract_filename(filename)
        content_type = request.headers.get('content-type', 'application/octet-stream')
        content_length = parse_content_length(request.headers.get('content-length'))

        # Detectar el content type real por nombre de fichero si no se especifica
        if content_type == 'application/octet-stream':
            guessed_type, _ = mimetypes.guess_type(original_filename)
            if guessed_type:
                content_type = guessed_type

        bridge.set_upload_info(request.stream(), original_filename, content_type, content_length)
        bridge.http_upload = True
        # Si hay un receptor browser esperando via WebSocket, avisarle que el emisor es curl/terminal
        for ws_client in filter(None, [bridge.up_ws, bridge.down_ws]):
            try:
                await ws_client.send_json({"type": "http_upload_available", "filename": original_filename, "size": content_length})
            except Exception as e:
                logger.warning(f"No se pudo notificar al receptor del upload HTTP: {e}")
        logger.info(f"Subida preparada: {original_filename} - esperando la descarga")
        try:
            await asyncio.wait_for(bridge.download_ready.wait(), timeout=TIMEOUT_SECONDS)
            await bridge.transfer_complete.wait()
            if bridge.transfer_error is not None:
                raise HTTPException(status_code=502, detail=bridge.transfer_error)
            response_text = f"""
---------------------------------------------
Transferencia completada con ÉXITO!
---------------------------------------------
"""
            return PlainTextResponse(content=response_text.strip())
        except asyncio.TimeoutError:
            raise HTTPException(status_code=408, detail="No se conectó ninguna descarga - P2P fallido")
    finally:
        bridge.upload_claimed = False
        bridge.transfer_active = False
        active_bridges.pop(token, None)

@app.get("/{token}")
async def download_p2p(
    token: str,
    request: Request,
    dl: Annotated[Optional[str], Query()] = None,
):
    accept = request.headers.get("accept", "")
    is_browser = "text/html" in accept and dl is None

    bridge = active_bridges.get(token)
    if bridge is None:
        if is_browser:
            return HTMLResponse(content=DOWNLOAD_TEMPLATE.safe_substitute(
                token=token,
                btn_disabled='disabled style="background:#4b5563;cursor:not-allowed"',
                error_msg='<p style="color:#ef4444;margin-top:1rem;text-align:center">⚠️ Token no encontrado o expirado</p>',
            ), status_code=404)
        raise HTTPException(status_code=404, detail="Token no encontrado")

    if is_browser:
        html = DOWNLOAD_TEMPLATE.safe_substitute(token=token, btn_disabled='', error_msg='')
        return HTMLResponse(content=html)

    if bridge.download_claimed:
        raise HTTPException(status_code=409, detail="Ya hay un receptor activo para este token")

    # Claim síncrono (sin await) para evitar dos receptores leyendo el mismo stream
    bridge.download_claimed = True
    bridge.transfer_active = True
    bridge.touch()
    bridge.download_connected.set()
    # Si hay un emisor browser esperando por WebSocket, avisarle que el receptor es curl
    if bridge.up_ws is not None:
        try:
            await bridge.up_ws.send_json({"type": "curl_download_connected"})
        except Exception as e:
            logger.warning(f"No se pudo notificar al emisor del receptor curl: {e}")
    try:
        await asyncio.wait_for(bridge.upload_ready.wait(), timeout=TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        bridge.download_claimed = False
        bridge.transfer_active = False
        active_bridges.pop(token, None)
        raise HTTPException(status_code=408, detail="No se conectó ninguna subida - P2P fallido")
    headers = {
        'Content-Disposition': content_disposition(bridge.filename),
        'Cache-Control': 'no-cache',
    }
    if bridge.content_length is not None:
        headers['Content-Length'] = str(bridge.content_length)
    logger.info(f"Descarga conectada: {bridge.filename} - comenzando stream P2P")
    return StreamingResponse(
        bridge.stream_direct_p2p(),
        media_type=bridge.content_type,
        headers=headers
    )

@app.get("/status/")
async def status() -> PlainTextResponse:
    cleanup_expired()
    now = datetime.now()
    response_text = f"""
---------------------------------------------
An I/O Link - io.elCamilet.com

Transferencia P2P sin almacenamiento en servidor

Enlaces activos: {len(active_bridges)}
---------------------------------------------
"""
    if not active_bridges:
        response_text += "No hay transferencias activas en este momento.\n"
    else:
        response_text += "\n"
    return PlainTextResponse(content=response_text.strip())


@app.get("/{token}/info")
async def get_file_info(token: str) -> dict:
    """Devuelve metadatos del archivo (nombre, tamaño) para mostrar al receptor antes de descargar."""
    bridge = active_bridges.get(token)
    if bridge is None:
        raise HTTPException(status_code=404, detail="Token no encontrado")
    data = dict(bridge.ws_metadata) if bridge.ws_metadata else {}
    if bridge.http_upload or bridge.upload_claimed:
        data.setdefault("filename", bridge.filename)
        if bridge.content_length is not None:
            data.setdefault("size", bridge.content_length)
    if not data:
        raise HTTPException(status_code=404, detail="Metadatos no disponibles aún")
    return data


@app.websocket("/{token}/signal")
async def webrtc_signal(ws: WebSocket, token: str):
    """Servidor de señalización WebRTC: relay de mensajes SDP e ICE entre peers."""
    bridge = active_bridges.get(token)
    if bridge is None:
        await ws.close(code=4004)
        return

    await ws.accept()
    bridge.touch()

    role = None
    peer_ready = False
    async with bridge.signal_lock:
        if bridge.up_ws is None:
            bridge.up_ws = ws
            role = "up"
            peer_ready = bridge.down_ws is not None
        elif bridge.down_ws is None:
            bridge.down_ws = ws
            role = "down"
            peer_ready = bridge.up_ws is not None
        else:
            await ws.close(code=4003)
            return

    # Notificar a ambos si el peer ya estaba esperando
    if peer_ready:
        other = bridge.down_ws if role == "up" else bridge.up_ws
        try:
            await other.send_json({"type": "peer_connected"})
            await ws.send_json({"type": "peer_connected"})
        except Exception as e:
            logger.error(f"Signal notify error ({role}): {e}")
    elif bridge.http_upload and bridge.upload_ready.is_set():
        # El emisor es curl/terminal (no WebSocket): notificar a este receptor browser
        try:
            size = bridge.content_length
            await ws.send_json({"type": "http_upload_available", "filename": bridge.filename, "size": size})
        except Exception as e:
            logger.error(f"Signal notify error (http_upload_available): {e}")

    def get_peer():
        return bridge.down_ws if role == "up" else bridge.up_ws

    logger.info(f"Signal WS connected: {role} for token {token}")
    try:
        while True:
            data = await ws.receive_text()
            bridge.touch()
            # Extraer metadatos si el emisor los manda (para endpoint /info)
            try:
                msg = json.loads(data)
                if msg.get("type") == "metadata":
                    bridge.ws_metadata = msg
            except (json.JSONDecodeError, TypeError):
                pass
            # Relay al peer
            peer = get_peer()
            if peer is not None:
                try:
                    await peer.send_text(data)
                except Exception:
                    break
    except WebSocketDisconnect:
        pass
    except Exception as e:
        logger.error(f"Signal WS error ({role}): {e}")
    finally:
        async with bridge.signal_lock:
            if role == "up":
                bridge.up_ws = None
            elif role == "down":
                bridge.down_ws = None
        bridge.touch()
        peer = get_peer()
        if peer:
            try:
                await peer.send_json({"type": "peer_disconnected"})
            except Exception:
                pass
        logger.info(f"Signal WS closed: {role} for token {token}")

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info", timeout_keep_alive=3600)

# Serve frontend SPA — must be mounted last so API routes take priority
@app.websocket("/{path:path}")
async def reject_websocket(websocket: WebSocket):
    """Reject all WebSocket connections before StaticFiles crashes on them."""
    await websocket.close(code=1008)

if os.path.isdir("static"):
    app.mount("/", StaticFiles(directory="static", html=True), name="frontend")
