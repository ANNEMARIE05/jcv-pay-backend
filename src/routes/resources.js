import { Router } from 'express';
import { pool } from '../db.js';
import { AppError, asyncHandler } from '../errors.js';
import { requireAuth, requireCampaigns, requireMoney, requirePeople } from '../middleware/auth.js';
import { buildEspace, notify } from '../services/espace.js';
import { presentMouvement, presentUser } from '../services/present.js';
import { deleteCaisse, nextMatricule, recordCash, setPaymentStatus, transferCaisse, withdraw } from '../services/payments.js';
import { getGeniusBalance } from '../services/geniuspay.js';
import { hashPassword } from '../utils/auth.js';
import { cleanEmail, formatPhone, normalizePhone } from '../utils/phone.js';
import { money, randomDigits } from '../utils/codes.js';
import { config } from '../config.js';

const router = Router();

router.get(
  '/espace',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/projets',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    const titre = String(req.body.titre || '').trim();
    const objectif = money(req.body.objectif);
    if (!titre || objectif <= 0) throw new AppError(400, 'Titre et objectif sont requis.');
    const { rows } = await pool.query(
      `INSERT INTO projets (titre, description, categorie, objectif, date_fin, statut, image_url, organisateur, lieu, cree_par)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id`,
      [
        titre,
        req.body.description || '',
        req.body.categorie || 'SOCIAL',
        objectif,
        req.body.dateFin || '',
        req.body.statut || 'EN_COURS',
        req.body.imageUrl || '',
        req.body.organisateur || '',
        req.body.lieu || null,
        req.user.id,
      ]
    );
    await pool.query(
      `INSERT INTO caisses (nom, description, projet_id, objectif, cree_par)
       VALUES ($1, $2, $3, $4, $5)`,
      [`Caisse — ${titre}`, req.body.description || '', rows[0].id, objectif, req.user.id]
    );
    await notify(req.user.id, {
      titre: 'Projet publié',
      message: `${titre} est visible par les fidèles.`,
      type: 'PROJET',
      referenceId: rows[0].id,
    });
    res.status(201).json(await buildEspace(req.user));
  })
);

router.post(
  '/evenements',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    const titre = String(req.body.titre || '').trim();
    if (!titre) throw new AppError(400, 'Le titre est requis.');
    await pool.query(
      `INSERT INTO evenements (titre, description, date_label, heure, lieu, tarif, places_disponibles, image_url, intervenant, cree_par)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [
        titre,
        req.body.description || '',
        req.body.date || '',
        req.body.heure || '',
        req.body.lieu || '',
        money(req.body.tarif),
        money(req.body.placesDisponibles || 0),
        req.body.imageUrl || '',
        req.body.intervenant || null,
        req.user.id,
      ]
    );
    res.status(201).json(await buildEspace(req.user));
  })
);

router.post(
  '/evenements/:id/inscription',
  requireAuth,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM evenements WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new AppError(404, 'Événement introuvable.');
    const reserved = await pool.query('SELECT COUNT(*)::int AS n FROM inscriptions WHERE evenement_id = $1', [
      req.params.id,
    ]);
    if (reserved.rows[0].n >= rows[0].places_disponibles) throw new AppError(409, 'Plus de places disponibles.');
    await pool.query(
      `INSERT INTO inscriptions (evenement_id, utilisateur_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [req.params.id, req.user.id]
    );
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/cotisations',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    const titre = String(req.body.titre || '').trim();
    const montant = money(req.body.montantTotal);
    if (!titre || montant <= 0) throw new AppError(400, 'Titre et montant sont requis.');
    await pool.query(
      `INSERT INTO cotisations (titre, categorie, montant_total, echeance, cree_par) VALUES ($1,$2,$3,$4,$5)`,
      [titre, req.body.categorie || 'COTISATION', montant, req.body.echeance || '', req.user.id]
    );
    res.status(201).json(await buildEspace(req.user));
  })
);

router.post(
  '/caisses',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    const nom = String(req.body.nom || '').trim();
    if (!nom) throw new AppError(400, 'Le nom de la caisse est requis.');
    await pool.query(
      `INSERT INTO caisses (nom, description, projet_id, objectif, cree_par) VALUES ($1,$2,$3,$4,$5)`,
      [nom, req.body.description || '', req.body.projetId || null, money(req.body.objectif), req.user.id]
    );
    res.status(201).json(await buildEspace(req.user));
  })
);

router.post(
  '/caisses/transfert',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    await transferCaisse(req.user, req.body);
    res.status(201).json(await buildEspace(req.user));
  })
);

router.post(
  '/caisses/:id/supprimer',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    await deleteCaisse(req.params.id);
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/caisses/:id/cloturer',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    const current = await pool.query('SELECT principale, supprimee FROM caisses WHERE id = $1', [req.params.id]);
    if (!current.rows[0] || current.rows[0].supprimee) throw new AppError(404, 'Caisse introuvable.');
    if (current.rows[0].principale) throw new AppError(400, 'La caisse principale ne se clôture pas.');
    const { rows } = await pool.query(
      `UPDATE caisses SET statut = 'TERMINEE', date_cloture = NOW() WHERE id = $1 RETURNING projet_id`,
      [req.params.id]
    );
    if (!rows[0]) throw new AppError(404, 'Caisse introuvable.');
    if (rows[0].projet_id) {
      await pool.query(`UPDATE projets SET statut = 'CLOTURE' WHERE id = $1`, [rows[0].projet_id]);
    }
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/paiements/especes',
  requireAuth,
  requireMoney,
  asyncHandler(async (req, res) => {
    const created = await recordCash(req.user, req.body);
    res.status(201).json({ ...created, espace: await buildEspace(req.user) });
  })
);

