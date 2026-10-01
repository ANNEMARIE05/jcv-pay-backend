# JCV Pay — API

Backend Node.js et PostgreSQL de l’application JCV Pay (Église Jésus Christ Victoire). Les clés GeniusPay restent sur ce serveur.

## Démarrage

1. Lancer PostgreSQL (port hôte **5433**, pour ne pas entrer en conflit avec un PostgreSQL déjà installé sur 5432) :

```bash
docker compose up -d
```

2. Copier `.env.example` vers `.env` et renseigner les clés GeniusPay.

3. Installer et démarrer :

```bash
npm install
npm run dev
```

La documentation Swagger est sur [http://localhost:4000/api/docs](http://localhost:4000/api/docs). La spécification brute est sur `/api/openapi.json`. Après `POST /api/auth/connexion`, collez le champ `token` dans **Authorize**.

Au lancement, la fonction `ensurePlatformAdmin` crée le super administrateur si aucun n’existe déjà. Ces accès sont dans le code, pas dans le fichier `.env`. Un redémarrage ne recrée pas le compte.

- Numéro : `+225 07 47 18 50 39`
- Email : `admin@jcvictoire.org`
- Mot de passe : `Password@123`

L’administrateur se connecte avec le numéro **ou** l’email. Les autres comptes se connectent uniquement avec le numéro et le mot de passe. Une fois connecté, il change son mot de passe via `POST /api/auth/mot-de-passe`.

Au lancement, une caisse principale est créée si elle n’existe pas. Elle ne s’envoie pas, ne se clôture pas et ne se supprime pas. Les versements hors projet y sont rattachés. Un versement de type projet doit indiquer `projetId` ou `caisseProjetId` : le serveur relie les deux et crédite la caisse du projet. Le solde affiché de la caisse principale est l’argent de l’église qui n’est pas encore dans une autre caisse.

- `POST /api/caisses/transfert` — `{ fromId, toId, montant, motif }`. `toId` vaut `principale` ou l’identifiant d’une autre caisse.
- `POST /api/caisses/:id/supprimer` — retire une caisse vide.
- `POST /api/fideles` — crée un fidèle (rôle membre) et renvoie un mot de passe temporaire.

## Paiements GeniusPay

Wave, Orange Money, MTN, Moov et carte passent par [l’API marchand GeniusPay](https://geniuspay.ci/docs/api). Le serveur crée le paiement, renvoie `checkout_url`, puis confirme le versement au webhook `POST /api/webhooks/geniuspay` (signature HMAC-SHA256). Les espèces et virements restent des déclarations validées par la trésorerie.

URL de webhook à enregistrer chez GeniusPay : `https://<votre-domaine>/api/webhooks/geniuspay`

Événements : `payment.success`, `payment.failed`, `payment.cancelled`, `payment.expired`.
