CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE IF NOT EXISTS utilisateurs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  prenom TEXT NOT NULL,
  email TEXT,
  telephone TEXT NOT NULL,
  telephone_norm TEXT NOT NULL UNIQUE,
  mot_de_passe_hash TEXT NOT NULL,
  matricule TEXT NOT NULL UNIQUE,
  paroisse TEXT NOT NULL,
  departement TEXT,
  avatar TEXT,
  role TEXT NOT NULL CHECK (role IN ('SUPER_ADMIN', 'ADMINISTRATEUR', 'TRESORIER', 'RESPONSABLE', 'MEMBRE')),
  date_adhesion DATE NOT NULL DEFAULT CURRENT_DATE,
  actif BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS utilisateurs_email_unique
  ON utilisateurs (lower(email))
  WHERE email IS NOT NULL AND email <> '';

CREATE TABLE IF NOT EXISTS codes_verification (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id UUID NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  objet TEXT NOT NULL CHECK (objet IN ('RESET_PASSWORD')),
  expire_at TIMESTAMPTZ NOT NULL,
  utilise BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS projets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titre TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  categorie TEXT NOT NULL CHECK (categorie IN ('CONSTRUCTION', 'MISSION', 'EQUIPEMENT', 'SOCIAL')),
  objectif INTEGER NOT NULL CHECK (objectif > 0),
  date_fin TEXT NOT NULL,
  statut TEXT NOT NULL CHECK (statut IN ('EN_COURS', 'CLOTURE', 'PLANIFIE')) DEFAULT 'EN_COURS',
  image_url TEXT NOT NULL DEFAULT '',
  organisateur TEXT NOT NULL DEFAULT '',
  lieu TEXT,
  cree_par UUID REFERENCES utilisateurs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS evenements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titre TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  date_label TEXT NOT NULL,
  heure TEXT NOT NULL DEFAULT '',
  lieu TEXT NOT NULL DEFAULT '',
  tarif INTEGER NOT NULL DEFAULT 0 CHECK (tarif >= 0),
  places_disponibles INTEGER NOT NULL CHECK (places_disponibles >= 0),
  image_url TEXT NOT NULL DEFAULT '',
  intervenant TEXT,
  cree_par UUID REFERENCES utilisateurs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS inscriptions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  evenement_id UUID NOT NULL REFERENCES evenements(id) ON DELETE CASCADE,
  utilisateur_id UUID NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (evenement_id, utilisateur_id)
);

CREATE TABLE IF NOT EXISTS cotisations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  titre TEXT NOT NULL,
  categorie TEXT NOT NULL CHECK (categorie IN ('COTISATION', 'DIME', 'EPARGNE', 'PROJET')),
  montant_total INTEGER NOT NULL CHECK (montant_total > 0),
  echeance TEXT NOT NULL,
  cree_par UUID REFERENCES utilisateurs(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS caisses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  nom TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  projet_id UUID REFERENCES projets(id) ON DELETE SET NULL,
  objectif INTEGER NOT NULL DEFAULT 0 CHECK (objectif >= 0),
  statut TEXT NOT NULL CHECK (statut IN ('OUVERTE', 'TERMINEE')) DEFAULT 'OUVERTE',
  visible_aux_membres BOOLEAN NOT NULL DEFAULT TRUE,
  date_ouverture TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  date_cloture TIMESTAMPTZ,
  cree_par UUID REFERENCES utilisateurs(id)
);

CREATE TABLE IF NOT EXISTS transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reference TEXT NOT NULL UNIQUE,
  titre TEXT NOT NULL,
  description TEXT,
  type TEXT NOT NULL CHECK (type IN ('DIME', 'OFFRANDE', 'COTISATION', 'PROJET', 'EVENEMENT', 'EPARGNE', 'LIBRE')),
  montant INTEGER NOT NULL CHECK (montant > 0),
  statut TEXT NOT NULL CHECK (statut IN ('VALIDE', 'EN_ATTENTE', 'REJETE', 'ANNULE')),
  moyen_paiement TEXT NOT NULL CHECK (moyen_paiement IN ('WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'CARTE_BANCAIRE', 'VIREMENT', 'ESPECES')),
  projet_id UUID REFERENCES projets(id) ON DELETE SET NULL,
  evenement_id UUID REFERENCES evenements(id) ON DELETE SET NULL,
  cotisation_id UUID REFERENCES cotisations(id) ON DELETE SET NULL,
  caisse_id UUID REFERENCES caisses(id) ON DELETE SET NULL,
  donateur_user_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  donateur_nom TEXT NOT NULL,
  donateur_telephone TEXT NOT NULL,
  donateur_telephone_norm TEXT NOT NULL DEFAULT '',
  donateur_email TEXT,
  donateur_matricule TEXT,
  frais INTEGER NOT NULL DEFAULT 0,
  montant_net INTEGER,
  geniuspay_id TEXT,
  geniuspay_reference TEXT UNIQUE,
  checkout_url TEXT,
  environnement TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS transactions_donateur_idx ON transactions (donateur_user_id);
CREATE INDEX IF NOT EXISTS transactions_statut_idx ON transactions (statut);
CREATE INDEX IF NOT EXISTS transactions_projet_idx ON transactions (projet_id);

CREATE TABLE IF NOT EXISTS recus (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  numero_recu TEXT NOT NULL UNIQUE,
  transaction_id UUID NOT NULL UNIQUE REFERENCES transactions(id) ON DELETE CASCADE,
  code_securite TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS mouvements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type TEXT NOT NULL CHECK (type IN ('ENTREE', 'SORTIE')),
  montant INTEGER NOT NULL CHECK (montant > 0),
  motif TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('CAISSE_PHYSIQUE', 'WAVE', 'ORANGE_MONEY', 'BANQUE')),
  auteur TEXT NOT NULL,
  auteur_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  transaction_id UUID REFERENCES transactions(id) ON DELETE SET NULL,
  beneficiaire TEXT,
  caisse_id UUID REFERENCES caisses(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS mouvements_entree_tx_unique
  ON mouvements (transaction_id)
  WHERE type = 'ENTREE' AND transaction_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  utilisateur_id UUID NOT NULL REFERENCES utilisateurs(id) ON DELETE CASCADE,
  titre TEXT NOT NULL,
  message TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('PAIEMENT', 'ECHEANCE', 'PROJET', 'EVENEMENT', 'INFO')),
  lue BOOLEAN NOT NULL DEFAULT FALSE,
  reference_id TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS webhooks_recus (
  id TEXT PRIMARY KEY,
  evenement TEXT NOT NULL,
  recu_le TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE caisses ADD COLUMN IF NOT EXISTS principale BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE caisses ADD COLUMN IF NOT EXISTS supprimee BOOLEAN NOT NULL DEFAULT FALSE;

CREATE UNIQUE INDEX IF NOT EXISTS caisses_principale_unique
  ON caisses (principale)
  WHERE principale = TRUE;

CREATE TABLE IF NOT EXISTS transferts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES caisses(id),
  destination_id UUID NOT NULL REFERENCES caisses(id),
  montant INTEGER NOT NULL CHECK (montant > 0),
  motif TEXT NOT NULL,
  auteur TEXT NOT NULL,
  auteur_id UUID REFERENCES utilisateurs(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (source_id <> destination_id)
);

CREATE INDEX IF NOT EXISTS transferts_source_idx ON transferts (source_id);
CREATE INDEX IF NOT EXISTS transferts_destination_idx ON transferts (destination_id);
