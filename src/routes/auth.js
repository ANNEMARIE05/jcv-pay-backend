import { Router } from 'express';
import { pool } from '../db.js';
import { AppError, asyncHandler } from '../errors.js';
import { requireAuth } from '../middleware/auth.js';
import { passwordResetLimiter } from '../middleware/security.js';
import { auditLog } from '../services/audit.js';
import { presentUser } from '../services/present.js';
import { buildEspace } from '../services/espace.js';
import { nextMatricule } from '../services/payments.js';
import { ADMIN_ROLES, hashPassword, signToken, verifyPassword } from '../utils/auth.js';
import { cleanEmail, formatPhone, isEmail, normalizePhone } from '../utils/phone.js';
import { randomDigits } from '../utils/codes.js';
import { config } from '../config.js';

const router = Router();

router.post(
  '/inscription',
  asyncHandler(async (req, res) => {
    const prenom = String(req.body.prenom || '').trim();
    const nom = String(req.body.nom || '').trim();
    const telephone = formatPhone(req.body.telephone);
    const phoneNorm = normalizePhone(req.body.telephone);
    const email = cleanEmail(req.body.email);
    const password = String(req.body.motDePasse || req.body.password || '');
    if (!prenom || !nom || !phoneNorm || password.length < 8) {
      throw new AppError(400, 'Prénom, nom, numéro et un mot de passe d’au moins 8 caractères sont requis.');
    }
    const matricule = await nextMatricule(pool, 'MEMBRE');
    const passwordHash = await hashPassword(password);
    try {
      const { rows } = await pool.query(
        `INSERT INTO utilisateurs (
           nom, prenom, email, telephone, telephone_norm, mot_de_passe_hash, matricule, paroisse, role
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'MEMBRE') RETURNING *`,
        [nom, prenom, email, telephone, phoneNorm, passwordHash, matricule, req.body.paroisse || config.org.paroisse]
      );
      const utilisateur = presentUser(rows[0]);
      res.status(201).json({
        token: signToken(rows[0]),
        utilisateur,
        espace: await buildEspace(rows[0]),
      });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Ce numéro ou cet email est déjà utilisé.');
      throw error;
    }
  })
);

router.post(
  '/connexion',
  asyncHandler(async (req, res) => {
    const identifiant = String(req.body.identifiant || req.body.telephone || req.body.email || '').trim();
    const password = String(req.body.motDePasse || req.body.password || '');
    if (!identifiant || !password) throw new AppError(400, 'Numéro et mot de passe requis.');

    let user;
    if (isEmail(identifiant)) {
      const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE lower(email) = $1', [
        identifiant.toLowerCase(),
      ]);
      user = rows[0];
      if (user && !ADMIN_ROLES.includes(user.role)) {
        throw new AppError(401, 'La connexion par email est réservée à l’administrateur. Utilisez votre numéro.');
      }
    } else {
      const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE telephone_norm = $1', [
        normalizePhone(identifiant),
      ]);
      user = rows[0];
    }

    if (!user || !user.actif || !(await verifyPassword(password, user.mot_de_passe_hash))) {
      // Audit des tentatives échouées
      await auditLog({
        acteurId: user?.id,
        action: 'CONNEXION_ECHEC',
        details: `Identifiant: ${identifiant.slice(0, 30)}`,
        ip: req.ip,
      });
      throw new AppError(401, 'Identifiants incorrects.');
    }

    await auditLog({
      acteurId: user.id,
      acteurRole: user.role,
      action: 'CONNEXION_OK',
      ip: req.ip,
    });

    res.json({
      token: signToken(user),
      utilisateur: presentUser(user),
      espace: await buildEspace(user),
    });
  })
);

router.get(
  '/moi',
  requireAuth,
  asyncHandler(async (req, res) => {
    res.json({ utilisateur: req.userPublic, espace: await buildEspace(req.user) });
  })
);

