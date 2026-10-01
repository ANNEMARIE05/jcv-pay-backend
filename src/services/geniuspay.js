import crypto from 'crypto';
import { config, geniusCredentialsStatus } from '../config.js';
import { AppError } from '../errors.js';
import { normalizePhone } from '../utils/phone.js';

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
  return geniusCredentialsStatus().ok;
}

function configurationError() {
  const status = geniusCredentialsStatus();
  if (status.authMode === 'doc-partial') {
    throw new AppError(
      503,
      'GeniusPay incomplet : il manque GENIUSPAY_PUBLIC_KEY (pk_sandbox_…). ' +
        'La clé sk_… va dans GENIUSPAY_SECRET_KEY (X-API-Secret). ' +
        'Ou renseignez sk_ + ss_ du dashboard dans PUBLIC_KEY et SECRET_KEY. ' +
        'Voir https://geniuspay.ci/docs/api'
    );
  }
  throw new AppError(
    503,
    'GeniusPay n’est pas configuré. Renseignez GENIUSPAY_PUBLIC_KEY et GENIUSPAY_SECRET_KEY — https://geniuspay.ci/docs/api'
  );
}

function signRequest(signingSecret, rawBody) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const signature = crypto
    .createHmac('sha256', signingSecret)
    .update(`${timestamp}.${rawBody || ''}`)
    .digest('hex');
  return { timestamp, signature };
}

/** Variantes d’auth pour le dashboard (sk + signature ss). */
function dashboardAuthAttempts(apiKey, signingSecret, rawBody) {
  const { timestamp, signature } = signRequest(signingSecret, rawBody);
  return [
    {
      'X-API-Key': apiKey,
      'X-API-Secret': signingSecret,
    },
    {
      Authorization: `Bearer ${apiKey}`,
      'X-API-Secret': signingSecret,
    },
    {
      'X-API-Key': apiKey,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    {
      Authorization: `Bearer ${apiKey}`,
      'X-Timestamp': timestamp,
      'X-Signature': signature,
    },
    {
      'X-API-Key': apiKey,
      'X-Request-Timestamp': timestamp,
      'X-Request-Signature': signature,
    },
    { 'X-API-Key': apiKey },
    { Authorization: `Bearer ${apiKey}` },
  ];
}

function docAuthHeaders() {
  return {
    'X-API-Key': config.genius.publicKey,
    'X-API-Secret': config.genius.secretKey,
  };
}

function formatCustomerPhone(phone) {
  const digits = normalizePhone(phone);
  return digits ? `+${digits}` : phone.replace(/\s/g, '');
}

async function geniusFetch(path, options = {}) {
  if (!geniusConfigured()) configurationError();

  const rawBody = typeof options.body === 'string' ? options.body : '';
  const baseHeaders = {
    Accept: 'application/json',
    ...(rawBody ? { 'Content-Type': 'application/json' } : {}),
    ...(options.headers || {}),
  };

  const authAttempts =
    config.genius.authMode === 'dashboard'
      ? dashboardAuthAttempts(config.genius.publicKey, config.genius.secretKey, rawBody)
      : [docAuthHeaders()];

  let lastBody = {};
  let lastStatus = 502;

  for (let i = 0; i < authAttempts.length; i += 1) {
    const response = await fetch(`${config.genius.baseUrl}${path}`, {
      ...options,
      headers: { ...baseHeaders, ...authAttempts[i] },
    });
    const body = await response.json().catch(() => ({}));
    lastBody = body;
    lastStatus = response.status;
    if (response.ok && body.success !== false) return body;
    if (response.status !== 401 || config.genius.authMode !== 'dashboard') break;
  }

  const code = lastBody?.error?.code;
  let message = lastBody?.error?.message || lastBody?.message || 'GeniusPay a refusé la requête.';
  if (code === 'INVALID_API_KEY') {
    message +=
      ' Recopiez la clé sk_sandbox depuis Intégrations (sans espace) ou régénérez les clés Sandbox.';
  }
  throw new AppError(lastStatus || 502, message);
}

export async function createGeniusPayment({
  amount,
  method,
  description,
  customer,
  transactionId,
  userId,
}) {
  if (config.genius.simulate) {
    return {
      id: `sim_${Date.now()}`,
      reference: `GP-SIM-${Date.now()}`,
      checkout_url: `${config.publicBaseUrl}/paiement/simulation?tx=${transactionId}`,
      environment: 'simulation',
      fees: 0,
      net_amount: amount,
    };
  }

  const payload = {
    amount,
    currency: 'XOF',
    description: String(description || '').slice(0, 500),
    customer: {
      name: customer.name,
      email: customer.email || undefined,
      phone: formatCustomerPhone(customer.phone),
      country: 'CI',
    },
    success_url: `${config.publicBaseUrl}/paiement/retour?status=success`,
    error_url: `${config.publicBaseUrl}/paiement/retour?status=error`,
    metadata: {
      transaction_id: transactionId,
      user_id: userId,
      order_id: transactionId,
    },
  };

  if (!config.genius.useHostedCheckout && METHOD_MAP[method]) {
    payload.payment_method = METHOD_MAP[method];
    payload.metadata.preferred_method = method;
  } else if (METHOD_MAP[method]) {
    payload.metadata.preferred_method = method;
  }

  const body = await geniusFetch('/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return body.data;
}

export async function getGeniusPayment(reference) {
  if (config.genius.simulate || String(reference).startsWith('GP-SIM-')) {
    return {
      reference,
      status: 'completed',
      fees: 0,
      net_amount: null,
    };
  }
  const body = await geniusFetch(`/payments/${encodeURIComponent(reference)}`);
  return body.data;
}

export async function listGeniusPayments(query = {}) {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value != null && String(value).trim() !== '') params.set(key, String(value));
  }
  const qs = params.toString();
  const body = await geniusFetch(`/payments${qs ? `?${qs}` : ''}`);
  return body;
}

