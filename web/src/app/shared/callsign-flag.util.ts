type PrefixRule =
  | { kind: 'exact'; prefix: string; flag: string }
  | { kind: 'range'; start: string; end: string; flag: string };

const exact = (prefix: string, flag: string): PrefixRule => ({
  kind: 'exact',
  prefix,
  flag,
});

const range = (start: string, end: string, flag: string): PrefixRule => ({
  kind: 'range',
  start,
  end,
  flag,
});

// Based on ITU callsign allocations provided in task description.
// Rules are sorted by specificity (longer prefixes/ranges first) at runtime.
const PREFIX_RULES: PrefixRule[] = [
  // Specific overrides
  exact('HB3Y', '🇱🇮'),
  exact('HB0', '🇱🇮'),
  exact('HBL', '🇱🇮'),

  // Taiwan subset inside B
  range('BM', 'BQ', '🇹🇼'),
  range('BU', 'BX', '🇹🇼'),

  // United States / A-block
  range('AA', 'AL', '🇺🇸'),
  range('AM', 'AO', '🇪🇸'),
  range('AP', 'AS', '🇵🇰'),
  range('AT', 'AW', '🇮🇳'),
  exact('AX', '🇦🇺'),
  range('AY', 'AZ', '🇦🇷'),
  exact('A2', '🇧🇼'),
  exact('A3', '🇹🇴'),
  exact('A4', '🇴🇲'),
  exact('A5', '🇧🇹'),
  exact('A6', '🇦🇪'),
  exact('A7', '🇶🇦'),
  exact('A8', '🇱🇷'),
  exact('A9', '🇧🇭'),
  exact('B', '🇨🇳'),

  range('CA', 'CE', '🇨🇱'),
  range('CF', 'CK', '🇨🇦'),
  range('CL', 'CM', '🇨🇺'),
  exact('CN', '🇲🇦'),
  exact('CO', '🇨🇺'),
  exact('CP', '🇧🇴'),
  range('CQ', 'CU', '🇵🇹'),
  range('CV', 'CX', '🇺🇾'),
  range('CY', 'CZ', '🇨🇦'),
  exact('C2', '🇳🇷'),
  exact('C3', '🇦🇩'),
  exact('C4', '🇨🇾'),
  exact('C5', '🇬🇲'),
  exact('C6', '🇧🇸'),
  range('C8', 'C9', '🇲🇿'),

  range('DA', 'DR', '🇩🇪'),
  range('DS', 'DT', '🇰🇷'),
  range('DU', 'DZ', '🇵🇭'),
  range('D2', 'D3', '🇦🇴'),
  exact('D4', '🇨🇻'),
  exact('D5', '🇱🇷'),
  exact('D6', '🇰🇲'),
  range('D7', 'D9', '🇰🇷'),

  range('EA', 'EH', '🇪🇸'),
  range('EI', 'EJ', '🇮🇪'),
  exact('EK', '🇦🇲'),
  exact('EL', '🇱🇷'),
  range('EM', 'EO', '🇺🇦'),
  range('EP', 'EQ', '🇮🇷'),
  exact('ER', '🇲🇩'),
  exact('ES', '🇪🇪'),
  exact('ET', '🇪🇹'),
  range('EU', 'EW', '🇧🇾'),
  exact('EX', '🇰🇬'),
  exact('EY', '🇹🇯'),
  exact('EZ', '🇹🇲'),
  exact('E2', '🇹🇭'),
  exact('E3', '🇪🇷'),
  exact('E4', '🇵🇸'),
  exact('E5', '🇨🇰'),
  exact('E6', '🇳🇺'),
  exact('E7', '🇧🇦'),

  exact('F', '🇫🇷'),
  exact('G', '🇬🇧'),

  exact('HA', '🇭🇺'),
  exact('HB', '🇨🇭'),
  range('HC', 'HD', '🇪🇨'),
  exact('HE', '🇨🇭'),
  exact('HF', '🇵🇱'),
  exact('HG', '🇭🇺'),
  exact('HH', '🇭🇹'),
  exact('HI', '🇩🇴'),
  range('HJ', 'HK', '🇨🇴'),
  exact('HL', '🇰🇷'),
  exact('HM', '🇰🇵'),
  exact('HN', '🇮🇶'),
  range('HO', 'HP', '🇵🇦'),
  range('HQ', 'HR', '🇭🇳'),
  exact('HS', '🇹🇭'),
  exact('HT', '🇳🇮'),
  exact('HU', '🇸🇻'),
  exact('HV', '🇻🇦'),
  range('HW', 'HY', '🇫🇷'),
  exact('HZ', '🇸🇦'),
  exact('H2', '🇨🇾'),
  exact('H3', '🇵🇦'),
  exact('H4', '🇸🇧'),
  range('H6', 'H7', '🇳🇮'),
  range('H8', 'H9', '🇵🇦'),

  exact('I', '🇮🇹'),

  range('JA', 'JS', '🇯🇵'),
  range('JT', 'JV', '🇲🇳'),
  range('JW', 'JX', '🇳🇴'),
  exact('JY', '🇯🇴'),
  exact('JZ', '🇮🇩'),
  exact('J2', '🇩🇯'),
  exact('J3', '🇬🇩'),
  exact('J4', '🇬🇷'),
  exact('J5', '🇬🇼'),
  exact('J6', '🇱🇨'),
  exact('J7', '🇩🇲'),
  exact('J8', '🇻🇨'),

  exact('K', '🇺🇸'),

  range('LA', 'LN', '🇳🇴'),
  range('LO', 'LW', '🇦🇷'),
  exact('LX', '🇱🇺'),
  exact('LY', '🇱🇹'),
  exact('LZ', '🇧🇬'),
  range('L2', 'L9', '🇦🇷'),

  exact('M', '🇬🇧'),
  exact('N', '🇺🇸'),

  range('OA', 'OC', '🇵🇪'),
  exact('OD', '🇱🇧'),
  exact('OE', '🇦🇹'),
  range('OF', 'OJ', '🇫🇮'),
  range('OK', 'OL', '🇨🇿'),
  exact('OM', '🇸🇰'),
  range('ON', 'OT', '🇧🇪'),
  range('OU', 'OZ', '🇩🇰'),

  range('PA', 'PI', '🇳🇱'),
  exact('PJ', '🇳🇱'),
  range('PK', 'PO', '🇮🇩'),
  range('PP', 'PY', '🇧🇷'),
  exact('PZ', '🇸🇷'),
  exact('P2', '🇵🇬'),
  exact('P3', '🇨🇾'),
  exact('P4', '🇦🇼'),
  range('P5', 'P9', '🇰🇵'),

  exact('R', '🇷🇺'),

  range('SA', 'SM', '🇸🇪'),
  range('SN', 'SR', '🇵🇱'),
  range('SSA', 'SSM', '🇪🇬'),
  range('SSN', 'SSZ', '🇸🇩'),
  exact('SU', '🇪🇬'),
  range('SV', 'SZ', '🇬🇷'),
  range('S2', 'S3', '🇧🇩'),
  exact('S5', '🇸🇮'),
  exact('S6', '🇸🇬'),
  exact('S7', '🇸🇨'),
  exact('S8', '🇿🇦'),
  exact('S9', '🇸🇹'),

  range('TA', 'TC', '🇹🇷'),
  exact('TD', '🇬🇹'),
  exact('TE', '🇨🇷'),
  exact('TF', '🇮🇸'),
  exact('TG', '🇬🇹'),
  exact('TH', '🇫🇷'),
  exact('TI', '🇨🇷'),
  exact('TJ', '🇨🇲'),
  exact('TK', '🇫🇷'),
  exact('TL', '🇨🇫'),
  exact('TM', '🇫🇷'),
  exact('TN', '🇨🇬'),
  range('TO', 'TQ', '🇫🇷'),
  exact('TR', '🇬🇦'),
  exact('TS', '🇹🇳'),
  exact('TT', '🇹🇩'),
  exact('TU', '🇨🇮'),
  range('TV', 'TX', '🇫🇷'),
  exact('TY', '🇧🇯'),
  exact('TZ', '🇲🇱'),
  exact('T2', '🇹🇻'),
  exact('T3', '🇰🇮'),
  exact('T4', '🇨🇺'),
  exact('T5', '🇸🇴'),
  exact('T6', '🇦🇫'),
  exact('T7', '🇸🇲'),
  exact('T8', '🇵🇼'),

  range('UA', 'UI', '🇷🇺'),
  range('UJ', 'UM', '🇺🇿'),
  range('UN', 'UQ', '🇰🇿'),
  range('UR', 'UZ', '🇺🇦'),

  range('VA', 'VG', '🇨🇦'),
  range('VH', 'VN', '🇦🇺'),
  exact('VO', '🇨🇦'),
  range('VP', 'VQ', '🇬🇧'),
  exact('VR', '🇭🇰'),
  exact('VS', '🇬🇧'),
  range('VT', 'VW', '🇮🇳'),
  range('VX', 'VY', '🇨🇦'),
  exact('VZ', '🇦🇺'),
  exact('V2', '🇦🇬'),
  exact('V3', '🇧🇿'),
  exact('V4', '🇰🇳'),
  exact('V5', '🇳🇦'),
  exact('V6', '🇫🇲'),
  exact('V7', '🇲🇭'),
  exact('V8', '🇧🇳'),

  exact('W', '🇺🇸'),

  range('XA', 'XI', '🇲🇽'),
  range('XJ', 'XO', '🇨🇦'),
  exact('XP', '🇩🇰'),
  range('XQ', 'XR', '🇨🇱'),
  exact('XS', '🇨🇳'),
  exact('XT', '🇧🇫'),
  exact('XU', '🇰🇭'),
  exact('XV', '🇻🇳'),
  exact('XW', '🇱🇦'),
  exact('XX', '🇲🇴'),
  range('XY', 'XZ', '🇲🇲'),

  exact('YA', '🇦🇫'),
  range('YB', 'YH', '🇮🇩'),
  exact('YI', '🇮🇶'),
  exact('YJ', '🇻🇺'),
  exact('YK', '🇸🇾'),
  exact('YL', '🇱🇻'),
  exact('YM', '🇹🇷'),
  exact('YN', '🇳🇮'),
  range('YO', 'YR', '🇷🇴'),
  exact('YS', '🇸🇻'),
  range('YT', 'YU', '🇷🇸'),
  range('YV', 'YY', '🇻🇪'),
  range('Y2', 'Y9', '🇩🇪'),

  exact('ZA', '🇦🇱'),
  range('ZB', 'ZJ', '🇬🇧'),
  range('ZK', 'ZM', '🇳🇿'),
  range('ZN', 'ZO', '🇬🇧'),
  exact('ZP', '🇵🇾'),
  exact('ZQ', '🇬🇧'),
  range('ZR', 'ZU', '🇿🇦'),
  range('ZV', 'ZZ', '🇧🇷'),
  exact('Z2', '🇿🇼'),
  exact('Z3', '🇲🇰'),
  exact('Z8', '🇸🇸'),

  exact('2', '🇬🇧'),

  exact('3A', '🇲🇨'),
  exact('3B', '🇲🇺'),
  exact('3C', '🇬🇶'),
  range('3DA', '3DM', '🇸🇿'),
  range('3DN', '3DZ', '🇫🇯'),
  range('3E', '3F', '🇵🇦'),
  exact('3G', '🇨🇱'),
  range('3H', '3U', '🇨🇳'),
  exact('3V', '🇹🇳'),
  exact('3W', '🇻🇳'),
  exact('3X', '🇬🇳'),
  exact('3Y', '🇳🇴'),
  exact('3Z', '🇵🇱'),

  range('4A', '4C', '🇲🇽'),
  range('4D', '4I', '🇵🇭'),
  range('4J', '4K', '🇦🇿'),
  exact('4L', '🇬🇪'),
  exact('4M', '🇻🇪'),
  exact('4O', '🇲🇪'),
  range('4P', '4S', '🇱🇰'),
  exact('4T', '🇵🇪'),
  exact('4V', '🇭🇹'),
  exact('4W', '🇹🇱'),
  exact('4X', '🇮🇱'),
  exact('4Z', '🇮🇱'),

  exact('5A', '🇱🇾'),
  exact('5B', '🇨🇾'),
  range('5C', '5G', '🇲🇦'),
  range('5H', '5I', '🇹🇿'),
  range('5J', '5K', '🇨🇴'),
  range('5L', '5M', '🇱🇷'),
  range('5N', '5O', '🇳🇬'),
  range('5P', '5Q', '🇩🇰'),
  range('5R', '5S', '🇲🇬'),
  exact('5T', '🇲🇷'),
  exact('5U', '🇳🇪'),
  exact('5V', '🇹🇬'),
  exact('5W', '🇼🇸'),
  exact('5X', '🇺🇬'),
  range('5Y', '5Z', '🇰🇪'),

  range('6A', '6B', '🇪🇬'),
  exact('6C', '🇸🇾'),
  range('6D', '6J', '🇲🇽'),
  range('6K', '6N', '🇰🇷'),
  exact('6O', '🇸🇴'),
  range('6P', '6S', '🇵🇰'),
  range('6T', '6U', '🇸🇩'),
  range('6V', '6W', '🇸🇳'),
  exact('6X', '🇲🇬'),
  exact('6Y', '🇯🇲'),
  exact('6Z', '🇱🇷'),

  range('7A', '7I', '🇮🇩'),
  range('7J', '7N', '🇯🇵'),
  exact('7O', '🇾🇪'),
  exact('7P', '🇱🇸'),
  exact('7Q', '🇲🇼'),
  exact('7R', '🇩🇿'),
  exact('7S', '🇸🇪'),
  range('7T', '7Y', '🇩🇿'),
  exact('7Z', '🇸🇦'),

  range('8A', '8I', '🇮🇩'),
  range('8J', '8N', '🇯🇵'),
  exact('8O', '🇧🇼'),
  exact('8P', '🇧🇧'),
  exact('8Q', '🇲🇻'),
  exact('8R', '🇬🇾'),
  exact('8S', '🇸🇪'),
  range('8T', '8Y', '🇮🇳'),
  exact('8Z', '🇸🇦'),

  exact('9A', '🇭🇷'),
  range('9B', '9D', '🇮🇷'),
  range('9E', '9F', '🇪🇹'),
  exact('9G', '🇬🇭'),
  exact('9H', '🇲🇹'),
  range('9I', '9J', '🇿🇲'),
  exact('9K', '🇰🇼'),
  exact('9L', '🇸🇱'),
  exact('9M', '🇲🇾'),
  exact('9N', '🇳🇵'),
  range('9O', '9T', '🇨🇩'),
  exact('9U', '🇧🇮'),
  exact('9V', '🇸🇬'),
  exact('9W', '🇲🇾'),
  exact('9X', '🇷🇼'),
  range('9Y', '9Z', '🇹🇹'),
];

