const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const multer = require('multer');

const {
  ensureFfmpegAvailable,
  probeVideo,
  buildLessonPaths,
  processLessonVideoQuickStart,
} = require('./src/video-processing');

const app = express();
const PORT = Number(process.env.PORT || 25565);
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(__dirname, 'media');
const TEMP_UPLOAD_ROOT = process.env.TEMP_UPLOAD_ROOT || path.join(__dirname, 'tmp', 'uploads');
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 2048);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const ORIGIN_WHITELIST = new Set(
  (process.env.CORS_ORIGINS || 'https://gonvar.io,https://www.gonvar.io,https://stage.gonvar.io')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

fs.mkdirSync(TEMP_UPLOAD_ROOT, { recursive: true });
fs.mkdirSync(MEDIA_ROOT, { recursive: true });

function buildAbsoluteUrl(req, relativePath) {
  const normalizedPath = String(relativePath || '').startsWith('/')
    ? String(relativePath || '')
    : `/${String(relativePath || '')}`;

  const isLocalBaseUrl =
    /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(PUBLIC_BASE_URL);
  const requestHost = String(req.headers['x-forwarded-host'] || req.get('host') || '');
  const isLocalRequestHost = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(requestHost);

  if (PUBLIC_BASE_URL && (!isLocalBaseUrl || isLocalRequestHost)) {
    return `${PUBLIC_BASE_URL}${normalizedPath}`;
  }

  const forwardedProto = req.headers['x-forwarded-proto'];
  const proto = typeof forwardedProto === 'string'
    ? forwardedProto.split(',')[0].trim()
    : req.protocol;
  const host = req.headers['x-forwarded-host'] || req.get('host');

  return `${proto}://${host}${normalizedPath}`;
}

const upload = multer({
  dest: TEMP_UPLOAD_ROOT,
  limits: {
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  },
});

app.use(compression());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowedOrigin = origin && ORIGIN_WHITELIST.has(origin);
  const isMediaRequest = req.url.endsWith('.m3u8') || req.url.endsWith('.ts');
  const isApiRequest = req.path.startsWith('/api/');

  if (isMediaRequest) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Origin, Accept, Content-Type, Authorization');
    res.setHeader('Vary', 'Origin');
  } else if (isAllowedOrigin && isApiRequest) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Range, Origin, Accept, Content-Type, Authorization'
    );
  }

  if (req.method === 'OPTIONS') {
    return res.sendStatus(204);
  }

  return next();
});

app.use(
  '/media',
  express.static(MEDIA_ROOT, {
    dotfiles: 'allow',
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.m3u8')) {
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
    fallthrough: true,
  })
);

app.get('/media/*', (req, res, next) => {
  if (!req.path.endsWith('.ts')) {
    return next();
  }

  const rel = req.path.replace(/^\/media\//, '');
  const filePath = path.join(MEDIA_ROOT, rel);

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      return res.sendStatus(404);
    }

    const fileSize = stats.size;
    const range = req.headers.range;

    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Accept-Ranges', 'bytes');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');

    if (!range) {
      return fs.createReadStream(filePath).pipe(res);
    }

    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr
      ? parseInt(endStr, 10)
      : Math.min(start + 1024 * 1024 - 1, fileSize - 1);

    if (Number.isNaN(start) || Number.isNaN(end) || start > end) {
      return res.sendStatus(416);
    }

    res.status(206).set({
      'Content-Range': `bytes ${start}-${end}/${fileSize}`,
      'Content-Length': end - start + 1,
    });

    return fs.createReadStream(filePath, { start, end }).pipe(res);
  });
});

app.get('/', (_req, res) => {
  res.send('GonvarVideo HLS server OK');
});

app.get('/health', async (_req, res) => {
  try {
    await ensureFfmpegAvailable();
    res.json({ ok: true, mediaRoot: MEDIA_ROOT });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message });
  }
});

