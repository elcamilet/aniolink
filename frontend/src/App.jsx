import React, { useState, useRef, useEffect } from 'react';

const API_BASE_URL = window.location.origin;
const WS_BASE_URL = API_BASE_URL.replace(/^http/, 'ws');

const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
  ],
};

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

      pc.onicecandidate = ({ candidate }) => {
        if (candidate && ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ice', candidate: candidate.toJSON() }));
        }
      };

      // 4. Esperar peer, señalizar y transferir
      await new Promise((resolve, reject) => {
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
            }
          } catch (e) { reject(e); }
        };

        dc.onopen = async () => {
          try {
            setUploadStatus('Conexión P2P directa establecida. Transfiriendo...');
            const file = selectedFile;
            // Enviar metadatos al servidor (para endpoint /info) y al peer via DataChannel
            const metadata = { type: 'metadata', name: file.name, size: file.size, mime: file.type || 'application/octet-stream' };
            if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(metadata));
            dc.send(JSON.stringify(metadata));

            // Enviar archivo en chunks con control de flujo (backpressure)
            const CHUNK = 64 * 1024;
            let offset = 0;
            while (offset < file.size) {
              while (dc.bufferedAmount > 2 * 1024 * 1024) {
                await new Promise(r => setTimeout(r, 30));
              }
              const slice = file.slice(offset, Math.min(offset + CHUNK, file.size));
              const buf = await slice.arrayBuffer();
              dc.send(buf);
              offset += buf.byteLength;
              setUploadStatus(`Transfiriendo... ${Math.round((offset / file.size) * 100)}%`);
            }
            dc.close();
            setUploadStatus('¡Archivo transferido con éxito!');
            resolve();
          } catch (e) { reject(e); }
        };

        dc.onerror = () => reject(new Error('Error en el canal de datos P2P'));
        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') reject(new Error('Conexión WebRTC fallida'));
        };
        ws.onerror = () => reject(new Error('Error de WebSocket'));
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
      if (pc) pc.close();
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
        const iceBuf = [];
        let remoteSet = false;

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
              reject(new Error('El emisor se desconectó'));
            }
          } catch (e) { reject(e); }
        };

        pc.ondatachannel = (event) => {
          const dc = event.channel;
          setDownloadStatus('Canal P2P directo abierto. Recibiendo...');

          dc.onmessage = (evt) => {
            if (typeof evt.data === 'string') {
              const msg = JSON.parse(evt.data);
              if (msg.type === 'metadata') {
                metadata = msg;
                setDownloadStatus(`Recibiendo: ${metadata.name}`);
              }
            } else {
              chunks.push(evt.data);
              receivedSize += evt.data.byteLength;
              if (metadata?.size > 0) {
                const pct = Math.round((receivedSize / metadata.size) * 100);
                setDownloadProgress(pct);
                setDownloadStatus(`Descargando... ${pct}%`);
              } else {
                setDownloadStatus(`Descargando... ${(receivedSize / 1024 / 1024).toFixed(1)} MB`);
              }
            }
          };

          dc.onclose = () => {
            const blob = new Blob(chunks, { type: metadata?.mime || 'application/octet-stream' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = metadata?.name || 'archivo';
            a.style.display = 'none';
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            setTimeout(() => URL.revokeObjectURL(url), 60000);
            setDownloadStatus('¡Descarga completada!');
            resolve();
          };

          dc.onerror = () => reject(new Error('Error en el canal de datos P2P'));
        };

        pc.onconnectionstatechange = () => {
          if (pc.connectionState === 'failed') reject(new Error('Conexión WebRTC fallida'));
        };
        ws.onerror = () => reject(new Error('Error de WebSocket'));
        setTimeout(() => reject(new Error('Tiempo de espera agotado')), 600000);
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
      if (ws && ws.readyState === WebSocket.OPEN) ws.close();
      if (pc) pc.close();
      setIsDownloading(false);
    }
  }

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
                  <span className="text-green-400">user@linux:~$</span>
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
                  <span className="text-green-400">user@linux:~$</span>
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
                  <span className="text-green-400">user@linux:~$</span>
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
