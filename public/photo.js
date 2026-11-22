// Photo helpers: read EXIF timestamp + GPS, then re-encode the image so the uploaded
// file carries no metadata (no GPS, camera serial, etc.) and is a sensible size.
import exifr from 'https://cdn.jsdelivr.net/npm/exifr@7.1.3/dist/full.esm.mjs';
import { inNepal } from './towns.js';

/**
 * @returns {Promise<{takenAt: Date|null, lat: number|null, lng: number|null, gpsOutsideNepal: boolean}>}
 */
export async function readPhotoMeta(file) {
  const out = { takenAt: null, lat: null, lng: null, gpsOutsideNepal: false };
  try {
    const meta = await exifr.parse(file, {
      tiff: true, exif: true, gps: true,
      pick: ['DateTimeOriginal', 'CreateDate', 'OffsetTimeOriginal', 'GPSLatitude', 'GPSLongitude',
             'GPSLatitudeRef', 'GPSLongitudeRef', 'latitude', 'longitude'],
    });
    if (meta) {
      const t = meta.DateTimeOriginal || meta.CreateDate;
      if (t instanceof Date && !isNaN(t)) {
        // Ignore obviously bogus camera clocks.
        const now = Date.now();
        if (t.getTime() > Date.UTC(2015, 0, 1) && t.getTime() < now + 24 * 3600 * 1000) out.takenAt = t;
      }
      // Android writes 0,0 when it redacts location ("Null Island") — treat that as no location.
      const redacted = Math.abs(meta.latitude) < 0.001 && Math.abs(meta.longitude) < 0.001;
      if (typeof meta.latitude === 'number' && typeof meta.longitude === 'number' && !redacted) {
        if (inNepal(meta.latitude, meta.longitude)) {
          out.lat = meta.latitude;
          out.lng = meta.longitude;
        } else {
          out.gpsOutsideNepal = true;
        }
      }
    }
  } catch (err) {
    console.warn('EXIF read failed', err);
  }
  return out;
}

// ---- HEIC/HEIF support (iPhone photos) ----
// Safari decodes HEIC natively; other browsers don't, so we convert with heic2any (libheif in
// WebAssembly), loaded only the first time a HEIC photo shows up.
const HEIC_LIB = 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js';
let heicLibPromise;
function loadHeicLib() {
  if (!heicLibPromise) {
    heicLibPromise = new Promise((resolve, reject) => {
      const s = document.createElement('script');
      s.src = HEIC_LIB;
      s.async = true;
      s.onload = () => (window.heic2any ? resolve(window.heic2any) : reject(new Error('HEIC converter failed to load')));
      s.onerror = () => { heicLibPromise = null; reject(new Error('Could not load the HEIC converter — check your connection.')); };
      document.head.appendChild(s);
    });
  }
  return heicLibPromise;
}

async function looksLikeHeic(file) {
  if (/image\/hei[cf]/i.test(file.type) || /\.hei[cf]$/i.test(file.name || '')) return true;
  // Some browsers give HEIC files an empty type: check the ISO-BMFF "ftyp" brand.
  try {
    const head = new Uint8Array(await file.slice(0, 16).arrayBuffer());
    const brand = String.fromCharCode(...head.slice(4, 12));
    return /^ftyp(heic|heix|hevc|heim|heis|mif1|msf1)/.test(brand);
  } catch {
    return false;
  }
}

function canDecode(blob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(true); };
    img.onerror = () => { URL.revokeObjectURL(url); resolve(false); };
    img.src = url;
  });
}

const decodable = new WeakMap();
/**
 * Returns a Blob the browser can display: the file itself, or a JPEG converted from HEIC.
 * Cached per File, so preview and upload share one conversion.
 */
export function toDisplayable(file) {
  if (!decodable.has(file)) {
    decodable.set(file, (async () => {
      if (!(await looksLikeHeic(file)) || (await canDecode(file))) return file;
      const heic2any = await loadHeicLib();
      const out = await heic2any({ blob: file, toType: 'image/jpeg', quality: 0.92 });
      return Array.isArray(out) ? out[0] : out;
    })().catch((err) => { decodable.delete(file); throw err; }));
  }
  return decodable.get(file);
}

/**
 * Resize, optionally rotate (clockwise, multiples of 90°) and/or centre-crop to a square, then
 * re-encode as JPEG. Drawing through a canvas drops all metadata (GPS, camera serial, …).
 */
export async function reencodeJpeg(file, { maxSide = 1600, quality = 0.82, rotation = 0, square = false } = {}) {
  const source = await toDisplayable(file);
  const bitmap = await decodeSmall(source, maxSide, file);
  let sx = 0, sy = 0, sw = bitmap.width, sh = bitmap.height;
  if (square) {
    const side = Math.min(sw, sh);
    sx = (sw - side) / 2; sy = (sh - side) / 2; sw = sh = side;
  }
  const scale = Math.min(1, maxSide / Math.max(sw, sh));
  const w = Math.round(sw * scale);
  const h = Math.round(sh * scale);
  const rot = ((rotation % 360) + 360) % 360;
  const swap = rot === 90 || rot === 270;
  const canvas = document.createElement('canvas');
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;
  const ctx = canvas.getContext('2d');
  ctx.translate(canvas.width / 2, canvas.height / 2);
  ctx.rotate((rot * Math.PI) / 180);
  ctx.drawImage(bitmap, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  if (bitmap.close) bitmap.close();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/jpeg', quality));
  if (!blob) throw new Error('Could not process this image. Try a JPEG or PNG.');
  return blob;
}

/**
 * Decode without holding a full-resolution copy in memory where possible: 50–200 MP phone
 * photos can exhaust memory (especially on phones) if decoded at full size.
 */
async function decodeSmall(blob, maxSide, original) {
  const attempts = [
    // Downscale while decoding (Chrome/Edge/Firefox). Width only keeps the aspect ratio;
    // a generous size leaves room for the final max-side resize below.
    () => createImageBitmap(blob, { imageOrientation: 'from-image', resizeWidth: maxSide * 2, resizeQuality: 'high' }),
    () => createImageBitmap(blob, { imageOrientation: 'from-image' }),
    () => loadViaImg(blob),
  ];
  let lastErr;
  for (const attempt of attempts) {
    try {
      return await attempt();
    } catch (err) {
      lastErr = err;
    }
  }
  console.error('Image decode failed', { type: original.type, size: original.size, name: original.name, lastErr });
  const mb = (original.size / 1024 / 1024).toFixed(1);
  throw new Error(`Couldn't read this photo (${original.type || 'unknown type'}, ${mb} MB). Try a smaller JPEG, or a screenshot of it.`);
}

function loadViaImg(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('img decode failed')); };
    img.src = url;
  });
}
