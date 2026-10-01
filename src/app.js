import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import swaggerUi from 'swagger-ui-express';
import authRoutes from './routes/auth.js';
import resourceRoutes from './routes/resources.js';
import paymentRoutes from './routes/paiements.js';
import webhookRoutes from './routes/webhooks.js';
import { openApiDocument } from './docs/openapi.js';
import { AppError } from './errors.js';
import { config, isProd } from './config.js';
import { loadPaymentView, setPaymentStatus } from './services/payments.js';
import {
  apiLimiter,
  authLimiter,
  passwordResetLimiter,
  paymentLimiter,
  headerGuard,
  securityLogger,
  bodySizeGuard,
} from './middleware/security.js';
import { ipBlockMiddleware } from './services/audit.js';

export function createApp() {
  const app = express();

  // ── Proxy trust (Render, Railway, Nginx) ──────────────────────────────
  if (isProd) app.set('trust proxy', 1);

  // ── Helmet : headers de sécurité HTTP ────────────────────────────────
  const secureHeaders = helmet({
    crossOriginEmbedderPolicy: false, // compatible mobile/web
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'", "'unsafe-inline'"],   // pour la page retour
        styleSrc: ["'self'", "'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        connectSrc: ["'self'"],
        frameSrc: ["'none'"],
        objectSrc: ["'none'"],
      },
    },
  });
  app.use((req, res, next) => {
    if (req.path === '/api/docs' || req.path.startsWith('/api/docs/')) return next();
    secureHeaders(req, res, next);
  });

  // ── CORS : autoriser uniquement les origines connues ─────────────────
  const allowedOrigins = [
    'http://localhost:3000',
    'http://localhost:5173',
    'http://localhost:19006',        // Expo web
    config.publicBaseUrl,
  ].filter(Boolean);
  app.use(cors({
    origin: isProd
      ? (origin, cb) => {
          if (!origin || allowedOrigins.some((o) => origin.startsWith(o))) cb(null, true);
          else cb(new Error('CORS non autorisé'));
        }
      : true,
    credentials: true,
    methods: ['GET', 'POST', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
  }));

  // ── Body parser : limite stricte à 200 Ko ────────────────────────────
  app.use(
    express.json({
      limit: '200kb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

  // ── Middlewares de sécurité globaux ───────────────────────────────────
  app.use(securityLogger);
  app.use(headerGuard);
  app.use(ipBlockMiddleware);
  app.use('/api', apiLimiter);

  app.get('/api/sante', (_req, res) => {
    res.json({ ok: true, service: 'jcv-pay' });
  });

  app.get('/api/openapi.json', (_req, res) => {
    res.json(openApiDocument);
  });
  app.use(
    '/api/docs',
    swaggerUi.serve,
    swaggerUi.setup(openApiDocument, {
      customSiteTitle: 'JCV Pay — API',
      swaggerOptions: {
        persistAuthorization: true,
        displayRequestDuration: true,
      },
    })
  );

  app.get('/paiement/retour', (req, res) => {
    const ok = req.query.status === 'success';
    res.type('html').send(`<!doctype html>
      <html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>JCV Pay</title></head>
      <body style="font-family:sans-serif;padding:32px;text-align:center;">
        <h1 style="color:${ok ? '#15803d' : '#b91c1c'};margin-bottom:12px;">${ok ? '✓ Paiement confirmé' : '✕ Paiement non abouti'}</h1>
        <p style="color:#475569;font-size:15px;line-height:1.5;">Vous pouvez fermer cette page et revenir dans l’application JCV Pay.<br>Le reçu se met à jour immédiatement.</p>
      </body></html>`);
  });

  app.get('/paiement/simulation', async (req, res) => {
    const txId = req.query.tx;
    if (!txId) return res.status(400).send('Transaction ID manquant.');
    const row = await loadPaymentView(txId);
    if (!row) return res.status(404).send('Transaction introuvable.');
    if (row.statut === 'VALIDE') {
      return res.redirect(`${config.publicBaseUrl}/paiement/retour?status=success`);
    }
    const formattedAmount = Number(row.montant).toLocaleString('fr-FR');
    res.type('html').send(`<!doctype html>
      <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>Simulateur GeniusPay — JCV Pay</title>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: #f1f5f9; color: #1e293b; display: flex; align-items: center; justify-content: center; min-height: 100vh; padding: 20px; }
          .card { background: white; border-radius: 20px; box-shadow: 0 10px 30px rgba(0,0,0,0.06); max-width: 440px; width: 100%; padding: 28px; }
          .tag { display: inline-block; background: #fef3c7; color: #92400e; font-size: 11px; font-weight: 700; padding: 4px 10px; border-radius: 9999px; text-transform: uppercase; margin-bottom: 12px; }
          h1 { font-size: 20px; font-weight: 700; color: #0f172a; margin-bottom: 4px; }
          .sub { font-size: 13px; color: #64748b; margin-bottom: 20px; }
          .amount-box { background: #f0fdf4; border: 1.5px dashed #86efac; border-radius: 14px; padding: 18px; text-align: center; margin-bottom: 20px; }
          .amount { font-size: 32px; font-weight: 800; color: #15803d; }
          .details { background: #f8fafc; border-radius: 12px; padding: 14px; font-size: 13px; color: #475569; margin-bottom: 24px; line-height: 1.8; }
          .details strong { color: #0f172a; }
          .btn-pay { display: block; width: 100%; background: #004d40; color: white; border: none; padding: 15px; border-radius: 12px; font-size: 15px; font-weight: 700; cursor: pointer; transition: background 0.2s; }
          .btn-pay:hover { background: #00382e; }
          .btn-cancel { display: block; text-align: center; margin-top: 10px; color: #94a3b8; text-decoration: none; font-size: 13px; padding: 8px; }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="tag">Simulateur GeniusPay Sandbox</div>
          <h1>JCV Pay</h1>
          <p class="sub">${row.titre || 'Paiement de versement'}</p>
          <div class="amount-box">
            <div class="amount">${formattedAmount} FCFA</div>
          </div>
          <div class="details">
            <div><strong>Donateur :</strong> ${row.donateur_nom || 'Anonyme'}</div>
            <div><strong>Téléphone :</strong> ${row.donateur_telephone || '—'}</div>
            <div><strong>Mode sélectionné :</strong> ${row.moyen_paiement || 'MOBILE MONEY'}</div>
          </div>
          <form method="POST" action="/paiement/simulation/valider">
            <input type="hidden" name="transactionId" value="${row.id}" />
            <button type="submit" class="btn-pay">Confirmer le paiement (Test)</button>
          </form>
          <a href="/paiement/retour?status=error" class="btn-cancel">Annuler la transaction</a>
        </div>
      </body>
      </html>`);
  });

  app.post('/paiement/simulation/valider', express.urlencoded({ extended: true }), async (req, res) => {
    const txId = req.body.transactionId;
    if (!txId) return res.status(400).send('Transaction ID manquant.');
    try {
      await setPaymentStatus(null, txId, 'VALIDE');
      res.redirect(`${config.publicBaseUrl}/paiement/retour?status=success`);
    } catch (e) {
      res.status(500).send('Erreur validation : ' + e.message);
    }
  });

  // ── Routes applicatives ───────────────────────────────────────────────
  app.use('/api/auth', authLimiter, authRoutes);
  app.use('/api', resourceRoutes);
  app.use('/api/paiements', paymentLimiter, paymentRoutes);
  app.use('/api/webhooks', webhookRoutes);

  app.use((req, res) => {
    res.status(404).json({ message: `Route introuvable : ${req.method} ${req.path}` });
  });

  app.use((error, _req, res, _next) => {
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) console.error('[ERR]', error.message, error.stack?.split('\n')[1] || '');
    // Ne pas exposer les détails d'erreur en production
    const message =
      status >= 500
        ? isProd
          ? 'Erreur interne du serveur.'
          : error.message
        : error.message;
    res.status(status).json({ message });
  });

  return app;
}
