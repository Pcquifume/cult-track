# cult-track 📊

Tableau de bord personnel pour vos modèles 3D publiés sur **Cults3D** : revenus, ventes,
vues, likes, téléchargements, abonnés — avec courbes et graphiques, alimenté par l'API
GraphQL officielle de Cults3D.

```
┌──────────────┐      ┌────────────────────┐      ┌──────────────────────┐
│  Navigateur  │─────▶│  Cloudflare Worker │─────▶│   Cults3D GraphQL    │
│  (Pages)     │ Bearer│  (cultsstat-api)   │ Basic│   /graphql           │
│  dashboard   │◀─────│  proxy + agrégats  │◀─────│  (pseudo + clé API)  │
└──────────────┘      └────────┬───────────┘      └──────────────────────┘
                               │ AES-256-GCM (ENC_KEY)
                               ▼
                     ┌──────────────────────┐
                     │      Supabase        │  ventes · créations ·
                     │  snapshots · histo   │  sessions · sync
                     └──────────────────────┘
```

## Arborescence

| Dossier      | Rôle                                                                 |
|--------------|----------------------------------------------------------------------|
| `pages/`     | Site statique (HTML/CSS/JS + Apache ECharts) → **Cloudflare Pages** |
| `worker/`    | API Cloudflare Workers (proxy, chiffrement, sync, agrégats)         |
| `database/`  | Schéma SQL Supabase (`schema.sql`)                                  |

## Prérequis

