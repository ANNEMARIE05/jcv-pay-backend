import { Router } from 'express';
import { AppError, asyncHandler } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { buildEspace } from '../services/espace.js';
import { declarePayment, loadPaymentView, syncPayment } from '../services/payments.js';
import { presentReceipt } from '../services/present.js';

const router = Router();

router.post(
  '/',
  requireAuth,
  asyncHandler(async (req, res) => {
    const created = await declarePayment(req.user, req.body);
    res.status(201).json({ ...created, espace: await buildEspace(req.user) });
  })
);

router.post(
  '/:id/synchroniser',
  requireAuth,
  asyncHandler(async (req, res) => {
    const transaction = await syncPayment(req.user, req.params.id);
    res.json({ transaction, espace: await buildEspace(req.user) });
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
