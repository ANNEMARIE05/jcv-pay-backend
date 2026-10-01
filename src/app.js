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

export function createApp() {
  const app = express();
  const secureHeaders = helmet();
  app.use((req, res, next) => {
    if (req.path === '/api/docs' || req.path.startsWith('/api/docs/')) return next();
    secureHeaders(req, res, next);
  });
  app.use(cors());
  app.use(
    express.json({
      limit: '1mb',
      verify: (req, _res, buf) => {
        req.rawBody = buf.toString('utf8');
      },
    })
  );

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
      <html lang="fr"><head><meta charset="utf-8"><title>JCV Pay</title></head>
      <body style="font-family:sans-serif;padding:32px">
        <h1>${ok ? 'Paiement transmis' : 'Paiement non abouti'}</h1>
        <p>Vous pouvez fermer cette page et revenir dans l’application JCV Pay. Le reçu se met à jour dès confirmation de GeniusPay.</p>
      </body></html>`);
  });

  app.use('/api/auth', authRoutes);
  app.use('/api', resourceRoutes);
  app.use('/api/paiements', paymentRoutes);
  app.use('/api/webhooks', webhookRoutes);

  app.use((req, res) => {
    res.status(404).json({ message: `Route introuvable : ${req.method} ${req.path}` });
  });

  app.use((error, _req, res, _next) => {
    const status = error instanceof AppError ? error.status : 500;
    if (status >= 500) console.error(error);
    res.status(status).json({
      message: status >= 500 ? 'Erreur interne du serveur.' : error.message,
    });
  });

  return app;
}
