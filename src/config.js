import dotenv from 'dotenv';

dotenv.config();

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  databaseUrl: process.env.DATABASE_URL || 'postgres://jcv:jcv@localhost:5433/jcv_pay',
  jwtSecret: process.env.JWT_SECRET || 'dev-only-change-me',
  jwtExpires: process.env.JWT_EXPIRES || '7d',
  publicBaseUrl: (process.env.PUBLIC_BASE_URL || 'http://localhost:4000').replace(/\/$/, ''),
  genius: {
    baseUrl: (process.env.GENIUSPAY_BASE_URL || 'https://geniuspay.ci/api/v1/merchant').replace(/\/$/, ''),
    apiKey: process.env.GENIUSPAY_API_KEY || '',
    apiSecret: process.env.GENIUSPAY_API_SECRET || '',
    webhookSecret: process.env.GENIUSPAY_WEBHOOK_SECRET || '',
  },
  org: {
    nom: 'Église Jésus Christ Victoire',
    adresse: 'Boulevard de la Victoire, Abidjan',
    paroisse: 'Église Jésus Christ Victoire - Abidjan',
  },
};

export const isProd = config.nodeEnv === 'production';
