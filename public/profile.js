// Profile helpers: well-known Nepal treks (shown as badges), countries and flags.

const REGION_COLORS = {
  Khumbu: '#2563eb',
  Annapurna: '#d97706',
  Langtang: '#059669',
  Manaslu: '#7c3aed',
  'Far East': '#0f766e',
  'Far West': '#9a3412',
  Mustang: '#b45309',
  'Across Nepal': '#be123c',
};

// id → { name, short (badge text), region }
export const TREKS = [
  ['ebc', 'Everest Base Camp', 'EBC', 'Khumbu'],
  ['gokyo', 'Gokyo Lakes', 'GOK', 'Khumbu'],
  ['three-passes', 'Everest Three Passes', '3P', 'Khumbu'],
  ['pikey-peak', 'Pikey Peak', 'PIK', 'Khumbu'],
  ['annapurna-circuit', 'Annapurna Circuit', 'AC', 'Annapurna'],
  ['abc', 'Annapurna Base Camp', 'ABC', 'Annapurna'],
  ['poon-hill', 'Ghorepani Poon Hill', 'PH', 'Annapurna'],
  ['mardi-himal', 'Mardi Himal', 'MH', 'Annapurna'],
  ['khopra', 'Khopra Ridge', 'KHR', 'Annapurna'],
  ['tilicho', 'Tilicho Lake', 'TIL', 'Annapurna'],
  ['nar-phu', 'Nar Phu Valley', 'NP', 'Annapurna'],
  ['dhaulagiri', 'Dhaulagiri Circuit', 'DHC', 'Annapurna'],
  ['upper-mustang', 'Upper Mustang', 'UM', 'Mustang'],
  ['langtang', 'Langtang Valley', 'LT', 'Langtang'],
  ['gosaikunda', 'Gosaikunda', 'GSK', 'Langtang'],
  ['helambu', 'Helambu', 'HEL', 'Langtang'],
  ['tamang-heritage', 'Tamang Heritage Trail', 'THT', 'Langtang'],
  ['manaslu', 'Manaslu Circuit', 'MCT', 'Manaslu'],
  ['tsum', 'Tsum Valley', 'TSV', 'Manaslu'],
  ['kanchenjunga', 'Kanchenjunga Base Camp', 'KBC', 'Far East'],
  ['makalu', 'Makalu Base Camp', 'MBC', 'Far East'],
  ['upper-dolpo', 'Upper Dolpo', 'DOL', 'Far West'],
  ['rara', 'Rara Lake', 'RAR', 'Far West'],
  ['ght', 'Great Himalaya Trail', 'GHT', 'Across Nepal'],
].map(([id, name, short, region]) => ({ id, name, short, region, color: REGION_COLORS[region] }));

const TREK_BY_ID = new Map(TREKS.map((t) => [t.id, t]));
export const MAX_TREKS = 40;

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export function knownTreks(ids) {
  return (Array.isArray(ids) ? ids : []).map((id) => TREK_BY_ID.get(id)).filter(Boolean);
}

export function trekBadge(t) {
  return `<span class="trek-badge" style="--c:${t.color}" title="${esc(t.name)} · ${esc(t.region)}">${esc(t.short)}</span>`;
}

/** Up to `max` badges, then "+N". */
export function trekBadges(ids, max = 3) {
  const treks = knownTreks(ids);
  if (!treks.length) return '';
  const shown = treks.slice(0, max).map(trekBadge).join('');
  const more = treks.length > max ? `<span class="trek-badge more" title="${esc(treks.slice(max).map((t) => t.name).join(', '))}">+${treks.length - max}</span>` : '';
  return `<span class="badges">${shown}${more}</span>`;
}

// ---- countries ----
const CODES = (
  'AF AL DZ AD AO AG AR AM AU AT AZ BS BH BD BB BY BE BZ BJ BT BO BA BW BR BN BG BF BI CV KH CM CA CF TD CL CN CO KM CG CD CR CI HR CU CY CZ DK DJ DM DO EC EG SV GQ ER EE SZ ET FJ FI FR GA GM GE DE GH GR GD GT GN GW GY HT HN HK HU IS IN ID IR IQ IE IL IT JM JP JO KZ KE KI KP KR XK KW KG LA LV LB LS LR LY LI LT LU MO MG MW MY MV ML MT MH MR MU MX FM MD MC MN ME MA MZ MM NA NR NP NL NZ NI NE NG MK NO OM PK PW PS PA PG PY PE PH PL PT PR QA RO RU RW KN LC VC WS SM ST SA SN RS SC SL SG SK SI SB SO ZA SS ES LK SD SR SE CH SY TW TJ TZ TH TL TG TO TT TN TR TM TV UG UA AE GB US UY UZ VU VA VE VN YE ZM ZW'
).split(' ');

let regionNames;
try { regionNames = new Intl.DisplayNames(['en'], { type: 'region' }); } catch { regionNames = null; }

export function countryName(code) {
  if (!code) return '';
  try { return regionNames?.of(code) || code; } catch { return code; }
}

export function flag(code) {
  if (!/^[A-Z]{2}$/.test(code || '')) return '';
  return String.fromCodePoint(...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65));
}

/** [{code, name}] sorted by name, Nepal first. */
export function countryOptions() {
  const list = CODES.map((code) => ({ code, name: countryName(code) })).sort((a, b) => a.name.localeCompare(b.name));
  const np = list.findIndex((c) => c.code === 'NP');
  if (np > 0) list.unshift(...list.splice(np, 1));
  return list;
}
