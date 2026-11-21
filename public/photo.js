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
      if (typeof meta.latitude === 'number' && typeof meta.longitude === 'number') {
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

/** Resize to max `maxSide` px and re-encode as JPEG, dropping all metadata. */
export async function reencodeJpeg(file, maxSide = 1600, quality = 0.82) {
  const source = await toDisplayable(file);
  const bitmap = await decodeSmall(source, maxSide, file);
  const scale = Math.min(1, maxSide / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d').drawImage(bitmap, 0, 0, w, h);
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
