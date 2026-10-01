import { AppError } from '../errors.js';
import { pool } from '../db.js';
import { readToken, canManagePeople, canManageMoney, canManageCampaigns } from '../utils/auth.js';
import { presentUser } from '../services/present.js';

export async function requireAuth(req, _res, next) {
  try {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (!token) throw new AppError(401, 'Connexion requise.');
    const payload = readToken(token);
    const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE id = $1 AND actif = TRUE', [payload.sub]);
    if (!rows[0]) throw new AppError(401, 'Session invalide.');
    req.user = rows[0];
    req.userPublic = presentUser(rows[0]);
    next();
  } catch (error) {
    if (error instanceof AppError) return next(error);
    next(new AppError(401, 'Session expirée. Reconnectez-vous.'));
  }
}

export function requirePeople(req, _res, next) {
  if (!canManagePeople(req.user.role)) {
    return next(new AppError(403, 'Réservé à l’administrateur.'));
  }
  next();
}

export function requireMoney(req, _res, next) {
  if (!canManageMoney(req.user.role)) {
    return next(new AppError(403, 'Réservé à la trésorerie.'));
  }
  next();
}

export function requireCampaigns(req, _res, next) {
  if (!canManageCampaigns(req.user.role)) {
    return next(new AppError(403, 'Action réservée à l’équipe de gestion.'));
  }
  next();
}
