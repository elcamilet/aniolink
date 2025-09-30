# An I/O Link - Frontend

Una aplicación React con Tailwind CSS para transferencias P2P sin almacenamiento en servidor.

## Características

- **Interfaz minimalista y moderna** con tema oscuro y detalles en verde mar
- **Drag & Drop** para subir archivos fácilmente
- **Generación automática de tokens** para compartir archivos
- **Descarga directa** mediante tokens o URLs
- **Transferencia P2P** sin almacenamiento en servidor
- **Interfaz completamente en español**

## Instalación

1. Instalar dependencias:
```bash
npm install
```

2. Ejecutar en modo desarrollo:
```bash
npm run dev
```

3. Construir para producción:
```bash
npm run build
```

## Configuración

Asegúrate de que el backend esté ejecutándose en `http://localhost:3000` o modifica la variable `API_BASE_URL` en `src/App.jsx`.

## Uso

1. **Enviar archivo**: Arrastra un archivo al área designada o haz clic para seleccionar
2. **Generar token**: Haz clic en "Generar Token y Subir" para crear un enlace de descarga
3. **Compartir**: Copia la URL generada y compártela
4. **Recibir archivo**: Pega el token o URL en el campo de descarga

## Tecnologías

- React 18
- Tailwind CSS
- Vite
- Axios

## Estructura del proyecto

```
frontend/
├── src/
│   ├── App.jsx          # Componente principal
│   ├── main.jsx         # Punto de entrada
│   └── index.css        # Estilos globales
├── index.html           # Template HTML
├── package.json         # Dependencias
├── tailwind.config.js   # Configuración de Tailwind
├── postcss.config.js    # Configuración de PostCSS
└── vite.config.js       # Configuración de Vite