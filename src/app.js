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
import { syncPaymentByReference } from './services/payments.js';

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
        imgSrc: ["'self'", 'data:', 'https:'],
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

  app.get('/paiement/retour', async (req, res) => {
    const rawStatus = String(req.query.status || '').toLowerCase();
    const isSuccess = rawStatus === 'success';
    const ref = String(req.query.ref || '').trim();

    let view = null;
    if (ref) {
      try {
        view = await syncPaymentByReference(ref, rawStatus);
      } catch (err) {
        console.warn('[Paiement Retour Sync Warning]', err.message);
      }
    }

    const isValide = view?.statut === 'VALIDE';
    const isPendingTreasury =
      view?.statut === 'EN_ATTENTE' &&
      view?.montant_net != null &&
      Boolean(view?.geniuspay_id || view?.geniuspay_reference);
    const isGatewayOk = isValide || isPendingTreasury || (isSuccess && Boolean(view?.recu_id));
    const recuId = view?.recu_id || '';
    const montantNum = view?.montant ? Number(view.montant) : null;
    const montantStr = montantNum ? `${montantNum.toLocaleString('fr-FR')} FCFA` : '';
    const titreStr = view?.titre || 'Contribution Financière';
    const numeroRecu = view?.numero_recu || '';

    // URL de redirection vers l'application mobile (deep link Expo scheme: jcvpay)
    const deepLink = isGatewayOk
      ? (recuId ? `jcvpay://recu/${recuId}?choix=1` : 'jcvpay://recus')
      : `jcvpay://paiement?error=1&ref=${encodeURIComponent(ref)}`;

    // URL de secours Web
    const webUrl = isGatewayOk
      ? (recuId ? `${config.clientUrl}/recu/${recuId}?choix=1` : `${config.clientUrl}/recus`)
      : `${config.clientUrl}/paiement?error=1&ref=${encodeURIComponent(ref)}`;

    const pageTitle = isValide
      ? 'Paiement confirmé'
      : isPendingTreasury
        ? 'Paiement en attente de confirmation'
        : 'Paiement non abouti';
    const heading = isValide
      ? 'Paiement confirmé !'
      : isPendingTreasury
        ? 'Paiement enregistré'
        : 'Paiement non abouti';
    const description = isValide
      ? 'Votre contribution a été validée avec succès. Votre reçu officiel a été généré et certifié.'
      : isPendingTreasury
        ? 'Votre paiement en ligne a bien été reçu. La trésorerie du Temple confirmera la réception avant la certification du reçu officiel.'
        : 'La transaction n’a pas pu être validée ou a été annulée. Vous pouvez réessayer votre paiement.';
    const iconChar = isValide ? '✓' : isPendingTreasury ? '⏳' : '✕';
    const toneOk = isValide;
    const tonePending = isPendingTreasury;
    const statusBadge = isValide
      ? '<span class="badge-ok">Validé</span>'
      : isPendingTreasury
        ? '<span class="badge-warn">En attente trésorerie</span>'
        : '<span class="badge-err">Non validé</span>';
    const primaryBtn = isValide
      ? 'Ouvrir mon reçu dans l’application'
      : isPendingTreasury
        ? 'Suivre mon versement dans l’application'
        : 'Réessayer dans l’application';
    const secondaryBtn = isValide
      ? 'Consulter le reçu sur le Web'
      : isPendingTreasury
        ? 'Voir le statut sur le Web'
        : 'Retourner au formulaire';
    const iconBg = toneOk
      ? 'rgba(16, 185, 129, 0.15)'
      : tonePending
        ? 'rgba(245, 158, 11, 0.15)'
        : 'rgba(239, 68, 68, 0.15)';
    const iconColor = toneOk ? '#10B981' : tonePending ? '#F59E0B' : '#EF4444';
    const iconBorder = iconColor;
    const iconShadow = toneOk
      ? 'rgba(16, 185, 129, 0.25)'
      : tonePending
        ? 'rgba(245, 158, 11, 0.25)'
        : 'rgba(239, 68, 68, 0.25)';
    const headingColor = toneOk ? '#34D399' : tonePending ? '#FBBF24' : '#F87171';
    const btnPrimaryBg = toneOk ? '#0D9488' : tonePending ? '#D97706' : '#DC2626';
    const btnPrimaryShadow = toneOk
      ? 'rgba(13, 148, 136, 0.35)'
      : tonePending
        ? 'rgba(217, 119, 6, 0.35)'
        : 'rgba(220, 38, 38, 0.35)';

    res.type('html').send(`<!doctype html>
      <html lang="fr">
      <head>
        <meta charset="utf-8">
        <meta name="viewport" content="width=device-width, initial-scale=1">
        <title>JCV Pay — ${pageTitle}</title>
        <script>
          // Tentative d'ouverture immédiate de l'application JCV Pay
          const deepLink = ${JSON.stringify(deepLink)};
          const webUrl = ${JSON.stringify(webUrl)};
          try {
            window.location.href = deepLink;
          } catch (e) {
            console.warn(e);
          }
        </script>
        <style>
          * { box-sizing: border-box; margin: 0; padding: 0; }
          body {
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            background: #0B1120;
            color: #F8FAFC;
            display: flex;
            align-items: center;
            justify-content: center;
            min-height: 100vh;
            padding: 24px;
          }
          .card {
            background: #151E32;
            border: 1px solid #1E293B;
            border-radius: 28px;
            max-width: 460px;
            width: 100%;
            padding: 38px 28px;
            text-align: center;
            box-shadow: 0 25px 50px -12px rgba(0, 0, 0, 0.5);
          }
          .brand {
            font-size: 13px;
            font-weight: 700;
            text-transform: uppercase;
            letter-spacing: 1.5px;
            color: #D97706;
            margin-bottom: 20px;
          }
          .icon-box {
            width: 80px;
            height: 80px;
            border-radius: 40px;
            display: inline-flex;
            align-items: center;
            justify-content: center;
            font-size: 38px;
            font-weight: 700;
            margin-bottom: 20px;
            background: ${iconBg};
            color: ${iconColor};
            border: 2px solid ${iconBorder};
            box-shadow: 0 0 25px ${iconShadow};
          }
          h1 {
            font-size: 23px;
            font-weight: 800;
            margin-bottom: 10px;
            color: ${headingColor};
          }
          .desc {
            color: #94A3B8;
            font-size: 14px;
            line-height: 1.6;
            margin-bottom: 24px;
          }
          .info-table {
            background: #0F172A;
            border: 1px solid #1E293B;
            border-radius: 18px;
            padding: 16px 18px;
            margin-bottom: 24px;
            text-align: left;
          }
          .info-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 8px 0;
            border-bottom: 1px solid #1E293B;
            font-size: 13px;
          }
          .info-row:last-child { border-bottom: none; }
          .info-label { color: #64748B; font-weight: 500; }
          .info-value { color: #F1F5F9; font-weight: 700; text-align: right; }
          .info-value.amount { color: #34D399; font-size: 15px; }
          .badge-ok {
            display: inline-block;
            background: rgba(16, 185, 129, 0.15);
            color: #34D399;
            padding: 4px 10px;
            border-radius: 8px;
            font-weight: 700;
            font-size: 12px;
          }
          .badge-err {
            display: inline-block;
            background: rgba(239, 68, 68, 0.15);
            color: #F87171;
            padding: 4px 10px;
            border-radius: 8px;
            font-weight: 700;
            font-size: 12px;
          }
          .badge-warn {
            display: inline-block;
            background: rgba(245, 158, 11, 0.15);
            color: #FBBF24;
            padding: 4px 10px;
            border-radius: 8px;
            font-weight: 700;
            font-size: 12px;
          }
          .actions {
            display: flex;
            flex-direction: column;
            gap: 12px;
          }
          .btn-primary {
            display: block;
            width: 100%;
            background: ${btnPrimaryBg};
            color: white;
            text-decoration: none;
            padding: 15px 20px;
            border-radius: 14px;
            font-weight: 700;
            font-size: 15px;
            transition: all 0.2s;
            box-shadow: 0 4px 12px ${btnPrimaryShadow};
          }
          .btn-primary:hover {
            opacity: 0.92;
            transform: translateY(-1px);
          }
          .btn-secondary {
            display: block;
            width: 100%;
            background: transparent;
            color: #94A3B8;
            text-decoration: none;
            padding: 13px 20px;
            border-radius: 14px;
            font-weight: 600;
            font-size: 14px;
            border: 1px solid #334155;
            transition: all 0.2s;
          }
          .btn-secondary:hover {
            background: #1E293B;
            color: #F8FAFC;
          }
          .subtext {
            font-size: 12px;
            color: #475569;
            margin-top: 20px;
          }
        </style>
      </head>
      <body>
        <div class="card">
          <div class="brand">JCV Pay • Église Jésus Christ Victoire</div>
          <div class="icon-box">${iconChar}</div>
          <h1>${heading}</h1>
          <p class="desc">${description}</p>

          <div class="info-table">
            ${montantStr ? `
            <div class="info-row">
              <span class="info-label">Montant</span>
              <span class="info-value amount">${montantStr}</span>
            </div>` : ''}
            <div class="info-row">
              <span class="info-label">Versement</span>
              <span class="info-value">${titreStr}</span>
            </div>
            ${numeroRecu ? `
            <div class="info-row">
              <span class="info-label">Reçu N°</span>
              <span class="info-value">${numeroRecu}</span>
            </div>` : ''}
            ${ref ? `
            <div class="info-row">
              <span class="info-label">Référence</span>
              <span class="info-value" style="font-family: monospace;">${ref}</span>
            </div>` : ''}
            <div class="info-row">
              <span class="info-label">Statut</span>
              <span>${statusBadge}</span>
            </div>
          </div>

          <div class="actions">
            <a class="btn-primary" href="${deepLink}">
              ${primaryBtn}
            </a>
            <a class="btn-secondary" href="${webUrl}">
              ${secondaryBtn}
            </a>
          </div>

          <div class="subtext">
            Si l’application ne s’ouvre pas automatiquement, appuyez sur le bouton ci-dessus.
          </div>
        </div>
      </body>
      </html>`);
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
