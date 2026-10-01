import dotenv from 'dotenv';

dotenv.config();

/**
 * Deux formats supportés (https://geniuspay.ci/docs/api) :
 * - doc : X-API-Key = pk_* , X-API-Secret = sk_*
 * - dashboard : sk_* → X-API-Key ou Bearer ; ss_* → signature HMAC des requêtes (pas X-API-Secret)
 */
export function resolveGeniusCredentials() {
  const rawPublic = (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_API_KEY || '').trim();
  const rawSecret = (process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_SECRET || '').trim();

  let publicKey = rawPublic;
  let secretKey = rawSecret;

  if (publicKey.startsWith('sk_') && secretKey.startsWith('pk_')) {
    [publicKey, secretKey] = [secretKey, publicKey];
  }

  if (publicKey.startsWith('pk_') && secretKey.startsWith('sk_')) {
    return { publicKey, secretKey, authMode: 'doc' };
  }

  if (publicKey.startsWith('sk_') && secretKey.startsWith('ss_')) {
    return { publicKey, secretKey, authMode: 'dashboard' };
  }

  if (publicKey.startsWith('pk_') && secretKey.startsWith('ss_')) {
    return { publicKey, secretKey: '', authMode: 'doc-partial' };
  }

  if (!publicKey && secretKey.startsWith('sk_')) {
    return { publicKey: '', secretKey, authMode: 'doc-partial' };
  }

  if (publicKey.startsWith('sk_') && secretKey.startsWith('sk_')) {
    return { publicKey: '', secretKey, authMode: 'doc-partial' };
  }

  return { publicKey, secretKey, authMode: 'unknown' };
}

const geniusCredentials = resolveGeniusCredentials();

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgres://jcv:jcv@localhost:5433/jcv_pay',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
  genius: {
    baseUrl: (process.env.GENIUSPAY_BASE_URL || 'https://geniuspay.ci/api/v1/merchant').replace(/\/$/, ''),
    publicKey: geniusCredentials.publicKey,
    secretKey: geniusCredentials.secretKey,
    authMode: geniusCredentials.authMode,
    webhookSecret: process.env.GENIUSPAY_WEBHOOK_SECRET || '',
    useHostedCheckout: process.env.GENIUSPAY_USE_CHECKOUT !== '0',
    simulate: process.env.GENIUSPAY_SIMULATE === '1',
  },
  org: {
    nom: 'Église Jésus Christ Victoire',
    adresse: 'Boulevard de la Victoire, Abidjan',
    paroisse: 'Église Jésus Christ Victoire - Abidjan',
  },
};

export const isProd = config.nodeEnv === 'production';

export function geniusCredentialsStatus() {
  const { authMode, publicKey, secretKey } = config.genius;
  if (authMode === 'doc' || authMode === 'dashboard') return { ok: true, authMode };
  if (authMode === 'doc-partial') {
    return {
      ok: false,
      authMode,
      hint:
        'Ajoutez GENIUSPAY_PUBLIC_KEY=pk_sandbox_… (doc). Si vous n’avez que sk_ + ss_ du dashboard, renseignez les deux dans PUBLIC_KEY et SECRET_KEY.',
    };
  }
  return {
    ok: false,
    authMode,
    hint: 'GENIUSPAY_PUBLIC_KEY et GENIUSPAY_SECRET_KEY requis — https://geniuspay.ci/docs/api',
  };
}

const status = geniusCredentialsStatus();
if (!status.ok && (process.env.GENIUSPAY_PUBLIC_KEY || process.env.GENIUSPAY_SECRET_KEY || process.env.GENIUSPAY_API_KEY)) {
  console.warn('GeniusPay : configuration incomplète —', status.hint);
}
