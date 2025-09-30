#!/usr/bin/env python3

import asyncio
import logging
import secrets
import string
import mimetypes
import os
from datetime import datetime, timedelta
from typing import Dict, Optional
from urllib.parse import unquote
from contextlib import asynccontextmanager

from fastapi import FastAPI, Request, HTTPException
from fastapi.responses import StreamingResponse, PlainTextResponse
from fastapi.middleware.cors import CORSMiddleware
import uvicorn
from dotenv import load_dotenv

load_dotenv()

HOST = '0.0.0.0'
PORT = int(os.getenv('PORT', 3000))
# PUBLIC_HOST = os.getenv('PUBLIC_HOST', 'p2p.example.com')
PUBLIC_HOST = os.getenv('PUBLIC_HOST', '192.168.1.98')
TOKEN_LENGTH = int(os.getenv('TOKEN_LENGTH', 4))
TIMEOUT_SECONDS = int(os.getenv('TIMEOUT_SECONDS', 3600))  # 1 hora para archivos grandes

logging.basicConfig(level=logging.INFO, format='%(levelname)s: %(message)s')
logger = logging.getLogger(__name__)

active_bridges: Dict[str, dict] = {}

class P2PBridge:
    def __init__(self, token: str):
        self.token = token
        self.upload_ready = asyncio.Event()  # Indica que el uploader está listo para enviar
        self.download_connected = asyncio.Event()  # Indica que el downloader está conectado
        self.download_ready = asyncio.Event()  # Indica que el downloader está listo para recibir
        self.stream_started = asyncio.Event()  # Indica que la transferencia ha comenzado
        self.upload_stream = None
        self.filename = "file.bin"
        self.content_type = 'application/octet-stream'
        self.content_length = None
        self.created = datetime.now()
        self.transfer_complete = asyncio.Event()
        
    def set_upload_info(self, stream, filename, content_type, content_length):
        self.upload_stream = stream
        self.filename = filename
        self.content_type = content_type
        self.content_length = content_length
        if hasattr(stream, 'seek'):
            stream.seek(0)
        self.upload_ready.set()
    
    async def stream_direct_p2p(self):
        logger.info(f"Download connecting: {self.filename}")
        self.download_ready.set()
        await self.upload_ready.wait()
        logger.info(f"Both peers ready, starting stream: {self.filename}")
        if not self.download_connected.is_set():
            logger.error("Download connection lost before transfer")
            raise HTTPException(status_code=408, detail="Conexión perdida antes de la transferencia")
        self.stream_started.set()
        try:
            if hasattr(self.upload_stream, 'read'):
                chunk_size = 64 * 1024
                while True:
                    chunk = self.upload_stream.read(chunk_size)
                    if not chunk:
                        break
                    yield chunk
            else:
                async for chunk in self.upload_stream:
                    if chunk:
                        yield chunk
        except Exception as e:
            logger.error(f"P2P stream error: {e}")
            raise
        finally:
            self.transfer_complete.set()
            logger.info(f"P2P transfer complete: {self.filename}")


def generate_token() -> str:
    chars = string.ascii_lowercase + string.digits
    return ''.join(secrets.choice(chars) for _ in range(TOKEN_LENGTH))

def extract_filename(path: str) -> str:
    return unquote(path.split('/')[-1])

def cleanup_expired():
    now = datetime.now()
    expired = [token for token, bridge in active_bridges.items()
        if now - bridge.created > timedelta(seconds=TIMEOUT_SECONDS)]
    for token in expired:
        logger.info(f"Cleaning expired token: {token}")
        del active_bridges[token]

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
    title="An I/O Link - elCamilet.com", 
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


@app.get("/")
async def home():
    response_text = f"""
An I/O Link - elCamilet.com
===========================
Transferencia P2P sin almacenamiento en servidor

1. Obtén un token: curl https://{PUBLIC_HOST}/token
2. Sube un archivo (reemplaza FILE y TOKEN): curl --upload-file FILE https://{PUBLIC_HOST}/TOKEN/
3. Descarga el archivo (reemplaza TOKEN): curl -O -J https://{PUBLIC_HOST}/TOKEN

"""
    return PlainTextResponse(content=response_text)

