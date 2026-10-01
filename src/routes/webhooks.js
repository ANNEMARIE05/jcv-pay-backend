import { Router } from 'express';
import { pool } from '../db.js';
import { asyncHandler } from '../errors.js';
import { verifyWebhookSignature } from '../services/geniuspay.js';
import { applyGatewayUpdate } from '../services/payments.js';

const router = Router();

router.post(
  '/geniuspay',
  asyncHandler(async (req, res) => {
    const signature = req.get('X-Webhook-Signature');
    const timestamp = req.get('X-Webhook-Timestamp');
    const event = req.get('X-Webhook-Event') || req.body?.event;
    const delivery = req.get('X-Webhook-Delivery') || req.body?.id;

    if (!verifyWebhookSignature({ rawBody: req.rawBody || '', timestamp, signature })) {
      return res.status(401).json({ message: 'Signature webhook invalide.' });
    }
    if (delivery) {
      const inserted = await pool.query(
        `INSERT INTO webhooks_recus (id, evenement) VALUES ($1, $2) ON CONFLICT DO NOTHING RETURNING id`,
        [String(delivery), event || 'inconnu']
      );
      if (!inserted.rowCount) return res.json({ received: true, duplicate: true });
    }

    const data = req.body?.data || req.body;
    const statusFromEvent = {
      'payment.success': 'completed',
      'payment.failed': 'failed',
      'payment.cancelled': 'cancelled',
      'payment.expired': 'expired',
      'payment.refunded': 'refunded',
    };
    if (event === 'webhook.test') return res.json({ received: true, test: true });
    if (event === 'payment.initiated') return res.json({ received: true });

    if (data && !data.status && statusFromEvent[event]) data.status = statusFromEvent[event];
    if (data?.reference || data?.metadata) await applyGatewayUpdate(data);
    res.json({ received: true });
  })
);

export default router;
