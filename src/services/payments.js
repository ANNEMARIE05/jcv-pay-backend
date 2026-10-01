import { pool, withTx } from '../db.js';
import { AppError } from '../errors.js';
import { config } from '../config.js';
import { formatPhone, normalizePhone } from '../utils/phone.js';
import {
  buildMatricule,
  buildReceiptNumber,
  buildReference,
  buildSecurityCode,
  money,
} from '../utils/codes.js';
import { presentReceipt, presentTransaction } from './present.js';
import { notify, sourceBalance } from './espace.js';
import { createGeniusPayment, getGeniusPayment, isGatewayMethod } from './geniuspay.js';

const GATEWAY_TO_LOCAL = {
  wave: 'WAVE',
  orange_money: 'ORANGE_MONEY',
  mtn_money: 'MTN_MOMO',
  mtn_momo: 'MTN_MOMO',
  moov_money: 'MOOV_MONEY',
  card: 'CARTE_BANCAIRE',
  paystack: 'CARTE_BANCAIRE',
  pawapay: 'WAVE',
  mobile_money: 'WAVE',
};

export function sourceForMethod(method) {
  if (method === 'WAVE') return 'WAVE';
  if (method === 'ORANGE_MONEY') return 'ORANGE_MONEY';
  if (method === 'ESPECES') return 'CAISSE_PHYSIQUE';
  return 'BANQUE';
}

const CONTRIBUTION_TYPES = new Set([
  'DIME',
  'OFFRANDE',
  'COTISATION',
  'PROJET',
  'EVENEMENT',
  'EPARGNE',
  'LIBRE',
]);

const PAYMENT_METHODS = new Set([
  'WAVE',
  'ORANGE_MONEY',
  'MTN_MOMO',
  'MOOV_MONEY',
  'CARTE_BANCAIRE',
  'VIREMENT',
  'ESPECES',
]);

function optionalUuid(value, label) {
  if (value == null || String(value).trim() === '') return null;
  const id = String(value).trim();
  if (id === 'principale') return 'principale';
  if (!isUuid(id)) throw new AppError(400, `${label} invalide.`);
  return id;
}

async function resolveTargets({ type, projetId, caisseId, evenementId, cotisationId }) {
  if (!CONTRIBUTION_TYPES.has(type)) throw new AppError(400, 'Type de versement invalide.');
  let projet = optionalUuid(projetId, 'Projet');
  let caisse = optionalUuid(caisseId, 'Caisse');
  const evenement = optionalUuid(evenementId, 'Événement');
  const cotisation = optionalUuid(cotisationId, 'Cotisation');
  if (projet === 'principale') projet = null;
  if (evenement === 'principale' || cotisation === 'principale') {
    throw new AppError(400, 'Référence invalide.');
  }

  if (type === 'PROJET' && !projet && (!caisse || caisse === 'principale')) {
    throw new AppError(400, 'Sélectionnez le projet concerné par ce versement.');
  }

  if (caisse && caisse !== 'principale') {
    const { rows } = await pool.query(
      `SELECT * FROM caisses WHERE id = $1 AND supprimee = FALSE`,
      [caisse]
    );
    if (!rows[0]) throw new AppError(404, 'Caisse introuvable.');
    if (rows[0].principale) {
      caisse = 'principale';
    } else if (rows[0].statut === 'TERMINEE') {
      throw new AppError(409, 'Cette caisse est clôturée.');
    } else if (projet && rows[0].projet_id && rows[0].projet_id !== projet) {
      throw new AppError(400, 'Cette caisse n’appartient pas à ce projet.');
    } else if (!projet && rows[0].projet_id) {
      projet = rows[0].projet_id;
    }
  }

  if (projet) {
    const { rows } = await pool.query('SELECT * FROM projets WHERE id = $1', [projet]);
    if (!rows[0]) throw new AppError(404, 'Projet introuvable.');
    if (rows[0].statut === 'CLOTURE') throw new AppError(409, 'Ce projet est clôturé.');
    if (!caisse || caisse === 'principale') {
      const linked = await pool.query(
        `SELECT id FROM caisses
         WHERE projet_id = $1 AND supprimee = FALSE AND principale = FALSE AND statut = 'OUVERTE'
         ORDER BY date_ouverture DESC
         LIMIT 1`,
        [projet]
      );
      if (!linked.rows[0]) throw new AppError(400, 'Aucune caisse ouverte pour ce projet.');
      caisse = linked.rows[0].id;
    }
  }

  if (!caisse || caisse === 'principale') {
    const { rows } = await pool.query('SELECT id FROM caisses WHERE principale = TRUE LIMIT 1');
    if (!rows[0]) throw new AppError(500, 'Caisse principale absente.');
    caisse = rows[0].id;
  }

  if (evenement) {
    const { rowCount } = await pool.query('SELECT 1 FROM evenements WHERE id = $1', [evenement]);
    if (!rowCount) throw new AppError(404, 'Événement introuvable.');
  }
  if (cotisation) {
    const { rowCount } = await pool.query('SELECT 1 FROM cotisations WHERE id = $1', [cotisation]);
    if (!rowCount) throw new AppError(404, 'Cotisation introuvable.');
  }

  return { projetId: projet, caisseId: caisse, evenementId: evenement, cotisationId: cotisation };
}

