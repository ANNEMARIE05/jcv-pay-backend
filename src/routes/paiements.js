import { Router } from 'express';
import { AppError, asyncHandler } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { buildEspace } from '../services/espace.js';
import { declarePayment, loadPaymentView, syncPayment } from '../services/payments.js';
import { presentReceipt, presentTransaction } from '../services/present.js';
import { hasGeniusPayCredentials } from '../services/geniuspay.js';
import { config } from '../config.js';

const router = Router();

router.get(
  '/config',
  asyncHandler(async (_req, res) => {
    res.json({
      geniuspayEnabled: hasGeniusPayCredentials(),
      environment: config.geniuspay.environment,
      supportedOnlineMethods: ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'CARTE_BANCAIRE'],
    });
  })
);

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'http';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const requestBaseUrl = host ? `${proto}://${host}` : null;
    const platform = req.body.platform || (req.headers['user-agent']?.toLowerCase().includes('mobile') ? 'mobile' : 'web');
    const appRedirect = req.body.appRedirect || req.body.returnUrl || null;
    const created = await declarePayment(req.user, req.body, { requestBaseUrl, platform, appRedirect });
    res.status(201).json({ ...created, espace: await buildEspace(req.user) });
  })
);

router.post(
  '/:id/synchroniser',
  requireAuth,
  asyncHandler(async (req, res) => {
    const transaction = await syncPayment(req.user, req.params.id);
    const view = await loadPaymentView(req.params.id);
    const recu = view ? presentReceipt(view) : null;
    res.json({ transaction, recu, espace: await buildEspace(req.user) });
  })
);

router.get(
  '/:id/statut',
  requireAuth,
  asyncHandler(async (req, res) => {
    const view = await loadPaymentView(req.params.id);
    if (!view) throw new AppError(404, 'Paiement introuvable.');
    const owner = view.donateur_user_id === req.user.id;
    const staff = ['SUPER_ADMIN', 'ADMINISTRATEUR', 'TRESORIER'].includes(req.user.role);
    if (!owner && !staff) throw new AppError(403, 'Accès refusé.');
    res.json({
      id: view.id,
      reference: view.reference,
      statut: view.statut,
      moyenPaiement: view.moyen_paiement,
      recuId: view.recu_id,
      numeroRecu: view.numero_recu,
      motifRejet: view.motif_rejet || null,
      isCompleted: view.statut === 'VALIDE',
    });
  })
);

router.get(
  '/recus/:id',
  requireAuth,
  asyncHandler(async (req, res) => {
    const row = await loadPaymentView(req.params.id);
    if (!row || !row.recu_id) throw new AppError(404, 'Reçu introuvable.');
    const owner = row.donateur_user_id === req.user.id;
    const staff = ['SUPER_ADMIN', 'ADMINISTRATEUR', 'TRESORIER'].includes(req.user.role);
    if (!owner && !staff) throw new AppError(403, 'Accès refusé.');
    res.json(presentReceipt(row));
  })
);

export default router;
