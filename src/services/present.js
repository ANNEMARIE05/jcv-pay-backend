import { config } from '../config.js';
import { formatDateFr, formatHeure } from '../utils/codes.js';

export function presentUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    nom: row.nom,
    prenom: row.prenom,
    email: row.email || '',
    telephone: row.telephone,
    matricule: row.matricule,
    paroisse: row.paroisse,
    departement: row.departement || undefined,
    avatar: row.avatar || undefined,
    role: row.role,
    dateAdhesion: formatDateFr(row.date_adhesion),
  };
}

export function presentTransaction(row) {
  return {
    id: row.id,
    reference: row.reference,
    titre: row.titre,
    description: row.description || undefined,
    type: row.type,
    montant: Number(row.montant),
    date: formatDateFr(row.created_at),
    heure: formatHeure(row.created_at),
    statut: row.statut,
    moyenPaiement: row.moyen_paiement,
    recuNumero: row.numero_recu || '',
    projetId: row.projet_id || undefined,
    evenementId: row.evenement_id || undefined,
    cotisationId: row.cotisation_id || undefined,
    donateurNom: row.donateur_nom,
    donateurTelephone: row.donateur_telephone,
    checkoutUrl: row.checkout_url || undefined,
    geniuspayReference: row.geniuspay_reference || undefined,
  };
}

export function presentReceipt(row) {
  return {
    id: row.recu_id || row.id,
    numeroRecu: row.numero_recu,
    transactionId: row.transaction_id,
    titre: row.titre,
    type: row.type,
    donateurNom: row.donateur_nom,
    donateurMatricule: row.donateur_matricule || '',
    donateurTelephone: row.donateur_telephone,
    donateurEmail: row.donateur_email || '',
    montant: Number(row.montant),
    frais: Number(row.frais || 0),
    total: Number(row.montant),
    date: formatDateFr(row.created_at),
    heure: formatHeure(row.created_at),
    statut: row.statut,
    moyenPaiement: row.moyen_paiement,
    egliseNom: config.org.nom,
    egliseAdresse: config.org.adresse,
    codeSecurite: row.code_securite,
  };
}

export function presentProject(row) {
  return {
    id: row.id,
    titre: row.titre,
    description: row.description,
    categorie: row.categorie,
    objectif: Number(row.objectif),
    montantCollecte: Number(row.montant_collecte || 0),
    dateFin: row.date_fin,
    statut: row.statut,
    imageUrl: row.image_url,
    participantsCount: Number(row.participants_count || 0),
    maContribution: Number(row.ma_contribution || 0),
    organisateur: row.organisateur,
    lieu: row.lieu || undefined,
  };
}

export function presentEvent(row) {
  return {
    id: row.id,
    titre: row.titre,
    description: row.description,
    date: row.date_label,
    heure: row.heure,
    lieu: row.lieu,
    tarif: Number(row.tarif),
    placesDisponibles: Number(row.places_disponibles),
    placesReservees: Number(row.places_reservees || 0),
    imageUrl: row.image_url,
    estInscrit: Boolean(row.est_inscrit),
    statutPaiement: row.statut_paiement || undefined,
    intervenant: row.intervenant || undefined,
  };
}

export function presentCotisation(row) {
  const verse = Number(row.montant_verse || 0);
  const total = Number(row.montant_total);
  const reste = Math.max(total - verse, 0);
  let statut = 'A_PAYER';
  if (verse <= 0) statut = 'A_PAYER';
  else if (verse >= total) statut = 'PAYE';
  else statut = 'PARTIEL';
  return {
    id: row.id,
    titre: row.titre,
    categorie: row.categorie,
    montantTotal: total,
    montantVerse: verse,
    resteAPayer: reste,
    echeance: row.echeance,
    statut,
  };
}

export function presentCaisse(row) {
  return {
    id: row.id,
    nom: row.nom,
    description: row.description,
    projetId: row.projet_id || undefined,
    montantCollecte: Number(row.montant_collecte || 0),
    objectif: Number(row.objectif),
    statut: row.statut,
    principale: row.principale === true,
    visibleAuxMembres: row.visible_aux_membres,
    dateOuverture: formatDateFr(row.date_ouverture),
    dateCloture: row.date_cloture ? formatDateFr(row.date_cloture) : undefined,
  };
}

export function presentMouvement(row) {
  return {
    id: row.id,
    type: row.type,
    montant: Number(row.montant),
    motif: row.motif,
    date: formatDateFr(row.created_at),
    heure: formatHeure(row.created_at),
    source: row.source,
    auteur: row.auteur,
    transactionId: row.transaction_id || undefined,
    beneficiaire: row.beneficiaire || undefined,
    caisseProjetId: row.caisse_id || undefined,
  };
}

export function presentNotification(row) {
  return {
    id: row.id,
    titre: row.titre,
    message: row.message,
    date: formatDateFr(row.created_at),
    lue: row.lue,
    type: row.type,
    referenceId: row.reference_id || undefined,
  };
}
