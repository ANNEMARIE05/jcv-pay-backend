/**
 * Test 1: Totaux de toutes les transactions et ventilation par statut
 * Exécute: node scripts/test-totals-and-status.js
 */

import { pool } from '../src/db.js';
import { buildEspace } from '../src/services/espace.js';

async function runTotalsTest() {
  console.log('========================================================');
  console.log('  TEST 1 : CALCUL DU TOTAL DE TOUTES LES TRANSACTIONS');
  console.log('========================================================\n');

  // Récupérer un utilisateur de test ou trésorier
  const userRes = await pool.query("SELECT * FROM utilisateurs WHERE role IN ('TRESORIER', 'SUPER_ADMIN') LIMIT 1");
  if (!userRes.rows[0]) {
    console.error('Aucun utilisateur administrateur/trésorier trouvé pour le test.');
    process.exit(1);
  }
  const user = userRes.rows[0];
  console.log(`Utilisateur de test: ${user.prenom} ${user.nom} (${user.role})`);

  // Requête directe pour calculer les totaux dans la base
  const dbTotals = await pool.query(`
    SELECT
      COUNT(*)::int AS total_count,
      COALESCE(SUM(montant), 0)::bigint AS total_montant,
      COALESCE(SUM(CASE WHEN statut = 'VALIDE' THEN montant ELSE 0 END), 0)::bigint AS total_valide,
      COUNT(CASE WHEN statut = 'VALIDE' THEN 1 END)::int AS count_valide,
      COALESCE(SUM(CASE WHEN statut = 'EN_ATTENTE' THEN montant ELSE 0 END), 0)::bigint AS total_en_attente,
      COUNT(CASE WHEN statut = 'EN_ATTENTE' THEN 1 END)::int AS count_en_attente,
      COALESCE(SUM(CASE WHEN statut IN ('ECHEC', 'REJETE', 'ANNULE') THEN montant ELSE 0 END), 0)::bigint AS total_echec,
      COUNT(CASE WHEN statut IN ('ECHEC', 'REJETE', 'ANNULE') THEN 1 END)::int AS count_echec
    FROM transactions
  `);

  const row = dbTotals.rows[0];
  console.log('\n--- Totaux calculés depuis la base de données ---');
  console.log(`• Nombre total d'opérations : ${row.total_count}`);
  console.log(`• Montant global cumulé     : ${Number(row.total_montant).toLocaleString('fr-FR')} FCFA`);
  console.log(`• Transactions validées     : ${Number(row.total_valide).toLocaleString('fr-FR')} FCFA (${row.count_valide} op.)`);
  console.log(`• Transactions en attente   : ${Number(row.total_en_attente).toLocaleString('fr-FR')} FCFA (${row.count_en_attente} op.)`);
  console.log(`• Échecs, refus et annulés  : ${Number(row.total_echec).toLocaleString('fr-FR')} FCFA (${row.count_echec} op.)`);

  // Vérifier la cohérence arithmétique
  const sommePartielle = Number(row.total_valide) + Number(row.total_en_attente) + Number(row.total_echec);
  if (sommePartielle !== Number(row.total_montant)) {
    throw new Error(`Incohérence: la somme des statuts (${sommePartielle}) ne correspond pas au total (${row.total_montant})`);
  }
  console.log('✓ Cohérence arithmétique vérifiée : somme(Validé + Attente + Échec) == Total global');

  // Vérifier la réponse de buildEspace
  console.log('\n--- Vérification du service buildEspace ---');
  const espace = await buildEspace(user);
  const res = espace.resume;

  console.log(`• totalToutesTransactions   : ${res.totalToutesTransactions?.toLocaleString('fr-FR')} FCFA`);
  console.log(`• totalTransactionsCount    : ${res.totalTransactionsCount}`);
  console.log(`• totalTransactionsValidees : ${res.totalTransactionsValidees?.toLocaleString('fr-FR')} FCFA (${res.countTransactionsValidees})`);
  console.log(`• totalTransactionsEnAttente: ${res.totalTransactionsEnAttente?.toLocaleString('fr-FR')} FCFA (${res.countTransactionsEnAttente})`);
  console.log(`• totalTransactionsEchec    : ${res.totalTransactionsEchec?.toLocaleString('fr-FR')} FCFA (${res.countTransactionsEchec})`);

  if (res.totalToutesTransactions !== Number(row.total_montant)) {
    throw new Error(`Mismatch total: attendu ${row.total_montant}, reçu ${res.totalToutesTransactions}`);
  }
  if (res.totalTransactionsCount !== row.total_count) {
    throw new Error(`Mismatch count: attendu ${row.total_count}, reçu ${res.totalTransactionsCount}`);
  }

  console.log('\n========================================================');
  console.log('  TEST 1 RÉUSSI : TOUS LES TOTAUX SONT CONFORMES ET EXACTS !');
  console.log('========================================================\n');
}

runTotalsTest()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error('❌ Échec test totaux :', err);
    process.exit(1);
  });
