const express = require('express');
const path = require('path');
const fs = require('fs');
const compression = require('compression');
const multer = require('multer');

const {
  ensureFfmpegAvailable,
  probeVideo,
  buildLessonPaths,
  tryBuildLessonPathsFromExistingLink,
  processLessonVideoQuickStart,
  getDirectorySizeBytes,
} = require('./src/video-processing');

const app = express();
const PORT = Number(process.env.PORT || 25565);
const MEDIA_ROOT = process.env.MEDIA_ROOT || path.join(__dirname, 'media');
const TEMP_UPLOAD_ROOT = process.env.TEMP_UPLOAD_ROOT || path.join(__dirname, 'tmp', 'uploads');
const MAX_UPLOAD_SIZE_MB = Number(process.env.MAX_UPLOAD_SIZE_MB || 102400);
const PUBLIC_BASE_URL = String(process.env.PUBLIC_BASE_URL || '').replace(/\/$/, '');
const GONVAR_API_BASE_URL = String(process.env.GONVAR_API_BASE_URL || process.env.API_BASE_URL || '').replace(/\/$/, '');
const CREATOR_STORAGE_WEBHOOK_SECRET = process.env.CREATOR_STORAGE_WEBHOOK_SECRET || '';
const MASTER_PLAYLIST_FILENAME = 'main.m3u8';
const LEGACY_MASTER_PLAYLIST_FILENAME = 'master.m3u8';
const DEFAULT_CORS_ORIGINS = [
  'https://gonvar.io',
  'https://www.gonvar.io',
  'https://stage.gonvar.io',
];

const ORIGIN_WHITELIST = new Set(
  (process.env.CORS_ORIGINS || DEFAULT_CORS_ORIGINS.join(','))
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
);

function isAllowedGonvarOrigin(origin) {
  if (!origin) {
    return false;
  }

  if (ORIGIN_WHITELIST.has(origin)) {
    return true;
  }

  return /^https:\/\/(?:[a-z0-9-]+\.)*gonvar\.io$/i.test(origin);
}

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
  const isPublicHost = /(^|\.)gonvar\.io$/i.test(String(host || '').split(':')[0]);

  return `${isPublicHost ? 'https' : proto}://${host}${normalizedPath}`;
}

const upload = multer({
  dest: TEMP_UPLOAD_ROOT,
  limits: {
    fileSize: MAX_UPLOAD_SIZE_MB * 1024 * 1024,
  },
});

const formatUploadLimit = () => `${MAX_UPLOAD_SIZE_MB}MB`;

async function postCreatorStorage(pathname, payload) {
  if (!GONVAR_API_BASE_URL || !CREATOR_STORAGE_WEBHOOK_SECRET || typeof fetch !== 'function') {
    return null;
  }

  const response = await fetch(`${GONVAR_API_BASE_URL}${pathname}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-gonvar-storage-secret': CREATOR_STORAGE_WEBHOOK_SECRET,
    },
    body: JSON.stringify(payload),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = data?.message || data?.error || `Storage API error ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.data = data;
    throw error;
  }
  return data;
}

app.use(compression());
app.use(express.json({ limit: '10mb' }));

