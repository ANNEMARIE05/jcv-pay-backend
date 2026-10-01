import { pool } from '../db.js';
import { canManageCampaigns, canManageMoney, canManagePeople } from '../utils/auth.js';
import {
  presentCaisse,
  presentCotisation,
  presentEvent,
  presentMouvement,
  presentNotification,
  presentProject,
  presentReceipt,
  presentTransaction,
  presentUser,
} from './present.js';

const TX_SELECT = `
  SELECT t.*, r.numero_recu, r.code_securite, r.id AS recu_id
  FROM transactions t
  LEFT JOIN recus r ON r.transaction_id = t.id
`;

export async function buildEspace(user) {
  const staff = canManageCampaigns(user.role);
  const money = canManageMoney(user.role);
  const people = canManagePeople(user.role) || money;

  const txFilter = staff ? '' : 'WHERE t.donateur_user_id = $1';
  const txParams = staff ? [] : [user.id];

  const [projects, events, cotisations, caisses, transactions, notifications, users, treasuryRaw] =
    await Promise.all([
      pool.query(
        `SELECT p.*,
           COALESCE((SELECT SUM(montant) FROM transactions t WHERE t.projet_id = p.id AND t.statut = 'VALIDE'), 0) AS montant_collecte,
           COALESCE((SELECT COUNT(DISTINCT donateur_telephone_norm) FROM transactions t WHERE t.projet_id = p.id AND t.statut = 'VALIDE'), 0) AS participants_count,
           COALESCE((SELECT SUM(montant) FROM transactions t WHERE t.projet_id = p.id AND t.statut = 'VALIDE' AND t.donateur_user_id = $1), 0) AS ma_contribution
         FROM projets p
         ORDER BY p.created_at DESC`,
        [user.id]
      ),
      pool.query(
        `SELECT e.*,
           (SELECT COUNT(*) FROM inscriptions i WHERE i.evenement_id = e.id) AS places_reservees,
           EXISTS(SELECT 1 FROM inscriptions i WHERE i.evenement_id = e.id AND i.utilisateur_id = $1) AS est_inscrit,
           (
             SELECT t.statut FROM transactions t
             WHERE t.evenement_id = e.id AND t.donateur_user_id = $1
             ORDER BY t.created_at DESC LIMIT 1
           ) AS statut_paiement
         FROM evenements e
         ORDER BY e.created_at DESC`,
        [user.id]
      ),
      pool.query(
        `SELECT c.*,
           COALESCE((
             SELECT SUM(montant) FROM transactions t
             WHERE t.cotisation_id = c.id AND t.donateur_user_id = $1 AND t.statut = 'VALIDE'
           ), 0) AS montant_verse
         FROM cotisations c
         ORDER BY c.created_at DESC`,
        [user.id]
      ),
      pool.query(
        `SELECT c.*,
           (
             COALESCE((
               SELECT SUM(t.montant) FROM transactions t
               WHERE t.statut = 'VALIDE' AND t.caisse_id = c.id
             ), 0)
             + COALESCE((SELECT SUM(tr.montant) FROM transferts tr WHERE tr.destination_id = c.id), 0)
             - COALESCE((SELECT SUM(tr.montant) FROM transferts tr WHERE tr.source_id = c.id), 0)
           ) AS montant_collecte
         FROM caisses c
         WHERE c.supprimee = FALSE
           AND c.principale = FALSE
           AND ($1::boolean = TRUE OR c.visible_aux_membres = TRUE)
         ORDER BY c.date_ouverture DESC`,
        [staff]
      ),
      pool.query(`${TX_SELECT} ${txFilter} ORDER BY t.created_at DESC`, txParams),
      pool.query(
        `SELECT * FROM notifications WHERE utilisateur_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [user.id]
      ),
      people
        ? pool.query('SELECT * FROM utilisateurs ORDER BY created_at DESC')
        : Promise.resolve({ rows: [] }),
      staff ? treasurySnapshot() : emptyTreasury(),
    ]);

  const txRows = transactions.rows;
  const mine = txRows.filter((row) => row.donateur_user_id === user.id);
  const totalContribue = mine
    .filter((row) => row.statut === 'VALIDE')
    .reduce((sum, row) => sum + Number(row.montant), 0);
  const enAttente = mine
    .filter((row) => row.statut === 'EN_ATTENTE')
    .reduce((sum, row) => sum + Number(row.montant), 0);
  const epargneSolde = mine
    .filter((row) => row.statut === 'VALIDE' && row.type === 'EPARGNE')
    .reduce((sum, row) => sum + Number(row.montant), 0);
  const resteAPayer = cotisations.rows.reduce((sum, row) => {
    const reste = Math.max(Number(row.montant_total) - Number(row.montant_verse || 0), 0);
    return sum + reste;
  }, 0);
  const last = mine.find((row) => row.statut === 'VALIDE') || mine[0];

  const mouvements = money
    ? await pool.query('SELECT * FROM mouvements ORDER BY created_at DESC LIMIT 200')
    : { rows: [] };

  let treasury = treasuryRaw;
  if (staff) {
    const locked = caisses.rows.reduce((sum, row) => sum + Number(row.montant_collecte || 0), 0);
    treasury = {
      ...treasuryRaw,
      soldeTotal: Number(treasuryRaw.soldeTotal) - locked,
    };
  }

  return {
    resume: {
      totalContribue,
      resteAPayer,
      enAttente,
      epargneSolde,
      projetsActifsCount: projects.rows.filter((row) => row.statut === 'EN_COURS').length,
      derniereContributionDate: last ? formatSafe(last.created_at) : '',
    },
    transactions: txRows.map(presentTransaction),
    projets: projects.rows.map(presentProject),
    evenements: events.rows.map(presentEvent),
    recus: txRows.filter((row) => row.recu_id).map(presentReceipt),
    cotisations: cotisations.rows.map(presentCotisation),
    mouvements: mouvements.rows.map(presentMouvement),
    caissesProjet: caisses.rows.map(presentCaisse),
    utilisateurs: users.rows.map(presentUser),
    notifications: notifications.rows.map(presentNotification),
    tresorerieGlobale: treasury,
  };
}

function formatSafe(value) {
  return new Intl.DateTimeFormat('fr-FR', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'Africa/Abidjan',
  }).format(new Date(value));
}

function emptyTreasury() {
  return {
    soldeTotal: 0,
    entreesMois: 0,
    sortiesMois: 0,
    soldeCaissePhysique: 0,
    soldeWave: 0,
    soldeOrangeMoney: 0,
    soldeBancaire: 0,
  };
}

async function treasurySnapshot() {
  const { rows } = await pool.query(`
    SELECT
      COALESCE(SUM(CASE WHEN type = 'ENTREE' THEN montant ELSE -montant END), 0) AS solde_total,
      COALESCE(SUM(CASE WHEN type = 'ENTREE' AND created_at >= date_trunc('month', NOW()) THEN montant ELSE 0 END), 0) AS entrees_mois,
      COALESCE(SUM(CASE WHEN type = 'SORTIE' AND created_at >= date_trunc('month', NOW()) THEN montant ELSE 0 END), 0) AS sorties_mois,
      COALESCE(SUM(CASE WHEN source = 'CAISSE_PHYSIQUE' AND type = 'ENTREE' THEN montant WHEN source = 'CAISSE_PHYSIQUE' AND type = 'SORTIE' THEN -montant ELSE 0 END), 0) AS caisse,
      COALESCE(SUM(CASE WHEN source = 'WAVE' AND type = 'ENTREE' THEN montant WHEN source = 'WAVE' AND type = 'SORTIE' THEN -montant ELSE 0 END), 0) AS wave,
      COALESCE(SUM(CASE WHEN source = 'ORANGE_MONEY' AND type = 'ENTREE' THEN montant WHEN source = 'ORANGE_MONEY' AND type = 'SORTIE' THEN -montant ELSE 0 END), 0) AS orange,
      COALESCE(SUM(CASE WHEN source = 'BANQUE' AND type = 'ENTREE' THEN montant WHEN source = 'BANQUE' AND type = 'SORTIE' THEN -montant ELSE 0 END), 0) AS banque
    FROM mouvements
  `);
  const row = rows[0];
  return {
    soldeTotal: Number(row.solde_total),
    entreesMois: Number(row.entrees_mois),
    sortiesMois: Number(row.sorties_mois),
    soldeCaissePhysique: Number(row.caisse),
    soldeWave: Number(row.wave),
    soldeOrangeMoney: Number(row.orange),
    soldeBancaire: Number(row.banque),
  };
}

export async function sourceBalance(source) {
  const { rows } = await pool.query(
    `SELECT COALESCE(SUM(CASE WHEN type = 'ENTREE' THEN montant ELSE -montant END), 0) AS solde
     FROM mouvements WHERE source = $1`,
    [source]
  );
  return Number(rows[0].solde);
}

export async function notify(userId, payload) {
  if (!userId) return;
  await pool.query(
    `INSERT INTO notifications (utilisateur_id, titre, message, type, reference_id)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, payload.titre, payload.message, payload.type, payload.referenceId || null]
  );
}
