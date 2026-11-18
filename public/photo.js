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

/** Resize to max `maxSide` px and re-encode as JPEG, dropping all metadata. */
export async function reencodeJpeg(file, maxSide = 1600, quality = 0.82) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    bitmap = await loadViaImg(file);
  }
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

function loadViaImg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Unsupported image format (HEIC? try exporting as JPEG).')); };
    img.src = url;
  });
}
