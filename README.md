# GonvarVideo

Servidor Node.js con Express para recibir videos desde `Gonvar-Nails-Academy`, convertirlos a HLS y servir playlists (`.m3u8`) y segmentos (`.ts`).

## Flujo pensado

1. Una persona creadora arma un `Course -> Season -> Lesson` en el front.
2. El front sube el video original a `GonvarVideo` junto con `courseTitle`, `seasonNumber` y `lessonNumber`.
3. El servidor detecta la resolucion del archivo, genera variantes HLS y responde con los hipervinculos que luego puedes guardar en la tabla `lessons`.

## Estructura de salida

Ejemplo para la leccion 1 de la temporada 2:

```text
media/gonvar/courses/<course-slug>/2_01/media.m3u8
media/gonvar/courses/<course-slug>/2_01/main.m3u8
media/gonvar/courses/<course-slug>/740/2_01/media.m3u8
media/gonvar/courses/<course-slug>/420/2_01/media.m3u8
```

Si el video original llega en 4K, la variante base queda en `media/gonvar/courses/<course-slug>/2_01/`.
Si llega en menor resolucion, la carpeta base guarda la resolucion fuente y las derivadas bajan desde ahi sin upscaling.

## Resoluciones

- Objetivo preferido: `420`, `740` y `4k`
- Si el video subido no alcanza 4K, el servidor genera `420`, `740` y la resolucion fuente cuando aplica
- Nunca hace upscale por defecto

## Requisitos

- Node.js 18+
- npm
- `ffmpeg`
- `ffprobe`

## Variables de entorno

Puedes copiar `.env.example` como referencia.

- `PORT`: puerto del servidor
- `PUBLIC_BASE_URL`: dominio base para devolver hipervinculos absolutos en la respuesta
- `MEDIA_ROOT`: carpeta final para playlists y segmentos
- `TEMP_UPLOAD_ROOT`: carpeta temporal para subidas
- `CORS_ORIGINS`: origenes permitidos separados por comas
- `MAX_UPLOAD_SIZE_MB`: limite maximo del archivo subido
- `HLS_TIME`: duracion de segmentos HLS
- `HLS_CRF`: calidad visual de salida
- `HLS_PRESET`: preset de `ffmpeg`
- `AUDIO_BITRATE`: bitrate de audio
- `SOURCE_TARGET_HEIGHT`: altura considerada como variante principal alta, por defecto `2160`

## Instalacion

```bash
npm install
```

## Desarrollo

```bash
npm run dev
```

## Produccion

```bash
npm start
```

Si el servicio esta detras de Nginx, el proxy tambien debe permitir cuerpos grandes o la subida fallara con `413 Request Entity Too Large` antes de llegar a Express. Usa `deploy/nginx-gonvarvideo.conf` como referencia; lo importante es tener en el `server` o `location` de `video.gonvar.io`:

```nginx
client_max_body_size 10240m;
proxy_request_buffering off;
```

Despues de cambiar Nginx, valida y recarga:

```bash
nginx -t && systemctl reload nginx
```

## Endpoints

- `GET /`: health check simple
- `GET /health`: verifica que `ffmpeg` y `ffprobe` esten disponibles
- `GET /media/*`: expone playlists `.m3u8` y segmentos `.ts`
- `POST /api/lessons/upload`: recibe y procesa un video de una leccion

## Upload de una leccion

El endpoint espera `multipart/form-data` con estos campos:

- `video`: archivo original (`.mp4`, `.mov`, etc.)
- `courseTitle`: titulo del curso
- `seasonNumber`: numero de temporada
- `lessonNumber`: numero de leccion dentro de la temporada
- `lessonTitle`: opcional
- `lessonId`: opcional, por si quieres enlazar con tu base de datos

Ejemplo con `curl`:

```bash
curl -X POST http://localhost:25565/api/lessons/upload \
  -F "courseTitle=Curso de prueba" \
  -F "seasonNumber=2" \
  -F "lessonNumber=1" \
  -F "lessonTitle=Introduccion" \
  -F "video=@/ruta/local/video.mp4"
```

La respuesta incluye `masterPlaylist`, `sourcePlaylist` y tambien `masterPlaylistUrl`, `sourcePlaylistUrl` y `publicUrl` por variante para que el backend o frontend pueda guardar el hyperlink final en `lessons`.

Ejemplo esperado:

```text
https://video.gonvar.io/media/gonvar/courses/<course-name>/<seasonNumber>_<lessonNumber>/main.m3u8
```

El `lessonNumber` se rellena con cero a la izquierda cuando es menor a 10, por ejemplo `2_01`, `2_02`, ..., `2_10`.

Si una leccion ya tenia hyperlink y se vuelve a subir un video, el sistema conserva el video anterior y genera una nueva version dentro de la carpeta de esa leccion, por ejemplo:

```text
https://video.gonvar.io/media/gonvar/courses/<course-name>/<seasonNumber>_<lessonNumber>/v20260329153045/main.m3u8
```

Luego el frontend solo actualiza el hyperlink de la leccion al nuevo `masterPlaylistUrl`.

## Nota de integracion

Este proyecto ya deja listo el procesamiento del video, pero todavia no escribe nada en las tablas de cursos. La idea recomendada es:

1. crear `course/season/lesson` desde `Gonvar-Nails-Academy` o su backend,
2. subir el archivo a `GonvarVideo`,
3. guardar el `masterPlaylist` devuelto en el registro de `lessons`.

## Deploy automatico

Hay un workflow en `GonvarVideo/.github/workflows/deploy.yml` que se ejecuta en cada push a `main` y despliega al servidor `15.235.66.220` en `/home/express-processing`.

Antes de activarlo en GitHub, crea estos secrets en el repositorio:

- `DEPLOY_PASSWORD`: password SSH del usuario `root`

El workflow:

- sincroniza el proyecto por `rsync`
- no pisa `.env`, `media`, `tmp` ni `node_modules`
- elimina el `node_modules` remoto anterior
- ejecuta `npm ci --omit=dev` si hay `package-lock.json`
- reinicia el proceso PM2 `gonvarvideo` y si no existe lo crea con `pm2 start server.js --name gonvarvideo`
