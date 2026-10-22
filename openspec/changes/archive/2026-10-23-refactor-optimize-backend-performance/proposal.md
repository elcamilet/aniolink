# Proposal

## Why

Las transferencias de archivos muy pequeños (~1 KB) y muy grandes (+15 GB) fallan por causas distintas: los receptores de navegador no fijan `binaryType`, dependen de `onclose` para completar y no manejan `eof`, mientras que los archivos grandes se acumulan íntegros en memoria (Blob) y están sujetos a un timeout absoluto de 10 minutos. En el servidor, el bridge puede borrarse durante una transferencia activa, no hay control de emisor/receptor único, los tokens pueden colisionar y una subida incompleta puede devolver éxito. El punto 1 del roadmap pide revisar el código y eliminar estos puntos de fallo.

## What Changes

- Expiración de tokens por inactividad y nunca mientras haya una transferencia activa; el TTL sigue aplicando a tokens sin peers.
- Generación de token única con reintento para no sobrescribir bridges vivos.
- Claims de emisor y receptor: un segundo `PUT` o `GET` sobre el mismo token responde `409` en lugar de corromper el stream.
- Verificación exacta de bytes transferidos y propagación de error al emisor y al receptor; una subida incompleta ya no devuelve éxito.
- Saneado del nombre de archivo en `Content-Disposition` (incluido `filename*` RFC 5987) y metadatos disponibles con independencia del rol WebSocket.
- Receptores de navegador (`App.jsx` y `download.html`): `binaryType = "arraybuffer"`, chunks de 16 KB, backpressure real sin fallback ciego, timeout por inactividad, manejo estricto de `eof`/cierre y ACK del receptor.
- Descarga de archivos grandes transmitida a disco con File System Access API (`showSaveFilePicker`) y fallback a Blob cuando el navegador no la soporta.
- Progreso de UI limitado a ~120 ms para no bloquear el hilo principal en transferencias largas.
- Suite de tests de integración del relay HTTP con uvicorn real (0 B, 1 KB, ~64 MB con checksum, claims, expiración y colisión de token).
- Ajuste del README para reflejar el límite real de los receptores sin File System Access API.

## Capabilities

### New Capabilities

- `transfer-integrity`: unicidad de tokens, claims de peers, expiración ligada a actividad, verificación de bytes, errores de transferencia y nombres de archivo seguros.
- `large-file-transfer`: comportamiento de los receptores de navegador para archivos pequeños y grandes (chunks, backpressure, timeouts, ACK, streaming a disco y progreso).

### Modified Capabilities

<!-- Sin capacidades existentes: openspec/specs/ está vacío. -->

## Impact

- `backend/aniolink.py`: estado del bridge, expiración, endpoints `PUT`/`GET`/`/info` y señalización.
- `frontend/src/App.jsx` y `backend/templates/download.html`: protocolo de recepción, descarga a disco y UI de progreso.
- `backend/requirements-dev.txt` y `backend/tests/`: nueva infraestructura de tests (sin cambios en la imagen de producción).
- `README.md`: afirmación sobre el tamaño máximo.
- `.gitignore`: dejar de ignorar `openspec/` para versionar specs y changes.
- Sin cambios en el protocolo HTTP público (se añaden respuestas `409` ante usos concurrentes) ni en el modo de despliegue de un solo proceso.