const CAISSE_BALANCE_SQL = `
  SELECT (
    COALESCE((
      SELECT SUM(t.montant) FROM transactions t
      WHERE t.statut = 'VALIDE' AND t.caisse_id = $1
    ), 0)
    + COALESCE((SELECT SUM(tr.montant) FROM transferts tr WHERE tr.destination_id = $1), 0)
    - COALESCE((SELECT SUM(tr.montant) FROM transferts tr WHERE tr.source_id = $1), 0)
  ) AS solde
`;

async function caisseBalance(client, caisseId) {
  const { rows } = await client.query(CAISSE_BALANCE_SQL, [caisseId]);
  return Number(rows[0].solde);
}

async function uniqueCode(client, builder, table, column) {
  for (let i = 0; i < 6; i += 1) {
    const value = builder();
    const { rowCount } = await client.query(`SELECT 1 FROM ${table} WHERE ${column} = $1`, [value]);
    if (!rowCount) return value;
  }
  throw new AppError(500, 'Impossible de générer une référence unique.');
}

async function insertPayment(client, input) {
  const reference = await uniqueCode(client, buildReference, 'transactions', 'reference');
  const numero = await uniqueCode(client, buildReceiptNumber, 'recus', 'numero_recu');
  const inserted = await client.query(
    `INSERT INTO transactions (
       reference, titre, description, type, montant, statut, moyen_paiement,
       projet_id, evenement_id, cotisation_id, caisse_id,
       donateur_user_id, donateur_nom, donateur_telephone, donateur_telephone_norm,
       donateur_email, donateur_matricule, frais, checkout_url, geniuspay_reference, geniuspay_id, environnement
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9,$10,$11,
       $12,$13,$14,$15,
       $16,$17,$18,$19,$20,$21,$22
     ) RETURNING *`,
    [
      reference,
      input.titre,
      input.description || null,
      input.type,
      input.montant,
      input.statut,
      input.moyenPaiement,
      input.projetId || null,
      input.evenementId || null,
      input.cotisationId || null,
      input.caisseId || null,
      input.userId || null,
      input.donateurNom,
      input.donateurTelephone,
      normalizePhone(input.donateurTelephone),
      input.donateurEmail || null,
      input.donateurMatricule || null,
      input.frais || 0,
      input.checkoutUrl || null,
      input.geniuspayReference || null,
      input.geniuspayId || null,
      input.environnement || null,
    ]
  );
  const recu = await client.query(
    `INSERT INTO recus (numero_recu, transaction_id, code_securite)
     VALUES ($1, $2, $3) RETURNING *`,
    [numero, inserted.rows[0].id, buildSecurityCode(input.statut === 'VALIDE' ? 'VAL' : 'ATT')]
  );
  return { transaction: inserted.rows[0], recu: recu.rows[0] };
}

