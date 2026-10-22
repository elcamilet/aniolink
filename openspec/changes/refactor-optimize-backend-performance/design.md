# Design

## Context

Ver `proposal.md` — Why. El relay HTTP usa `request.stream()` sin buffering y la señalización WebSocket comparte el mismo `P2PBridge`. El proceso es único y el estado vive en memoria, así que cualquier cambio debe seguir siendo compatible con un solo worker. `download.html` duplica el receptor de `App.jsx` y el protocolo DataChannel (`metadata`, `eof`) debe mantenerse sincronizado en ambos.

## Goals / Non-Goals

**Goals:**

- Eliminar los deadlocks, corrupciones y éxitos falsos del relay HTTP.
- Soportar transferencias de +15 GB sin crecer en memoria en el navegador.
- Completar correctamente archivos de 0 B y 1 KB sin depender del cierre del canal.
- Mantener un solo proceso, sin almacenamiento en disco del lado servidor.

**Non-Goals:**

- Replicación o multiproceso; `active_bridges` sigue en memoria.
- Reanudación de transferencias interrumpidas.
- Soporte de streaming a disco en navegadores sin File System Access API.
- Cambiar el contrato de `PUT /{token}/{filename}` (sigue siendo el cuerpo crudo).
- Añadir autenticación o límites de cuota.

## Decisions

### Expiración por actividad, no por creación

`P2PBridge` gana `last_activity` y `transfer_active`. Se actualiza al crear el token, al reclamar emisor/receptor, al iniciar la transferencia y al ceder cada bloque (con límite de frecuencia para no mutar el reloj por chunk). `cleanup_expired()` solo borra si no hay peers, no hay transferencia activa y `now - last_activity > TIMEOUT_SECONDS`; el TTL original se conserva para tokens sin usar.

Alternativa descartada: aumentar `TIMEOUT_SECONDS`; no arregla transferencias de duración arbitraria y retrasa la limpieza de tokens muertos.

### Claims atómicos en el handler

`upload_claimed` y `download_claimed` se activan de forma síncrona al entrar en `PUT`/`GET`, antes del primer `await`, y responden `409` si ya estaban activos. El event loop es monohilo, así que esta asignación evita la carrera sin locks adicionales. Los flags se liberan en el `finally` del handler.

Alternativa descartada: `asyncio.Lock` por endpoint; añade espera innecesaria y no mejora la exclusión.

### Integridad basada en `Content-Length` y cancelación

Si `content_length` está presente, el generador compara los bytes cedidos al final; si difieren, marca `transfer_error` y el `PUT` responde `502`. Un `CancelledError` por desconexión del receptor se captura para marcar error y liberar el bridge. Para subidas chunked sin longitud se considera completa cuando el stream termina; no se inventa un tamaño.

Alternativa descartada: bufferizar para contar; viola la restricción de no almacenar ni bufferizar el cuerpo.

### Token con reintento acotado

`generate_token()` reintenta hasta 100 veces contra `active_bridges`. Con 4 caracteres y 36 símbolos el espacio es amplio, pero el reintento elimina la sobrescritura silenciosa de un bridge vivo. Si se agota, `GET /token` responde `503`.

### `Content-Disposition` seguro

Se sanea el nombre (sin controles, comillas, `/`, `\`; longitud acotada) y se emite `filename="<ascii>"` más `filename*=UTF-8''<quoted>` para conservar caracteres no ASCII. El nombre mostrado por el navegador sigue siendo el original saneado.

### Protocolo de recepción

- `binaryType = "arraybuffer"` antes de abrir el canal; chunks de 16 KB.
- Backpressure: el emisor espera `bufferedamountlow` y vuelve a comprobar `bufferedAmount`; se elimina el `setTimeout` que resolvía sin comprobar.
- Timeout de inactividad (60 s) reiniciado por chunk o mensaje de control, en lugar del timeout absoluto de 600 s.
- El receptor valida `eof`/tamaño y responde `{"type":"ack","size":N}`; el emisor espera el `ack` (30 s) antes de declarar éxito. El cierre sin `eof` es error en ambos receptores.
- `download.html` gana el manejo de `eof` y `JSON.parse` protegido que ya tiene `App.jsx`.

El `ack` es un mensaje nuevo del DataChannel; ambos extremos se despliegan juntos, por lo que no hay compatibilidad que mantener con clientes antiguos.

### Streaming a disco con File System Access API

El receptor intenta `showSaveFilePicker` cuando ya conoce el nombre (metadatos WebRTC o cabecera `Content-Disposition` del relay HTTP), dentro de la ventana de activación del clic. Si el navegador lo rechaza, cae a Blob y muestra la advertencia. Con un `FileSystemWritableFileStream`, cada chunk se escribe y se vacía de memoria; al fallar se llama `abort()` y no se conserva un archivo parcial. En el relay HTTP se usa el mismo camino tras leer la respuesta; el fallback sin FSA mantiene el `fetch` + Blob actual.

Alternativa descartada: descarga por navegación directa a `/{token}?dl=1`; evita memoria pero pierde progreso y no cubre WebRTC.

### Tests de integración con uvicorn real

Los tests arrancan un subproceso `uvicorn` en un puerto libre (no `TestClient`) para ejercitar streaming y backpressure reales. Cada test crea su token y usa hilos para emisor/receptor simultáneos. Los casos unitarios (token, saneado) importan el módulo directamente con `TIMEOUT_SECONDS` bajo.

## Risks / Trade-offs

- [FSA no disponible en Firefox/Safari] → fallback Blob con aviso; el README deja de prometer "sin límite" en esos navegadores.
- [El `ack` retrasa la confirmación 30 s si el receptor antiguo no lo envía] → ambos frontends se actualizan en el mismo despliegue.
- [Transferencias de +15 GB siguen dependiendo de una conexión estable] → timeout por inactividad y error explícito; no se reanuda.
- [El picker puede perder la activación si el emisor tarda] → fallback controlado y advertencia; no se bloquea la transferencia.
- [Los tests de 64 MB añaden tiempo a la suite] → tamaño configurable por variable y marcados como integración.
- [La limpieza por actividad puede retener bridges con un peer conectado indefinidamente] → el TTL se sigue aplicando cuando no hay transferencia activa y el WebSocket se cierra al terminar.

## Migration Plan

1. Desplegar backend y frontend juntos (misma imagen Docker).
2. Sin migración de datos: los bridges viven en memoria y expiran solos.
3. Rollback: revertir el commit; no hay cambios de esquema ni de almacenamiento.
4. Tras el despliegue, verificar con el smoke test curl de 1 KB y 64 MB.

## Open Questions

Ninguna que bloquee la implementación.