router.post(
  '/paiements/:id/valider',
  requireAuth,
  requireMoney,
  asyncHandler(async (req, res) => {
    await setPaymentStatus(req.user, req.params.id, 'VALIDE');
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/paiements/:id/rejeter',
  requireAuth,
  requireMoney,
  asyncHandler(async (req, res) => {
    await setPaymentStatus(req.user, req.params.id, 'REJETE');
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/mouvements/sortie',
  requireAuth,
  requireMoney,
  asyncHandler(async (req, res) => {
    const row = await withdraw(req.user, req.body);
    if (!row) throw new AppError(400, 'Solde insuffisant sur cette caisse.');
    res.status(201).json({ mouvement: presentMouvement(row), espace: await buildEspace(req.user) });
  })
);

router.get(
  '/tresorerie/geniuspay',
  requireAuth,
  requireMoney,
  asyncHandler(async (req, res) => {
    res.json(await getGeniusBalance());
  })
);

router.get(
  '/utilisateurs',
  requireAuth,
  requirePeople,
  asyncHandler(async (req, res) => {
    const { rows } = await pool.query('SELECT * FROM utilisateurs ORDER BY created_at DESC');
    res.json(rows.map(presentUser));
  })
);

router.post(
  '/fideles',
  requireAuth,
  requireCampaigns,
  asyncHandler(async (req, res) => {
    const prenom = String(req.body.prenom || '').trim();
    const nom = String(req.body.nom || '').trim();
    const telephone = formatPhone(req.body.telephone);
    const phoneNorm = normalizePhone(req.body.telephone);
    if (!prenom || !nom || !phoneNorm) throw new AppError(400, 'Prénom, nom et numéro sont requis.');
    const temporary = `Jcv${randomDigits(4)}@1`;
    const matricule = await nextMatricule(pool, 'MEMBRE');
    try {
      const { rows } = await pool.query(
        `INSERT INTO utilisateurs (
           nom, prenom, telephone, telephone_norm, mot_de_passe_hash, matricule, paroisse, role
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,'MEMBRE') RETURNING *`,
        [nom, prenom, telephone, phoneNorm, await hashPassword(temporary), matricule, config.org.paroisse]
      );
      res.status(201).json({
        utilisateur: { ...presentUser(rows[0]), motDePasseTemporaire: temporary },
        espace: await buildEspace(req.user),
      });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Ce numéro est déjà utilisé.');
      throw error;
    }
  })
);

router.post(
  '/utilisateurs',
  requireAuth,
  requirePeople,
  asyncHandler(async (req, res) => {
    const prenom = String(req.body.prenom || '').trim();
    const nom = String(req.body.nom || '').trim();
    const role = req.body.role || 'MEMBRE';
    const telephone = formatPhone(req.body.telephone);
    const phoneNorm = normalizePhone(req.body.telephone);
    const email = cleanEmail(req.body.email);
    const allowed = ['MEMBRE', 'TRESORIER', 'RESPONSABLE', 'ADMINISTRATEUR'];
    if (req.user.role === 'SUPER_ADMIN') allowed.push('SUPER_ADMIN');
    if (!allowed.includes(role)) throw new AppError(400, 'Rôle non autorisé.');
    if (!prenom || !nom || !phoneNorm) throw new AppError(400, 'Prénom, nom et numéro sont requis.');
    const temporary = req.body.motDePasse || `Jcv${randomDigits(4)}@1`;
    const matricule = await nextMatricule(pool, role);
    try {
      const { rows } = await pool.query(
        `INSERT INTO utilisateurs (
           nom, prenom, email, telephone, telephone_norm, mot_de_passe_hash, matricule, paroisse, departement, role
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [
          nom,
          prenom,
          email,
          telephone,
          phoneNorm,
          await hashPassword(temporary),
          matricule,
          config.org.paroisse,
          req.body.departement || null,
          role,
        ]
      );
      res.status(201).json({
        utilisateur: { ...presentUser(rows[0]), motDePasseTemporaire: temporary },
        espace: await buildEspace(req.user),
      });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Ce numéro ou cet email est déjà utilisé.');
      throw error;
    }
  })
);

router.patch(
  '/utilisateurs/:id/role',
  requireAuth,
  requirePeople,
  asyncHandler(async (req, res) => {
    const role = req.body.role;
    const allowed = ['MEMBRE', 'TRESORIER', 'RESPONSABLE', 'ADMINISTRATEUR'];
    if (!allowed.includes(role)) throw new AppError(400, 'Rôle non autorisé.');
    const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE id = $1', [req.params.id]);
    if (!rows[0]) throw new AppError(404, 'Utilisateur introuvable.');
    if (rows[0].role === 'SUPER_ADMIN') throw new AppError(403, 'Le super administrateur ne peut pas être rétrogradé ici.');
    await pool.query('UPDATE utilisateurs SET role = $2, updated_at = NOW() WHERE id = $1', [req.params.id, role]);
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/notifications/:id/lire',
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query('UPDATE notifications SET lue = TRUE WHERE id = $1 AND utilisateur_id = $2', [
      req.params.id,
      req.user.id,
    ]);
    res.json(await buildEspace(req.user));
  })
);

router.post(
  '/notifications/lire-tout',
  requireAuth,
  asyncHandler(async (req, res) => {
    await pool.query('UPDATE notifications SET lue = TRUE WHERE utilisateur_id = $1', [req.user.id]);
    res.json(await buildEspace(req.user));
  })
);

export default router;