export async function loadPaymentView(id) {
  const { rows } = await pool.query(
    `SELECT t.*, r.numero_recu, r.code_securite, r.id AS recu_id
     FROM transactions t
     LEFT JOIN recus r ON r.transaction_id = t.id
     WHERE t.id::text = $1 OR t.reference = $1 OR t.geniuspay_reference = $1 OR r.numero_recu = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function declarePayment(user, body) {
  const montant = money(body.montant);
  const moyen = body.moyenPaiement;
  if (!body.titre || !body.type || !moyen) throw new AppError(400, 'Titre, type et moyen de paiement sont requis.');
  if (montant <= 0) throw new AppError(400, 'Le montant doit être supérieur à 0.');

  if (!PAYMENT_METHODS.has(moyen)) throw new AppError(400, 'Moyen de paiement invalide.');
  const telephone = formatPhone(body.donateurTelephone || user.telephone);
  const targets = await resolveTargets({
    type: body.type,
    projetId: body.projetId,
    caisseId: body.caisseProjetId,
    evenementId: body.evenementId,
    cotisationId: body.cotisationId,
  });
  const base = {
    titre: String(body.titre).slice(0, 180),
    description: body.description,
    type: body.type,
    montant,
    moyenPaiement: moyen,
    projetId: targets.projetId,
    evenementId: targets.evenementId,
    cotisationId: targets.cotisationId,
    caisseId: targets.caisseId,
    userId: user.id,
    donateurNom: body.donateurNom || `${user.prenom} ${user.nom}`.trim(),
    donateurTelephone: telephone,
    donateurEmail: body.donateurEmail || user.email,
    donateurMatricule: user.matricule,
  };

  if (!isGatewayMethod(moyen)) {
    const created = await withTx((client) =>
      insertPayment(client, { ...base, statut: 'EN_ATTENTE' })
    );
    await notify(user.id, {
      titre: 'Versement déclaré',
      message: `${base.titre} est en attente de confirmation par la trésorerie.`,
      type: 'PAIEMENT',
      referenceId: created.transaction.id,
    });
    const view = await loadPaymentView(created.transaction.id);
    return { transaction: presentTransaction(view), recu: presentReceipt(view), checkoutUrl: null };
  }

  if (montant < 200) throw new AppError(400, 'Le montant minimum GeniusPay est de 200 FCFA.');

  const pending = await withTx((client) => insertPayment(client, { ...base, statut: 'EN_ATTENTE' }));
  try {
    const remote = await createGeniusPayment({
      amount: montant,
      method: moyen,
      description: base.titre,
      customer: { name: base.donateurNom, email: base.donateurEmail, phone: telephone.replace(/\s/g, '') },
      transactionId: pending.transaction.id,
      userId: user.id,
    });
    await pool.query(
      `UPDATE transactions
       SET geniuspay_id = $2, geniuspay_reference = $3, checkout_url = $4, environnement = $5, frais = $6, montant_net = $7, updated_at = NOW()
       WHERE id = $1`,
      [
        pending.transaction.id,
        remote.id ? String(remote.id) : null,
        remote.reference || null,
        remote.checkout_url || remote.payment_url || null,
        remote.environment || null,
        money(remote.fees),
        remote.net_amount != null ? money(remote.net_amount) : null,
      ]
    );
  } catch (error) {
    await pool.query(`UPDATE transactions SET statut = 'ECHEC', updated_at = NOW() WHERE id = $1`, [
      pending.transaction.id,
    ]);
    throw error;
  }

  const view = await loadPaymentView(pending.transaction.id);
  return {
    transaction: presentTransaction(view),
    recu: presentReceipt(view),
    checkoutUrl: view.checkout_url,
  };
}

export async function recordCash(actor, body) {
  const montant = money(body.montant);
  if (!body.donateurNom || montant <= 0 || !body.type) {
    throw new AppError(400, 'Nom, type et montant sont requis.');
  }
  const phone = formatPhone(body.donateurTelephone || '');
  const donor = await findUserByPhone(phone);
  const targets = await resolveTargets({
    type: body.type,
    projetId: body.projetId,
    caisseId: body.caisseProjetId,
  });
  const created = await withTx(async (client) => {
    const payment = await insertPayment(client, {
      titre: body.titre || 'Versement en espèces',
      type: body.type,
      montant,
      statut: 'VALIDE',
      moyenPaiement: 'ESPECES',
      projetId: targets.projetId,
      caisseId: targets.caisseId,
      userId: donor?.id || null,
      donateurNom: body.donateurNom,
      donateurTelephone: phone || 'Guichet',
      donateurEmail: donor?.email,
      donateurMatricule: body.donateurMatricule || donor?.matricule,
    });
    await creditMovement(client, {
      transaction: payment.transaction,
      auteur: `${actor.prenom} ${actor.nom}`.trim(),
      auteurId: actor.id,
    });
    return payment;
  });
  if (donor) {
    await notify(donor.id, {
      titre: 'Reçu disponible',
      message: `Votre versement de ${montant.toLocaleString('fr-FR')} FCFA a été confirmé.`,
      type: 'PAIEMENT',
      referenceId: created.transaction.id,
    });
  }
  const view = await loadPaymentView(created.transaction.id);
  return { transaction: presentTransaction(view), recu: presentReceipt(view) };
}

async function findUserByPhone(phone) {
  const norm = normalizePhone(phone);
  if (!norm) return null;
  const { rows } = await pool.query('SELECT * FROM utilisateurs WHERE telephone_norm = $1', [norm]);
  return rows[0] || null;
}

async function creditMovement(client, { transaction, auteur, auteurId }) {
  await client.query(
    `INSERT INTO mouvements (type, montant, motif, source, auteur, auteur_id, transaction_id, caisse_id)
     VALUES ('ENTREE', $1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT DO NOTHING`,
    [
      transaction.montant,
      `${transaction.titre} — ${transaction.donateur_nom}`,
      sourceForMethod(transaction.moyen_paiement),
      auteur,
      auteurId || null,
      transaction.id,
      transaction.caisse_id,
    ]
  );
  if (transaction.evenement_id && transaction.donateur_user_id) {
    await client.query(
      `INSERT INTO inscriptions (evenement_id, utilisateur_id)
       VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [transaction.evenement_id, transaction.donateur_user_id]
    );
  }
}

