// Seed list of towns used for autocomplete and for snapping a report to the nearest town.
// Coordinates are approximate town centres. Elevation is NOT stored here: each report's
// elevation comes from the Open-Meteo elevation API (see functions/index.js), and a town's
// elevation on the map is the median of its reports.
// Add towns freely — users can also type any town name that isn't listed.
export const TOWNS = [
  // Kathmandu Valley
  ['Kathmandu', 27.7172, 85.3240],
  ['Lalitpur', 27.6644, 85.3188],
  ['Bhaktapur', 27.6710, 85.4298],
  ['Kirtipur', 27.6781, 85.2775],
  ['Dhulikhel', 27.6200, 85.5500],
  // Terai
  ['Biratnagar', 26.4525, 87.2718],
  ['Itahari', 26.6650, 87.2718],
  ['Rajbiraj', 26.5400, 86.7500],
  ['Janakpur', 26.7288, 85.9263],
  ['Birgunj', 27.0104, 84.8770],
  ['Bharatpur', 27.6833, 84.4333],
  ['Sauraha', 27.5786, 84.4950],
  ['Butwal', 27.7006, 83.4483],
  ['Bhairahawa', 27.5050, 83.4500],
  ['Lumbini', 27.4840, 83.2760],
  ['Nepalgunj', 28.0500, 81.6167],
  ['Dhangadhi', 28.6833, 80.6000],
  ['Mahendranagar', 28.9630, 80.1780],
  // Hills
  ['Dharan', 26.8125, 87.2836],
  ['Ilam', 26.9100, 87.9280],
  ['Hetauda', 27.4284, 85.0322],
  ['Pokhara', 28.2096, 83.9856],
  ['Bandipur', 27.9381, 84.4069],
  ['Damauli', 27.9700, 84.2700],
  ['Gorkha', 28.0000, 84.6333],
  ['Besisahar', 28.2300, 84.3750],
  ['Tansen', 27.8673, 83.5467],
  ['Baglung', 28.2700, 83.5900],
  ['Birendranagar (Surkhet)', 28.6019, 81.6339],
  ['Dadeldhura', 29.3000, 80.5800],
  ['Okhaldhunga', 27.3200, 86.5000],
  ['Salleri', 27.5000, 86.5833],
  // Mountains / trekking
  ['Lukla', 27.6870, 86.7314],
  ['Namche Bazaar', 27.8050, 86.7140],
  ['Tengboche', 27.8361, 86.7644],
  ['Dingboche', 27.8920, 86.8310],
  ['Gorak Shep', 27.9800, 86.8290],
  ['Ghandruk', 28.3750, 83.8070],
  ['Chhomrong', 28.4167, 83.8167],
  ['Annapurna Base Camp', 28.5300, 83.8780],
  ['Tatopani', 28.4860, 83.6500],
  ['Chame', 28.5500, 84.2400],
  ['Manang', 28.6667, 84.0167],
  ['Muktinath', 28.8167, 83.8667],
  ['Jomsom', 28.7804, 83.7231],
  ['Lo Manthang', 29.1830, 83.9590],
  ['Syabrubesi', 28.1600, 85.3450],
  ['Kyanjin Gompa', 28.2110, 85.5630],
  ['Jumla', 29.2747, 82.1838],
  ['Simikot', 29.9686, 81.8270],
].map(([name, lat, lng]) => ({ name, lat, lng, key: townKey(name) }));

export function townKey(name) {
  return String(name)
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/\(.*?\)/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'unknown';
}

export function distanceKm(aLat, aLng, bLat, bLng) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(bLat - aLat);
  const dLng = toRad(bLng - aLng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(aLat)) * Math.cos(toRad(bLat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Nearest seed town within maxKm, or null. */
export function nearestTown(lat, lng, maxKm = 12) {
  let best = null;
  for (const t of TOWNS) {
    const d = distanceKm(lat, lng, t.lat, t.lng);
    if (d <= maxKm && (!best || d < best.d)) best = { ...t, d };
  }
  return best;
}

export const NEPAL_BOUNDS = [[26.3, 80.0], [30.5, 88.3]];
export function inNepal(lat, lng) {
  return lat > 26.2 && lat < 30.6 && lng > 79.9 && lng < 88.4;
}
