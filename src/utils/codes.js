const dateFmt = new Intl.DateTimeFormat('fr-FR', {
  day: 'numeric',
  month: 'long',
  year: 'numeric',
  timeZone: 'Africa/Abidjan',
});

const timeFmt = new Intl.DateTimeFormat('fr-FR', {
  hour: '2-digit',
  minute: '2-digit',
  timeZone: 'Africa/Abidjan',
});

export function formatDateFr(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return dateFmt.format(date);
}

export function formatHeure(value) {
  if (!value) return '';
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return timeFmt.format(date);
}

export function money(value) {
  return Math.round(Number(value) || 0);
}

export function randomDigits(length) {
  const max = 10 ** length;
  return String(Math.floor(Math.random() * max)).padStart(length, '0');
}

const ROLE_PREFIX = {
  SUPER_ADMIN: 'ADM',
  ADMINISTRATEUR: 'ADM',
  TRESORIER: 'TRS',
  RESPONSABLE: 'RSP',
  MEMBRE: 'MBR',
};

export function buildMatricule(role) {
  const prefix = ROLE_PREFIX[role] || 'MBR';
  return `JCV-${prefix}-${randomDigits(4)}`;
}

export function buildReference() {
  const year = new Date().getFullYear();
  return `TXN-${year}-${randomDigits(6)}`;
}

export function buildReceiptNumber() {
  const year = new Date().getFullYear();
  return `REC-${year}-${randomDigits(6)}`;
}

export function buildSecurityCode(suffix) {
  return `JCV-SEC-${randomDigits(6)}-${suffix}`;
}
