import { Router } from 'express';
import { asyncHandler } from '../errors.js';
import { verifyWebhookSignature } from '../services/geniuspay.js';
import { handleWebhookEvent } from '../services/payments.js';

const router = Router();

/**
 * Webhook GeniusPay
 * Endpoint: POST /api/webhooks/geniuspay
 * Événements supportés: payment.success, payment.failed, payment.cancelled, payment.expired, webhook.test
 */
router.post(
  '/geniuspay',
  asyncHandler(async (req, res) => {
    const signature = req.headers['x-webhook-signature'];
    const timestamp = req.headers['x-webhook-timestamp'];
    const event = req.headers['x-webhook-event'] || req.body?.event;
    const environment = req.headers['x-webhook-environment'] || req.body?.environment;

    console.log(`[GeniusPay Webhook] Événement reçu: "${event}" (${environment || 'inconnu'})`);

    // Vérifier la signature si le secret ou la signature est fournie
    if (signature) {
      const verification = verifyWebhookSignature({
        signature,
        timestamp,
        rawBody: req.rawBody,
      });

      if (!verification.valid) {
        console.warn('[GeniusPay Webhook] Rejeté :', verification.reason);
        return res.status(401).json({
          status: 401,
          detail: verification.reason || 'Invalid signature',
        });
      }
    }

    if (event === 'webhook.test') {
      return res.status(200).json({
        success: true,
        message: 'Webhook test reçu avec succès par JCV Pay',
      });
    }

    // Traitement de l'événement de paiement
    const result = await handleWebhookEvent(event, req.body);

    return res.status(200).json({
      success: true,
      handled: result.handled ?? true,
      event,
    });
  })
);

export default router;
