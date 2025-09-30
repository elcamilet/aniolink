import React, { useState, useRef } from 'react';
import axios from 'axios';

const API_BASE_URL = import.meta.env.API_BASE_URL || 'https://p2p.example.com';

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
    try {
      // Generate token using axios
      const tokenResponse = await axios.get(`${API_BASE_URL}/token`);
      const tokenText = tokenResponse.data;
      const tokenMatch = tokenText.match(/TOKEN: (\w+)/);
      if (!tokenMatch) {
        throw new Error('No se pudo extraer el token');
      }
      const newToken = tokenMatch[1];
      setToken(newToken);
      setUploadStatus('Token generado. Preparando subida...');
      const uploadUrl = `${API_BASE_URL}/${newToken}/${encodeURIComponent(selectedFile.name)}`;
      setUploadStatus('Esperando conexión P2P...');
      const checkPeerStatus = async () => {
        try {
          const statusResponse = await axios.get(`${API_BASE_URL}/${newToken}/status`);
          return statusResponse.data?.ready === true;
        } catch (error) {
          return false;
        }
      };
      let isPeerReady = false;
      const maxAttempts = 120; // 2 minutes (120 * 1000ms)
      let attempts = 0;
      while (!isPeerReady && attempts < maxAttempts) {
        isPeerReady = await checkPeerStatus();
        if (!isPeerReady) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          attempts++;
          setUploadStatus(`Esperando conexión P2P... (${maxAttempts - attempts} segundos restantes)`);
        }
      }
      if (!isPeerReady) {
        throw new Error('timeout-no-peer');
      }
      await new Promise(resolve => setTimeout(resolve, 1000));
      const finalCheck = await checkPeerStatus();
      if (!finalCheck) {
        throw new Error('peer-disconnected');
      }
      setUploadStatus('¡Conexión P2P establecida! Iniciando transferencia...');
      const formData = new FormData();
      formData.append('file', selectedFile);
      const controller = new AbortController();
      const uploadResponse = await axios.put(uploadUrl, formData, {
        headers: { 'Content-Type': 'multipart/form-data', },
        signal: controller.signal,
        timeout: 3600000, // 1 hour timeout for large files
        onUploadProgress: (progressEvent) => {
          if (progressEvent.total && progressEvent.total > 0) {
            const progress = Math.round((progressEvent.loaded * 100) / progressEvent.total);
            setUploadStatus(`Transfiriendo... ${progress}%`);
          } else {
            const mbUploaded = (progressEvent.loaded / 1024 / 1024).toFixed(1);
            setUploadStatus(`Transfiriendo... ${mbUploaded} MB`);
          }
        },
      });
      setUploadStatus('¡Archivo listo para compartir!');
      setTimeout(() => {
        setSelectedFile(null);
        setUploadStatus('');
        setToken('');
        if (fileInputRef.current) {
          fileInputRef.current.value = '';
        }
      }, 3000);
    } catch (error) {
      console.error('Error:', error);
      let errorMessage = 'Error al subir el archivo. Inténtalo de nuevo.';
      if (error.message === 'timeout-no-peer') {
        errorMessage = 'Tiempo de espera agotado. Nadie se conectó para descargar.';
      } else if (error.message === 'peer-disconnected') {
        errorMessage = 'El destinatario se desconectó antes de iniciar la transferencia.';
      } else if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        errorMessage = 'Tiempo de espera agotado durante la transferencia.';
      } else if (error.response?.status === 408) {
        errorMessage = 'La conexión P2P se perdió durante la transferencia.';
      } else if (error.response?.status === 404) {
        errorMessage = 'Token inválido o expirado.';
      } else if (error.message.includes('Network Error')) {
        errorMessage = 'Error de conexión. Verifica tu internet.';
      }
      setUploadStatus(errorMessage);
      setTimeout(() => {
        setUploadStatus('');
      }, 5000);
    } finally {
      setIsUploading(false);
    }
  };

  const handleDownload = async () => {
    if (!downloadToken.trim()) return
    setIsDownloading(true)
    setDownloadProgress(0)
    setDownloadStatus('Conectando...')
    try {
      const downloadUrl = `${API_BASE_URL}/${downloadToken.trim()}`
      const response = await fetch(downloadUrl, {
        method: 'GET',
        headers: { 'Accept': '*/*' }
      })
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`)
      }
      let filename = 'archivo_descargado'
      const contentDisposition = response.headers.get('content-disposition')
      if (contentDisposition) {
        const filenameMatch = contentDisposition.match(/filename="([^"]+)"/) || contentDisposition.match(/filename=([^;]+)/)
        if (filenameMatch) {
          filename = filenameMatch[1].trim()
        }
      }
      const contentLength = response.headers.get('content-length')
      const totalSize = contentLength ? parseInt(contentLength, 10) : 0
      setDownloadStatus('Descarga iniciada...')
      if ('showSaveFilePicker' in window) {
        const fileHandle = await window.showSaveFilePicker({
          suggestedName: filename,
          types: [{
            description: 'Todos los archivos',
            accept: { '*/*': ['.*'] }
          }]
        })
        setDownloadStatus('Iniciando descarga...')
        const writableStream = await fileHandle.createWritable()
        const reader = response.body.getReader()
        let receivedLength = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          await writableStream.write(value)
          receivedLength += value.length
          if (totalSize > 0) {
            const progress = Math.round((receivedLength * 100) / totalSize)
            setDownloadProgress(progress)
            setDownloadStatus(`Descargando... ${progress}%`)
          } else {
            const mbDownloaded = (receivedLength / 1024 / 1024).toFixed(1)
            setDownloadStatus(`Descargando... ${mbDownloaded} MB`)
          }
        }
        await writableStream.close()
        setDownloadStatus('¡Descarga completada!')
      } else {
        const link = document.createElement('a')
        link.download = filename
        link.style.display = 'none'
        document.body.appendChild(link)
        setDownloadStatus('Iniciando descarga...')
        const reader = response.body.getReader()
        const chunks = []
        let receivedLength = 0
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          chunks.push(value)
          receivedLength += value.length
          if (totalSize > 0) {
            const progress = Math.round((receivedLength * 100) / totalSize)
            setDownloadProgress(progress)
            setDownloadStatus(`Descargando... ${progress}%`)
          } else {
            const mbDownloaded = (receivedLength / 1024 / 1024).toFixed(1)
            setDownloadStatus(`Descargando... ${mbDownloaded} MB`)
          }
        }
        const blob = new Blob(chunks, {
          type: response.headers.get('content-type') || 'application/octet-stream'
        })
        const url = URL.createObjectURL(blob)
        link.href = url
        link.click()
        document.body.removeChild(link)
        URL.revokeObjectURL(url)
        setDownloadStatus('¡Descarga completada!')
      }
      setTimeout(() => {
        setDownloadToken('')
        setDownloadStatus('')
        setDownloadProgress(0)
      }, 3000)
    } catch (error) {
      let errorMessage = 'Error al descargar el archivo. Verifica el token.'
      if (error.message.includes('404')) {
        errorMessage = 'Token no encontrado o expirado.'
      } else if (error.message.includes('408')) {
        errorMessage = 'No hay archivo disponible para este token.'
      } else if (error.message.includes('cancelada')) {
        errorMessage = 'Descarga cancelada por el usuario.'
      } else if (error.name === 'NetworkError') {
        errorMessage = 'Error de conexión. Verifica tu internet.'
      }
      setDownloadStatus(errorMessage)
      setTimeout(() => {
        setDownloadStatus('')
        setDownloadProgress(0)
      }, 5000)
    } finally {
      setIsDownloading(false)
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
        <div className="grid md:grid-cols-2 gap-8 mb-12">
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
                  <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-teal-400 font-mono"> {token} </code>
                  <button onClick={copyShareToken} className="bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" > TOKEN </button>
                </div>
                <div className="flex items-center gap-2 mb-2">
                  <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-teal-400 font-mono text-sm"> {`${API_BASE_URL}/${token}`} </code>
                  <button onClick={copyShareUrl} className="bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" > URL </button>
                </div>
                <div className="flex items-center gap-2">
                  <code className="flex-1 bg-gray-800 px-3 py-2 rounded text-teal-400 font-mono text-xs"> {`curl -O -J ${API_BASE_URL}/${token}`} </code>
                  <button onClick={copyShareCurl} className="bg-teal-600 hover:bg-teal-700 px-3 py-2 rounded text-sm transition-colors" > CURL </button>
                </div>
              </div>
            )}
          </div>
          <div className="bg-gray-800 rounded-lg p-6">
            <h2 className="text-2xl font-semibold mb-6 text-teal-400"> Recibir Archivo </h2>
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-300 mb-2"> Token o URL de descarga: </label>
                <input type="text" value={downloadToken} onChange={(e) => setDownloadToken(e.target.value)} placeholder="Pega aquí el token o URL completa" className="w-full bg-gray-700 border border-gray-600 rounded-lg px-4 py-3 text-white placeholder-gray-400 focus:outline-none focus:border-teal-400 focus:ring-1 focus:ring-teal-400" />
              </div>
              <button onClick={handleDownload} disabled={!downloadToken.trim() || isDownloading} className="w-full bg-teal-600 hover:bg-teal-700 disabled:bg-gray-600 disabled:cursor-not-allowed text-white font-semibold py-3 px-6 rounded-lg transition-colors" >
                {isDownloading ? 'Descargando...' : 'Descargar Archivo'}
              </button>
            </div>
            {isDownloading && (
              <div className="mt-4 p-4 bg-gray-700 rounded-lg">
                <div className="mb-2">
                  <div className="flex justify-between text-sm text-gray-300 mb-1">
                    <span>Progreso de descarga</span>
                    <span>{downloadProgress}%</span>
                  </div>
                  <div className="w-full bg-gray-600 rounded-full h-2">
                    <div className="bg-teal-600 h-2 rounded-full transition-all duration-300 ease-out" style={{ width: `${downloadProgress}%` }}></div>
                  </div>
                </div>
                {downloadStatus && (
                  <p className="text-sm text-gray-300">{downloadStatus}</p>
                )}
              </div>
            )}
            {downloadStatus && !isDownloading && (
              <div className="mt-4 p-3 bg-gray-700 rounded-lg">
                <p className="text-sm text-gray-300">{downloadStatus}</p>
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
          <p className="flex items-center justify-center gap-2">Hecho con <img src="/heart.svg" alt="heart" className="w-5 h-5" /> especialmente para ti!</p>
          <a href="https://elcamilet.com" target="_blank" rel="noopener noreferrer" className="text-teal-400 hover:underline"> elCamilet.com</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
