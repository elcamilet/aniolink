# An I/O Link - elcamilet.com
Mi hijo se llama Aniol 😍

Una aplicación para transferencias P2P sin almacenamiento en servidor.

Creada con ❤️ especialmente para tí!

Puedes hacerte un **Self-Hosted** con Docker🐳, en toda regla: https://hub.docker.com/r/elcamilet/aniolink

Adáptalo a tus necesidades y compárteme tus mejoras, es **Open Source**

## Demo funcional (Beta): https://io.elcamilet.com

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

Un solo `Dockerfile` multi-stage en la raíz del proyecto construye frontend y backend juntos:

```bash
docker build -t aniolink .
docker run -p 3000:3000 aniolink
```

Configura las variables de entorno según `.env.example`.



## Uso en Web

1. **Enviar archivo**: Arrastra un archivo al área designada o haz clic para seleccionar
2. **Generar token**: Haz clic en "Generar Token y Subir" para crear un enlace de descarga
3. **Compartir**: Copia el Token, la URL generada o el comando CURL y compártelo
4. **Recibir archivo**: Abre la URL en un navegador y pulsa "Descargar Archivo", o usa curl directamente

## Uso en Terminal

1. Obtén un token:

```curl https://io.example.com/token```

2. Sube un archivo (reemplaza FILE y TOKEN):

```curl --upload-file FILE https://io.example.com/TOKEN/```

3. Descarga el archivo (reemplaza TOKEN):

```curl -O -J https://io.example.com/TOKEN```
##
> **TIP**: Puedes ver el numero de tokens en uso
```curl https://io.example.com/status/```
##
## elCamilet
Este software está hecho **"as is"**, tal cual, sin garantías ni tonterías. Puedes usarlo, copiarlo, o lo que quieras, pero no me reproches nada...

Si quieres contactar conmigo, me encontrarás en https://elcamilet.com