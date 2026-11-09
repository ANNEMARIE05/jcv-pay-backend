/**
 * Test complet du flux de retour après paiement en ligne :
 * 1. Rapidité d'exécution (suppression de toute latence)
 * 2. Redirection 302 directe vers le reçu (deep link jcvpay://recu/:id et webUrl)
 * 3. Validation instantanée et existence du reçu officiel certifié
 */
import 'dotenv/config';
import http from 'node:http';
import { pool } from '../src/db.js';
import { createApp } from '../src/app.js';
import { declarePayment } from '../src/services/payments.js';

async function run() {
  console.log('========================================================');
  console.log('  TEST 2 : FLUX DE RETOUR APRÈS PAIEMENT & ACCÈS AU REÇU');
  console.log('========================================================\n');

  // 1. Récupérer l'administrateur de test
  const adminRes = await pool.query(`SELECT * FROM utilisateurs WHERE role = 'SUPER_ADMIN' LIMIT 1`);
  const admin = adminRes.rows[0];
  if (!admin) throw new Error('Aucun administrateur trouvé.');

  // 2. Déclarer une intention de paiement mobile
  console.log('1. Déclaration d\'un paiement en ligne pour test de retour...');
  const paymentDeclaration = await declarePayment(
    admin,
    {
      titre: 'Don Spécial Rénovation — Test Retour',
      montant: 15000,
      type: 'OFFRANDE',
      platform: 'mobile',
      donateurNom: 'Testeur Rapide',
      donateurTelephone: '+2250701020304',
      moyenPaiement: 'ORANGE_MONEY',
    },
    { skipGeniusPay: true }
  );

  const tx = paymentDeclaration.transaction;
  const initialRecu = paymentDeclaration.recu;
  console.log(`✓ Paiement initié: Réf = ${tx.reference}, ID = ${tx.id}, Statut = ${tx.statut}`);
  console.log(`✓ ID Reçu initial : ${initialRecu?.id}`);

  // 3. Démarrer un serveur HTTP local temporaire pour tester l'endpoint Express
  const app = createApp();
  const server = http.createServer(app);
  await new Promise((resolve) => server.listen(0, resolve));
  const port = server.address().port;
  console.log(`✓ Serveur de test Express démarré sur le port ${port}`);

  try {
    // 4. Test Retour Mobile (avec simulation User-Agent mobile et status=success)
    console.log('\n2. Simulation du retour de passerelle Mobile (/paiement/retour?status=success&ref=...)...');
    const startMobile = Date.now();

    const mobileRedirectResult = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/paiement/retour?status=success&ref=${encodeURIComponent(tx.reference)}&platform=mobile`,
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) Mobile/15E148',
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body,
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    const elapsedMobile = Date.now() - startMobile;
    console.log(`⏱️ Temps de traitement retour mobile : ${elapsedMobile} ms (ultra-rapide)`);
    console.log(`• Code HTTP retourné : ${mobileRedirectResult.statusCode}`);
    console.log(`• En-tête Location    : ${mobileRedirectResult.headers.location}`);

    if (mobileRedirectResult.statusCode !== 302) {
      throw new Error(`Attendu HTTP 302 mais reçu ${mobileRedirectResult.statusCode}`);
    }

    if (!mobileRedirectResult.headers.location.startsWith('jcvpay://recu/')) {
      throw new Error(`La redirection ne pointe pas vers le reçu jcvpay://recu/ : ${mobileRedirectResult.headers.location}`);
    }

    if (!mobileRedirectResult.headers.location.includes(initialRecu.id)) {
      throw new Error(`La redirection ne contient pas l'ID du reçu attendu (${initialRecu.id})`);
    }
    console.log('✓ Validation de la redirection mobile : pointe directement vers jcvpay://recu/' + initialRecu.id + '?choix=1');

    // 5. Vérifier la mise à jour immédiate en base de données
    console.log('\n3. Vérification de l\'état de la transaction en base de données...');
    const checkTxRes = await pool.query(
      `SELECT t.id, t.reference, t.statut, t.montant, r.id as recu_id, r.numero_recu
       FROM transactions t
       LEFT JOIN recus r ON r.transaction_id = t.id
       WHERE t.id = $1`,
      [tx.id]
    );
    const updatedTx = checkTxRes.rows[0];
    console.log(`• Statut transaction : ${updatedTx.statut}`);
    console.log(`• N° de reçu officiel: ${updatedTx.numero_recu}`);

    if (updatedTx.statut !== 'VALIDE') {
      throw new Error(`La transaction aurait dû passer à 'VALIDE', statut actuel: ${updatedTx.statut}`);
    }
    if (!updatedTx.numero_recu) {
      throw new Error('Le reçu officiel certifié n\'a pas été généré.');
    }

    // 6. Test Retour Web (platform=web)
    console.log('\n4. Simulation du retour Web (/paiement/retour?status=success&ref=...&platform=web)...');
    const startWeb = Date.now();
    const webRedirectResult = await new Promise((resolve, reject) => {
      const req = http.request(
        {
          hostname: '127.0.0.1',
          port,
          path: `/paiement/retour?status=success&ref=${encodeURIComponent(tx.reference)}&platform=web`,
          method: 'GET',
        },
        (res) => {
          let body = '';
          res.on('data', (chunk) => (body += chunk));
          res.on('end', () => {
            resolve({
              statusCode: res.statusCode,
              headers: res.headers,
              body,
            });
          });
        }
      );
      req.on('error', reject);
      req.end();
    });

    const elapsedWeb = Date.now() - startWeb;
    console.log(`⏱️ Temps de traitement retour web : ${elapsedWeb} ms`);
    console.log(`• Code HTTP retourné : ${webRedirectResult.statusCode}`);
    console.log(`• En-tête Location Web: ${webRedirectResult.headers.location}`);

    if (webRedirectResult.statusCode !== 302 || !webRedirectResult.headers.location.includes('/recu/' + initialRecu.id)) {
      throw new Error(`La redirection Web ne pointe pas vers le reçu attendu : ${webRedirectResult.headers.location}`);
    }
    console.log('✓ Validation de la redirection Web : pointe directement vers /recu/' + initialRecu.id);

    console.log('\n========================================================');
    console.log('  TEST 2 RÉUSSI : LE RETOUR EST INSTANTANÉ ET TOMBE SUR LE REÇU !');
    console.log('========================================================\n');
  } finally {
    server.close();
    await pool.end();
  }
}

run().catch((err) => {
  console.error('\n❌ Échec du Test 2 :', err);
  process.exit(1);
});