const SORTED_RULES = [...PREFIX_RULES].sort((a, b) => {
  const lenA = a.kind === 'exact' ? a.prefix.length : a.start.length;
  const lenB = b.kind === 'exact' ? b.prefix.length : b.start.length;
  return lenB - lenA;
});

// Explicit non-country allocations from the ITU source table.
// These are intentionally mapped to "no country flag".
const NON_COUNTRY_PREFIXES = ['C7', '4U', '4Y'];

function normalizeCallsignForCountry(raw: string): string {
  return raw
    .trim()
    .toUpperCase()
    .replace(/-\d+$/, '')
    .split('/')[0]
    .replace(/[^A-Z0-9]/g, '');
}

export function getCallsignFlag(callsign: string): string {
  const normalized = normalizeCallsignForCountry(callsign || '');
  if (!normalized) return '';

  if (NON_COUNTRY_PREFIXES.some(prefix => normalized.startsWith(prefix))) {
    return '';
  }

  for (const rule of SORTED_RULES) {
    if (rule.kind === 'exact') {
      if (normalized.startsWith(rule.prefix)) return rule.flag;
      continue;
    }

    const len = rule.start.length;
    if (normalized.length < len) continue;
    const probe = normalized.slice(0, len);
    if (probe >= rule.start && probe <= rule.end) return rule.flag;
  }

  return '';
}
