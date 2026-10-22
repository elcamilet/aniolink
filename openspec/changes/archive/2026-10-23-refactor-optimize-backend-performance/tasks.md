# Tasks

## 1. Preparación

- [x] 1.1 Dejar de ignorar `openspec/` en `.gitignore` y verificar con `git check-ignore openspec/config.yaml` que ya no está ignorado
- [x] 1.2 Crear `backend/requirements-dev.txt` con `pytest` y `httpx`, e instalar las dependencias verificando que `pytest --version` funciona

## 2. Backend: estado y expiración

- [x] 2.1 Añadir `last_activity`, `transfer_active`, `upload_claimed` y `download_claimed` a `P2PBridge`, y verificar que `python -m py_compile backend/aniolink.py` pasa
- [x] 2.2 Reescribir `cleanup_expired()` para expirar solo tokens sin peers, sin transferencia activa y con `last_activity` vencida, y verificar con el test de expiración que una transferencia activa no se borra
- [x] 2.3 Actualizar `last_activity` al crear el token, reclamar peers, iniciar la transferencia y ceder bloques, y verificar que el test de transferencia larga supera `TIMEOUT_SECONDS` sin perder el bridge

## 3. Backend: concurrencia e integridad

- [x] 3.1 Implementar `generate_token()` con reintento acotado contra `active_bridges`, y verificar con el test unitario de colisión que el bridge existente no se sobrescribe
- [x] 3.2 Rechazar un segundo `PUT` con `409` mediante `upload_claimed`, liberando el claim en `finally`, y verificar con el test de segundo emisor
- [x] 3.3 Rechazar un segundo `GET` de descarga con `409` mediante `download_claimed`, liberando el claim en `finally`, y verificar con el test de segundo receptor
- [x] 3.4 Marcar `transfer_error` al detectar `CancelledError` o bytes incompletos, responder `502` al emisor y no devolver éxito, verificando con los tests de subida truncada y desconexión del receptor
- [x] 3.5 Sanear el nombre y emitir `Content-Disposition` con `filename` ASCII y `filename*` UTF-8, verificando con el test unitario de nombres especiales
- [x] 3.6 Guardar `metadata` con independencia del rol y exponer nombre/tamaño en `GET /{token}/info`, verificando con el test de metadatos cuando el emisor conecta segundo

## 4. Frontend: receptor común

- [x] 4.1 En `App.jsx` y `download.html`, fijar `binaryType = "arraybuffer"`, usar chunks de 16 KB y manejar `eof` de forma explícita, verificando con el test manual de 0 B y 1 KB
- [x] 4.2 Sustituir el timeout absoluto de 600 s por un timeout de inactividad de 60 s reiniciado por chunk o mensaje de control, y verificar que una transferencia activa de más de 10 minutos no se cancela
- [x] 4.3 Implementar el `ack` del receptor y la espera de `ack` en el emisor con timeout de 30 s, verificando que un cierre sin `ack` muestra error y no éxito
- [x] 4.4 Endurecer el final de la recepción: `onclose` sin `eof`/tamaño es error, `JSON.parse` protegido y validación de tamaño en ambos receptores, verificando que un corte simulado no descarga un archivo parcial

## 5. Frontend: emisor y archivos grandes

- [x] 5.1 Corregir el backpressure del emisor eliminando el fallback que resuelve sin comprobar `bufferedAmount`, y verificar que un receptor lento no acumula buffer por encima del umbral
- [x] 5.2 Implementar escritura incremental a disco con `showSaveFilePicker` + `createWritable` en ambos receptores, con `abort()` al fallar, y verificar con un archivo de prueba que el uso de memoria no crece con el tamaño
- [x] 5.3 Añadir fallback a Blob con advertencia visible cuando no hay File System Access API o se pierde la activación, y verificar el flujo en un navegador sin soporte
- [x] 5.4 Limitar las actualizaciones de progreso a una cada 120 ms en ambos receptores, verificando que una transferencia larga no bloquea la interfaz

## 6. Documentación y tests

- [x] 6.1 Ajustar el README para explicar el límite real de los receptores sin File System Access API y verificar que las instrucciones de Docker y curl siguen siendo correctas
- [x] 6.2 Implementar los tests de integración con uvicorn real para 0 B, 1 KB y ~64 MB con checksum, verificando `pytest backend/tests -q`
- [x] 6.3 Implementar los tests de claims (`409`), expiración por actividad, colisión de token y nombres especiales, verificando `pytest backend/tests -q`

## 7. Verificación de integración

- [x] 7.1 Ejecutar `python -m py_compile backend/aniolink.py`, `pytest backend/tests -q` y `npm run build` en `frontend/`, y corregir cualquier fallo
- [x] 7.2 Ejecutar el smoke test curl de AGENTS.md con 1 KB y ~64 MB, comparando checksums, y verificar el arranque con `docker build`/`docker run`

## Workflow follow-up

- Ejecutar `openspec validate refactor-optimize-backend-performance --strict`.
- Commit de especificación, apply, sync, archive y push según el guión del roadmap.
- Marcar el punto como archivado en `docs/ROADMAP.md`.
- Inicializar wikipoke y ejecutar `check --strict` e ingesta.
