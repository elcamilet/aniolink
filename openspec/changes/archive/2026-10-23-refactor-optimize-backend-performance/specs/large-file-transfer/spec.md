# Spec Delta

## Purpose

Define el comportamiento de los receptores de navegador para que archivos de 1 KB y de más de 15 GB se reciban completos, sin bloquear el hilo principal y sin depender de la memoria disponible.

## ADDED Requirements

### Requirement: Recepción binaria fiable

Los receptores SHALL fijar `binaryType = "arraybuffer"` antes de recibir datos y MUST usar mensajes de 16 KB para mantenerse dentro de los límites de SCTP de los navegadores.

#### Scenario: Archivo de 1 KB

- **WHEN** el emisor envía un archivo de 1 KB por el DataChannel
- **THEN** el receptor contabiliza 1024 bytes y completa la descarga sin esperar al cierre del canal

#### Scenario: Archivo de 0 bytes

- **WHEN** el emisor envía un archivo vacío
- **THEN** el receptor completa la descarga inmediatamente al recibir `eof`

### Requirement: Backpressure real en el emisor

El emisor MUST esperar a que `bufferedAmount` baje del umbral antes de enviar más datos; ningún temporizador MUST liberar el envío sin comprobar ese valor.

#### Scenario: Receptor lento

- **WHEN** el receptor consume más lento de lo que el emisor produce
- **THEN** el emisor deja de enviar hasta que el buffer baje del umbral y no acumula datos sin límite

### Requirement: Timeout por inactividad

La recepción SHALL usar un timeout que se reinicia con cada chunk o mensaje de control; una transferencia activa MUST NOT cancelarse por duración total.

#### Scenario: Transferencia de más de 10 minutos

- **WHEN** un archivo grande sigue recibiendo datos después de 10 minutos
- **THEN** la transferencia continúa

#### Scenario: Transferencia estancada

- **WHEN** no llegan datos ni mensajes durante el intervalo de inactividad configurado
- **THEN** la recepción termina con un error explícito

### Requirement: Finalización verificada

La descarga SHALL completarse solo al recibir `eof` o al alcanzar el tamaño anunciado. Un cierre del canal sin esa evidencia MUST tratarse como error y no MUST generar un archivo truncado.

#### Scenario: Cierre prematuro

- **WHEN** el DataChannel se cierra antes de recibir `eof` o el tamaño completo
- **THEN** el receptor muestra un error y no descarga un archivo parcial

#### Scenario: Tamaño anunciado alcanzado

- **WHEN** los bytes recibidos igualan el tamaño de los metadatos
- **THEN** la descarga se marca como completada

### Requirement: Confirmación del receptor

El receptor SHALL enviar un mensaje de confirmación al emisor tras validar la integridad. El emisor MUST NOT mostrar éxito hasta recibir esa confirmación o agotar el timeout de confirmación.

#### Scenario: Confirmación recibida

- **WHEN** el receptor valida todos los bytes y envía `ack`
- **THEN** el emisor muestra la transferencia como completada

#### Scenario: Confirmación ausente

- **WHEN** el emisor termina de enviar y no recibe `ack` dentro del timeout
- **THEN** el emisor muestra un error en lugar de un éxito falso

### Requirement: Descarga a disco para archivos grandes

Cuando el navegador soporte File System Access API, el receptor SHALL escribir los chunks incrementalmente en el archivo elegido por el usuario y MUST NOT acumular el archivo completo en memoria. El selector SHALL solicitarse en respuesta a una acción del usuario; si el navegador rechaza la apertura por pérdida de activación, el receptor MUST degradar a Blob con aviso. El archivo MUST abortarse si la transferencia falla.

#### Scenario: Archivo de 15 GB en navegador compatible

- **WHEN** el receptor compatible recibe un archivo de 15 GB
- **THEN** los chunks se escriben a disco y el uso de memoria no crece con el tamaño del archivo

#### Scenario: Selector rechazado por el navegador

- **WHEN** `showSaveFilePicker` falla porque la activación del usuario ya expiró
- **THEN** el receptor continúa con Blob y muestra la advertencia de memoria

#### Scenario: Fallo durante la escritura

- **WHEN** la transferencia falla después de crear el archivo de destino
- **THEN** el receptor aborta la escritura y no deja un archivo parcial como descarga válida

### Requirement: Fallback sin File System Access API

En navegadores sin File System Access API, el receptor SHALL usar Blob y MUST advertir al usuario de que el archivo se cargará en memoria antes de continuar con archivos grandes.

#### Scenario: Navegador sin soporte

- **WHEN** el receptor no dispone de `showSaveFilePicker`
- **THEN** la descarga funciona mediante Blob y la interfaz informa de la limitación de memoria

### Requirement: Progreso sin bloquear la interfaz

La interfaz SHALL actualizar el progreso como máximo cada 120 ms y MUST evitar una actualización de estado por cada chunk.

#### Scenario: Archivo de 15 GB

- **WHEN** se reciben decenas de miles de chunks
- **THEN** la interfaz actualiza el progreso de forma periódica sin bloquear el hilo principal
