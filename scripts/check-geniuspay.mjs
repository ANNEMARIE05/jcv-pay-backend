import crypto from 'crypto';
import { config, geniusCredentialsStatus } from '../src/config.js';

const status = geniusCredentialsStatus();
if (!status.ok) {
  console.log('Configuration GeniusPay : incomplète');
  console.log(status.hint || '');
  process.exit(1);
}

const url = `${config.genius.baseUrl}/account`;
const apiKey = config.genius.publicKey;
const ss = config.genius.secretKey;

function sign(rawBody) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto.createHmac('sha256', ss).update(`${timestamp}.${rawBody}`).digest('hex');
  return { timestamp, signature };
}

const attempts =
  status.authMode === 'dashboard'
    ? (() => {
        const { timestamp, signature } = sign('');
        return [
          ['X-API-Key + X-API-Secret', { 'X-API-Key': apiKey, 'X-API-Secret': ss }],
          ['Bearer + X-API-Secret', { Authorization: `Bearer ${apiKey}`, 'X-API-Secret': ss }],
          ['signed + X-API-Key', { 'X-API-Key': apiKey, 'X-Timestamp': timestamp, 'X-Signature': signature }],
          ['Bearer + signature', { Authorization: `Bearer ${apiKey}`, 'X-Timestamp': timestamp, 'X-Signature': signature }],
          ['X-API-Key seul', { 'X-API-Key': apiKey }],
          ['Bearer seul', { Authorization: `Bearer ${apiKey}` }],
        ];
      })()
    : [['doc pk+sk', { 'X-API-Key': apiKey, 'X-API-Secret': ss }]];

for (const [label, headers] of attempts) {
  const response = await fetch(url, { headers: { Accept: 'application/json', ...headers } });
  const body = await response.json().catch(() => ({}));
  const ok = response.ok && body.success !== false;
  console.log(label, response.status, ok ? 'OK' : body.error?.message || 'FAIL');
  if (ok) process.exit(0);
}

console.log('Aucune méthode d’auth n’a abouti. Recopiez les clés depuis le dashboard ou contactez GeniusPay.');
process.exit(1);
