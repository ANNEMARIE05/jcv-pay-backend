import { pool } from '../db.js';
import { config } from '../config.js';
import { hashPassword } from '../utils/auth.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import { nextMatricule } from './payments.js';

const ADMIN_INITIAL = {
  prenom: 'Administrateur',
  nom: 'JCV',
  email: 'admin@jcvictoire.org',
  telephone: '+225 07 47 18 50 39',
  motDePasse: 'Password@123',
};

export async function ensurePlatformAdmin() {
  const phoneNorm = normalizePhone(ADMIN_INITIAL.telephone);
  const email = ADMIN_INITIAL.email.toLowerCase();
  const { rows } = await pool.query(
    `SELECT id FROM utilisateurs
     WHERE role = 'SUPER_ADMIN'
        OR telephone_norm = $1
        OR lower(COALESCE(email, '')) = $2
     LIMIT 1`,
    [phoneNorm, email]
  );
  if (rows[0]) {
    console.log('Administrateur déjà présent, aucune recréation.');
    return;
  }

  const passwordHash = await hashPassword(ADMIN_INITIAL.motDePasse);
  const client = await pool.connect();
  try {
    const matricule = await nextMatricule(client, 'SUPER_ADMIN');
    await client.query(
      `INSERT INTO utilisateurs (
         nom, prenom, email, telephone, telephone_norm, mot_de_passe_hash,
         matricule, paroisse, departement, role
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'SUPER_ADMIN')`,
      [
        ADMIN_INITIAL.nom,
        ADMIN_INITIAL.prenom,
        email,
        formatPhone(ADMIN_INITIAL.telephone),
        phoneNorm,
        passwordHash,
        matricule,
        config.org.paroisse,
        'Administration',
      ]
    );
    console.log(`Administrateur créé : ${formatPhone(ADMIN_INITIAL.telephone)} / ${email}`);
  } finally {
    client.release();
  }
}

export async function ensurePrincipalCaisse() {
  const existing = await pool.query(`SELECT id FROM caisses WHERE principale = TRUE LIMIT 1`);
  let principaleId = existing.rows[0]?.id;
  if (!principaleId) {
    const created = await pool.query(
      `INSERT INTO caisses (nom, description, objectif, statut, visible_aux_membres, principale)
       VALUES (
         'Caisse principale',
         'Caisse de l’église. Elle reçoit les versements hors projet et les transferts.',
         0,
         'OUVERTE',
         FALSE,
         TRUE
       )
       RETURNING id`
    );
    principaleId = created.rows[0].id;
    console.log('Caisse principale créée.');
  }

  await pool.query(
    `UPDATE transactions t
     SET caisse_id = sub.id
     FROM (
       SELECT DISTINCT ON (projet_id) id, projet_id
       FROM caisses
       WHERE projet_id IS NOT NULL AND principale = FALSE AND supprimee = FALSE
       ORDER BY projet_id, date_ouverture ASC
     ) sub
     WHERE t.caisse_id IS NULL AND t.projet_id = sub.projet_id`,
  );

  await pool.query(
    `UPDATE transactions
     SET caisse_id = $1
     WHERE caisse_id IS NULL AND projet_id IS NULL`,
    [principaleId]
  );
}
