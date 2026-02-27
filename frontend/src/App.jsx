import React, { useState, useRef } from 'react';

const API_BASE_URL = window.location.origin;

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
      const tokenResponse = await fetch(`${API_BASE_URL}/token`);
      const tokenText = await tokenResponse.text();
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
          const statusResponse = await fetch(`${API_BASE_URL}/${newToken}/status`);
          if (!statusResponse.ok) return false;
          const data = await statusResponse.json();
          return data?.ready === true;
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
      const totalBytes = selectedFile.size;
      let uploadedBytes = 0;
      const fileStream = selectedFile.stream();
      const trackingStream = new ReadableStream({
        async start(controller) {
          const reader = fileStream.getReader();
          while (true) {
            const { done, value } = await reader.read();
            if (done) { controller.close(); break; }
            uploadedBytes += value.length;
            const progress = totalBytes > 0 ? Math.round((uploadedBytes * 100) / totalBytes) : 0;
            setUploadStatus(totalBytes > 0 ? `Transfiriendo... ${progress}%` : `Transfiriendo... ${(uploadedBytes / 1024 / 1024).toFixed(1)} MB`);
            controller.enqueue(value);
          }
        }
      });
      const uploadResponse = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Type': selectedFile.type || 'application/octet-stream',
          'Content-Length': String(totalBytes),
        },
        body: trackingStream,
        duplex: 'half',
      });
      if (!uploadResponse.ok) throw new Error(`HTTP ${uploadResponse.status}`);
      setUploadStatus('¡Archivo transferido con éxito!');
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
          <a href="https://elcamilet.com" target="_blank" rel="noopener noreferrer" className="text-teal-400 hover:underline"> elCamilet.com</a>
        </div>
      </footer>
    </div>
  );
}

export default App;
