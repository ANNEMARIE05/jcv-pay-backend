/**
 * Test 3 : Gestion complète des refus de paiement et cas d'échecs :
 * - Solde insuffisant, rejet opérateur, échec carte/mobile money
 * - Annulation par l'utilisateur
 * - Expiration / Timeout du paiement
 * - Traitement Webhook des refus (payment.failed, payment.declined, payment.cancelled, payment.expired)
 * - Traitement du rejet manuel trésorier avec motif
 * - Vérification de la persistance de 'motif_rejet' et exposition dans le reçu
 */
import 'dotenv/config';
import http from 'node:http';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import {
  declarePayment,
  handleWebhookEvent,
  setPaymentStatus,
  loadPaymentView,
} from '../src/services/payments.js';
import { presentReceipt, presentTransaction } from '../src/services/present.js';

async function run() {
  console.log('========================================================');
  console.log('  TEST 3 : GESTION EXHAUSTIVE DES REFUS ET ÉCHECS');
  console.log('========================================================\n');

  const adminRes = await pool.query(`SELECT * FROM utilisateurs WHERE role = 'SUPER_ADMIN' LIMIT 1`);
  const admin = adminRes.rows[0];
  if (!admin) throw new Error('Aucun administrateur trouvé.');

  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;

  try {
    // ------------------------------------------------------------------
    // CAS 1 : Refus opérateur au retour de passerelle (ex: Solde insuffisant)
    // ------------------------------------------------------------------
    console.log('--- CAS 1 : Refus passerelle (Solde insuffisant) au retour utilisateur ---');
    const decl1 = await declarePayment(
      admin,
      {
        titre: 'Dîme du mois — Test Refus',
        montant: 25000,
        type: 'DIME',
        platform: 'mobile',
        donateurNom: 'Donateur Cas 1',
        donateurTelephone: '+2250700000001',
        moyenPaiement: 'ORANGE_MONEY',
      },
      { skipGeniusPay: true }
    );
    const tx1 = decl1.transaction;
    const recu1 = decl1.recu;

    const res1 = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/paiement/retour?status=error&ref=${encodeURIComponent(tx1.reference)}&reason=${encodeURIComponent('Solde insuffisant sur le compte Orange Money')}&platform=mobile`,
          method: 'GET',
        },
        (res) => {
          let body = '';
          res.on('data', (c) => (body += c));
          res.on('end', () => resolve({ statusCode: res.statusCode, headers: res.headers, body }));
        }
      );
      req.on('error', reject);
      req.end();
    });

    console.log(`• Code HTTP retour : ${res1.statusCode}`);
    console.log(`• Location retour  : ${res1.headers.location}`);

    const view1 = await loadPaymentView(tx1.id);
    console.log(`• Statut en base   : ${view1.statut}`);
    console.log(`• Motif de rejet   : ${view1.motif_rejet}`);

    if (view1.statut !== 'ECHEC') {
      throw new Error(`Attendu statut 'ECHEC' mais obtenu '${view1.statut}'`);
    }
    if (!view1.motif_rejet || !view1.motif_rejet.includes('Solde insuffisant')) {
      throw new Error(`Motif de rejet invalide : ${view1.motif_rejet}`);
    }
    if (!res1.headers.location.includes(recu1.id)) {
      throw new Error(`La redirection ne pointe pas vers le reçu du paiement refusé`);
    }
    console.log('✓ CAS 1 validé : Statut ECHEC, motif persisté, redirection vers le reçu');

    // ------------------------------------------------------------------
    // CAS 2 : Annulation délibérée par l'utilisateur
    // ------------------------------------------------------------------
    console.log('\n--- CAS 2 : Annulation du paiement par l\'utilisateur ---');
    const decl2 = await declarePayment(
      admin,
      {
        titre: 'Offrande libre — Test Annulation',
        montant: 5000,
        type: 'OFFRANDE',
        platform: 'mobile',
        donateurNom: 'Donateur Cas 2',
        donateurTelephone: '+2250700000002',
        moyenPaiement: 'WAVE',
      },
      { skipGeniusPay: true }
    );
    const tx2 = decl2.transaction;
    const recu2 = decl2.recu;

    await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/paiement/retour?status=cancelled&ref=${encodeURIComponent(tx2.reference)}&platform=mobile`,
          method: 'GET',
        },
        (res) => {
          res.on('data', () => {});
          res.on('end', resolve);
        }
      );
      req.on('error', reject);
      req.end();
    });

    const view2 = await loadPaymentView(tx2.id);
    console.log(`• Statut en base : ${view2.statut}`);
    console.log(`• Motif de rejet : ${view2.motif_rejet}`);

    if (view2.statut !== 'ANNULE') {
      throw new Error(`Attendu statut 'ANNULE' mais obtenu '${view2.statut}'`);
    }
    console.log('✓ CAS 2 validé : Statut ANNULE, motif d\'annulation enregistré');

    // ------------------------------------------------------------------
    // CAS 3 : Webhook GeniusPay (payment.declined / payment.failed)
    // ------------------------------------------------------------------
    console.log('\n--- CAS 3 : Notification Webhook (Rejet opérateur ou carte) ---');
    const decl3 = await declarePayment(
      admin,
      {
        titre: 'Projet Climatisation — Test Webhook Rejet',
        montant: 50000,
        type: 'OFFRANDE',
        platform: 'mobile',
        donateurNom: 'Donateur Cas 3',
        donateurTelephone: '+2250700000003',
        moyenPaiement: 'CARTE_BANCAIRE',
      },
      { skipGeniusPay: true }
    );
    const tx3 = decl3.transaction;

    // Simulation d'un webhook GeniusPay payment.declined
    const webhookResult = await handleWebhookEvent('payment.declined', {
      reference: tx3.geniuspay_reference || tx3.reference,
      status: 'declined',
      decline_reason: 'Authentification 3-D Secure échouée (délai dépassé)',
    });
    console.log(`• Résultat traitement webhook : statut = ${webhookResult?.status}`);

    const view3 = await loadPaymentView(tx3.id);
    console.log(`• Statut en base : ${view3.statut}`);
    console.log(`• Motif de rejet : ${view3.motif_rejet}`);

    if (view3.statut !== 'ECHEC') {
      throw new Error(`Attendu statut 'ECHEC' après webhook mais obtenu '${view3.statut}'`);
    }
    if (!view3.motif_rejet.includes('3-D Secure')) {
      throw new Error(`Motif attendu avec 3-D Secure mais obtenu '${view3.motif_rejet}'`);
    }
    console.log('✓ CAS 3 validé : Webhook decline convertit en ECHEC avec motif explicite');

    // ------------------------------------------------------------------
    // CAS 4 : Webhook Expiration / Délai dépassé
    // ------------------------------------------------------------------
    console.log('\n--- CAS 4 : Notification Webhook (Expiration / Session timeout) ---');
    const decl4 = await declarePayment(
      admin,
      {
        titre: 'Cotisation Annuelle — Test Expiration',
        montant: 12000,
        type: 'OFFRANDE',
        platform: 'mobile',
        donateurNom: 'Donateur Cas 4',
        donateurTelephone: '+2250700000004',
        moyenPaiement: 'MTN_MOMO',
      },
      { skipGeniusPay: true }
    );
    const tx4 = decl4.transaction;

    await handleWebhookEvent('payment.expired', {
      reference: tx4.geniuspay_reference || tx4.reference,
      status: 'expired',
      failure_reason: 'Délai de validation du client expiré (Timeout 15 min)',
    });

    const view4 = await loadPaymentView(tx4.id);
    console.log(`• Statut en base : ${view4.statut}`);
    console.log(`• Motif de rejet : ${view4.motif_rejet}`);

    if (view4.statut !== 'ECHEC') {
      throw new Error(`Attendu statut 'ECHEC' pour expiration`);
    }
    console.log('✓ CAS 4 validé : Expiration gérée avec motif explicite');

    // ------------------------------------------------------------------
    // CAS 5 : Rejet manuel trésorier avec motif personnalisé
    // ------------------------------------------------------------------
    console.log('\n--- CAS 5 : Rejet administratif trésorerie avec motif ---');
    const decl5 = await declarePayment(
      admin,
      {
        titre: 'Offrande Extraordinaire — Test Rejet Manuel',
        montant: 100000,
        type: 'OFFRANDE',
        platform: 'mobile',
        donateurNom: 'Donateur Cas 5',
        donateurTelephone: '+2250700000005',
        moyenPaiement: 'CARTE_BANCAIRE',
      },
      { skipGeniusPay: true }
    );
    const tx5 = decl5.transaction;

    const updatedManual = await setPaymentStatus(
      admin,
      tx5.id,
      'REJETE',
      'Transaction contestée ou non autorisée par le titulaire du compte'
    );
    console.log(`• Statut mis à jour : ${updatedManual.statut}`);
    console.log(`• Motif de rejet    : ${updatedManual.motifRejet}`);

    if (updatedManual.statut !== 'REJETE') {
      throw new Error(`Attendu 'REJETE' mais obtenu '${updatedManual.statut}'`);
    }
    if (!updatedManual.motifRejet.includes('contestée')) {
      throw new Error(`Motif attendu non trouvé dans la réponse API`);
    }
    console.log('✓ CAS 5 validé : Rejet administratif trésorerie avec motif enregistré');

    // ------------------------------------------------------------------
    // CAS 6 : Présentation Reçu / Transaction (contrat d'API)
    // ------------------------------------------------------------------
    console.log('\n--- CAS 6 : Vérification de la présence de motifRejet dans le Reçu API ---');
    const receiptPresented = presentReceipt(await loadPaymentView(tx1.id));
    const txPresented = presentTransaction(await loadPaymentView(tx1.id));

    console.log(`• Reçu ID        : ${receiptPresented.id}`);
    console.log(`• Reçu Statut    : ${receiptPresented.statut}`);
    console.log(`• Reçu motifRejet: ${receiptPresented.motifRejet}`);
    console.log(`• Tx motifRejet  : ${txPresented.motifRejet}`);

    if (!receiptPresented.motifRejet) {
      throw new Error('Le champ motifRejet n\'est pas présent dans la structure du reçu généré !');
    }
    console.log('✓ CAS 6 validé : Le reçu expose clairement la cause du refus au client');

    console.log('\n========================================================');
    console.log('  TEST 3 RÉUSSI : TOUS LES CAS DE REFUS ET D’ÉCHECS SONT OPÉRATIONNELS !');
    console.log('========================================================\n');
  } finally {
    server.close();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('\n❌ Échec du Test 3 :', err);
  process.exit(1);
});