export async function setPaymentStatus(actor, id, statut) {
  const current = await loadPaymentView(id);
  if (!current) throw new AppError(404, 'Versement introuvable.');
  if (current.statut === statut) return presentTransaction(current);
  if (current.statut === 'VALIDE' && statut !== 'VALIDE') {
    throw new AppError(409, 'Un versement déjà validé ne peut plus être modifié.');
  }

  await withTx(async (client) => {
    await client.query(`UPDATE transactions SET statut = $2, updated_at = NOW() WHERE id = $1`, [
      current.id,
      statut,
    ]);
    if (statut === 'VALIDE') {
      const fresh = { ...current, statut: 'VALIDE' };
      await creditMovement(client, {
        transaction: fresh,
        auteur: actor ? `${actor.prenom} ${actor.nom}`.trim() : 'Trésorerie',
        auteurId: actor?.id,
      });
    }
  });

  await notify(current.donateur_user_id, {
    titre: statut === 'VALIDE' ? 'Versement confirmé' : 'Versement rejeté',
    message:
      statut === 'VALIDE'
        ? `${current.titre} est confirmé. Votre reçu est disponible.`
        : `${current.titre} n’a pas été confirmé.`,
    type: 'PAIEMENT',
    referenceId: current.id,
  });
  return presentTransaction(await loadPaymentView(current.id));
}