router.patch(
  '/profil',
  requireAuth,
  asyncHandler(async (req, res) => {
    const prenom = req.body.prenom != null ? String(req.body.prenom).trim() : req.user.prenom;
    const nom = req.body.nom != null ? String(req.body.nom).trim() : req.user.nom;
    const email = req.body.email != null ? cleanEmail(req.body.email) : req.user.email;
    const telephone = req.body.telephone != null ? formatPhone(req.body.telephone) : req.user.telephone;
    const phoneNorm = req.body.telephone != null ? normalizePhone(req.body.telephone) : req.user.telephone_norm;
    const departement = req.body.departement != null ? String(req.body.departement).trim() : req.user.departement;
    if (!prenom || !nom || !phoneNorm) throw new AppError(400, 'Le nom et le numéro sont requis.');
    try {
      const { rows } = await pool.query(
        `UPDATE utilisateurs
         SET prenom = $2, nom = $3, email = $4, telephone = $5, telephone_norm = $6, departement = $7, updated_at = NOW()
         WHERE id = $1 RETURNING *`,
        [req.user.id, prenom, nom, email, telephone, phoneNorm, departement || null]
      );
      res.json({ utilisateur: presentUser(rows[0]) });
    } catch (error) {
      if (error.code === '23505') throw new AppError(409, 'Ce numéro ou cet email est déjà utilisé.');
      throw error;
    }
  })
);

router.post(
  '/mot-de-passe',
  requireAuth,
  asyncHandler(async (req, res) => {
    const actuel = String(req.body.ancienMotDePasse || '');
    const nouveau = String(req.body.nouveauMotDePasse || '');
    if (nouveau.length < 8) throw new AppError(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères.');
    if (!(await verifyPassword(actuel, req.user.mot_de_passe_hash))) {
      throw new AppError(400, 'L’ancien mot de passe est incorrect.');
    }
    const passwordHash = await hashPassword(nouveau);
    await pool.query('UPDATE utilisateurs SET mot_de_passe_hash = $2, updated_at = NOW() WHERE id = $1', [
      req.user.id,
      passwordHash,
    ]);
    res.json({ message: 'Mot de passe modifié.' });
  })
);

router.post(
  '/mot-de-passe/demande',
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const phoneNorm = normalizePhone(req.body.telephone);
    const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE telephone_norm = $1', [phoneNorm]);
    if (!rows[0]) {
      res.json({ message: 'Si ce numéro existe, un code a été préparé.' });
      return;
    }
    const code = randomDigits(4);
    await pool.query(
      `INSERT INTO codes_verification (utilisateur_id, code, objet, expire_at)
       VALUES ($1, $2, 'RESET_PASSWORD', NOW() + INTERVAL '10 minutes')`,
      [rows[0].id, code]
    );
    const payload = { message: 'Un code de réinitialisation a été généré.' };
    if (config.nodeEnv !== 'production') payload.code = code;
    res.json(payload);
  })
);

router.post(
  '/mot-de-passe/reinitialiser',
  passwordResetLimiter,
  asyncHandler(async (req, res) => {
    const phoneNorm = normalizePhone(req.body.telephone);
    const code = String(req.body.code || '').trim();
    const nouveau = String(req.body.nouveauMotDePasse || '');
    if (nouveau.length < 8) throw new AppError(400, 'Le nouveau mot de passe doit contenir au moins 8 caractères.');
    const { rows } = await pool.query(
      `SELECT c.id, u.id AS user_id
       FROM codes_verification c
       JOIN utilisateurs u ON u.id = c.utilisateur_id
       WHERE u.telephone_norm = $1 AND c.code = $2 AND c.objet = 'RESET_PASSWORD'
         AND c.utilise = FALSE AND c.expire_at > NOW()
       ORDER BY c.created_at DESC LIMIT 1`,
      [phoneNorm, code]
    );
    if (!rows[0]) throw new AppError(400, 'Code invalide ou expiré.');
    const passwordHash = await hashPassword(nouveau);
    await pool.query('UPDATE utilisateurs SET mot_de_passe_hash = $2, updated_at = NOW() WHERE id = $1', [
      rows[0].user_id,
      passwordHash,
    ]);
    await pool.query('UPDATE codes_verification SET utilise = TRUE WHERE id = $1', [rows[0].id]);
    res.json({ message: 'Mot de passe réinitialisé. Vous pouvez vous connecter.' });
  })
);

export default router;
