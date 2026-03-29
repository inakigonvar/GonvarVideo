const path = require('path');
const fs = require('fs/promises');
const { spawn } = require('child_process');

const HLS_TIME = Number(process.env.HLS_TIME || 10);
const HLS_CRF = Number(process.env.HLS_CRF || 23);
const HLS_PRESET = process.env.HLS_PRESET || 'medium';
const AUDIO_BITRATE = process.env.AUDIO_BITRATE || '128k';
const SOURCE_LABEL = process.env.SOURCE_LABEL || 'source';
const SOURCE_TARGET_HEIGHT = Number(process.env.SOURCE_TARGET_HEIGHT || 2160);
const BASE_TARGET_HEIGHTS = [420, 740, SOURCE_TARGET_HEIGHT];

function runCommand(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
    });

    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(new Error(stderr.trim() || `${command} exited with code ${code}`));
    });
  });
}

async function ensureFfmpegAvailable() {
  await runCommand('ffmpeg', ['-version']);
  await runCommand('ffprobe', ['-version']);
}

function slugify(value) {
  return String(value || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
}

function formatLessonKey(seasonNumber, lessonNumber) {
  const season = Number(seasonNumber);
  const lesson = Number(lessonNumber);

  if (!Number.isInteger(season) || season < 1) {
    throw new Error('seasonNumber debe ser un entero positivo.');
  }

  if (!Number.isInteger(lesson) || lesson < 1) {
    throw new Error('lessonNumber debe ser un entero positivo.');
  }

  return `${season}_${String(lesson).padStart(2, '0')}`;
}

function buildLessonPaths(mediaRoot, lessonInput) {
  if (!lessonInput.courseTitle) {
    throw new Error('courseTitle es obligatorio.');
  }

  const courseSlug = slugify(lessonInput.courseTitle);

  if (!courseSlug) {
    throw new Error('courseTitle no es valido.');
  }

  const lessonKey = formatLessonKey(lessonInput.seasonNumber, lessonInput.lessonNumber);
  const courseDir = path.join(mediaRoot, courseSlug);
  const sourceDir = path.join(courseDir, lessonKey);

  return {
    courseSlug,
    courseTitle: lessonInput.courseTitle,
    seasonNumber: Number(lessonInput.seasonNumber),
    lessonNumber: Number(lessonInput.lessonNumber),
    lessonKey,
    courseDir,
    sourceDir,
    versionKey: null,
  };
}

function parseLessonKey(lessonKey) {
  const match = String(lessonKey || '').match(/^(\d+)_(\d{2})$/);

  if (!match) {
    throw new Error('lessonKey no es valido.');
  }

  return {
    seasonNumber: Number(match[1]),
    lessonNumber: Number(match[2]),
  };
}

function tryBuildLessonPathsFromExistingLink(mediaRoot, existingLink, fallbackCourseTitle) {
  const normalizedLink = String(existingLink || '').trim();
  const match = normalizedLink.match(/(?:https?:\/\/[^/]+)?\/media\/([^/]+)\/(\d+_\d{2})(?:\/([^/]+))?\/master\.m3u8(?:\?.*)?$/i);

  if (!match) {
    return null;
  }

  const courseSlug = match[1];
  const lessonKey = match[2];
  const versionKey = match[3] || null;
  const { seasonNumber, lessonNumber } = parseLessonKey(lessonKey);
  const courseDir = path.join(mediaRoot, courseSlug);
  const sourceDir = versionKey
    ? path.join(courseDir, lessonKey, versionKey)
    : path.join(courseDir, lessonKey);

  return {
    courseSlug,
    courseTitle: fallbackCourseTitle || courseSlug,
    seasonNumber,
    lessonNumber,
    lessonKey,
    courseDir,
    sourceDir,
    versionKey,
  };
}

function createVersionKey() {
  const now = new Date();
  const pad = (value) => String(value).padStart(2, '0');

  return `v${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
}

function buildVersionedLessonPaths(existingLessonPaths) {
  const versionKey = createVersionKey();

  return {
    ...existingLessonPaths,
    sourceDir: path.join(existingLessonPaths.courseDir, existingLessonPaths.lessonKey, versionKey),
    versionKey,
  };
}

async function probeVideo(inputFilePath) {
  const args = [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height',
    '-show_entries',
    'format=duration',
    '-of',
    'json',
    inputFilePath,
  ];
  const { stdout } = await runCommand('ffprobe', args);
  const parsed = JSON.parse(stdout);
  const stream = parsed.streams && parsed.streams[0];

  if (!stream || !stream.width || !stream.height) {
    throw new Error('No se pudo detectar la resolucion del video subido.');
  }

  return {
    width: Number(stream.width),
    height: Number(stream.height),
    duration: parsed.format && parsed.format.duration ? Number(parsed.format.duration) : null,
  };
}

function pickTargetHeights(sourceHeight) {
  const validHeights = BASE_TARGET_HEIGHTS.filter((height) => height < sourceHeight);
  const heights = [...validHeights, sourceHeight];
  return Array.from(new Set(heights)).sort((a, b) => a - b);
}

function getVariantLabel(targetHeight, sourceHeight) {
  if (targetHeight === sourceHeight) {
    return sourceHeight >= SOURCE_TARGET_HEIGHT ? '4k' : `${targetHeight}`;
  }

  return `${targetHeight}`;
}

function getBitrateForHeight(height) {
  if (height >= 2160) {
    return '12000k';
  }

  if (height >= 1440) {
    return '8000k';
  }

  if (height >= 1080) {
    return '6000k';
  }

  if (height >= 740) {
    return '3200k';
  }

  if (height >= 720) {
    return '2800k';
  }

  return '1200k';
}

function getScaledWidth(sourceWidth, sourceHeight, targetHeight) {
  const rawWidth = Math.round((sourceWidth / sourceHeight) * targetHeight);
  return rawWidth % 2 === 0 ? rawWidth : rawWidth + 1;
}

async function generateHlsVariant({ inputFilePath, outputDir, targetHeight, sourceHeight }) {
  await fs.mkdir(outputDir, { recursive: true });

  const playlistPath = path.join(outputDir, 'media.m3u8');
  const segmentPattern = path.join(outputDir, 'segment_%05d.ts');
  const shouldScale = targetHeight !== sourceHeight;
  const args = [
    '-y',
    '-i',
    inputFilePath,
    '-map',
    '0:v:0',
    '-map',
    '0:a?',
    '-c:v',
    'libx264',
    '-preset',
    HLS_PRESET,
    '-crf',
    String(HLS_CRF),
    '-pix_fmt',
    'yuv420p',
    '-c:a',
    'aac',
    '-b:a',
    AUDIO_BITRATE,
    '-b:v',
    getBitrateForHeight(targetHeight),
  ];

  if (shouldScale) {
    args.push('-vf', `scale=-2:${targetHeight}`);
  }

  args.push(
    '-start_number',
    '0',
    '-hls_time',
    String(HLS_TIME),
    '-hls_list_size',
    '0',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    segmentPattern,
    playlistPath
  );

  await runCommand('ffmpeg', args);

  return playlistPath;
}

async function writeMasterPlaylist({ sourceDir, lessonKey, variants }) {
  const lines = ['#EXTM3U', '#EXT-X-VERSION:3'];

  const sortedVariants = [...variants].sort((a, b) => a.height - b.height);

  for (const variant of sortedVariants) {
    const bandwidth = variant.bandwidth;
    const relativePath = path.relative(sourceDir, variant.playlistPath).split(path.sep).join('/');
    lines.push(
      `#EXT-X-STREAM-INF:BANDWIDTH=${bandwidth},RESOLUTION=${variant.width}x${variant.height}`,
      relativePath
    );
  }

  const masterPath = path.join(sourceDir, 'master.m3u8');
  await fs.writeFile(masterPath, `${lines.join('\n')}\n`, 'utf8');
  return masterPath;
}

