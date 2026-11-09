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
import {
  createPayment,
  getPayment,
  hasGeniusPayCredentials,
} from './geniuspay.js';

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
  'ESPECES',
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isUuid(value) {
  return UUID_RE.test(String(value || ''));
}

function optionalUuid(value, label) {
  if (value == null) return null;
  const id = String(value).trim();
  if (!id) return null;
  if (id === 'principale') return 'principale';
  if (!isUuid(id)) throw new AppError(400, `${label} invalide.`);
  return id;
}

function validateContributionTargets(type, projet, caisse, evenement, cotisation) {
  if (!CONTRIBUTION_TYPES.has(type)) {
    throw new AppError(400, 'Type de versement invalide.');
  }
  if (evenement === 'principale' || cotisation === 'principale') {
    throw new AppError(400, 'Référence invalide.');
  }
  const isCaissePrincipaleOrEmpty = !caisse || caisse === 'principale';
  if (type === 'PROJET' && !projet && isCaissePrincipaleOrEmpty) {
    throw new AppError(400, 'Sélectionnez le projet concerné par ce versement.');
  }
}

async function resolveExplicitCaisse(caisseId, projetId) {
  if (!caisseId || caisseId === 'principale') {
    return { caisse: caisseId, projet: projetId };
  }

  const { rows } = await pool.query(
    'SELECT * FROM caisses WHERE id = $1 AND supprimee = FALSE',
    [caisseId]
  );
  const caisse = rows[0];
  if (!caisse) {
    throw new AppError(404, 'Caisse introuvable.');
  }
  if (caisse.principale) {
    return { caisse: 'principale', projet: projetId };
  }
  if (caisse.statut === 'TERMINEE') {
    throw new AppError(409, 'Cette caisse est clôturée.');
  }
  if (projetId && caisse.projet_id && caisse.projet_id !== projetId) {
    throw new AppError(400, 'Cette caisse n’appartient pas à ce projet.');
  }

  const resolvedProjet = (!projetId && caisse.projet_id) ? caisse.projet_id : projetId;
  return { caisse: caisse.id, projet: resolvedProjet };
}

async function resolveProjetCaisse(projetId, currentCaisseId) {
  if (!projetId) return currentCaisseId;

  const { rows } = await pool.query('SELECT * FROM projets WHERE id = $1', [projetId]);
  const projet = rows[0];
  if (!projet) {
    throw new AppError(404, 'Projet introuvable.');
  }
  if (projet.statut === 'CLOTURE') {
    throw new AppError(409, 'Ce projet est clôturé.');
  }

  if (currentCaisseId && currentCaisseId !== 'principale') {
    return currentCaisseId;
  }

  const linked = await pool.query(
    `SELECT id FROM caisses
     WHERE projet_id = $1 AND supprimee = FALSE AND principale = FALSE AND statut = 'OUVERTE'
     ORDER BY date_ouverture DESC
     LIMIT 1`,
    [projetId]
  );
  if (!linked.rows[0]) {
    throw new AppError(400, 'Aucune caisse ouverte pour ce projet.');
  }
  return linked.rows[0].id;
}

async function assertEntityExists(table, id, label) {
  if (!id) return;
  const { rowCount } = await pool.query(`SELECT 1 FROM ${table} WHERE id = $1`, [id]);
  if (!rowCount) {
    throw new AppError(404, `${label} introuvable.`);
  }
}

