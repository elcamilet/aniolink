# An I/O Link - elcamilet.com

Una aplicación para transferencias P2P sin almacenamiento en servidor.

**SELF-HOSTED**
**OPEN-SOURCE**

## Características Backend
Python 3

- **Generación de tokens**
- **Comandos CURL** para enviar y recibir
- **Status** con número de tokens activos
- **Número de caracteres del Token** configurable
- **Tiempo de vida del Token** configurable

## Características Frontend
Vite, React, Tailwind CSS
- **Interfaz minimalista y moderna** 
- **Drag & Drop** para subir archivos fácilmente
- **Generación automática de tokens** para compartir archivos
- **Descarga directa** mediante tokens o URLs
- **Transferencia P2P** sin almacenamiento en servidor

## Contenedores Docker

**Backend**: https://hub.docker.com/r/elcamilet/aniolink
**Frontend**: https://hub.docker.com/r/elcamilet/aniolink-frontend

Dockerfiles preparados para adaptarlos con tus necesidades



## Uso en Web

1. **Enviar archivo**: Arrastra un archivo al área designada o haz clic para seleccionar
2. **Generar token**: Haz clic en "Generar Token y Subir" para crear un enlace de descarga
3. **Compartir**: Copia el Token, la URL generada o el comando CURL y compártelo
4. **Recibir archivo**: Pega el token en el campo de descarga o usa los enlaces directamente

## Uso en Terminal

1. Obtén un token: 
```curl https://p2p.example.com/token```
2. Sube un archivo (reemplaza FILE y TOKEN): 
```curl --upload-file FILE https://p2p.example.com/TOKEN/```
3. Descarga el archivo (reemplaza TOKEN): 
```curl -O -J https://p2p.example.com/TOKEN```
##
> **TIP**: Puedes ver el numero de tokens en uso
```curl https://p2p.example.com/status/```