app.post('/api/lessons/upload', upload.single('video'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ ok: false, error: 'Debes enviar un archivo en el campo video.' });
  }

  const cleanupTempFile = () => {
    fs.promises.unlink(req.file.path).catch(() => {});
  };

  try {
    await ensureFfmpegAvailable();

    const lessonInput = {
      courseTitle: req.body.courseTitle,
      seasonNumber: req.body.seasonNumber,
      lessonNumber: req.body.lessonNumber,
      lessonTitle: req.body.lessonTitle,
      lessonId: req.body.lessonId,
    };

    const lessonPaths = buildLessonPaths(MEDIA_ROOT, lessonInput);

    const sourceProbe = await probeVideo(req.file.path);
    const pendingVariants = [420, 740, 2160].filter((height) => height < sourceProbe.height).length;
    const predictedMasterPlaylist = `${'/media'}/${path.relative(
      MEDIA_ROOT,
      path.join(lessonPaths.sourceDir, 'master.m3u8'),
    ).split(path.sep).join('/')}`;

    const backgroundTask = processLessonVideoQuickStart({
      inputFilePath: req.file.path,
      mediaRoot: MEDIA_ROOT,
      sourceProbe,
      lessonPaths,
      publicMediaBase: '/media',
    });

    const predictedResult = {
      courseTitle: lessonPaths.courseTitle,
      courseSlug: lessonPaths.courseSlug,
      seasonNumber: lessonPaths.seasonNumber,
      lessonNumber: lessonPaths.lessonNumber,
      lessonKey: lessonPaths.lessonKey,
      sourceDir: lessonPaths.sourceDir,
      sourcePlaylist: `${'/media'}/${path.relative(
        MEDIA_ROOT,
        path.join(lessonPaths.sourceDir, 'media.m3u8'),
      ).split(path.sep).join('/')}`,
      masterPlaylist: predictedMasterPlaylist,
      masterPlaylistUrl: buildAbsoluteUrl(req, predictedMasterPlaylist),
      sourcePlaylistUrl: buildAbsoluteUrl(req, `${'/media'}/${path.relative(
        MEDIA_ROOT,
        path.join(lessonPaths.sourceDir, 'media.m3u8'),
      ).split(path.sep).join('/')}`),
      variants: [],
      versionKey: lessonPaths.versionKey || null,
    };

    backgroundTask
      .catch((error) => {
        console.error('[GonvarVideo] Background processing task failed', {
          courseTitle: lessonInput.courseTitle,
          lessonTitle: lessonInput.lessonTitle || null,
          lessonId: lessonInput.lessonId || null,
          existingLink: lessonInput.existingLink || null,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
      })
      .finally(() => {
        cleanupTempFile();
      });

    return res.status(201).json({
      ok: true,
      lesson: {
        lessonId: lessonInput.lessonId || null,
        lessonTitle: lessonInput.lessonTitle || null,
        courseTitle: lessonPaths.courseTitle,
        seasonNumber: lessonPaths.seasonNumber,
        lessonNumber: lessonPaths.lessonNumber,
        lessonKey: lessonPaths.lessonKey,
      },
      source: sourceProbe,
      processing: {
        startedInBackground: pendingVariants > 0,
        pendingVariants,
        readyToUse: true,
        message: pendingVariants > 0
          ? 'La primera resolucion ya esta disponible. El resto se seguira generando en segundo plano.'
          : 'El video ya quedo disponible.',
      },
      hls: {
        ...predictedResult,
      },
    });
  } catch (error) {
    await cleanupTempFile();
    return res.status(500).json({
      ok: false,
      error: error.message,
    });
  }
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ ok: false, error: error.message });
  }

  return res.status(500).json({ ok: false, error: error.message || 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`GonvarVideo on http://localhost:${PORT}`);
  console.log(`Serving /media from ${MEDIA_ROOT}`);
  console.log(`Temporary uploads in ${TEMP_UPLOAD_ROOT}`);
});
