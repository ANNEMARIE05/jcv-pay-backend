import crypto from 'crypto';
import { config } from '../config.js';
import { AppError } from '../errors.js';
import { normalizePhone } from '../utils/phone.js';

const METHOD_MAP = {
  WAVE: 'wave',
  ORANGE_MONEY: 'orange_money',
  MTN_MOMO: 'mtn_money',
  MOOV_MONEY: 'moov_money',
  CARTE_BANCAIRE: 'card',
  PAWAPAY: 'pawapay',
  PAYSTACK: 'paystack',
};

export function hasGeniusPayCredentials() {
  return Boolean(config.geniuspay.apiKey && config.geniuspay.apiSecret);
}

export function mapPaymentMethod(method) {
  if (!method) return undefined;
  const upper = String(method).toUpperCase();
  if (METHOD_MAP[upper]) return METHOD_MAP[upper];
  const lower = String(method).toLowerCase();
  const known = ['wave', 'orange_money', 'mtn_money', 'moov_money', 'card', 'pawapay', 'paystack'];
  if (known.includes(lower)) return lower;
  return undefined;
}

function formatPhoneForGeniusPay(phone) {
  if (!phone) return undefined;
  const cleaned = String(phone).trim();
  if (cleaned.startsWith('+')) return cleaned.replace(/\s+/g, '');
  const digits = normalizePhone(cleaned);
  if (!digits) return undefined;
  if (digits.length === 10) return `+225${digits}`;
  return `+${digits}`;
}

async function geniusPayRequest(path, options = {}) {
  if (!hasGeniusPayCredentials()) {
    throw new AppError(500, 'GeniusPay n’est pas configuré (clés API manquantes).');
  }

  const url = `${config.geniuspay.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers = {
    'X-API-Key': config.geniuspay.apiKey,
    'X-API-Secret': config.geniuspay.apiSecret,
    'Content-Type': 'application/json',
    Accept: 'application/json',
    ...(options.headers || {}),
  };

  let response;
  try {
    response = await fetch(url, {
      ...options,
      headers,
    });
  } catch (netErr) {
    console.error('[GeniusPay Net Error]', netErr.message);
    throw new AppError(502, `Connexion à GeniusPay impossible : ${netErr.message}`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  if (!response.ok || (body && body.success === false)) {
    const errorDetail = body?.error?.message || body?.message || response.statusText;
    const errorCode = body?.error?.code || 'GENIUSPAY_ERROR';
    console.error(`[GeniusPay API Error] Status ${response.status} (${errorCode}):`, errorDetail);
    throw new AppError(
      response.status >= 400 && response.status < 500 ? response.status : 502,
      `Erreur GeniusPay [${errorCode}] : ${errorDetail}`
    );
  }

  return body;
}

/**
 * Initier un paiement sur GeniusPay.
 * Retourne les détails de la transaction GeniusPay et l'URL de paiement/checkout.
 */
export async function createPayment({
  amount,
  currency = 'XOF',
  paymentMethod,
  description,
  customer = {},
  metadata = {},
  successUrl,
  errorUrl,
  gateway,
  mmoProvider,
}) {
  const mappedMethod = mapPaymentMethod(paymentMethod);
  const formattedPhone = formatPhoneForGeniusPay(customer.phone || customer.telephone);

  const payload = {
    amount: Math.round(Number(amount)),
    currency: currency || 'XOF',
    ...(mappedMethod ? { payment_method: mappedMethod } : {}),
    ...(gateway ? { gateway } : {}),
    ...(mmoProvider ? { mmo_provider: mmoProvider } : {}),
    ...(description ? { description: String(description).slice(0, 500) } : {}),
    customer: {
      ...(customer.name ? { name: customer.name } : {}),
      ...(customer.email ? { email: customer.email } : {}),
      ...(formattedPhone ? { phone: formattedPhone } : {}),
      country: customer.country || 'CI',
    },
    metadata: {
      ...metadata,
    },
    ...(successUrl ? { success_url: successUrl } : {}),
    ...(errorUrl ? { error_url: errorUrl } : {}),
  };

  const res = await geniusPayRequest('/payments', {
    method: 'POST',
    body: JSON.stringify(payload),
  });

  return res.data;
}

/**
 * Récupérer une transaction GeniusPay par sa référence (ex: SANDBOX_... ou MTX-...).
 */
export async function getPayment(reference) {
  if (!reference) throw new AppError(400, 'Référence de transaction requise.');
  const res = await geniusPayRequest(`/payments/${encodeURIComponent(reference)}`, {
    method: 'GET',
  });
  return res.data;
}

/**
 * Lister les paiements récents depuis GeniusPay.
 */
export async function listPayments(params = {}) {
  const query = new URLSearchParams();
  if (params.status) query.set('status', params.status);
  if (params.paymentMethod) query.set('payment_method', mapPaymentMethod(params.paymentMethod) || params.paymentMethod);
  if (params.from) query.set('from', params.from);
  if (params.to) query.set('to', params.to);
  if (params.search) query.set('search', params.search);
  if (params.perPage) query.set('per_page', String(params.perPage));

  const path = query.toString() ? `/payments?${query.toString()}` : '/payments';
  const res = await geniusPayRequest(path, { method: 'GET' });
  return res;
}

/**
 * Obtenir les informations du compte marchand.
 */
export async function getAccount() {
  const res = await geniusPayRequest('/account', { method: 'GET' });
  return res.data;
}

/**
 * Obtenir le solde disponible et en attente du compte.
 */
export async function getBalance() {
  const res = await geniusPayRequest('/account/balance', { method: 'GET' });
  return res.data;
}

/**
 * Obtenir la liste des opérateurs MMO (PawaPay).
 */
export async function getPawaPayProviders(country = 'CI') {
  const res = await geniusPayRequest(`/pawapay/providers?country=${encodeURIComponent(country)}`, {
    method: 'GET',
  });
  return res.data;
}

/**
 * Vérifier la signature HMAC-SHA256 d'un webhook GeniusPay.
 * Format spec: signature = HMAC-SHA256(timestamp + "." + json_payload, secret)
 */
export function verifyWebhookSignature({
  signature,
  timestamp,
  rawBody,
  webhookSecret = config.geniuspay.webhookSecret,
}) {
  if (!signature) {
    return { valid: false, reason: 'Header X-Webhook-Signature manquant' };
  }
  if (!timestamp) {
    return { valid: false, reason: 'Header X-Webhook-Timestamp manquant' };
  }

  // Protection replay attack : max 5 minutes (300 secondes)
  const currentTs = Math.floor(Date.now() / 1000);
  const sentTs = parseInt(timestamp, 10);
  if (Number.isNaN(sentTs) || Math.abs(currentTs - sentTs) > 300) {
    return { valid: false, reason: 'Timestamp trop ancien (replay attack)' };
  }

  // Si aucun webhookSecret n'est encore configuré dans l'environnement
  if (!webhookSecret) {
    return { valid: true, warning: 'Webhook secret non configuré, signature non vérifiée en mode dev' };
  }

  const payloadString = typeof rawBody === 'string' ? rawBody : JSON.stringify(rawBody || {});
  const dataToSign = `${timestamp}.${payloadString}`;
  const expectedSignature = crypto
    .createHmac('sha256', webhookSecret)
    .update(dataToSign)
    .digest('hex');

  const sigBuffer = Buffer.from(signature, 'utf8');
  const expectedBuffer = Buffer.from(expectedSignature, 'utf8');

  if (sigBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(sigBuffer, expectedBuffer)) {
    return { valid: false, reason: 'Signature HMAC invalide' };
  }

  return { valid: true };
}
