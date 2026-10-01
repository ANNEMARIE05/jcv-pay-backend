export function normalizePhone(value) {
  let digits = String(value || '').replace(/\D/g, '');
  if (digits.startsWith('00225')) digits = digits.slice(2);
  if (!digits.startsWith('225') && digits.length === 10) digits = `225${digits}`;
  return digits;
}

export function formatPhone(value) {
  const digits = normalizePhone(value);
  if (digits.startsWith('225') && digits.length >= 11) {
    const local = digits.slice(3);
    const parts = local.match(/.{1,2}/g) || [local];
    return `+225 ${parts.join(' ')}`.trim();
  }
  return digits ? `+${digits}` : '';
}

export function isEmail(value) {
  return String(value || '').includes('@');
}

export function cleanEmail(value) {
  const email = String(value || '').trim().toLowerCase();
  return email || null;
}