@app.get("/token")
async def create_token():
    cleanup_expired()
    token = generate_token()
    active_bridges[token] = P2PBridge(token)
    logger.info(f"Token created: {token}")
    response_text = f"""

Se ha generado el TOKEN: {token}
El token expira en {TIMEOUT_SECONDS // 60} minutos

ENVIAR: curl --upload-file FILE https://{PUBLIC_HOST}/{token}/
RECIBIR: curl -O -J https://{PUBLIC_HOST}/{token}

"""
    return PlainTextResponse(content=response_text.strip())

@app.get("/{token}/status")
async def check_token_status(token: str):
    if token not in active_bridges:
        return {"ready": False, "error": "Token no encontrado"}
    bridge = active_bridges[token]
    return {
        "ready": bridge.download_connected.is_set() and not bridge.stream_started.is_set(),
        "waiting_since": bridge.created.isoformat()
    }

@app.put("/{token}/{filename:path}")
async def upload_p2p(token: str, filename: str, request: Request):
    if token not in active_bridges:
        raise HTTPException(status_code=404, detail="Token inválido o expirado. Por favor, genera un nuevo token.")
    
    bridge = active_bridges[token]
    original_filename = extract_filename(filename)
    content_type = request.headers.get('content-type', 'application/octet-stream')
    content_length = request.headers.get('content-length')

    # Handle both FormData and raw data (curl compatibility)
    if content_type.startswith('multipart/form-data'):
        form = await request.form()
        file = form.get("file")
        if file:
            content = file.file
            if not original_filename or original_filename == "blob":
                original_filename = file.filename
            content_type = file.content_type
    else:
        content = request.stream()
    
    # Try to guess content type from filename if not specified
    if content_type in ['application/octet-stream', 'multipart/form-data']:
        guessed_type, _ = mimetypes.guess_type(original_filename)
        if guessed_type:
            content_type = guessed_type

    bridge.set_upload_info(content, original_filename, content_type, content_length)
    logger.info(f"Subida preparada: {original_filename} - esperando la descarga")
    try:
        await asyncio.wait_for(bridge.download_ready.wait(), timeout=TIMEOUT_SECONDS)
        await bridge.transfer_complete.wait()
        response_text = f"""

Transferencia completada con ÉXITO!

"""
        return PlainTextResponse(content=response_text.strip())
    except asyncio.TimeoutError:
        raise HTTPException(status_code=408, detail="No se conectó ninguna descarga - P2P fallido")
    finally:
        active_bridges.pop(token, None)

@app.get("/{token}")
async def download_p2p(token: str):
    if token not in active_bridges:
        raise HTTPException(status_code=404, detail="Token no encontrado")
    bridge = active_bridges[token]
    bridge.download_connected.set()
    try:
        await asyncio.wait_for(bridge.upload_ready.wait(), timeout=TIMEOUT_SECONDS)
    except asyncio.TimeoutError:
        active_bridges.pop(token, None)
        raise HTTPException(status_code=408, detail="No se conectó ninguna subida - P2P fallido")
    headers = {
        'Content-Disposition': f'attachment; filename="{bridge.filename}"',
        'Cache-Control': 'no-cache',
        'Transfer-Encoding': 'chunked'  # Indica que usaremos streaming sin Content-Length
    }
    logger.info(f"Descarga conectada: {bridge.filename} - comenzando stream P2P")
    return StreamingResponse(
        bridge.stream_direct_p2p(),
        media_type=bridge.content_type,
        headers=headers
    )

@app.get("/status/")
async def status():
    cleanup_expired()
    now = datetime.now()
    response_text = f"""
An I/O Link - elCamilet.com

Transferencia P2P sin almacenamiento en servidor

Enlaces activos: {len(active_bridges)}

"""
    if not active_bridges:
        response_text += "No hay transferencias activas en este momento.\n"
    else:
        response_text += "\n"
    return PlainTextResponse(content=response_text.strip())

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=PORT, log_level="info", timeout_keep_alive=3600)