async function resolveTargets({ type, projetId, caisseId, evenementId, cotisationId }) {
  let projet = optionalUuid(projetId, 'Projet');
  let caisse = optionalUuid(caisseId, 'Caisse');
  const evenement = optionalUuid(evenementId, 'Événement');
  const cotisation = optionalUuid(cotisationId, 'Cotisation');
  if (projet === 'principale') projet = null;

  validateContributionTargets(type, projet, caisse, evenement, cotisation);

  const resolved = await resolveExplicitCaisse(caisse, projet);
  projet = resolved.projet;
  caisse = await resolveProjetCaisse(projet, resolved.caisse);

  if (!caisse || caisse === 'principale') {
    caisse = await principalCaisseId(pool);
  }

  await assertEntityExists('evenements', evenement, 'Événement');
  await assertEntityExists('cotisations', cotisation, 'Cotisation');

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
       donateur_email, donateur_matricule, frais, checkout_url, environnement
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9,$10,$11,
       $12,$13,$14,$15,
       $16,$17,$18,$19,$20
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
    `SELECT t.*, r.numero_recu, r.code_securite, r.id AS recu_id, r.transaction_id
     FROM transactions t
     LEFT JOIN recus r ON r.transaction_id = t.id
     WHERE t.id::text = $1 OR t.reference = $1 OR r.numero_recu = $1 OR t.geniuspay_reference = $1 OR r.id::text = $1
     LIMIT 1`,
    [id]
  );
  return rows[0] || null;
}

