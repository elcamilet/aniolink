# Spec Delta

## Purpose

Garantiza que cada token identifique una única transferencia íntegra: tokens sin colisiones, un solo emisor y un solo receptor, expiración ligada a la actividad real y errores explícitos ante datos incompletos.

## ADDED Requirements

### Requirement: Token único por transferencia

El sistema SHALL generar un token que no exista en `active_bridges` en el momento de crearlo; si el primer intento colisiona, MUST reintentar antes de responder.

#### Scenario: Token sin colisión

- **WHEN** el cliente solicita `GET /token`
- **THEN** el servidor responde con un token que no pertenece a ningún bridge activo

#### Scenario: Colisión de token

- **WHEN** el token generado ya existe en `active_bridges`
- **THEN** el servidor genera otro token y no modifica el bridge existente

### Requirement: Un único emisor por token

Un token SHALL aceptar un solo `PUT`. Mientras exista una subida registrada, otro `PUT` MUST responder `409` sin alterar el stream del primero.

#### Scenario: Segundo emisor rechazado

- **WHEN** un segundo cliente hace `PUT /{token}/{filename}` sobre un token con emisor activo
- **THEN** recibe `409` y la transferencia del primer emisor continúa intacta

### Requirement: Un único receptor por token

Un token SHALL aceptar un solo `GET` de descarga. Mientras exista un receptor registrado, otro `GET` MUST responder `409` sin leer el mismo stream.

#### Scenario: Segundo receptor rechazado

- **WHEN** un segundo cliente hace `GET /{token}` sobre una transferencia ya reclamada
- **THEN** recibe `409` y el primer receptor sigue recibiendo los datos correctos

### Requirement: Expiración ligada a la actividad

Un token sin peers SHALL expirar tras `TIMEOUT_SECONDS`; un token con emisor, receptor o transferencia en curso MUST NOT borrarse hasta que la transferencia termine o quede inactiva.

#### Scenario: Transferencia larga no expira

- **WHEN** una transferencia sigue enviando bytes después de `TIMEOUT_SECONDS`
- **THEN** el bridge permanece en `active_bridges` y la transferencia continúa

#### Scenario: Token inactivo expira

- **WHEN** un token no tiene peers ni actividad durante `TIMEOUT_SECONDS`
- **THEN** la tarea de limpieza lo elimina

#### Scenario: Token esperando peer dentro del TTL

- **WHEN** un token se creó hace menos de `TIMEOUT_SECONDS` y aún no tiene peers
- **THEN** el token sigue disponible para el primer emisor o receptor

### Requirement: Integridad de la subida

Cuando el tamaño es conocido, el sistema MUST verificar que los bytes recibidos coinciden con `Content-Length`. Si la subida termina antes, el emisor MUST recibir un error y el receptor MUST poder detectar el truncamiento.

#### Scenario: Subida completa

- **WHEN** el emisor envía exactamente los bytes declarados
- **THEN** el emisor recibe confirmación de éxito y el receptor recibe el archivo completo

#### Scenario: Subida truncada

- **WHEN** el emisor corta la conexión antes de enviar todos los bytes declarados
- **THEN** el emisor recibe un error y el receptor no recibe una confirmación de éxito

### Requirement: Error propagado al emisor

Si el receptor se desconecta o el stream falla antes de completarse, el emisor MUST recibir un error HTTP y el bridge MUST liberarse.

#### Scenario: Receptor se desconecta

- **WHEN** el receptor cierra la conexión durante el relay
- **THEN** el `PUT` del emisor responde con error y el token deja de estar activo

### Requirement: Nombre de archivo seguro

El sistema SHALL sanear el nombre recibido y MUST codificarlo de forma segura en `Content-Disposition`, usando `filename*` para caracteres no ASCII y sin permitir saltos de línea ni comillas.

#### Scenario: Nombre con caracteres especiales

- **WHEN** el nombre contiene espacios, comillas o caracteres no ASCII
- **THEN** la cabecera `Content-Disposition` es válida y el navegador guarda el nombre esperado

### Requirement: Metadatos disponibles para el receptor

Los metadatos enviados por el emisor SHALL guardarse con independencia de su rol WebSocket y MUST estar disponibles en `GET /{token}/info` antes de la descarga.

#### Scenario: Emisor conectado en segundo lugar

- **WHEN** el receptor abre el WebSocket antes que el emisor y el emisor envía `metadata`
- **THEN** `GET /{token}/info` devuelve esos metadatos
