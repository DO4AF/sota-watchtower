const PREFIX_FLAG_MAP: Array<[string, string]> = [
  ['HB0', '🇱🇮'],
  ['CT3', '🇵🇹'],
  ['CU', '🇵🇹'],
  ['HB', '🇨🇭'],
  ['OE', '🇦🇹'],
  ['DL', '🇩🇪'],
  ['DM', '🇩🇪'],
  ['DB', '🇩🇪'],
  ['DF', '🇩🇪'],
  ['DG', '🇩🇪'],
  ['DK', '🇩🇪'],
  ['DO', '🇩🇪'],
  ['F', '🇫🇷'],
  ['I', '🇮🇹'],
  ['PA', '🇳🇱'],
  ['ON', '🇧🇪'],
  ['LX', '🇱🇺'],
  ['9A', '🇭🇷'],
  ['OK', '🇨🇿'],
  ['SP', '🇵🇱'],
  ['OM', '🇸🇰'],
  ['HA', '🇭🇺'],
  ['S5', '🇸🇮'],
  ['YU', '🇷🇸'],
  ['YO', '🇷🇴'],
  ['LZ', '🇧🇬'],
  ['G', '🇬🇧'],
  ['M', '🇬🇧'],
  ['2E', '🇬🇧'],
  ['EI', '🇮🇪'],
  ['EA', '🇪🇸'],
  ['CT', '🇵🇹'],
  ['LA', '🇳🇴'],
  ['SM', '🇸🇪'],
  ['OZ', '🇩🇰'],
  ['OH', '🇫🇮'],
  ['TF', '🇮🇸'],
  ['SV', '🇬🇷'],
  ['JW', '🇳🇴'],
];

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
  for (const [prefix, flag] of PREFIX_FLAG_MAP) {
    if (normalized.startsWith(prefix)) return flag;
  }
  return '';
}
