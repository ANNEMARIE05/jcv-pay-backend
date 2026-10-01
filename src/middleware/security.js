/**
 * Middleware de sécurité — Protection contre :
 *  - Brute-force sur login/inscription (rate limiting en mémoire)
 *  - Trop nombreuses requêtes API (rate limit global)
 *  - Requêtes trop volumineuses
 *  - Injections via headers suspects
 *  - Accès aux routes admin sans le bon rôle
 */

import { AppError } from '../errors.js';
import { isProd } from '../config.js';

// ─── Rate Limiter en mémoire (sans dépendance externe) ─────────────────────

const store = new Map(); // ip → { count, resetAt }

function getClientIp(req) {
  // Derrière un proxy/reverse-proxy, utiliser X-Forwarded-For si en prod
  const forwarded = req.headers['x-forwarded-for'];
  if (isProd && forwarded) return String(forwarded).split(',')[0].trim();
  return req.ip || req.socket?.remoteAddress || 'unknown';
}

function rateLimiter({ windowMs = 60_000, max = 30, message = 'Trop de requêtes. Réessayez dans un moment.' } = {}) {
  return (req, res, next) => {
    const ip = getClientIp(req);
    const key = `${ip}:${req.path}`;
    const now = Date.now();

    let entry = store.get(key);
    if (!entry || now > entry.resetAt) {
      entry = { count: 0, resetAt: now + windowMs };
      store.set(key, entry);
    }
    entry.count++;

    // Nettoyage périodique (toutes les 5 minutes pour éviter les fuites mémoire)
    if (Math.random() < 0.01) {
      for (const [k, v] of store.entries()) {
        if (now > v.resetAt) store.delete(k);
      }
    }

    if (entry.count > max) {
      const retryAfter = Math.ceil((entry.resetAt - now) / 1000);
      res.set('Retry-After', String(retryAfter));
      return next(new AppError(429, message));
    }
    next();
  };
}

// ─── Limiteurs spécialisés ──────────────────────────────────────────────────

/** Login / inscription : 10 tentatives / 15 min par IP */
export const authLimiter = rateLimiter({
  windowMs: 15 * 60_000,
  max: 10,
  message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.',
});

/** Réinitialisation de mot de passe : 5 / 15 min par IP */
export const passwordResetLimiter = rateLimiter({
  windowMs: 15 * 60_000,
  max: 5,
  message: 'Trop de demandes de réinitialisation. Réessayez dans 15 minutes.',
});

/** API globale : 120 req / min par IP */
export const apiLimiter = rateLimiter({
  windowMs: 60_000,
  max: 120,
  message: 'Trop de requêtes. Ralentissez.',
});

/** Paiements : 15 / 10 min par IP (évite le spam de paiements) */
export const paymentLimiter = rateLimiter({
  windowMs: 10 * 60_000,
  max: 15,
  message: 'Trop de demandes de paiement. Réessayez dans 10 minutes.',
});

// ─── Validation de taille du body ───────────────────────────────────────────

/** Refuse les requêtes dont le body dépasse la limite */
export function bodySizeGuard(limitBytes = 100_000) {
  return (req, res, next) => {
    const len = parseInt(req.headers['content-length'] || '0', 10);
    if (len > limitBytes) {
      return next(new AppError(413, 'Contenu trop volumineux.'));
    }
    next();
  };
}

// ─── Protection contre les headers suspects ─────────────────────────────────

const BLOCKED_UA_PATTERNS = [
  /sqlmap/i,
  /nikto/i,
  /nessus/i,
  /masscan/i,
  /zgrab/i,
  /python-requests\/[01]\./i, // vieilles versions souvent utilisées pour scanner
];

export function headerGuard(req, res, next) {
  const ua = req.headers['user-agent'] || '';
  if (BLOCKED_UA_PATTERNS.some((p) => p.test(ua))) {
    return res.status(403).json({ message: 'Accès refusé.' });
  }
  // Bloque les host headers suspects (protection contre Host Header Injection)
  const host = req.headers['host'] || '';
  if (host.includes('..') || host.includes('%')) {
    return res.status(400).json({ message: 'Requête invalide.' });
  }
  next();
}

// ─── Validation UUID ─────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Valide que req.params.id est un UUID avant d'aller en BD */
export function requireUuidParam(req, res, next) {
  const id = req.params.id;
  if (id && !UUID_RE.test(id)) {
    return next(new AppError(400, 'Identifiant invalide.'));
  }
  next();
}

// ─── Middleware de log sécurité (développement) ──────────────────────────────

export function securityLogger(req, res, next) {
  if (isProd) return next(); // en prod, utiliser un vrai logger (Winston/Pino)
  const start = Date.now();
  res.on('finish', () => {
    const ms = Date.now() - start;
    const ip = getClientIp(req);
    const status = res.statusCode;
    if (status >= 400) {
      console.warn(`[SEC] ${status} ${req.method} ${req.path} — ${ip} — ${ms}ms`);
    }
  });
  next();
}
