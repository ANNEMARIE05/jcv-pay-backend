import { pool } from '../db.js';

/**
 * Enregistre une action sensible dans la table audit_log.
 * Ne lève jamais d'erreur (on ne veut pas bloquer une action métier à cause d'un log).
 */
export async function auditLog({ acteurId, acteurRole, action, cibleType, cibleId, details, ip } = {}) {
  try {
    await pool.query(
      `INSERT INTO audit_log (acteur_id, acteur_role, action, cible_type, cible_id, details, ip)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [
        acteurId || null,
        acteurRole || null,
        String(action || '').slice(0, 100),
        cibleType ? String(cibleType).slice(0, 50) : null,
        cibleId ? String(cibleId).slice(0, 100) : null,
        details ? String(details).slice(0, 500) : null,
        ip ? String(ip).slice(0, 45) : null,
      ]
    );
  } catch {
    // On ne bloque jamais sur une erreur d'audit
  }
}

/**
 * Vérifie si une IP est bloquée dans la table ip_bloquees.
 * Retourne true si l'IP est bloquée, false sinon.
 */
export async function isIpBlocked(ip) {
  if (!ip) return false;
  try {
    const { rows } = await pool.query(
      `SELECT 1 FROM ip_bloquees
       WHERE ip = $1 AND (expire_at IS NULL OR expire_at > NOW())
       LIMIT 1`,
      [ip]
    );
    return rows.length > 0;
  } catch {
    return false;
  }
}

/**
 * Middleware Express : bloque les IPs présentes dans ip_bloquees.
 */
export async function ipBlockMiddleware(req, res, next) {
  const ip = req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.ip || '';
  if (await isIpBlocked(ip)) {
    return res.status(403).json({ message: 'Accès refusé.' });
  }
  next();
}
