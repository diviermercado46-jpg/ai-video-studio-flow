AI VIDEO EDITOR V4.1 — RENDER
=================================

Esta versión está preparada para ejecutarse como una aplicación web HTTPS en Render.
NO abras public/index.html directamente desde el teléfono.

FUNCIONES:
- Audio + imágenes.
- Transcripción del audio en el servidor con OPENAI_API_KEY.
- Organización de imágenes basada en la narración.
- Ajuste de duración de escenas.
- Exportación MP4 con FFmpeg en el servidor.
- 16:9, 9:16 y 1:1.

DESPLIEGUE RÁPIDO:
1. Crea un repositorio nuevo en GitHub y sube TODOS los archivos de este ZIP.
2. En Render: New + Web Service.
3. Conecta ese repositorio.
4. Runtime: Docker.
5. Render usará Dockerfile y arrancará `node server.js`.
6. Añade OPENAI_API_KEY en Environment.
7. Espera a que el servicio termine el deploy.
8. Abre la URL HTTPS de Render desde el celular.

COMPROBACIÓN:
Abre:
https://TU-DOMINIO.onrender.com/api/health

Debe mostrar algo parecido a:
{"ok":true,"ffmpeg":true,"semanticMode":true}

Si semanticMode aparece false, falta OPENAI_API_KEY.

IMPORTANTE:
No pongas la OPENAI_API_KEY dentro de index.html ni la compartas públicamente.