export async function getGeniusBalance() {
  if (config.genius.simulate) {
    return { available: 0, pending: 0, total: 0 };
  }
  const body = await geniusFetch('/account/balance');
  return body.data;
}

const WEBHOOK_EVENTS = [
  'payment.success',
  'payment.failed',
  'payment.cancelled',
  'payment.expired',
  'payment.refunded',
];

export async function ensureGeniusPayWebhook() {
  if (!geniusConfigured()) return;
  const targetUrl = `${config.publicBaseUrl}/api/webhooks/geniuspay`;
  if (!/^https:\/\//i.test(config.publicBaseUrl)) {
    console.log(
      'GeniusPay : webhook non enregistré automatiquement (PUBLIC_BASE_URL en HTTP). ' +
        'En local, la sync manuelle /api/paiements/:id/synchroniser suffit.'
    );
    return;
  }
  if (config.nodeEnv === 'production' && !/^https:\/\//i.test(config.publicBaseUrl)) {
    console.warn('GeniusPay webhook : PUBLIC_BASE_URL doit être en HTTPS en production.');
    return;
  }
  try {
    const listed = await geniusFetch('/webhooks');
    const hooks = Array.isArray(listed?.data) ? listed.data : listed?.data?.webhooks || [];
    const exists = hooks.some(
      (hook) => String(hook.url || '').replace(/\/$/, '') === targetUrl.replace(/\/$/, '')
    );
    if (exists) return;
    const created = await geniusFetch('/webhooks', {
      method: 'POST',
      body: JSON.stringify({
        name: 'JCV Pay',
        url: targetUrl,
        events: WEBHOOK_EVENTS,
      }),
    });
    const secret = created?.data?.secret || created?.data?.signing_secret;
    if (secret) {
      console.warn(
        'GeniusPay : webhook créé. Copiez ce secret dans GENIUSPAY_WEBHOOK_SECRET puis redémarrez :',
        secret
      );
    } else {
      console.log(`GeniusPay : webhook enregistré vers ${targetUrl}`);
    }
  } catch (error) {
    console.warn('GeniusPay : enregistrement webhook ignoré —', error.message);
  }
}

export function verifyWebhookSignature({ rawBody, timestamp, signature }) {
  const secret = config.genius.webhookSecret;
  if (!secret) {
    return config.nodeEnv !== 'production';
  }
  if (!timestamp || !signature || !rawBody) return false;
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!Number.isFinite(age) || age > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
  const given = String(signature).replace(/^sha256=/i, '');
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}
