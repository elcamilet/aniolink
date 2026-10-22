import React, { useState, useRef, useEffect } from 'react';

const API_BASE_URL = window.location.origin;
const WS_BASE_URL = API_BASE_URL.replace(/^http/, 'ws');

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

const LARGE_FILE_THRESHOLD = 1024 * 1024 * 1024;
const IDLE_TIMEOUT_MS = 60000;
const READY_TIMEOUT_MS = 300000;
const ACK_TIMEOUT_MS = 120000;

const supportsFileSystemAccess = () =>
  typeof window !== 'undefined' && typeof window.showSaveFilePicker === 'function';

const withTimeout = (promise, ms, message) =>
  Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
  ]);

async function openDiskWriter(filename) {
  if (!supportsFileSystemAccess()) return null;
  try {
    const handle = await window.showSaveFilePicker({ suggestedName: filename || 'archivo' });
    return await handle.createWritable();
  } catch (error) {
    if (error && error.name === 'AbortError') throw error;
    return null;
  }
}

function saveBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename || 'archivo';
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  }, 0);
}

function startNativeDownload(url, filename) {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename || '';
  a.style.display = 'none';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

function App() {
  const [selectedFile, setSelectedFile] = useState(null);
  const [token, setToken] = useState('');
  const [uploadStatus, setUploadStatus] = useState('');
  const [downloadToken, setDownloadToken] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [isDownloading, setIsDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState(0);
  const [downloadStatus, setDownloadStatus] = useState('');
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef(null);

  // Leer token de URL params (cuando se redirige desde /{token})
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const t = params.get('token');
    if (t) {
      setDownloadToken(t);
      window.history.replaceState({}, '', '/');
    }
  }, []);

  const handleFileSelect = (file) => {
    setSelectedFile(file);
    setUploadStatus('');
    setToken('');
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    const files = e.dataTransfer.files;
    if (files.length > 0) {
      handleFileSelect(files[0]);
    }
  };

  const handleFileInputChange = (e) => {
    if (e.target.files.length > 0) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const generateTokenAndUpload = async () => {
    if (!selectedFile) return;
    setIsUploading(true);
    setUploadStatus('Generando token...');
    let ws = null;
    let pc = null;
    try {
      // 1. Obtener token
      const tokenResponse = await fetch(`${API_BASE_URL}/token`);
      const tokenText = await tokenResponse.text();
      const tokenMatch = tokenText.match(/TOKEN: (\w+)/);
      if (!tokenMatch) throw new Error('No se pudo extraer el token');
      const newToken = tokenMatch[1];
      setToken(newToken);
      setUploadStatus('Esperando conexión del receptor...');

      // 2. Conectar WebSocket de señalización
      ws = new WebSocket(`${WS_BASE_URL}/${newToken}/signal`);
      await new Promise((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('Error al conectar servidor de señalización'));
        setTimeout(() => reject(new Error('Timeout de conexión al servidor')), 10000);
      });

      // 3. Crear RTCPeerConnection con DataChannel
      pc = new RTCPeerConnection(ICE_SERVERS);
      const dc = pc.createDataChannel('file', { ordered: true });
      dc.binaryType = 'arraybuffer';

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ice', candidate: candidate.toJSON() }));
        }
      };

      // 4. Esperar peer, señalizar y transferir
      await new Promise((resolve, reject) => {
        let transferComplete = false;
        let readyResolve;
        let ackResolve;
        const readyPromise = new Promise((res) => { readyResolve = res; });
        const ackPromise = new Promise((res) => { ackResolve = res; });
        const MAX_BUFFERED_AMOUNT = 2 * 1024 * 1024;
        const LOW_WATERMARK = 512 * 1024;
        dc.bufferedAmountLowThreshold = LOW_WATERMARK;

        dc.onmessage = (event) => {
          if (typeof event.data !== 'string') return;
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'ready') readyResolve();
            else if (msg.type === 'ack') ackResolve(msg);
          } catch (_) {
            // Ignorar mensajes de control no JSON
          }
        };

        const waitForBufferedDrain = () => new Promise((drainResolve, drainReject) => {
          if (transferComplete || dc.bufferedAmount <= LOW_WATERMARK) {
            drainResolve();
            return;
          }

          let settled = false;
          let interval = null;
          const cleanup = () => {
            dc.removeEventListener('bufferedamountlow', onLow);
            dc.removeEventListener('close', onClose);
            dc.removeEventListener('error', onError);
            if (interval) clearInterval(interval);
          };
          const settleResolve = () => {
            if (settled) return;
            settled = true;
            cleanup();
            drainResolve();
          };
          const settleReject = (err) => {
            if (settled) return;
            settled = true;
            cleanup();
            drainReject(err);
          };
          const onLow = () => settleResolve();
          const onClose = () => settleReject(new Error('Canal P2P cerrado durante la transferencia'));
          const onError = () => settleReject(new Error('Error en el canal de datos P2P'));

          dc.addEventListener('bufferedamountlow', onLow);
          dc.addEventListener('close', onClose);
          dc.addEventListener('error', onError);
          // Reintento periódico: solo resuelve si el buffer realmente bajó.
          interval = setInterval(() => {
            if (transferComplete || dc.bufferedAmount <= LOW_WATERMARK) settleResolve();
          }, 250);
        });

        ws.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'peer_connected') {
              setUploadStatus('¡Receptor conectado! Iniciando WebRTC...');
              const offer = await pc.createOffer();
              await pc.setLocalDescription(offer);
              ws.send(JSON.stringify({ type: 'offer', sdp: offer.sdp }));
            } else if (msg.type === 'answer') {
              await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
            } else if (msg.type === 'ice' && msg.candidate) {
              await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
            } else if (msg.type === 'peer_disconnected') {
              reject(new Error('El receptor se desconectó antes de completar la transferencia'));
            } else if (msg.type === 'curl_download_connected') {
              // El receptor es curl: saltar WebRTC y subir el archivo via HTTP PUT
              setUploadStatus('Receptor curl conectado. Enviando archivo...');
              try {
                const file = selectedFile;
                const metadata = { type: 'metadata', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
                if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(metadata));
                const resp = await fetch(
                  `${API_BASE_URL}/${newToken}/${encodeURIComponent(file.name)}`,
                  { method: 'PUT', body: file, headers: { 'Content-Type': file.type || 'application/octet-stream' } }
                );
                if (!resp.ok) throw new Error(`Error HTTP ${resp.status}`);
                setUploadStatus('¡Archivo transferido con éxito!');
                resolve();
              } catch (e) { reject(e); }
            }
          } catch (e) { reject(e); }
        };

        dc.onopen = async () => {
          try {
            setUploadStatus('Conexión P2P directa establecida. Transfiriendo...');
            const file = selectedFile;
            const metadata = { type: 'metadata', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(metadata));
            dc.send(JSON.stringify(metadata));

            // El receptor confirma que ya puede guardar antes de enviar datos
            try {
              await withTimeout(readyPromise, READY_TIMEOUT_MS, 'El receptor no confirmó que está listo para guardar el archivo');
            } catch (e) {
              reject(e);
              return;
            }

            // Enviar archivo en chunks con control de flujo (backpressure)
            const CHUNK = 16 * 1024;
            let offset = 0;
            let lastUiUpdate = 0;
            while (offset < file.size) {
              while (dc.bufferedAmount > MAX_BUFFERED_AMOUNT) {
                await waitForBufferedDrain();
              }
              const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
              const buf = await slice.arrayBuffer();
              dc.send(buf);
              offset += buf.byteLength;
              const now = Date.now();
              if (offset === file.size || now - lastUiUpdate > 120) {
                const pct = file.size > 0 ? Math.round((offset / file.size) * 100) : 100;
                setUploadStatus(`Transfiriendo... ${pct}%`);
                lastUiUpdate = now;
              }
            }
            dc.send(JSON.stringify({ type: 'eof', size: file.size }));
            try {
              await withTimeout(ackPromise, ACK_TIMEOUT_MS, 'El receptor no confirmó la recepción completa');
            } catch (e) {
              reject(e);
              return;
            }
            transferComplete = true;
            setUploadStatus('¡Archivo transferido con éxito!');
            resolve();
          } catch (e) { reject(e); }
        };

        dc.onclose = () => {
          if (!transferComplete) reject(new Error('Canal P2P cerrado antes de completar la transferencia'));
        };
        dc.onerror = () => { if (!transferComplete) reject(new Error('Error en el canal de datos P2P')); };
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' && !transferComplete) reject(new Error('Conexión WebRTC fallida'));
        };
        ws.onerror = () => { if (!transferComplete) reject(new Error('Error de WebSocket')); };
      });

      setTimeout(() => {
        setSelectedFile(null);
        setUploadStatus('');
        setToken('');
        if (fileInputRef.current) fileInputRef.current.value = '';
      }, 3000);
    } catch (error) {
      console.error('Error upload:', error);
      setUploadStatus(`Error: ${error.message}`);
      setTimeout(() => setUploadStatus(''), 5000);
    } finally {
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      // Retrasar pc.close() para que el ACK del receptor llegue antes de cerrar
      const pcRef = pc;
      setTimeout(() => { try { pcRef?.close(); } catch (_) {} }, 2000);
      setIsUploading(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadToken.trim()) return;
    setIsDownloading(true);
    setDownloadProgress(0);
    setDownloadStatus('Conectando...');
    let ws = null;
    let pc = null;
    let abortActiveTransfer = null;
    try {
      const tok = downloadToken.trim();
      ws = new WebSocket(`${WS_BASE_URL}/${tok}/signal`);
      await new Promise((resolve, reject) => {
        ws.onopen = () => resolve();
        ws.onerror = () => reject(new Error('Error al conectar servidor de señalización'));
        setTimeout(() => reject(new Error('Timeout de conexión al servidor')), 10000);
      });

      pc = new RTCPeerConnection(ICE_SERVERS);

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ice', candidate: candidate.toJSON() }));
        }
      };

      setDownloadStatus('Esperando al emisor...');

      await new Promise((resolve, reject) => {
        let metadata = null;
        const chunks = [];
        let receivedSize = 0;
        let eofReceived = false;
        const iceBuf = [];
        let remoteSet = false;
        let transferComplete = false;
        let dataChannel = null;
        let writable = null;
        let writeChain = Promise.resolve();
        let writeError = null;
        let lastUiUpdate = 0;
        let finishing = false;
        let idleTimer = null;
        let abortHttp = null;

        const resetIdle = () => {
          if (idleTimer) clearTimeout(idleTimer);
          idleTimer = setTimeout(() => {
            if (abortHttp) abortHttp();
            if (writable) { try { writable.abort(); } catch (_) {} }
            reject(new Error('Tiempo de inactividad agotado'));
          }, IDLE_TIMEOUT_MS);
        };
        resetIdle();

        const abortWritable = () => {
          if (writable) {
            try { writable.abort(); } catch (_) {}
            writable = null;
          }
        };
        abortActiveTransfer = () => {
          abortWritable();
          if (abortHttp) abortHttp();
        };

        const finish = async () => {
          if (finishing || transferComplete) return;
          finishing = true;
          if (idleTimer) clearTimeout(idleTimer);
          try {
            await writeChain;
            if (writeError) throw writeError;
            if (writable) {
              await writable.close();
              writable = null;
            } else {
              const blob = new Blob(chunks, { type: metadata?.mime || 'application/octet-stream' });
              saveBlob(blob, metadata?.name || 'archivo');
            }
            transferComplete = true;
            setDownloadProgress(100);
            setDownloadStatus('¡Descarga completada!');
            try {
              dataChannel?.send(JSON.stringify({ type: 'ack', size: receivedSize }));
            } catch (_) { /* el emisor ya se fue */ }
            resolve();
          } catch (error) {
            abortWritable();
            reject(error);
          }
        };

        ws.onmessage = async (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type === 'peer_connected') {
              setDownloadStatus('Emisor conectado, estableciendo P2P...');
            } else if (msg.type === 'offer') {
              await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
              remoteSet = true;
              for (const c of iceBuf) await pc.addIceCandidate(new RTCIceCandidate(c));
              iceBuf.length = 0;
              const answer = await pc.createAnswer();
              await pc.setLocalDescription(answer);
              ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
              setDownloadStatus('Estableciendo conexión P2P directa...');
            } else if (msg.type === 'ice' && msg.candidate) {
              if (remoteSet) await pc.addIceCandidate(new RTCIceCandidate(msg.candidate));
              else iceBuf.push(msg.candidate);
            } else if (msg.type === 'peer_disconnected') {
              if (!transferComplete && !finishing) reject(new Error('El emisor se desconectó'));
            } else if (msg.type === 'http_upload_available') {
              // El emisor es curl/terminal: descargar via HTTP GET en lugar de WebRTC
              if (idleTimer) clearTimeout(idleTimer);
              const totalSize = msg.size || 0;
              const filename = msg.filename || 'archivo';
              (async () => {
                let diskWriter = null;
                let httpIdle = null;
                try {
                  if (supportsFileSystemAccess()) {
                    try {
                      diskWriter = await openDiskWriter(filename);
                    } catch (e) {
                      reject(e);
                      return;
                    }
                  }

                  // Sin FSA y archivo grande: dejar que el navegador lo guarde directo en disco
                  if (!diskWriter && totalSize > LARGE_FILE_THRESHOLD) {
                    setDownloadStatus('Archivo grande: la descarga continuará en el gestor de descargas del navegador...');
                    startNativeDownload(`${API_BASE_URL}/${tok}?dl=1`, filename);
                    transferComplete = true;
                    resolve();
                    return;
                  }

                  const controller = new AbortController();
                  abortHttp = () => {
                    controller.abort();
                    if (diskWriter) { try { diskWriter.abort(); } catch (_) {} }
                  };
                  const resetHttpIdle = () => {
                    if (httpIdle) clearTimeout(httpIdle);
                    httpIdle = setTimeout(() => controller.abort(), IDLE_TIMEOUT_MS);
                  };
                  resetHttpIdle();

                  setDownloadStatus(`Recibiendo de terminal: ${filename}...`);
                  const resp = await fetch(`${API_BASE_URL}/${tok}?dl=1`, { signal: controller.signal });
                  if (!resp.ok) throw new Error(`Error HTTP ${resp.status}`);
                  if (!resp.body) throw new Error('El servidor no devolvió contenido');

                  const reader = resp.body.getReader();
                  const httpChunks = [];
                  let received = 0;
                  let lastHttpUi = 0;
                  while (true) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    resetHttpIdle();
                    received += value.length;
                    if (diskWriter) await diskWriter.write(value);
                    else httpChunks.push(value);
                    const now = Date.now();
                    if (now - lastHttpUi > 120) {
                      lastHttpUi = now;
                      if (totalSize > 0) {
                        const pct = Math.min(99, Math.round((received / totalSize) * 100));
                        setDownloadProgress(pct);
                        setDownloadStatus(`Descargando... ${pct}%`);
                      } else {
                        setDownloadStatus(`Descargando... ${(received / 1024 / 1024).toFixed(1)} MB`);
                      }
                    }
                  }
                  if (httpIdle) clearTimeout(httpIdle);
                  if (diskWriter) {
                    await diskWriter.close();
                    diskWriter = null;
                  } else {
                    const blob = new Blob(httpChunks, { type: resp.headers.get('Content-Type') || 'application/octet-stream' });
                    saveBlob(blob, filename);
                  }
                  transferComplete = true;
                  setDownloadProgress(100);
                  setDownloadStatus('¡Descarga completada!');
                  resolve();
                } catch (e) {
                  if (httpIdle) clearTimeout(httpIdle);
                  if (diskWriter) { try { await diskWriter.abort(); } catch (_) {} }
                  if (!transferComplete) reject(e);
                }
              })();
            }
          } catch (e) {
            if (!transferComplete) reject(e);
          }
        };

        pc.ondatachannel = (event) => {
          const dc = event.channel;
          dataChannel = dc;
          dc.binaryType = 'arraybuffer';
          setDownloadStatus('Canal P2P directo abierto. Recibiendo...');
          resetIdle();

          dc.onmessage = (evt) => {
            if (transferComplete || finishing) return;
            resetIdle();
            if (typeof evt.data === 'string') {
              if (finishing) return;
              try {
                const msg = JSON.parse(evt.data);
                if (msg.type === 'metadata') {
                  metadata = msg;
                  setDownloadStatus(`Recibiendo: ${metadata.name}`);
                  (async () => {
                    if (idleTimer) clearTimeout(idleTimer);
                    try {
                      if (supportsFileSystemAccess()) {
                        try {
                          writable = await openDiskWriter(metadata.name);
                        } catch (e) {
                          reject(e);
                          return;
                        }
                      }
                      if (!writable && metadata.size > LARGE_FILE_THRESHOLD) {
                        if (!window.confirm('Tu navegador no permite guardar en disco desde esta página. El archivo se cargará en memoria y puede fallar. ¿Continuar?')) {
                          reject(new Error('Descarga cancelada'));
                          return;
                        }
                      }
                      dc.send(JSON.stringify({ type: 'ready' }));
                      resetIdle();
                    } catch (e) {
                      reject(e);
                    }
                  })();
                } else if (msg.type === 'eof') {
                  eofReceived = true;
                  finish();
                }
              } catch (_) {
                // Ignorar mensajes de control no JSON
              }
            } else {
              const buf = evt.data;
              receivedSize += buf.byteLength;
              writeChain = writeChain
                .then(async () => {
                  if (writable) await writable.write(buf);
                  else chunks.push(buf);
                })
                .catch((err) => { writeError = err; });

              if (metadata?.size > 0) {
                const now = Date.now();
                if (now - lastUiUpdate > 120) {
                  lastUiUpdate = now;
                  const pct = Math.min(99, Math.round((receivedSize / metadata.size) * 100));
                  setDownloadProgress(pct);
                  setDownloadStatus(`Descargando... ${pct}%`);
                }
                if (receivedSize >= metadata.size) finish();
              } else {
                setDownloadStatus(`Descargando... ${(receivedSize / 1024 / 1024).toFixed(1)} MB`);
              }
            }
          };

          // Solo finalizar si hay evidencia de transferencia completa.
          dc.onclose = () => {
            if (transferComplete || finishing) return;
            if (eofReceived || (metadata?.size > 0 && receivedSize >= metadata.size)) {
              finish();
              return;
            }
            abortWritable();
            reject(new Error('Transferencia incompleta: el canal se cerró antes de recibir todos los datos'));
          };
          dc.onerror = () => {
            if (transferComplete || finishing) return;
            abortWritable();
            reject(new Error('Error en el canal de datos P2P'));
          };
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed' && !transferComplete && !finishing) {
            abortWritable();
            reject(new Error('Conexión WebRTC fallida'));
          }
        };
        ws.onerror = () => { if (!transferComplete) reject(new Error('Error de WebSocket')); };
      });

      setTimeout(() => {
        setDownloadToken('');
        setDownloadStatus('');
        setDownloadProgress(0);
      }, 3000);
    } catch (error) {
      console.error('Error descarga:', error);
      setDownloadStatus(`Error: ${error.message}`);
      setTimeout(() => {
        setDownloadStatus('');
        setDownloadProgress(0);
      }, 5000);
    } finally {
      if (abortActiveTransfer) abortActiveTransfer();
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      // Dar tiempo a que el ACK del DataChannel salga antes de cerrar el transporte
      const pcRef = pc;
      setTimeout(() => { try { pcRef?.close(); } catch (_) {} }, 2000);
      setIsDownloading(false);
    }
  };

  const copyShareToken = () => {
    if (token) {
      navigator.clipboard.writeText(token);
    }
  };

  const copyShareUrl = () => {
    if (token) {
      const shareUrl = `${API_BASE_URL}/${token} `;
      navigator.clipboard.writeText(shareUrl);
    }
  };

  const copyShareCurl = () => {
    if (token) {
      const shareCurl = `curl -O -J ${API_BASE_URL}/${token}`;
      navigator.clipboard.writeText(shareCurl);
    }
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col">
      <header className="text-center py-12">
        <h1 className="text-6xl font-bold mb-4">
          <span className="text-white">An I</span>
          <span className="text-red-camilet-500">/</span>
          <span className="text-white">O L</span>
          <span className="text-red-camilet-500">ink</span>
        </h1>
        <p className="text-xl text-gray-300">
          Transferencia P2P sin almacenamiento en servidor
        </p>
      </header>

      <main className="flex-1 container mx-auto px-4 max-w-4xl">
        <div className="mb-12">
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-2xl font-semibold mb-6 text-teal-400"> Enviar Archivo </h2>
            <div className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer ${
                isDragOver ? 'border-teal-400 bg-teal-400/10' : 'border-gray-600 hover:border-teal-400 hover:bg-teal-400/5'
              }`} onDragOver={handleDragOver} onDragLeave={handleDragLeave} onDrop={handleDrop} onClick={() => fileInputRef.current?.click()} >
              <p className="text-lg mb-2">
                Arrastra y suelta un archivo aquí
              </p>
              <div className="text-4xl mb-4">📁</div>
              <p className="mb-2">o haz clic para seleccionar</p>
              <input ref={fileInputRef} type="file" onChange={handleFileInputChange} className="hidden" />
            </div>
            {selectedFile && (
              <div className="mt-4 p-4 bg-gray-700 rounded-lg">
                <p className="text-sm text-gray-300">Archivo seleccionado:</p>
                <p className="font-medium text-teal-400">{selectedFile.name}</p>
                <p className="text-sm text-gray-400"> {(selectedFile.size / 1024 / 1024).toFixed(2)} MB </p>
              </div>
            )}
            <button onClick={generateTokenAndUpload} disabled={!selectedFile || isUploading} className="w-full mt-6 bg-teal-600 hover:bg-teal-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors" >
              {isUploading ? 'Procesando...' : 'Generar Token y Subir'}
            </button>
            {uploadStatus && (
              <div className="mt-4 p-3 bg-gray-700 rounded-lg">
                <p className="text-sm">{uploadStatus}</p>
              </div>
            )}
            {token && (
              <div className="mt-4 p-4 bg-teal-900/30 border border-teal-600 rounded-lg">
                <p className="text-sm text-gray-300 mb-2">Opciones para compartir:</p>
                <div className="flex items-center gap-2 mb-2">
                  <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-teal-400 font-mono text-sm"> {`${API_BASE_URL}/${token}`} </code>
                  <button onClick={copyShareUrl} className="flex items-center gap-1 bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" >
                    URL <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M216,40V168H168V88H88V40Z" opacity="0.2"></path><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path></svg>
                  </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-teal-400 font-mono text-xs"> {`curl -O -J ${API_BASE_URL}/${token}`} </code>
                  <button onClick={copyShareCurl} className="flex items-center gap-1 bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" >
                    CURL <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" fill="currentColor" viewBox="0 0 256 256"><path d="M216,40V168H168V88H88V40Z" opacity="0.2"></path><path d="M216,32H88a8,8,0,0,0-8,8V80H40a8,8,0,0,0-8,8V216a8,8,0,0,0,8,8H168a8,8,0,0,0,8-8V176h40a8,8,0,0,0,8-8V40A8,8,0,0,0,216,32ZM160,208H48V96H160Zm48-48H176V88a8,8,0,0,0-8-8H96V48H208Z"></path></svg>
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
        <div className="bg-gray-800 rounded-lg p-6 mb-8">
          <h2 className="text-2xl font-semibold mb-6 text-teal-400">
            Ejemplos con Terminal (curl)
          </h2>
          <div className="space-y-4">
            <div>
              <h3 className="text-lg font-medium text-gray-300 mb-3">1. Generar un token:</h3>
              <div className="bg-black rounded-lg p-4 font-mono text-sm mb-2">
                <div className="flex items-center mb-2">
                  <span className="text-green-400">{"#>"}</span>
                  <span className="text-white ml-2">curl {API_BASE_URL}/token</span>
                </div>
                <div className="text-gray-300 text-xs">
                  Se ha generado el TOKEN: <span className="text-teal-400">abc4</span><br/>
                  El token expira en 10 minutos
                </div>
              </div>
              <button onClick={() => navigator.clipboard.writeText(`curl ${API_BASE_URL}/token`)} className="bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" >
                Copiar Comando
              </button>
            </div>
            <div>
              <h3 className="text-lg font-medium text-gray-300 mb-3">2. Enviar un archivo:</h3>
              <div className="bg-black rounded-lg p-4 font-mono text-sm mb-2">
                <div className="flex items-center mb-2">
                  <span className="text-green-400">{"#>"}</span>
                  <span className="text-white ml-2">curl --upload-file FILE {API_BASE_URL}/abc4/</span>
                </div>
              </div>
              <button onClick={() => navigator.clipboard.writeText(`curl --upload-file FILE ${API_BASE_URL}/abc4/`)} className="bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" >
                Copiar Comando
              </button>
            </div>
            <div>
              <h3 className="text-lg font-medium text-gray-300 mb-3">3. Recibir el archivo:</h3>
              <div className="bg-black rounded-lg p-4 font-mono text-sm mb-2">
                <div className="flex items-center mb-2">
                  <span className="text-green-400">{"#>"}</span>
                  <span className="text-white ml-2">curl -O -J {API_BASE_URL}/abc4</span>
                </div>
              </div>
              <button onClick={() => navigator.clipboard.writeText(`curl -O -J ${API_BASE_URL}/abc4`)} className="bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" >
                Copiar Comando
              </button>
            </div>
            <div className="mt-4 p-3 bg-teal-900/20 border border-teal-600 rounded-lg">
              <p className="text-sm text-gray-300">
                <span className="text-teal-400 font-semibold">Tip:</span> Reemplaza "abc4" con tu token generado y "FILE" con tu archivo.
              </p>
            </div>
          </div>
        </div>
      </main>
      <footer className="bg-gray-800 border-t border-gray-700 py-4">
        <div className="container mx-auto px-4 text-center">
          <p className="flex items-center justify-center gap-2">Hecho con <svg style={{width:'1.25rem',height:'1.25rem',display:'inline-block'}} viewBox="0 0 163.83836 158.46089" xmlns="http://www.w3.org/2000/svg"><path style={{fill:'#ec003f'}} d="m 173.27751,117.19664 c 8.95443,-15.99188 16.93438,-36.030858 12.4775,-53.550028 -4.45711,-17.51918 -17.45013,-31.20329 -34.08452,-35.89744 -16.63504,-4.69454 -34.38461,0.30236 -46.56213,13.13948 -12.176948,-12.82427 -29.925238,-17.83326 -46.559258,-13.13948 -16.63454,4.69378 -29.627413,18.37826 -34.084593,35.89744 -4.457596,17.5188 3.520617,37.558148 12.474703,53.550028 15.59737,27.85728 68.169148,67.28063 68.169148,67.28063 0,0 52.5711,-39.42373 68.16915,-67.28063 z" transform="translate(-23.190318,-26.016384)"/></svg> especialmente para ti!</p>
          <a href="https://github.com/elcamilet/aniolink" target="_blank" rel="noopener noreferrer" className="text-teal-400 hover:underline"> Open Source Code</a> - <a href="https://elcamilet.com" target="_blank" rel="noopener noreferrer" className="text-teal-400 hover:underline"> elCamilet.com</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
