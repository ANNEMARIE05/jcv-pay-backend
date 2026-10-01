const message = { $ref: '#/components/schemas/Message' };
const espace = { $ref: '#/components/schemas/Espace' };
const session = { $ref: '#/components/schemas/Session' };
const utilisateur = { $ref: '#/components/schemas/Utilisateur' };

const bearer = [{ bearerAuth: [] }];

function json(description, schema) {
  return {
    description,
    content: { 'application/json': { schema } },
  };
}

function erreur(description) {
  return json(description, message);
}

const nonAutorise = erreur('Connexion requise ou session invalide.');
const interdit = erreur('Action non autorisée pour ce rôle.');
const introuvable = erreur('Ressource introuvable.');
const requeteInvalide = erreur('Données invalides.');

export const openApiDocument = {
  openapi: '3.0.3',
  info: {
    title: 'JCV Pay API',
    version: '1.0.0',
    description: [
      'API de l’application JCV Pay (Église Jésus Christ Victoire). Les montants sont des entiers en francs CFA.',
      '',
      'Connectez-vous avec `POST /api/auth/connexion`, puis collez le champ `token` dans **Authorize**. Swagger ajoute le préfixe `Bearer`.',
      '',
      '**Rôles**',
      '- `MEMBRE` et `RESPONSABLE` : espace personnel, profil et versements.',
      '- `TRESORIER` : campagnes, caisse, validation des versements et solde GeniusPay.',
      '- `ADMINISTRATEUR` : campagnes et gestion des comptes.',
      '- `SUPER_ADMIN` : l’ensemble des actions.',
    ].join('\n'),
  },
  servers: [{ url: '/', description: 'Serveur courant' }],
  tags: [
    { name: 'Santé' },
    { name: 'Authentification' },
    { name: 'Espace' },
    { name: 'Projets' },
    { name: 'Événements' },
    { name: 'Cotisations' },
    { name: 'Caisses' },
    { name: 'Paiements' },
    { name: 'Trésorerie' },
    { name: 'Utilisateurs' },
    { name: 'Notifications' },
    { name: 'Webhooks' },
  ],
  paths: {
    '/api/sante': {
      get: {
        tags: ['Santé'],
        summary: 'Vérifier que l’API répond',
        responses: {
          200: json('Service disponible.', { $ref: '#/components/schemas/Sante' }),
        },
      },
    },
    '/paiement/retour': {
      get: {
        tags: ['Paiements'],
        summary: 'Page de retour après le checkout GeniusPay',
        parameters: [
          {
            name: 'status',
            in: 'query',
            schema: { type: 'string', example: 'success' },
            description: 'Vaut `success` lorsque le paiement a été transmis.',
          },
        ],
        responses: {
          200: { description: 'Page HTML de confirmation.' },
        },
      },
    },
    '/api/auth/inscription': {
      post: {
        tags: ['Authentification'],
        summary: 'Créer un compte membre',
        requestBody: json('Identité et mot de passe.', { $ref: '#/components/schemas/Inscription' }),
        responses: {
          201: json('Compte créé et session ouverte.', session),
          400: requeteInvalide,
          409: erreur('Ce numéro ou cet email est déjà utilisé.'),
        },
      },
    },
    '/api/auth/connexion': {
      post: {
        tags: ['Authentification'],
        summary: 'Ouvrir une session',
        description:
          'Les membres se connectent avec leur numéro. Les administrateurs peuvent aussi utiliser leur email.',
        requestBody: json('Identifiants.', { $ref: '#/components/schemas/Connexion' }),
        responses: {
          200: json('Session ouverte.', session),
          400: requeteInvalide,
          401: erreur('Identifiants incorrects, ou email utilisé par un compte non administrateur.'),
        },
      },
    },
    '/api/auth/moi': {
      get: {
        tags: ['Authentification'],
        summary: 'Lire le profil et l’espace courant',
        security: bearer,
        responses: {
          200: json('Profil et espace.', {
            type: 'object',
            properties: { utilisateur, espace },
          }),
          401: nonAutorise,
        },
      },
    },
    '/api/auth/profil': {
      patch: {
        tags: ['Authentification'],
        summary: 'Mettre à jour son profil',
        security: bearer,
        requestBody: json('Champs à modifier.', { $ref: '#/components/schemas/Profil' }),
        responses: {
          200: json('Profil mis à jour.', {
            type: 'object',
            properties: { utilisateur },
          }),
          400: requeteInvalide,
          401: nonAutorise,
          409: erreur('Ce numéro ou cet email est déjà utilisé.'),
        },
      },
    },
    '/api/auth/mot-de-passe': {
      post: {
        tags: ['Authentification'],
        summary: 'Changer son mot de passe',
        security: bearer,
        requestBody: json('Ancien et nouveau mot de passe.', { $ref: '#/components/schemas/ChangementMotDePasse' }),
        responses: {
          200: json('Mot de passe modifié.', message),
          400: requeteInvalide,
          401: nonAutorise,
        },
      },
    },
    '/api/auth/mot-de-passe/demande': {
      post: {
        tags: ['Authentification'],
        summary: 'Demander un code de réinitialisation',
        description:
          'Hors production, la réponse contient aussi le champ `code` pour faciliter les essais. En production, seul le message est renvoyé.',
        requestBody: json('Numéro du compte.', {
          type: 'object',
          required: ['telephone'],
          properties: { telephone: { type: 'string', example: '+2250700000000' } },
        }),
        responses: {
          200: json('Demande enregistrée.', { $ref: '#/components/schemas/DemandeReinitialisation' }),
        },
      },
    },
    '/api/auth/mot-de-passe/reinitialiser': {
      post: {
        tags: ['Authentification'],
        summary: 'Réinitialiser le mot de passe avec le code',
        requestBody: json('Code reçu et nouveau mot de passe.', { $ref: '#/components/schemas/Reinitialisation' }),
        responses: {
          200: json('Mot de passe réinitialisé.', message),
          400: erreur('Code invalide ou expiré, ou mot de passe trop court.'),
        },
      },
    },
    '/api/espace': {
      get: {
        tags: ['Espace'],
        summary: 'Charger l’espace de l’utilisateur connecté',
        security: bearer,
        responses: {
          200: json('Espace.', espace),
          401: nonAutorise,
        },
      },
    },
    '/api/projets': {
      post: {
        tags: ['Projets'],
        summary: 'Publier un projet et sa caisse',
        description: 'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`.',
        security: bearer,
        requestBody: json('Projet.', { $ref: '#/components/schemas/NouveauProjet' }),
        responses: {
          201: json('Espace à jour.', espace),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/evenements': {
      post: {
        tags: ['Événements'],
        summary: 'Publier un événement',
        description: 'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`.',
        security: bearer,
        requestBody: json('Événement.', { $ref: '#/components/schemas/NouvelEvenement' }),
        responses: {
          201: json('Espace à jour.', espace),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/evenements/{id}/inscription': {
      post: {
        tags: ['Événements'],
        summary: 'Réserver une place',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/Id' }],
        responses: {
          200: json('Espace à jour.', espace),
          401: nonAutorise,
          404: introuvable,
          409: erreur('Plus de places disponibles.'),
        },
      },
    },
    '/api/cotisations': {
      post: {
        tags: ['Cotisations'],
        summary: 'Créer une cotisation',
        description: 'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`.',
        security: bearer,
        requestBody: json('Cotisation.', { $ref: '#/components/schemas/NouvelleCotisation' }),
        responses: {
          201: json('Espace à jour.', espace),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/caisses': {
      post: {
        tags: ['Caisses'],
        summary: 'Ouvrir une caisse',
        description: 'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`.',
        security: bearer,
        requestBody: json('Caisse.', { $ref: '#/components/schemas/NouvelleCaisse' }),
        responses: {
          201: json('Espace à jour.', espace),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/caisses/transfert': {
      post: {
        tags: ['Caisses'],
        summary: 'Transférer un solde entre caisses',
        description:
          'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`. La caisse principale reçoit, elle n’envoie pas. `toId` vaut `principale` ou l’identifiant d’une autre caisse.',
        security: bearer,
        requestBody: json('Transfert.', { $ref: '#/components/schemas/Transfert' }),
        responses: {
          201: json('Espace à jour.', espace),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
          404: introuvable,
          409: erreur('Caisse clôturée.'),
        },
      },
    },
    '/api/caisses/{id}/supprimer': {
      post: {
        tags: ['Caisses'],
        summary: 'Supprimer une caisse vide',
        description: 'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`. La caisse principale ne se supprime pas.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/Id' }],
        responses: {
          200: json('Espace à jour.', espace),
          400: erreur('Caisse principale, ou solde encore présent.'),
          401: nonAutorise,
          403: interdit,
          404: introuvable,
        },
      },
    },
    '/api/caisses/{id}/cloturer': {
      post: {
        tags: ['Caisses'],
        summary: 'Clôturer une caisse',
        description:
          'Réservé à `SUPER_ADMIN`, `ADMINISTRATEUR` et `TRESORIER`. Clôture aussi le projet lié. La caisse principale ne se clôture pas.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/Id' }],
        responses: {
          200: json('Espace à jour.', espace),
          400: erreur('La caisse principale ne se clôture pas.'),
          401: nonAutorise,
          403: interdit,
          404: introuvable,
        },
      },
    },
    '/api/paiements': {
      post: {
        tags: ['Paiements'],
        summary: 'Déclarer un versement',
        description:
          'Wave, Orange Money, MTN, Moov et carte ouvrent un checkout GeniusPay (montant minimum 200 FCFA) et renvoient `checkoutUrl`. Les espèces et virements restent en attente de validation par la trésorerie. Un versement de type `PROJET` doit indiquer `projetId` ou `caisseProjetId`.',
        security: bearer,
        requestBody: json('Versement.', { $ref: '#/components/schemas/NouveauPaiement' }),
        responses: {
          201: json('Versement créé.', { $ref: '#/components/schemas/PaiementCree' }),
          400: requeteInvalide,
          401: nonAutorise,
          404: introuvable,
          409: erreur('Projet ou caisse clôturé.'),
        },
      },
    },
    '/api/paiements/{id}/synchroniser': {
      post: {
        tags: ['Paiements'],
        summary: 'Relire le statut GeniusPay d’un versement',
        description: 'Le donateur, un administrateur ou le trésorier peuvent synchroniser. `id` accepte l’identifiant, la référence, la référence GeniusPay ou le numéro de reçu.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/ReferencePaiement' }],
        responses: {
          200: json('Versement et espace.', {
            type: 'object',
            properties: {
              transaction: { $ref: '#/components/schemas/Transaction' },
              espace,
            },
          }),
          401: nonAutorise,
          403: interdit,
          404: introuvable,
        },
      },
    },
    '/api/paiements/recus/{id}': {
      get: {
        tags: ['Paiements'],
        summary: 'Lire un reçu',
        description: 'Réservé au donateur, à un administrateur ou au trésorier. `id` accepte l’identifiant, la référence ou le numéro de reçu.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/ReferencePaiement' }],
        responses: {
          200: json('Reçu.', { $ref: '#/components/schemas/Recu' }),
          401: nonAutorise,
          403: interdit,
          404: introuvable,
        },
      },
    },
    '/api/paiements/especes': {
      post: {
        tags: ['Paiements'],
        summary: 'Enregistrer un versement en espèces',
        description: 'Réservé à `SUPER_ADMIN` et `TRESORIER`. Le versement est validé immédiatement.',
        security: bearer,
        requestBody: json('Encaissement.', { $ref: '#/components/schemas/PaiementEspeces' }),
        responses: {
          201: json('Versement validé.', { $ref: '#/components/schemas/PaiementEspecesCree' }),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/paiements/{id}/valider': {
      post: {
        tags: ['Paiements'],
        summary: 'Valider un versement en attente',
        description: 'Réservé à `SUPER_ADMIN` et `TRESORIER`.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/ReferencePaiement' }],
        responses: {
          200: json('Espace à jour.', espace),
          401: nonAutorise,
          403: interdit,
          404: introuvable,
          409: erreur('Un versement déjà validé ne peut plus être modifié.'),
        },
      },
    },
    '/api/paiements/{id}/rejeter': {
      post: {
        tags: ['Paiements'],
        summary: 'Rejeter un versement en attente',
        description: 'Réservé à `SUPER_ADMIN` et `TRESORIER`.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/ReferencePaiement' }],
        responses: {
          200: json('Espace à jour.', espace),
          401: nonAutorise,
          403: interdit,
          404: introuvable,
          409: erreur('Un versement déjà validé ne peut plus être modifié.'),
        },
      },
    },
    '/api/mouvements/sortie': {
      post: {
        tags: ['Trésorerie'],
        summary: 'Enregistrer une sortie de caisse',
        description: 'Réservé à `SUPER_ADMIN` et `TRESORIER`.',
        security: bearer,
        requestBody: json('Sortie.', { $ref: '#/components/schemas/Sortie' }),
        responses: {
          201: json('Sortie enregistrée.', {
            type: 'object',
            properties: {
              mouvement: { $ref: '#/components/schemas/Mouvement' },
              espace,
            },
          }),
          400: erreur('Données invalides ou solde insuffisant.'),
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/tresorerie/geniuspay': {
      get: {
        tags: ['Trésorerie'],
        summary: 'Lire le solde du compte marchand GeniusPay',
        description: 'Réservé à `SUPER_ADMIN` et `TRESORIER`.',
        security: bearer,
        responses: {
          200: json('Solde renvoyé par GeniusPay.', { type: 'object', additionalProperties: true }),
          401: nonAutorise,
          403: interdit,
        },
      },
    },
    '/api/utilisateurs': {
      get: {
        tags: ['Utilisateurs'],
        summary: 'Lister les comptes',
        description: 'Réservé à `SUPER_ADMIN` et `ADMINISTRATEUR`.',
        security: bearer,
        responses: {
          200: json('Comptes.', { type: 'array', items: utilisateur }),
          401: nonAutorise,
          403: interdit,
        },
      },
      post: {
        tags: ['Utilisateurs'],
        summary: 'Créer un compte avec un rôle',
        description:
          'Réservé à `SUPER_ADMIN` et `ADMINISTRATEUR`. Seul le super administrateur peut créer un autre `SUPER_ADMIN`. Sans `motDePasse`, un mot de passe temporaire est généré.',
        security: bearer,
        requestBody: json('Compte.', { $ref: '#/components/schemas/NouvelUtilisateur' }),
        responses: {
          201: json('Compte créé.', { $ref: '#/components/schemas/CompteCree' }),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
          409: erreur('Ce numéro ou cet email est déjà utilisé.'),
        },
      },
    },
    '/api/fideles': {
      post: {
        tags: ['Utilisateurs'],
        summary: 'Créer un fidèle',
        description:
          'Réservé à `SUPER_ADMIN` et `ADMINISTRATEUR`. Le compte est créé avec le rôle `MEMBRE` et un mot de passe temporaire.',
        security: bearer,
        requestBody: json('Fidèle.', { $ref: '#/components/schemas/NouveauFidele' }),
        responses: {
          201: json('Fidèle créé.', { $ref: '#/components/schemas/CompteCree' }),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
          409: erreur('Ce numéro est déjà utilisé.'),
        },
      },
    },
    '/api/utilisateurs/{id}/role': {
      patch: {
        tags: ['Utilisateurs'],
        summary: 'Changer le rôle d’un compte',
        description: 'Réservé à `SUPER_ADMIN` et `ADMINISTRATEUR`. Le super administrateur ne peut pas être rétrogradé ici.',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/Id' }],
        requestBody: json('Nouveau rôle.', {
          type: 'object',
          required: ['role'],
          properties: {
            role: {
              type: 'string',
              enum: ['MEMBRE', 'TRESORIER', 'RESPONSABLE', 'ADMINISTRATEUR'],
            },
          },
        }),
        responses: {
          200: json('Espace à jour.', espace),
          400: requeteInvalide,
          401: nonAutorise,
          403: interdit,
          404: introuvable,
        },
      },
    },
    '/api/notifications/{id}/lire': {
      post: {
        tags: ['Notifications'],
        summary: 'Marquer une notification comme lue',
        security: bearer,
        parameters: [{ $ref: '#/components/parameters/Id' }],
        responses: {
          200: json('Espace à jour.', espace),
          401: nonAutorise,
        },
      },
    },
    '/api/notifications/lire-tout': {
      post: {
        tags: ['Notifications'],
        summary: 'Marquer toutes les notifications comme lues',
        security: bearer,
        responses: {
          200: json('Espace à jour.', espace),
          401: nonAutorise,
        },
      },
    },
    '/api/webhooks/geniuspay': {
      post: {
        tags: ['Webhooks'],
        summary: 'Recevoir un événement GeniusPay',
        description:
          'Signature HMAC-SHA256 du corps brut, préfixée par l’horodatage : `timestamp.rawBody`. L’en-tête `X-Webhook-Delivery` sert à ignorer les doublons.',
        parameters: [
          { name: 'X-Webhook-Signature', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Webhook-Timestamp', in: 'header', required: true, schema: { type: 'string' } },
          { name: 'X-Webhook-Event', in: 'header', schema: { type: 'string', example: 'payment.success' } },
          { name: 'X-Webhook-Delivery', in: 'header', schema: { type: 'string' } },
        ],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: { type: 'object', additionalProperties: true },
            },
          },
        },
        responses: {
          200: json('Événement accepté.', { $ref: '#/components/schemas/WebhookRecu' }),
          401: erreur('Signature webhook invalide.'),
        },
      },
    },
  },
  components: {
    securitySchemes: {
      bearerAuth: {
        type: 'http',
        scheme: 'bearer',
        bearerFormat: 'JWT',
      },
    },
    parameters: {
      Id: {
        name: 'id',
        in: 'path',
        required: true,
        schema: { type: 'string', format: 'uuid' },
      },
      ReferencePaiement: {
        name: 'id',
        in: 'path',
        required: true,
        description: 'Identifiant, référence interne, référence GeniusPay ou numéro de reçu.',
        schema: { type: 'string' },
      },
    },
    schemas: {
      Message: {
        type: 'object',
        properties: { message: { type: 'string' } },
      },
      Sante: {
        type: 'object',
        properties: {
          ok: { type: 'boolean', example: true },
          service: { type: 'string', example: 'jcv-pay' },
        },
      },
      Role: {
        type: 'string',
        enum: ['SUPER_ADMIN', 'ADMINISTRATEUR', 'TRESORIER', 'RESPONSABLE', 'MEMBRE'],
      },
      TypeVersement: {
        type: 'string',
        enum: ['DIME', 'OFFRANDE', 'COTISATION', 'PROJET', 'EVENEMENT', 'EPARGNE', 'LIBRE'],
      },
      MoyenPaiement: {
        type: 'string',
        enum: ['WAVE', 'ORANGE_MONEY', 'MTN_MOMO', 'MOOV_MONEY', 'CARTE_BANCAIRE', 'VIREMENT', 'ESPECES'],
      },
      StatutPaiement: {
        type: 'string',
        enum: ['VALIDE', 'EN_ATTENTE', 'REJETE', 'ANNULE', 'ECHEC'],
      },
      SourceCaisse: {
        type: 'string',
        enum: ['CAISSE_PHYSIQUE', 'WAVE', 'ORANGE_MONEY', 'BANQUE'],
      },
      Utilisateur: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          nom: { type: 'string' },
          prenom: { type: 'string' },
          email: { type: 'string' },
          telephone: { type: 'string' },
          matricule: { type: 'string' },
          paroisse: { type: 'string' },
          departement: { type: 'string' },
          avatar: { type: 'string' },
          role: { $ref: '#/components/schemas/Role' },
          dateAdhesion: { type: 'string' },
          motDePasseTemporaire: {
            type: 'string',
            description: 'Présent uniquement à la création d’un compte par l’équipe.',
          },
        },
      },
      Resume: {
        type: 'object',
        properties: {
          totalContribue: { type: 'integer' },
          resteAPayer: { type: 'integer' },
          enAttente: { type: 'integer' },
          epargneSolde: { type: 'integer' },
          projetsActifsCount: { type: 'integer' },
          derniereContributionDate: { type: 'string' },
        },
      },
      Transaction: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          reference: { type: 'string' },
          titre: { type: 'string' },
          description: { type: 'string' },
          type: { $ref: '#/components/schemas/TypeVersement' },
          montant: { type: 'integer' },
          date: { type: 'string' },
          heure: { type: 'string' },
          statut: { $ref: '#/components/schemas/StatutPaiement' },
          moyenPaiement: { $ref: '#/components/schemas/MoyenPaiement' },
          recuNumero: { type: 'string' },
          projetId: { type: 'string', format: 'uuid' },
          evenementId: { type: 'string', format: 'uuid' },
          cotisationId: { type: 'string', format: 'uuid' },
          donateurNom: { type: 'string' },
          donateurTelephone: { type: 'string' },
          checkoutUrl: { type: 'string' },
          geniuspayReference: { type: 'string' },
        },
      },
      Recu: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          numeroRecu: { type: 'string' },
          transactionId: { type: 'string', format: 'uuid' },
          titre: { type: 'string' },
          type: { $ref: '#/components/schemas/TypeVersement' },
          donateurNom: { type: 'string' },
          donateurMatricule: { type: 'string' },
          donateurTelephone: { type: 'string' },
          donateurEmail: { type: 'string' },
          montant: { type: 'integer' },
          frais: { type: 'integer' },
          total: { type: 'integer' },
          date: { type: 'string' },
          heure: { type: 'string' },
          statut: { $ref: '#/components/schemas/StatutPaiement' },
          moyenPaiement: { $ref: '#/components/schemas/MoyenPaiement' },
          egliseNom: { type: 'string' },
          egliseAdresse: { type: 'string' },
          codeSecurite: { type: 'string' },
        },
      },
      Projet: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          titre: { type: 'string' },
          description: { type: 'string' },
          categorie: { type: 'string', enum: ['CONSTRUCTION', 'MISSION', 'EQUIPEMENT', 'SOCIAL'] },
          objectif: { type: 'integer' },
          montantCollecte: { type: 'integer' },
          dateFin: { type: 'string' },
          statut: { type: 'string', enum: ['EN_COURS', 'CLOTURE', 'PLANIFIE'] },
          imageUrl: { type: 'string' },
          participantsCount: { type: 'integer' },
          maContribution: { type: 'integer' },
          organisateur: { type: 'string' },
          lieu: { type: 'string' },
        },
      },
      Evenement: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          titre: { type: 'string' },
          description: { type: 'string' },
          date: { type: 'string' },
          heure: { type: 'string' },
          lieu: { type: 'string' },
          tarif: { type: 'integer' },
          placesDisponibles: { type: 'integer' },
          placesReservees: { type: 'integer' },
          imageUrl: { type: 'string' },
          estInscrit: { type: 'boolean' },
          statutPaiement: { $ref: '#/components/schemas/StatutPaiement' },
          intervenant: { type: 'string' },
        },
      },
      Cotisation: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          titre: { type: 'string' },
          categorie: { type: 'string', enum: ['COTISATION', 'DIME', 'EPARGNE', 'PROJET'] },
          montantTotal: { type: 'integer' },
          montantVerse: { type: 'integer' },
          resteAPayer: { type: 'integer' },
          echeance: { type: 'string' },
          statut: { type: 'string', enum: ['A_PAYER', 'PARTIEL', 'PAYE'] },
        },
      },
      Caisse: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          nom: { type: 'string' },
          description: { type: 'string' },
          projetId: { type: 'string', format: 'uuid' },
          montantCollecte: { type: 'integer' },
          objectif: { type: 'integer' },
          statut: { type: 'string', enum: ['OUVERTE', 'TERMINEE'] },
          principale: { type: 'boolean' },
          visibleAuxMembres: { type: 'boolean' },
          dateOuverture: { type: 'string' },
          dateCloture: { type: 'string' },
        },
      },
      Mouvement: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          type: { type: 'string', enum: ['ENTREE', 'SORTIE'] },
          montant: { type: 'integer' },
          motif: { type: 'string' },
          date: { type: 'string' },
          heure: { type: 'string' },
          source: { $ref: '#/components/schemas/SourceCaisse' },
          auteur: { type: 'string' },
          transactionId: { type: 'string', format: 'uuid' },
          beneficiaire: { type: 'string' },
          caisseProjetId: { type: 'string', format: 'uuid' },
        },
      },
      Notification: {
        type: 'object',
        properties: {
          id: { type: 'string', format: 'uuid' },
          titre: { type: 'string' },
          message: { type: 'string' },
          date: { type: 'string' },
          lue: { type: 'boolean' },
          type: { type: 'string', enum: ['PAIEMENT', 'ECHEANCE', 'PROJET', 'EVENEMENT', 'INFO'] },
          referenceId: { type: 'string' },
        },
      },
      Tresorerie: {
        type: 'object',
        properties: {
          soldeTotal: { type: 'number' },
          entreesMois: { type: 'number' },
          sortiesMois: { type: 'number' },
          soldeCaissePhysique: { type: 'number' },
          soldeWave: { type: 'number' },
          soldeOrangeMoney: { type: 'number' },
          soldeBancaire: { type: 'number' },
        },
      },
      Espace: {
        type: 'object',
        properties: {
          resume: { $ref: '#/components/schemas/Resume' },
          transactions: { type: 'array', items: { $ref: '#/components/schemas/Transaction' } },
          projets: { type: 'array', items: { $ref: '#/components/schemas/Projet' } },
          evenements: { type: 'array', items: { $ref: '#/components/schemas/Evenement' } },
          recus: { type: 'array', items: { $ref: '#/components/schemas/Recu' } },
          cotisations: { type: 'array', items: { $ref: '#/components/schemas/Cotisation' } },
          mouvements: { type: 'array', items: { $ref: '#/components/schemas/Mouvement' } },
          caissesProjet: { type: 'array', items: { $ref: '#/components/schemas/Caisse' } },
          utilisateurs: { type: 'array', items: utilisateur },
          notifications: { type: 'array', items: { $ref: '#/components/schemas/Notification' } },
          tresorerieGlobale: { $ref: '#/components/schemas/Tresorerie' },
        },
      },
      Session: {
        type: 'object',
        properties: {
          token: { type: 'string' },
          utilisateur,
          espace,
        },
      },
      Inscription: {
        type: 'object',
        required: ['prenom', 'nom', 'telephone', 'motDePasse'],
        properties: {
          prenom: { type: 'string' },
          nom: { type: 'string' },
          telephone: { type: 'string', example: '+2250700000000' },
          email: { type: 'string' },
          motDePasse: { type: 'string', minLength: 8 },
          paroisse: { type: 'string' },
        },
      },
      Connexion: {
        type: 'object',
        required: ['identifiant', 'motDePasse'],
        properties: {
          identifiant: {
            type: 'string',
            description: 'Numéro de téléphone, ou email pour un administrateur. `telephone` et `email` sont aussi acceptés.',
          },
          motDePasse: { type: 'string', description: '`password` est aussi accepté.' },
        },
      },
      Profil: {
        type: 'object',
        properties: {
          prenom: { type: 'string' },
          nom: { type: 'string' },
          email: { type: 'string' },
          telephone: { type: 'string' },
          departement: { type: 'string' },
        },
      },
      ChangementMotDePasse: {
        type: 'object',
        required: ['ancienMotDePasse', 'nouveauMotDePasse'],
        properties: {
          ancienMotDePasse: { type: 'string' },
          nouveauMotDePasse: { type: 'string', minLength: 8 },
        },
      },
      DemandeReinitialisation: {
        type: 'object',
        properties: {
          message: { type: 'string' },
          code: { type: 'string', description: 'Renvoyé uniquement hors production.' },
        },
      },
      Reinitialisation: {
        type: 'object',
        required: ['telephone', 'code', 'nouveauMotDePasse'],
        properties: {
          telephone: { type: 'string' },
          code: { type: 'string' },
          nouveauMotDePasse: { type: 'string', minLength: 8 },
        },
      },
      NouveauProjet: {
        type: 'object',
        required: ['titre', 'objectif'],
        properties: {
          titre: { type: 'string' },
          description: { type: 'string' },
          categorie: { type: 'string', enum: ['CONSTRUCTION', 'MISSION', 'EQUIPEMENT', 'SOCIAL'], default: 'SOCIAL' },
          objectif: { type: 'integer', minimum: 1 },
          dateFin: { type: 'string' },
          statut: { type: 'string', enum: ['EN_COURS', 'CLOTURE', 'PLANIFIE'], default: 'EN_COURS' },
          imageUrl: { type: 'string' },
          organisateur: { type: 'string' },
          lieu: { type: 'string' },
        },
      },
      NouvelEvenement: {
        type: 'object',
        required: ['titre'],
        properties: {
          titre: { type: 'string' },
          description: { type: 'string' },
          date: { type: 'string' },
          heure: { type: 'string' },
          lieu: { type: 'string' },
          tarif: { type: 'integer', minimum: 0 },
          placesDisponibles: { type: 'integer', minimum: 0 },
          imageUrl: { type: 'string' },
          intervenant: { type: 'string' },
        },
      },
      NouvelleCotisation: {
        type: 'object',
        required: ['titre', 'montantTotal'],
        properties: {
          titre: { type: 'string' },
          categorie: { type: 'string', enum: ['COTISATION', 'DIME', 'EPARGNE', 'PROJET'], default: 'COTISATION' },
          montantTotal: { type: 'integer', minimum: 1 },
          echeance: { type: 'string' },
        },
      },
      NouvelleCaisse: {
        type: 'object',
        required: ['nom'],
        properties: {
          nom: { type: 'string' },
          description: { type: 'string' },
          projetId: { type: 'string', format: 'uuid' },
          objectif: { type: 'integer', minimum: 0 },
        },
      },
      Transfert: {
        type: 'object',
        required: ['fromId', 'toId', 'montant', 'motif'],
        properties: {
          fromId: { type: 'string', format: 'uuid' },
          toId: { type: 'string', description: 'Identifiant d’une caisse, ou `principale`.' },
          montant: { type: 'integer', minimum: 1 },
          motif: { type: 'string' },
        },
      },
      NouveauPaiement: {
        type: 'object',
        required: ['titre', 'type', 'montant', 'moyenPaiement'],
        properties: {
          titre: { type: 'string' },
          description: { type: 'string' },
          type: { $ref: '#/components/schemas/TypeVersement' },
          montant: { type: 'integer', minimum: 1 },
          moyenPaiement: { $ref: '#/components/schemas/MoyenPaiement' },
          projetId: { type: 'string', format: 'uuid' },
          caisseProjetId: { type: 'string', description: 'Identifiant de caisse, ou `principale`.' },
          evenementId: { type: 'string', format: 'uuid' },
          cotisationId: { type: 'string', format: 'uuid' },
          donateurNom: { type: 'string' },
          donateurTelephone: { type: 'string' },
          donateurEmail: { type: 'string' },
        },
      },
      PaiementCree: {
        type: 'object',
        properties: {
          transaction: { $ref: '#/components/schemas/Transaction' },
          recu: { $ref: '#/components/schemas/Recu' },
          checkoutUrl: { type: 'string', nullable: true },
          espace,
        },
      },
      PaiementEspeces: {
        type: 'object',
        required: ['donateurNom', 'type', 'montant'],
        properties: {
          donateurNom: { type: 'string' },
          donateurTelephone: { type: 'string' },
          donateurMatricule: { type: 'string' },
          titre: { type: 'string' },
          type: { $ref: '#/components/schemas/TypeVersement' },
          montant: { type: 'integer', minimum: 1 },
          projetId: { type: 'string', format: 'uuid' },
          caisseProjetId: { type: 'string' },
        },
      },
      PaiementEspecesCree: {
        type: 'object',
        properties: {
          transaction: { $ref: '#/components/schemas/Transaction' },
          recu: { $ref: '#/components/schemas/Recu' },
          espace,
        },
      },
      Sortie: {
        type: 'object',
        required: ['montant', 'motif', 'source'],
        properties: {
          montant: { type: 'integer', minimum: 1 },
          motif: { type: 'string' },
          source: { $ref: '#/components/schemas/SourceCaisse' },
          auteur: { type: 'string' },
          beneficiaire: { type: 'string' },
          caisseProjetId: { type: 'string', format: 'uuid' },
        },
      },
      NouveauFidele: {
        type: 'object',
        required: ['prenom', 'nom', 'telephone'],
        properties: {
          prenom: { type: 'string' },
          nom: { type: 'string' },
          telephone: { type: 'string' },
        },
      },
      NouvelUtilisateur: {
        type: 'object',
        required: ['prenom', 'nom', 'telephone'],
        properties: {
          prenom: { type: 'string' },
          nom: { type: 'string' },
          telephone: { type: 'string' },
          email: { type: 'string' },
          departement: { type: 'string' },
          role: {
            type: 'string',
            enum: ['MEMBRE', 'TRESORIER', 'RESPONSABLE', 'ADMINISTRATEUR', 'SUPER_ADMIN'],
            default: 'MEMBRE',
          },
          motDePasse: { type: 'string', description: 'Optionnel. Un mot de passe temporaire est généré sinon.' },
        },
      },
      CompteCree: {
        type: 'object',
        properties: {
          utilisateur,
          espace,
        },
      },
      WebhookRecu: {
        type: 'object',
        properties: {
          received: { type: 'boolean' },
          duplicate: { type: 'boolean' },
        },
      },
    },
  },
};
