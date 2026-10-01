import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { config } from '../config.js';

const ROUNDS = 12;

export function hashPassword(password) {
  return bcrypt.hash(password, ROUNDS);
}

export function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

export function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, {
    expiresIn: config.jwtExpires,
  });
}

export function readToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

export const ADMIN_ROLES = ['SUPER_ADMIN', 'ADMINISTRATEUR'];
export const MONEY_ROLES = ['SUPER_ADMIN', 'TRESORIER'];
export const CAMPAIGN_ROLES = ['SUPER_ADMIN', 'ADMINISTRATEUR', 'TRESORIER'];

export function canManagePeople(role) {
  return ADMIN_ROLES.includes(role);
}

export function canManageMoney(role) {
  return MONEY_ROLES.includes(role);
}

export function canManageCampaigns(role) {
  return CAMPAIGN_ROLES.includes(role);
}
