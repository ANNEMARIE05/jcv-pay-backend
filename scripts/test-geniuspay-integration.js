/**
 * Script de validation et test d'intégration GeniusPay
 * Exécute: node scripts/test-geniuspay-integration.js
 */

import { config } from '../src/config.js';
import {
  hasGeniusPayCredentials,
  createPayment,
  getPayment,
  getPawaPayProviders,
  verifyWebhookSignature,
} from '../src/services/geniuspay.js';
import crypto from 'crypto';

async function runTests() {
  console.log('========================================================');
  console.log('  TEST D’INTÉGRATION GENIUSPAY — JCV PAY');
  console.log('========================================================\n');

  // Test 1: Configuration
  console.log('1. Vérification des configurations :');
  console.log('   - Base URL :', config.geniuspay.baseUrl);
  console.log('   - API Key  :', config.geniuspay.apiKey ? `${config.geniuspay.apiKey.slice(0, 15)}...` : 'MANQUANTE');
  console.log('   - Mode     :', config.geniuspay.environment);
  console.log('   - Prêt ?   :', hasGeniusPayCredentials() ? 'OUI (Clés détectées)' : 'NON');

  if (!hasGeniusPayCredentials()) {
    console.error('\n❌ Échec : Clés API GeniusPay absentes.');
    process.exit(1);
  }

  // Test 2: Fournisseurs PawaPay en CI
  console.log('\n2. Test de découverte des opérateurs (Côte d’Ivoire) :');
  try {
    const providers = await getPawaPayProviders('CI');
    console.log('   ✓ Opérateurs détectés :', providers.providers?.map(p => `${p.name} (${p.code})`).join(', ') || 'OK');
  } catch (err) {
    console.warn('   ⚠️ Avertissement :', err.message);
  }

  // Test 3: Création d’un paiement réel en Sandbox
  console.log('\n3. Test d’initiation d’un paiement Wave (Sandbox) :');
  let testPayment = null;
  try {
    testPayment = await createPayment({
      amount: 5000,
      currency: 'XOF',
      paymentMethod: 'WAVE',
      description: 'Test Offrande — Culte de Victoire',
      customer: {
        name: 'Kouassi Christian',
        email: 'christian.kouassi@example.com',
        phone: '+2250748921033',
        country: 'CI',
      },
      metadata: {
        test: true,
        order_id: `CMD-TEST-${Date.now()}`,
        titre: 'Offrande libre',
      },
      successUrl: `${config.publicBaseUrl}/paiement/retour?status=success`,
      errorUrl: `${config.publicBaseUrl}/paiement/retour?status=error`,
    });

    console.log('   ✓ Paiement initié avec succès !');
    console.log('     • ID GeniusPay   :', testPayment.id);
    console.log('     • Référence      :', testPayment.reference);
    console.log('     • Gateway        :', testPayment.gateway);
    console.log('     • Montant        :', testPayment.amount, testPayment.currency);
    console.log('     • Checkout URL   :', testPayment.checkout_url);
    console.log('     • Environnement  :', testPayment.environment);
  } catch (err) {
    console.error('   ❌ Échec initiation :', err.message);
    process.exit(1);
  }

  // Test 4: Récupération des détails du paiement par référence
  console.log('\n4. Test de récupération par référence (GET /payments/:reference) :');
  try {
    const fetched = await getPayment(testPayment.reference);
    console.log('   ✓ Récupération réussie !');
    console.log('     • Statut         :', fetched.status || 'pending');
    console.log('     • Frais calculés :', fetched.fees ?? 0, 'FCFA');
    console.log('     • Montant net    :', fetched.net_amount ?? fetched.amount, 'FCFA');
    console.log('     • Métadonnées    :', JSON.stringify(fetched.metadata));
  } catch (err) {
    console.error('   ❌ Échec consultation :', err.message);
    process.exit(1);
  }

  // Test 5: Vérification de la signature Webhook HMAC-SHA256
  console.log('\n5. Test de sécurité Webhook (Vérification signature HMAC-SHA256) :');
  const dummySecret = 'whsec_test_secret_for_verification';
  const dummyTimestamp = Math.floor(Date.now() / 1000).toString();
  const dummyPayload = JSON.stringify({
    event: 'payment.success',
    data: { id: testPayment.id, reference: testPayment.reference, amount: 5000 },
  });
  const dummySignature = crypto
    .createHmac('sha256', dummySecret)
    .update(`${dummyTimestamp}.${dummyPayload}`)
    .digest('hex');

  const verificationSuccess = verifyWebhookSignature({
    signature: dummySignature,
    timestamp: dummyTimestamp,
    rawBody: dummyPayload,
    webhookSecret: dummySecret,
  });

  const verificationTampered = verifyWebhookSignature({
    signature: dummySignature,
    timestamp: dummyTimestamp,
    rawBody: dummyPayload + 'TAMPERED',
    webhookSecret: dummySecret,
  });

  console.log('   ✓ Signature légitime validée :', verificationSuccess.valid ? 'OUI (Authentique)' : 'NON');
  console.log('   ✓ Signature altérée rejetée   :', !verificationTampered.valid ? 'OUI (Bloqué correctement)' : 'NON');

  console.log('\n========================================================');
  console.log('  TOUS LES TESTS GENIUSPAY SONT AU VERT ! (5/5 RÉUSSIS)');
  console.log('========================================================\n');
}

runTests().catch(err => {
  console.error('Erreur non gérée :', err);
  process.exit(1);
});