export async function declarePayment(user, body, options = {}) {
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

  const created = await withTx((client) =>
    insertPayment(client, { ...base, statut: 'EN_ATTENTE' })
  );

  const isOnline = ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'CARTE_BANCAIRE'].includes(moyen);
  let checkoutUrl = null;

  if (isOnline && hasGeniusPayCredentials() && !options.skipGeniusPay) {
    if (montant < 200) {
      throw new AppError(400, 'Le montant minimum pour un paiement en ligne est de 200 FCFA.');
    }

    try {
      const baseUrl = options.requestBaseUrl || config.publicBaseUrl;
      const platformParam = encodeURIComponent(options.platform || body.platform || 'mobile');
      const successUrl = `${baseUrl}/paiement/retour?status=success&ref=${encodeURIComponent(created.transaction.reference)}&platform=${platformParam}`;
      const errorUrl = `${baseUrl}/paiement/retour?status=error&ref=${encodeURIComponent(created.transaction.reference)}&platform=${platformParam}`;

      const gp = await createPayment({
        amount: montant,
        paymentMethod: moyen,
        description: `${base.titre} — ${base.donateurNom}`,
        customer: {
          name: base.donateurNom,
          email: base.donateurEmail,
          phone: telephone,
        },
        metadata: {
          transaction_id: created.transaction.id,
          reference: created.transaction.reference,
          order_id: created.transaction.reference,
          donateur_user_id: user.id,
          type: body.type,
        },
        successUrl,
        errorUrl,
      });

      checkoutUrl = gp.checkout_url || gp.payment_url || null;

      await pool.query(
        `UPDATE transactions
         SET geniuspay_id = $1,
             geniuspay_reference = $2,
             checkout_url = $3,
             environnement = $4,
             updated_at = NOW()
         WHERE id = $5`,
        [
          gp.id ? String(gp.id) : null,
          gp.reference || null,
          checkoutUrl,
          gp.environment || config.geniuspay.environment,
          created.transaction.id,
        ]
      );
    } catch (gpErr) {
      console.error('[GeniusPay Initiation Error]', gpErr.message);
      await pool.query(`UPDATE transactions SET statut = 'ECHEC', motif_rejet = $2 WHERE id = $1`, [
        created.transaction.id,
        `Échec d’initialisation de paiement : ${gpErr.message}`,
      ]);
      throw gpErr;
    }
  }

  await notify(user.id, {
    titre: isOnline ? 'Paiement initié' : 'Versement déclaré',
    message: isOnline
      ? `${base.titre} — Veuillez finaliser le paiement sur GeniusPay.`
      : `${base.titre} est en attente de confirmation par la trésorerie.`,
    type: 'PAIEMENT',
    referenceId: created.transaction.id,
  });

  const view = await loadPaymentView(created.transaction.id);
  return {
    transaction: presentTransaction(view),
    recu: presentReceipt(view),
    checkoutUrl,
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

export async function setPaymentStatus(actor, id, statut, motifRejet = null) {
  const current = await loadPaymentView(id);
  if (!current) throw new AppError(404, 'Versement introuvable.');
  if (current.statut === statut) return presentTransaction(current);
  if (current.statut === 'VALIDE' && statut !== 'VALIDE') {
    throw new AppError(409, 'Un versement déjà validé ne peut plus être modifié.');
  }

  await withTx(async (client) => {
    await client.query(
      `UPDATE transactions SET statut = $2, motif_rejet = COALESCE($3, motif_rejet), updated_at = NOW() WHERE id = $1`,
      [current.id, statut, motifRejet]
    );
    if (statut === 'VALIDE') {
      const fresh = { ...current, statut: 'VALIDE' };
      await creditMovement(client, {
        transaction: fresh,
        auteur: actor ? `${actor.prenom} ${actor.nom}`.trim() : 'Trésorerie',
        auteurId: actor?.id,
      });
      await client.query(
        `UPDATE recus SET code_securite = $1 WHERE transaction_id = $2`,
        [buildSecurityCode('VAL'), current.id]
      );
    }
  });

  await notify(current.donateur_user_id, {
    titre: statut === 'VALIDE' ? 'Versement confirmé' : 'Versement rejeté',
    message:
      statut === 'VALIDE'
        ? `${current.titre} est confirmé. Votre reçu est disponible.`
        : `${current.titre} n’a pas été confirmé${motifRejet ? ` (${motifRejet})` : ''}.`,
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
async function notifyTreasuryStaff(payload) {
  const { rows } = await pool.query(
    `SELECT id FROM utilisateurs WHERE role IN ('TRESORIER', 'SUPER_ADMIN') AND actif = TRUE`
  );
  await Promise.all(rows.map((row) => notify(row.id, payload)));
}

/** Valide directement le paiement en ligne réussi sans exiger de confirmation manuelle. */
export async function applySuccessfulPayment(tx, gpData = {}) {
  if (tx.statut === 'VALIDE') return;

  const fees = Math.round(Number(gpData.fees || 0));
  const netAmount = Math.round(Number(gpData.net_amount || (Number(tx.montant) - fees)));

  await withTx(async (client) => {
    await client.query(
      `UPDATE transactions
       SET statut = 'VALIDE',
           frais = $1,
           montant_net = $2,
           motif_rejet = NULL,
           geniuspay_id = COALESCE($3, geniuspay_id),
           geniuspay_reference = COALESCE($4, geniuspay_reference),
           updated_at = NOW()
       WHERE id = $5`,
      [
        fees,
        netAmount,
        gpData.id ? String(gpData.id) : null,
        gpData.reference || null,
        tx.id,
      ]
    );

    const fresh = { ...tx, statut: 'VALIDE' };
    await creditMovement(client, {
      transaction: fresh,
      auteur: 'Paiement en ligne (Automatique)',
      auteurId: null,
    });

    await client.query(
      `UPDATE recus SET code_securite = $1 WHERE transaction_id = $2`,
      [buildSecurityCode('VAL'), tx.id]
    );
  });

  if (tx.donateur_user_id) {
    await notify(tx.donateur_user_id, {
      titre: 'Paiement validé !',
      message: `Votre versement de ${Number(tx.montant).toLocaleString('fr-FR')} FCFA (${tx.titre}) a été validé avec succès. Votre reçu officiel est disponible.`,
      type: 'PAIEMENT',
      referenceId: tx.id,
    });
  }

  await notifyTreasuryStaff({
    titre: 'Versement en ligne encaissé',
    message: `${tx.donateur_nom} — ${Number(tx.montant).toLocaleString('fr-FR')} FCFA (${tx.titre}). Paiement en ligne validé et crédité automatiquement.`,
    type: 'PAIEMENT',
    referenceId: tx.id,
  });
}

export async function syncPayment(user, id) {
  const tx = await loadPaymentView(id);
  if (!tx) throw new AppError(404, 'Versement introuvable.');
  const owner = tx.donateur_user_id === user.id;
  const staff = user.role === 'SUPER_ADMIN' || user.role === 'TRESORIER' || user.role === 'ADMINISTRATEUR';
  if (!owner && !staff) throw new AppError(403, 'Accès refusé.');

  if (tx.statut === 'VALIDE') {
    return presentTransaction(tx);
  }

  if (tx.geniuspay_reference && hasGeniusPayCredentials()) {
    try {
      const gp = await getPayment(tx.geniuspay_reference, { timeoutMs: 3000 });
      if (gp && gp.status === 'completed') {
        await applySuccessfulPayment(tx, gp);
        const refreshed = await loadPaymentView(tx.id);
        return presentTransaction(refreshed);
      } else if (gp && ['failed', 'rejected', 'declined', 'cancelled', 'canceled', 'expired', 'timeout'].includes(gp.status)) {
        const isCancelled = gp.status === 'cancelled' || gp.status === 'canceled';
        const newStatus = isCancelled ? 'ANNULE' : 'ECHEC';
        const reason = gp.failure_reason || gp.error_message || gp.decline_reason || (
          isCancelled
            ? 'Paiement annulé par l’utilisateur.'
            : gp.status === 'expired' || gp.status === 'timeout'
              ? 'Délai d’authentification de paiement expiré.'
              : 'Paiement rejeté ou refusé par l’opérateur (solde insuffisant ou rejet banque).'
        );
        await pool.query(
          `UPDATE transactions SET statut = $1, motif_rejet = $2, updated_at = NOW() WHERE id = $3`,
          [newStatus, reason, tx.id]
        );
        const refreshed = await loadPaymentView(tx.id);
        return presentTransaction(refreshed);
      }
    } catch (err) {
      console.warn(`[Sync GeniusPay Warning for tx ${tx.reference}]`, err.message);
    }
  }

  return presentTransaction(tx);
}

export async function syncPaymentByReference(reference, statusHint = null, reasonHint = null) {
  if (!reference) return null;
  let view = await loadPaymentView(reference);
  if (!view) return null;

  if (view.statut === 'VALIDE') {
    return view;
  }

  // 1. Si statusHint === 'success' : Validation rapide instantanée (sans délai réseau externe)
  if (statusHint === 'success') {
    if (view.statut === 'EN_ATTENTE') {
      await applySuccessfulPayment(view, {
        reference: view.geniuspay_reference || view.reference,
        status: 'completed',
      });
      // Requête asynchrone non bloquante pour récupérer les détails de frais si besoin
      const gpRef = view.geniuspay_reference || (reference.startsWith('MTX-') ? null : reference);
      if (gpRef && hasGeniusPayCredentials()) {
        getPayment(gpRef, { timeoutMs: 1500 })
          .then((gp) => {
            if (gp?.fees != null || gp?.net_amount != null) {
              const fees = Math.round(Number(gp.fees || 0));
              const net = Math.round(Number(gp.net_amount || (Number(view.montant) - fees)));
              pool.query(
                'UPDATE transactions SET frais = $1, montant_net = $2, updated_at = NOW() WHERE id = $3',
                [fees, net, view.id]
              ).catch(() => {});
            }
          })
          .catch(() => {});
      }
      return await loadPaymentView(view.id);
    }
    return view;
  }

  // 2. Si le retour de passerelle indique échec ou annulation
  if (statusHint === 'error' || statusHint === 'failed' || statusHint === 'cancelled' || statusHint === 'canceled') {
    const isCancelled = statusHint === 'cancelled' || statusHint === 'canceled';
    const newStatus = isCancelled ? 'ANNULE' : 'ECHEC';
    const reason = reasonHint || (
      isCancelled
        ? 'Paiement annulé par le donateur.'
        : 'Paiement refusé ou non validé par l’opérateur (solde insuffisant ou rejet carte/mobile).'
    );
    await pool.query(
      `UPDATE transactions SET statut = $1, motif_rejet = $2, updated_at = NOW() WHERE id = $3`,
      [newStatus, reason, view.id]
    );
    if (view.donateur_user_id) {
      await notify(view.donateur_user_id, {
        titre: isCancelled ? 'Paiement annulé' : 'Paiement non abouti',
        message: `${view.titre} — ${reason}`,
        type: 'PAIEMENT',
        referenceId: view.id,
      });
    }
    return await loadPaymentView(view.id);
  }

  // 3. Synchronisation via l'API GeniusPay avec timeout strict pour ne pas ralentir le retour
  const gpRef = view.geniuspay_reference || (reference.startsWith('MTX-') ? null : reference);
  if (gpRef && hasGeniusPayCredentials()) {
    try {
      const gp = await getPayment(gpRef, { timeoutMs: 2500 });
      if (gp && gp.status === 'completed') {
        await applySuccessfulPayment(view, gp);
        return await loadPaymentView(view.id);
      } else if (gp && ['failed', 'rejected', 'declined', 'cancelled', 'canceled', 'expired', 'timeout'].includes(gp.status)) {
        const isCancelled = gp.status === 'cancelled' || gp.status === 'canceled';
        const newStatus = isCancelled ? 'ANNULE' : 'ECHEC';
        const reason = gp.failure_reason || gp.error_message || gp.decline_reason || (
          isCancelled
            ? 'Paiement annulé par le donateur.'
            : gp.status === 'expired' || gp.status === 'timeout'
              ? 'Délai d’authentification expiré.'
              : 'Paiement refusé ou rejeté par l’opérateur.'
        );
        await pool.query(
          `UPDATE transactions SET statut = $1, motif_rejet = $2, updated_at = NOW() WHERE id = $3`,
          [newStatus, reason, view.id]
        );
        return await loadPaymentView(view.id);
      }
    } catch (err) {
      console.warn(`[Sync GeniusPay Warning for ref ${reference}]`, err.message);
    }
  }

  return view;
}

export async function handleWebhookEvent(event, payload) {
  const data = payload?.data || payload || {};
  const metadata = data?.metadata || {};
  const txId = metadata.transaction_id || data.transaction_id;
  const ref = metadata.order_id || metadata.reference || data.reference;

  let tx = null;
  if (txId) {
    tx = await loadPaymentView(txId);
  }
  if (!tx && ref) {
    tx = await loadPaymentView(ref);
  }
  if (!tx && (data.id || data.reference)) {
    const { rows } = await pool.query(
      `SELECT t.*, r.numero_recu, r.code_securite, r.id AS recu_id
       FROM transactions t
       LEFT JOIN recus r ON r.transaction_id = t.id
       WHERE t.geniuspay_id = $1 OR t.geniuspay_reference = $2
       LIMIT 1`,
      [String(data.id || ''), String(data.reference || '')]
    );
    tx = rows[0] || null;
  }

  if (!tx) {
    console.warn(`[Webhook GeniusPay] Transaction non trouvée pour event ${event}`, {
      ref,
      txId,
      gpId: data.id,
    });
    return { success: false, reason: 'Transaction introuvable' };
  }

  if (event === 'payment.success') {
    await applySuccessfulPayment(tx, data);
    return { success: true, status: 'VALIDE' };
  } else if (event === 'payment.failed' || event === 'payment.declined' || event === 'payment.rejected') {
    const reason = data.failure_reason || data.error_message || data.decline_reason || 'Paiement rejeté par l’opérateur (solde insuffisant ou refus banque)';
    await pool.query(
      `UPDATE transactions SET statut = 'ECHEC', motif_rejet = $1, updated_at = NOW() WHERE id = $2`,
      [reason, tx.id]
    );
    if (tx.donateur_user_id) {
      await notify(tx.donateur_user_id, {
        titre: 'Paiement non abouti',
        message: `Le versement de ${Number(tx.montant).toLocaleString('fr-FR')} FCFA pour ${tx.titre} a été refusé : ${reason}`,
        type: 'PAIEMENT',
        referenceId: tx.id,
      });
    }
    return { success: true, status: 'ECHEC' };
  } else if (event === 'payment.cancelled') {
    const reason = data.failure_reason || 'Paiement annulé par le donateur.';
    await pool.query(
      `UPDATE transactions SET statut = 'ANNULE', motif_rejet = $1, updated_at = NOW() WHERE id = $2`,
      [reason, tx.id]
    );
    return { success: true, status: 'ANNULE' };
  } else if (event === 'payment.expired') {
    const reason = 'Délai d’authentification de paiement expiré.';
    await pool.query(
      `UPDATE transactions SET statut = 'ECHEC', motif_rejet = $1, updated_at = NOW() WHERE id = $2`,
      [reason, tx.id]
    );
    return { success: true, status: 'ECHEC' };
  }

  return { success: true, status: tx.statut };
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