- Un compte [Cloudflare](https://dash.cloudflare.com) (+ le CLI `wrangler`).
- Un projet **Supabase** (vous avez déjà l'URL + clé service_role).
- Un compte **Cults3D** avec une clé API : https://cults3d.com/en/api/keys
- [Node.js 18+](https://nodejs.org) et `npm`.

---

## 1. Base de données (Supabase)

1. Allez sur votre dashboard Supabase → **SQL Editor** → **New query**.
2. Collez tout le contenu de [`database/schema.sql`](database/schema.sql) puis **Run**.
3. Dans **Project Settings → API**, notez :
   - **Project URL** (ex : `https://jieqlemhubgnhuvktqbb.supabase.co`)
   - **service_role key** (« role key ») : **ne JAMAIS la mettre dans le front, elle vit
     uniquement dans le Worker.**

## 2. Worker Cloudflare

```bash
cd worker
npm install
npx wrangler login
```

> **Test local** : créez `worker/.dev.vars` (non versionné) contenant
> `SUPABASE_SERVICE_KEY=…` et `ENC_KEY=…` puis lancez `npx wrangler dev`.
> Les secrets en production se font avec `wrangler secret put` (ci-dessous).

Créez d'abord une clé de chiffrement (32 octets en base64) :

```bash
# Windows PowerShell :
[Convert]::ToBase64String((1..32 | ForEach-Object { Get-Random -Maximum 256 }))
# macOS / Linux :
openssl rand -base64 32
```

Enregistrez les 3 secrets (à chaque commande, collez la valeur puis Entrée) :

```bash
npx wrangler secret put SUPABASE_SERVICE_KEY   # la clé "role key" Supabase
npx wrangler secret put ENC_KEY                # la clé base64 générée ci-dessus
```

Déployez :

```bash
npx wrangler deploy
```

📌 Notez l'URL affichée, ex : `https://cultsstat-api.<votre-identifiant>.workers.dev`.
Cette URL doit être mise dans le front (étape 4).

> **Synchronisation automatique (optionnelle)** : les déclencheurs `cron` ne sont
> disponibles que sur les **plans Workers payants**. Pour activer une sync toutes les 4 h,
> décommentez le bloc `[triggers]` de `worker/wrangler.toml` puis redéployez.

## 3. Cloudflare Pages (le site)

Méthode CLI (recommandée) :

```bash
cd ..
npx wrangler pages deploy pages --project-name cult-track
```

Méthode dashboard : **Workers & Pages → Create → Pages → Upload assets** puis sélectionnez
le dossier `pages/`. Aucun build n'est nécessaire (site 100 % statique), répertoire de
sortie = racine.

## 4. Brancher le front sur le Worker

Dans [`pages/assets/app.js`](pages/assets/app.js), en haut du fichier :

```js
const CONFIG = {
  WORKER_URL: "https://cultsstat-api.<votre-identifiant>.workers.dev", // ← votre URL
  ...
};
```

Si vous laissez `WORKER_URL: ""`, le front utilisera des chemins relatifs `/api/...`
(pensez alors à déployer les mêmes routes via des Pages Functions sur le même domaine).

Redéployez Pages avec le nouveau fichier : `npx wrangler pages deploy pages --project-name cult-track`.

## 5. Relais local (indispensable pour appeler Cults3D)

⚠️ **Cults3D bloque les appels venus du cloud** : le Worker Cloudflare reçoit un
HTTP 403 (protection anti-bot) et le navigateur seul reçoit une erreur CORS.
La solution : un petit relais Node sur votre machine (IP de maison), qui détient
la clé API et relaie vos requêtes GraphQL vers Cults3D. Aucune donnée ne transite
par un tiers — uniquement `127.0.0.1`.

1. Copiez l'exemple puis remplissez vos identifiants :
   ```bash
   cd relay
   cp relay.config.json.example relay.config.json   # puis éditez le fichier
   ```
   ```json
   {
     "nick": "VotrePseudoCults3D",
     "apiKey": "VotreCleAPI",
     "allowedOrigins": ["https://cult-track.pages.dev"]
   }
   ```
2. Démarrez le relais (laissez cette fenêtre ouverte) :
   ```bash
   cd relay
   npm start        # → "Relais cult-track prêt : http://127.0.0.1:8790/graphql"
   ```
   Le relais n'écoute que sur `127.0.0.1` (non accessible depuis Internet) et n'accepte
   que les origines listées dans `allowedOrigins`.

> Le relais est requis **au moment de la connexion et de chaque synchronisation** ;
> la consultation du dashboard (toutes les données sont déjà dans Supabase) ne le nécessite pas.

Ensuite, ouvrez votre site :

1. **Première connexion** : le front vérifie que le relais local tourne, compare le pseudo
   saisi à celui du `relay.config.json`, puis enregistre votre compte (clé chiffrée
   AES-256-GCM dans Supabase) et crée une session (jeton stocké dans le `localStorage`,
   seule valeur hachée en base).
2. **Synchronisation** : le navigateur pagine vos créations puis toutes vos ventes via le
   relais, et chaque lot est stocké dans Supabase par le Worker (`/api/ingest`,
   ventes auto-dédupliquées). Les stats sont capturées à chaque sync →
   les courbes grandissent dans le temps.
3. **Dashboard** : revenus cumulés, ventes/jour, engagement (vues/likes/téléchargements/
   abonnés), top créations, répartition gratuit/payant, tableau complet avec sparklines.

## Sécurité

- La clé API Cults3D vit dans `relay/relay.config.json` (local) ou dans le secret
  `ENC_KEY` : chiffrée AES-256-GCM côté Worker, jamais en clair dans Supabase.
- Le relais n'écoute que sur `127.0.0.1` et n'accepte que les origines explicites
  (`allowedOrigins`).
- Les jetons de session sont stockés hachés (SHA-256) ; changer de clé ou se déconnecter
  invalide toutes les sessions.
- La clé `service_role` Supabase est un **secret Worker** ; `wrangler.toml` ne contient
  que `SUPABASE_URL` (public) et aucun secret.
- Endpoints protégés par `Authorization: Bearer <jeton>` ; CORS ouvert (`*`) car la page
  est sur un domaine Cloudflare Pages distinct du Worker.

## Remarques sur l'API Cults3D

- Endpoint unique : `https://cults3d.com/graphql` — auth HTTP Basic (pseudo + clé API).
- **Rate limiting dynamique** lu dans les headers `x-ratelimit-limit / remaining / reset` ;
  le worker adapte son débit (pauses + backoff exponentiel) et la sync se fait en *chunks*
  pour rester dans les limites.
- Les fichiers 3D ne sont pas accessibles par l'API (légalité Cults3D) : seules les métadonnées
  sont remontées (vues, likes, téléchargements, prix, revenus, ventes…).
- Pour vérifier le schéma actuel : https://cults3d.com/graphiql, ou la doc communautaire
  dans le dossier `docs/` de ce repo si vous l'ajoutez.

## Résolution des problèmes

| Problème | Cause probable / solution |
|----------|---------------------------|
| `Worker non configuré : secrets …` | Faites `npx wrangler secret put SUPABASE_SERVICE_KEY` et `ENC_KEY`. |
| « Impossible de valider cette clé API » | Pseudo exact + clé recréée sur https://cults3d.com/en/api/keys. |
| `SyntaxError: invalid acknowledgment` côté navigateur | L'URL du Worker est fausse → corrigez `CONFIG.WORKER_URL`. |
| Sync très longue | Normal au 1er lancement (historique des ventes complet), ou rate limit bas → réessaiez plus tard. |
| Graphiques vides pour l'engagement | Les courbes ne s'affichent qu'après ≥ 2 synchronisations. |
| Aucune vente / aucun revenu | Les ventes arrivent à la 1re sync ; l'indicateur « conversion » reste à 0 % tant que vous n'avez pas de ventes. |

## Commandes utiles

```bash
cd worker && npm run dev            # test local du worker (wrangler dev)
cd worker && npm run deploy         # publier le worker
npx wrangler pages deploy pages     # publier le site
```