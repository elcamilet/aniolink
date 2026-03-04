# An I/O Link - elcamilet.com
Mi hijo se llama Aniol 😍

Una aplicación para transferencias P2P **realmente peer-to-peer** sin almacenamiento en servidor.

Creada con ❤️ especialmente para tí!

Puedes hacerte un **Self-Hosted** con Docker🐳, en toda regla: https://hub.docker.com/r/elcamilet/aniolink

Adáptalo a tus necesidades y compárteme tus mejoras, es **Open Source**

## Demo funcional (Beta): https://io.elcamilet.com

## Cómo funciona

El servidor actúa como punto de encuentro entre emisor y receptor. Los datos **nunca se almacenan en disco**. Hay cuatro modos de transferencia según quién envía y quién recibe:

**Browser → Browser** (P2P puro via WebRTC DataChannel):
```
Browser (emisor)        Servidor               Browser (receptor)
  |--- WS /signal ------->|<------ WS /signal ---|
  |<-- peer_connected ---->|----> peer_connected ->|
  |--- SDP offer -------->|-----> SDP offer ------>|
  |<-- SDP answer --------|<----- SDP answer ------|
  |<-- ICE candidates ---->|<-- ICE candidates ---->|
  |                        |                        |
  |<====== WebRTC DataChannel (P2P directo) =======>|
  |            (el servidor no ve los datos)        |
```

**Terminal → Terminal** (relay HTTP streaming):
```
curl PUT /{token}/file  →  servidor  →  curl GET /{token}
         (streaming directo, sin buffering ni disco)
```

**Browser → Terminal** (browser envía, curl descarga):
```
Browser --- WS /signal --->  Servidor
Browser <-- curl_download_connected --  (curl hace GET /{token})
Browser --- HTTP PUT /{token}/file --->  Servidor  ---> curl
```

**Terminal → Browser** (curl envía, browser descarga):
```
curl --- HTTP PUT /{token}/file --->  Servidor
Browser <-- http_upload_available --  (via WS /signal)
Browser --- HTTP GET /{token}?dl=1 -->  Servidor  (streaming del PUT de curl)
```

## Características Backend
Python 3 / FastAPI

- **Señalización WebRTC** — relay de SDP e ICE candidates entre peers
- **Generación de tokens** como punto de encuentro entre peers
- **Relay HTTP streaming** para compatibilidad con `curl` (sin buffering, sin almacenamiento en disco)
- **Detección automática del modo de transferencia** — browser→browser, curl→curl, browser→curl y curl→browser
- **Notificación cruzada via WebSocket** — avisa al receptor cuando el emisor es curl y viceversa
- **Status** con número de tokens activos
- **Número de caracteres del Token** configurable
- **Tiempo de vida del Token** configurable

## Características Frontend
Vite, React, Tailwind CSS

- **Transferencia P2P real via WebRTC DataChannels** — los datos no pasan por el servidor en browser→browser
- **Modo mixto automático** — si el receptor es curl, el browser cambia a HTTP PUT; si el emisor es curl, el browser descarga via HTTP streaming
- **Drag & Drop** para seleccionar archivos
- **Generación automática de tokens** para compartir
- **Descarga directa** mediante tokens o URLs compartidas (página `/token` independiente del SPA)
- **Sin límite de tamaño** — funciona con archivos de varios GB sin timeouts
- **Interfaz minimalista y moderna**

## Contenedores Docker

Un solo `Dockerfile` multi-stage en la raíz del proyecto construye frontend y backend juntos:

```bash
docker build -t aniolink .
docker run -p 3000:3000 aniolink
```

Configura las variables de entorno según `.env.example`.



## Uso en Web (browser → browser)

1. **Enviar archivo**: Arrastra un archivo al área designada o haz clic para seleccionar
2. **Generar token**: Haz clic en "Generar Token y Subir" — el emisor queda esperando conexión
3. **Compartir**: Copia el Token, la URL generada o el comando CURL y compártelo con el receptor
4. **Recibir archivo**: El receptor abre la URL en un navegador → se establece la conexión WebRTC P2P directa → el archivo se transfiere sin pasar por el servidor

> **Nota**: Requiere un servidor STUN para la negociación NAT (se usa `stun.l.google.com` por defecto, gratuito). Cubre el 95%+ de los casos. En redes con NAT simétrico muy restrictivo puede ser necesario un servidor TURN propio.

## Uso en Terminal (curl)

**Terminal → Terminal:**

```bash
# Receptor espera primero
curl https://io.elcamilet.com/token          # obtener token
curl --upload-file FILE https://io.elcamilet.com/TOKEN/   # enviar
curl -O -J https://io.elcamilet.com/TOKEN    # recibir
```

**Terminal → Browser** (curl envía, browser recibe):

```bash
curl https://io.elcamilet.com/token          # obtener token
# El receptor abre https://io.elcamilet.com/TOKEN en el navegador y pulsa "Descargar"
curl --upload-file FILE https://io.elcamilet.com/TOKEN/   # enviar
```

**Browser → Terminal** (browser envía, curl recibe):

```bash
# El emisor sube el archivo desde el navegador y obtiene un TOKEN
curl -O -J https://io.elcamilet.com/TOKEN    # recibir con curl
```

> **TIP**: Puedes ver el número de tokens en uso:
```bash
curl https://io.elcamilet.com/status/
```

## elCamilet
Este software está hecho **"as is"**, tal cual, sin garantías ni tonterías. Puedes usarlo, copiarlo, o lo que quieras, pero no me reproches nada...

Si quieres contactar conmigo, me encontrarás en https://elcamilet.com