app.use((req, res, next) => {
  const origin = req.headers.origin;
  const isAllowedOrigin = isAllowedGonvarOrigin(origin);
  const isMediaRequest = req.url.endsWith('.m3u8') || req.url.endsWith('.ts');
  const isApiRequest = req.path.startsWith('/api/');

  if (isAllowedOrigin && (isApiRequest || isMediaRequest)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, POST, OPTIONS');
    res.setHeader(
      'Access-Control-Allow-Headers',
      'Range, Origin, Accept, Content-Type, Authorization'
    );

    if (isMediaRequest) {
      res.setHeader('Access-Control-Expose-Headers', 'Accept-Ranges, Content-Length, Content-Range');
    }
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
  if (!req.path.endsWith('.m3u8')) {
    return next();
  }

  const rel = req.path.replace(/^\/media\//, '');
  const requestedFile = path.basename(rel);

  if (![MASTER_PLAYLIST_FILENAME, LEGACY_MASTER_PLAYLIST_FILENAME].includes(requestedFile)) {
    return next();
  }

  const fallbackFile = requestedFile === MASTER_PLAYLIST_FILENAME
    ? LEGACY_MASTER_PLAYLIST_FILENAME
    : MASTER_PLAYLIST_FILENAME;
  const fallbackPath = path.join(MEDIA_ROOT, path.dirname(rel), fallbackFile);

  fs.stat(fallbackPath, (err, stats) => {
    if (err || !stats.isFile()) {
      return next();
    }

    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    return res.sendFile(fallbackPath);
  });
});

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
      organizationSlug: req.body.organizationSlug,
      organizationId: req.body.organizationId,
      creatorId: req.body.creatorId,
      userId: req.body.userId,
      contentType: req.body.contentType,
      contentSlug: req.body.contentSlug,
      courseTitle: req.body.courseTitle,
      seasonNumber: req.body.seasonNumber,
      lessonNumber: req.body.lessonNumber,
      lessonTitle: req.body.lessonTitle,
      lessonId: req.body.lessonId,
      existingLink: req.body.existingLink,
    };

    const lessonPaths = req.body.existingLink
      ? tryBuildLessonPathsFromExistingLink(MEDIA_ROOT, req.body.existingLink, lessonInput.courseTitle) || buildLessonPaths(MEDIA_ROOT, lessonInput)
      : buildLessonPaths(MEDIA_ROOT, lessonInput);

    const sourceProbe = await probeVideo(req.file.path);
    const storagePayloadBase = {
      lessonId: lessonInput.lessonId || null,
      courseId: req.body.courseId || null,
      organizationId: lessonInput.organizationId || null,
      creatorId: lessonInput.creatorId || null,
      userId: lessonInput.userId || null,
      organizationSlug: lessonPaths.organizationSlug,
      contentType: lessonPaths.contentType,
      contentSlug: lessonPaths.contentSlug,
      sourceBytes: req.file.size || 0,
      durationSeconds: sourceProbe.duration || null,
      width: sourceProbe.width,
      height: sourceProbe.height,
    };

    const storageCheck = await postCreatorStorage('/creator-billing/storage/check', {
      ...storagePayloadBase,
      incomingBytes: (req.file.size || 0) * Number(process.env.STORAGE_UPLOAD_ESTIMATE_MULTIPLIER || 3),
    }).catch((error) => {
      if (error.status === 402 || error.status === 400 || error.status === 403) throw error;
      console.warn('[GonvarVideo] Storage precheck skipped', error.message);
      return null;
    });
    if (storageCheck && storageCheck.allowed === false) {
      cleanupTempFile();
      return res.status(402).json({ ok: false, error: storageCheck.message, changePlanUrl: storageCheck.changePlanUrl, storage: storageCheck.storage });
    }

    const isVertical = sourceProbe.height > sourceProbe.width;
    const pendingVariants = [420, 740, 2160].filter((height) => height < sourceProbe.height).length;
    const predictedMasterPlaylist = `${'/media'}/${path.relative(
      MEDIA_ROOT,
      path.join(lessonPaths.sourceDir, MASTER_PLAYLIST_FILENAME),
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
      .then(async (processingResult) => {
        const variants = await processingResult.backgroundTask.catch(() => processingResult.initialResult.variants || []);
        const variantDirectories = Array.from(new Set([
          lessonPaths.sourceDir,
          ...variants.map((variant) => variant.directory).filter(Boolean),
        ]));
        let processedBytes = 0;
        for (const directory of variantDirectories) {
          processedBytes += await getDirectorySizeBytes(directory);
        }
        const storagePath = path.relative(MEDIA_ROOT, lessonPaths.sourceDir).split(path.sep).join('/');
        await postCreatorStorage('/creator-billing/storage/report', {
          ...storagePayloadBase,
          storagePath,
          masterPlaylist: predictedMasterPlaylist,
          processedBytes,
          totalBytes: processedBytes,
          variants: variants.map((variant) => ({ label: variant.label, width: variant.width, height: variant.height, publicPath: variant.publicPath })),
          status: 'ready',
        }).catch((error) => {
          console.error('[GonvarVideo] Storage report failed', error.message);
        });
      })
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
        organizationSlug: lessonPaths.organizationSlug,
        contentType: lessonPaths.contentType,
        contentSlug: lessonPaths.contentSlug,
        courseTitle: lessonPaths.courseTitle,
        seasonNumber: lessonPaths.seasonNumber,
        lessonNumber: lessonPaths.lessonNumber,
        lessonKey: lessonPaths.lessonKey,
      },
      source: {
        ...sourceProbe,
        aspectRatio: sourceProbe.width / sourceProbe.height,
        orientation: isVertical ? 'vertical' : 'horizontal',
        isVertical,
      },
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
        organizationSlug: lessonPaths.organizationSlug,
        contentType: lessonPaths.contentType,
        contentSlug: lessonPaths.contentSlug,
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
    if (error.code === 'LIMIT_FILE_SIZE') {
      return res.status(413).json({
        ok: false,
        error: `El archivo excede el limite permitido de ${formatUploadLimit()}.`,
      });
    }

    return res.status(400).json({ ok: false, error: error.message });
  }

  return res.status(500).json({ ok: false, error: error.message || 'Unexpected server error.' });
});

app.listen(PORT, () => {
  console.log(`GonvarVideo on http://localhost:${PORT}`);
  console.log(`Serving /media from ${MEDIA_ROOT}`);
  console.log(`Temporary uploads in ${TEMP_UPLOAD_ROOT}`);
});
