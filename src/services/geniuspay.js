import crypto from 'crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';

const METHOD_MAP = {
  WAVE: 'wave',
  ORANGE_MONEY: 'orange_money',
  MTN_MOMO: 'mtn_money',
  MOOV_MONEY: 'moov_money',
  CARTE_BANCAIRE: 'card',
};

export function isGatewayMethod(method) {
  return Boolean(METHOD_MAP[method]);
}

export function geniusConfigured() {
  return Boolean(config.genius.apiKey && config.genius.apiSecret);
}

async function geniusFetch(path, options = {}) {
  if (!geniusConfigured()) {
    throw new AppError(
      503,
      'GeniusPay n’est pas configuré. Renseignez GENIUSPAY_API_KEY et GENIUSPAY_API_SECRET sur le serveur.'
    );
  }
  const response = await fetch(`${config.genius.baseUrl}${path}`, {
    ...options,
    headers: {
      'X-API-Key': config.genius.apiKey,
      'X-API-Secret': config.genius.apiSecret,
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.success === false) {
    const message = body?.error?.message || body?.message || 'GeniusPay a refusé la requête.';
    throw new AppError(response.status || 502, message);
  }
  return body;
}

export async function createGeniusPayment({
  amount,
  method,
  description,
  customer,
  transactionId,
  userId,
}) {
  const payload = {
    amount,
    currency: 'XOF',
    description,
    customer: {
      name: customer.name,
      email: customer.email || undefined,
      phone: customer.phone,
      country: 'CI',
    },
    success_url: `${config.publicBaseUrl}/paiement/retour?status=success`,
    error_url: `${config.publicBaseUrl}/paiement/retour?status=error`,
    metadata: {
      transaction_id: transactionId,
      user_id: userId,
    },
  };
  if (METHOD_MAP[method]) payload.payment_method = METHOD_MAP[method];

  const body = await geniusFetch('/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return body.data;
}

export async function getGeniusPayment(reference) {
  const body = await geniusFetch(`/payments/${encodeURIComponent(reference)}`);
  return body.data;
}

export async function getGeniusBalance() {
  const body = await geniusFetch('/account/balance');
  return body.data;
}

export function verifyWebhookSignature({ rawBody, timestamp, signature }) {
  const secret = config.genius.webhookSecret;
  if (!secret || !timestamp || !signature || !rawBody) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const given = String(signature).replace(/^sha256=/i, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