export async function transferCaisse(actor, body) {
  const montant = money(body.montant);
  const motif = String(body.motif || '').trim();
  const fromId = String(body.fromId || '').trim();
  const toRaw = String(body.toId || '').trim();
  if (montant <= 0 || !motif) throw new AppError(400, 'Montant et motif sont requis.');
  if (!isUuid(fromId)) throw new AppError(400, 'Choisissez la caisse à débiter.');
  if (toRaw !== 'principale' && !isUuid(toRaw)) throw new AppError(400, 'Choisissez la caisse de destination.');
  if (fromId === toRaw) throw new AppError(400, 'Choisissez une autre caisse.');

  await withTx(async (client) => {
    const destId = toRaw === 'principale' ? await principalCaisseId(client) : toRaw;
    const ordered = [fromId, destId].sort();
    await lockCaisse(client, ordered[0]);
    if (ordered[1] !== ordered[0]) await lockCaisse(client, ordered[1]);

    const source = (await client.query('SELECT * FROM caisses WHERE id = $1', [fromId])).rows[0];
    if (!source || source.supprimee) throw new AppError(404, 'Caisse source introuvable.');
    if (source.principale) {
      throw new AppError(400, 'La caisse principale reçoit, elle n’envoie pas.');
    }
    if (source.statut === 'TERMINEE') throw new AppError(409, 'Cette caisse est clôturée.');

    const destination = (await client.query('SELECT * FROM caisses WHERE id = $1', [destId])).rows[0];
    if (!destination || destination.supprimee) throw new AppError(404, 'Caisse de destination introuvable.');
    if (destination.id === source.id) throw new AppError(400, 'Choisissez une autre caisse.');
    if (!destination.principale && destination.statut === 'TERMINEE') {
      throw new AppError(409, 'La caisse de destination est clôturée.');
    }

    const solde = await caisseBalance(client, source.id);
    if (montant > solde) throw new AppError(400, 'Solde insuffisant sur cette caisse.');

    await client.query(
      `INSERT INTO transferts (source_id, destination_id, montant, motif, auteur, auteur_id)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [source.id, destination.id, montant, motif.slice(0, 240), `${actor.prenom} ${actor.nom}`.trim(), actor.id]
    );
  });
}

export async function deleteCaisse(id) {
  if (!isUuid(id)) throw new AppError(400, 'Caisse invalide.');
  await withTx(async (client) => {
    const caisse = await lockCaisse(client, id);
    if (!caisse || caisse.supprimee) throw new AppError(404, 'Caisse introuvable.');
    if (caisse.principale) throw new AppError(400, 'La caisse principale ne se supprime pas.');
    const solde = await caisseBalance(client, caisse.id);
    if (solde > 0) {
      throw new AppError(400, 'Transférez d’abord le solde, puis supprimez la caisse.');
    }
    await client.query(
      `UPDATE caisses
       SET supprimee = TRUE, statut = 'TERMINEE', date_cloture = COALESCE(date_cloture, NOW())
       WHERE id = $1`,
      [caisse.id]
    );
  });
}

async function principalCaisseId(client) {
  const { rows } = await client.query('SELECT id FROM caisses WHERE principale = TRUE LIMIT 1');
  if (!rows[0]) throw new AppError(500, 'Caisse principale absente.');
  return rows[0].id;
}

async function lockCaisse(client, id) {
  const { rows } = await client.query('SELECT * FROM caisses WHERE id = $1 FOR UPDATE', [id]);
  return rows[0] || null;
}

export async function withdraw(actor, body) {
  const montant = money(body.montant);
  const source = body.source;
  if (!body.motif || montant <= 0 || !source) throw new AppError(400, 'Montant, motif et caisse sont requis.');
  const solde = await sourceBalance(source);
  if (montant > solde) return null;
  const { rows } = await pool.query(
    `INSERT INTO mouvements (type, montant, motif, source, auteur, auteur_id, beneficiaire, caisse_id)
     VALUES ('SORTIE', $1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [
      montant,
      body.motif,
      source,
      body.auteur || `${actor.prenom} ${actor.nom}`.trim(),
      actor.id,
      body.beneficiaire || null,
      body.caisseProjetId || null,
    ]
  );
  return rows[0];
}

const STATUS_MAP = {
  pending: null,
  processing: null,
  completed: 'VALIDE',
  success: 'VALIDE',
  failed: 'ECHEC',
  cancelled: 'ANNULE',
  canceled: 'ANNULE',
  expired: 'ECHEC',
  declined: 'ECHEC',
  rejected: 'ECHEC',
  refunded: 'ANNULE',
};

export async function applyGatewayUpdate(data) {
  const meta = data.metadata || {};
  const reference = data.reference;
  const localId = meta.transaction_id || meta.order_id || meta.transactionId;
  const { rows } = await pool.query(
    `SELECT * FROM transactions
     WHERE ($1::uuid IS NOT NULL AND id = $1::uuid)
        OR ($2::text IS NOT NULL AND geniuspay_reference = $2)
     LIMIT 1`,
    [isUuid(localId) ? localId : null, reference || null]
  );
  const tx = rows[0];
  if (!tx) return null;
  const remoteStatus = String(data.status || '').toLowerCase();
  const statut = STATUS_MAP[remoteStatus];
  const methodKey = String(
    data.payment_method || data.payment_provider || data.provider || ''
  ).toLowerCase();
  const method = GATEWAY_TO_LOCAL[methodKey];
  await pool.query(
    `UPDATE transactions
     SET frais = COALESCE($2, frais),
         montant_net = COALESCE($3, montant_net),
         moyen_paiement = COALESCE($4, moyen_paiement),
         updated_at = NOW()
     WHERE id = $1`,
    [tx.id, data.fees != null ? money(data.fees) : null, data.net_amount != null ? money(data.net_amount) : null, method || null]
  );
  if (!statut || tx.statut === statut || tx.statut === 'VALIDE') return tx.id;
  try {
    await setPaymentStatus(null, tx.id, statut);
  } catch (error) {
    if (error.status !== 409) throw error;
  }
  return tx.id;
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

export async function syncPayment(user, id) {
  const tx = await loadPaymentView(id);
  if (!tx) throw new AppError(404, 'Versement introuvable.');
  const owner = tx.donateur_user_id === user.id;
  const staff = user.role === 'SUPER_ADMIN' || user.role === 'TRESORIER' || user.role === 'ADMINISTRATEUR';
  if (!owner && !staff) throw new AppError(403, 'Accès refusé.');
  if (!tx.geniuspay_reference) return presentTransaction(tx);
  let remote = null;
  try {
    remote = await getGeniusPayment(tx.geniuspay_reference);
    await applyGatewayUpdate(remote);
  } catch {
    // En cas d'erreur de contact passerelle
  }
  const updated = await loadPaymentView(tx.id);
  if (!updated) return presentTransaction(tx);
  if (updated.statut === 'VALIDE') return presentTransaction(updated);

  const remoteStatus = String(remote?.status || '').toLowerCase();
  const mapped = STATUS_MAP[remoteStatus];
  if (mapped && mapped !== updated.statut && updated.statut !== 'VALIDE') {
    try {
      await setPaymentStatus(null, tx.id, mapped);
    } catch (error) {
      if (error.status !== 409) throw error;
    }
  }
  return presentTransaction(await loadPaymentView(tx.id));
}

export async function nextMatricule(client, role) {
  for (let i = 0; i < 6; i += 1) {
    const value = buildMatricule(role);
    const { rowCount } = await client.query('SELECT 1 FROM utilisateurs WHERE matricule = $1', [value]);
    if (!rowCount) return value;
  }
  throw new AppError(500, 'Impossible de générer un matricule.');
}

export { config };
