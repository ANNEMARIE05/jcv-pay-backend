-- ============================================================
-- Sécurité base de données — migrations additionnelles
-- Appliquées automatiquement au démarrage via migrate()
-- ============================================================

-- 1. Nettoyage automatique des codes de vérification expirés
--    (évite l'accumulation de lignes et les attaques par énumération)
CREATE INDEX IF NOT EXISTS codes_verification_expire_idx
  ON codes_verification (expire_at)
  WHERE utilise = FALSE;

-- 2. Index sur les tentatives de login (recherche par téléphone normalisé)
CREATE INDEX IF NOT EXISTS utilisateurs_telephone_norm_idx
  ON utilisateurs (telephone_norm)
  WHERE actif = TRUE;

-- 3. Index pour recherche rapide des paiements par statut + date
CREATE INDEX IF NOT EXISTS transactions_created_statut_idx
  ON transactions (created_at DESC, statut);

-- 4. Index pour les webhooks reçus (déduplication rapide)
CREATE INDEX IF NOT EXISTS webhooks_recus_recu_le_idx
  ON webhooks_recus (recu_le DESC);

-- 5. Index pour notifications non lues par utilisateur
CREATE INDEX IF NOT EXISTS notifications_utilisateur_lue_idx
  ON notifications (utilisateur_id, lue, created_at DESC);

-- 6. Limite la longueur des champs texte libres (protection contre les DoS via données énormes)
--    Ces contraintes sont idempotentes (ADD CONSTRAINT IF NOT EXISTS uniquement en PG 9.5+)
DO $$
BEGIN
  -- Nom et prénom ne dépassent pas 100 caractères
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'utilisateurs_nom_length'
  ) THEN
    ALTER TABLE utilisateurs
      ADD CONSTRAINT utilisateurs_nom_length CHECK (length(nom) <= 100),
      ADD CONSTRAINT utilisateurs_prenom_length CHECK (length(prenom) <= 100);
  END IF;

  -- Email : 200 max
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'utilisateurs_email_length'
  ) THEN
    ALTER TABLE utilisateurs
      ADD CONSTRAINT utilisateurs_email_length CHECK (email IS NULL OR length(email) <= 200);
  END IF;

  -- Titre de transaction : 500 max
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_titre_length'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_titre_length CHECK (length(titre) <= 500);
  END IF;

  -- Donateur nom : 200 max
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_donateur_nom_length'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_donateur_nom_length CHECK (length(donateur_nom) <= 200);
  END IF;

  -- checkout_url : 2000 max (URLs raisonnables)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_checkout_url_length'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_checkout_url_length CHECK (checkout_url IS NULL OR length(checkout_url) <= 2000);
  END IF;

  -- Montant maximum par transaction : 50 000 000 FCFA (50 millions)
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'transactions_montant_max'
  ) THEN
    ALTER TABLE transactions
      ADD CONSTRAINT transactions_montant_max CHECK (montant <= 50000000);
  END IF;
END;
$$;

-- 7. Table d'audit pour les actions sensibles (validation/rejet de paiement, création d'admin)
CREATE TABLE IF NOT EXISTS audit_log (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  acteur_id   UUID        REFERENCES utilisateurs(id) ON DELETE SET NULL,
  acteur_role TEXT,
  action      TEXT        NOT NULL,
  cible_type  TEXT,
  cible_id    TEXT,
  details     TEXT,
  ip          TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS audit_log_acteur_idx  ON audit_log (acteur_id, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_action_idx  ON audit_log (action, created_at DESC);
CREATE INDEX IF NOT EXISTS audit_log_created_idx ON audit_log (created_at DESC);

-- 8. Table de blocage IP (pour bloquer manuellement des adresses malveillantes)
CREATE TABLE IF NOT EXISTS ip_bloquees (
  ip          TEXT        PRIMARY KEY,
  raison      TEXT        NOT NULL DEFAULT '',
  bloque_par  UUID        REFERENCES utilisateurs(id) ON DELETE SET NULL,
  expire_at   TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS ip_bloquees_expire_idx ON ip_bloquees (expire_at) WHERE expire_at IS NOT NULL;