async function processLessonVideo({ inputFilePath, mediaRoot, sourceProbe, lessonPaths, publicMediaBase }) {
  const targetHeights = pickTargetHeights(sourceProbe.height);
  const variants = [];

  await fs.mkdir(lessonPaths.courseDir, { recursive: true });

  for (const targetHeight of targetHeights) {
    const label = getVariantLabel(targetHeight, sourceProbe.height);
    const isSourceVariant = targetHeight === sourceProbe.height;
    const outputDir = isSourceVariant
      ? lessonPaths.sourceDir
      : lessonPaths.versionKey
        ? path.join(lessonPaths.courseDir, label, lessonPaths.lessonKey, lessonPaths.versionKey)
        : path.join(lessonPaths.courseDir, label, lessonPaths.lessonKey);

    await generateHlsVariant({
      inputFilePath,
      outputDir,
      targetHeight,
      sourceHeight: sourceProbe.height,
    });

    variants.push({
      label: isSourceVariant && label !== '4k' ? SOURCE_LABEL : label,
      width: getScaledWidth(sourceProbe.width, sourceProbe.height, targetHeight),
      height: targetHeight,
      bandwidth: parseInt(getBitrateForHeight(targetHeight), 10) * 1000,
      playlistPath: path.join(outputDir, 'media.m3u8'),
      publicPath: `${publicMediaBase}/${path.relative(mediaRoot, path.join(outputDir, 'media.m3u8')).split(path.sep).join('/')}`,
      directory: outputDir,
      isSourceVariant,
    });
  }

  const masterPlaylistPath = await writeMasterPlaylist({
    sourceDir: lessonPaths.sourceDir,
    lessonKey: lessonPaths.lessonKey,
    variants,
  });

  return {
    courseTitle: lessonPaths.courseTitle,
    courseSlug: lessonPaths.courseSlug,
    seasonNumber: lessonPaths.seasonNumber,
    lessonNumber: lessonPaths.lessonNumber,
    lessonKey: lessonPaths.lessonKey,
    sourceDir: lessonPaths.sourceDir,
    sourcePlaylist: `${publicMediaBase}/${path.relative(mediaRoot, path.join(lessonPaths.sourceDir, 'media.m3u8')).split(path.sep).join('/')}`,
    masterPlaylist: `${publicMediaBase}/${path.relative(mediaRoot, masterPlaylistPath).split(path.sep).join('/')}`,
    variants,
  };
}

module.exports = {
  ensureFfmpegAvailable,
  probeVideo,
  buildLessonPaths,
  tryBuildLessonPathsFromExistingLink,
  buildVersionedLessonPaths,
  processLessonVideo,
};
