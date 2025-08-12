## Venus Switch Bot — Optimiseur de dépôts sur Venus (BSC)

Outil Node.js/TypeScript pour analyser et simuler l’optimisation de dépôts sur les core pools de Venus Protocol (BNB Chain), en tenant compte des frais de swap et du coût gas. Le projet inclut:
- un CLI complet (scan des marchés, simulation, quotes de swap, historique d’APY, suivi des intérêts d’emprunt),
- une UI de visualisation temps réel (Vite + React), mobile‑first.

### Architecture rapide
- `server/`: CLI + modules de simulation et services on-chain/off-chain.
- `frontend/`: UI (Vite + React) lisant les logs via endpoints JSON/SSE pendant le dev.
- `logs/` et `data/`: fichiers NDJSON/JSON produits par la simulation et consommés par l’UI.

## Installation et démarrage
- Installer les dépendances: `npm install`
- Variables d’environnement: copier `env.example` en `.env` si besoin, puis renseigner les valeurs utiles (voir section Configuration)
- Build du serveur: `npm run build -w server`
- Vérifier les marchés: `npm run check`
- Lancer l’UI en dev: `npm run dev:front`
- Dev complet (UI + simulation en parallèle): `npm run dev:all`

## Commandes CLI (détaillées)

### 1) check — Scan des core pools
- **But**: lister toutes les core pools actives, triées par Supply APY, avec les APY moyenne 1/3/6/12 mois quand disponible.
- **Utilisation**:
  - `npm run check`
- **Sortie**: table CLI puis meilleure cible suggérée.
- **Filtrage**: seules les pools entièrement actives sont listées (isListed = true, mint/supply non pausé, borrow non pausé).

### 2) dry-run — Estimation de rentabilité instantanée
- **But**: estimer la rentabilité d’un switch pour un nominal USD: APY différentiel − frais de swap (bps) − coût gas (%)
- **Utilisation**:
  - `npm run dry-run -- --amount 1000 --asset USDT`
- **Options**:
  - `--amount <usd>`: montant nominal en USD (nombre > 0)
  - `--asset <SYM>`: symbole de l’actif courant (ex: USDT, USDC, BUSD, BTCB…)
- **Notes**:
  - Le coût gas est estimé via RPC si `SERVER_BSC_RPC_URL` est défini, et converti en USD via le prix BNB (CoinGecko).
  - Les frais de swap sont approximés si le mode quote live n’est pas utilisé.

### 3) simulate — Simulation dry‑run H24 (avec logs)
- **But**: simuler une stratégie de bascule automatique vers la meilleure pool en tenant compte des frais; aucune transaction réelle.
- **Utilisation (par défaut 24h)**:
  - `npm run simulate`
  - ou paramétrée: `node --enable-source-maps server/dist/index.js simulate --amount 100000 --asset USDC --hours 24 --interval 60`
- **Options principales**:
  - `--amount <usd>`: montant initial en USD (défaut 100000)
  - `--asset <SYM>`: actif de départ (défaut USDC)
  - `--interval <sec>`: intervalle de tick en secondes (défaut 60)
  - `--hours <n>`: durée totale de simulation (défaut 24). Utiliser `0` (ou négatif) pour mode continu.
  - `--continuous`: force le mode continu (boucle infinie jusqu'à arrêt manuel).
  - `--live-quote`: active un quote PancakeSwap v2 en direct (meilleure route `getAmountsOut`, gas via Etherscan v2 si API key)
  - `--log-actions <path>`: NDJSON des événements (défaut `logs/actions.ndjson`)
  - `--log-balance <path>`: NDJSON série `{ t, v }` (défaut `logs/balance.ndjson`)
  - `--log-blocks <path>`: NDJSON des gains par bloc (défaut `logs/per-block.ndjson`)
- **Seuil de bascule**:
  - `MIN_NET_APY_DIFF_BPS` (ou `SERVER_MIN_NET_APY_DIFF_BPS`): différentiel net minimal en bps (ex: 5 = 0.05%).
- **Logs produits**:
  - `actions.ndjson`: `start` | `tick` | `switch` | `error` | `summary`
  - `balance.ndjson`: `{ t: ISODate, v: number }`
  - `per-block.ndjson`: détail par bloc
  - `state.json`: snapshot pour reprise (fingerprint + état)

#### Structure de `data/markets.json`
- Le fichier contient `{ ts, markets }`.
- Chaque entrée de `markets` suit la forme suivante:

```json
{
  "assetSymbol": "USDC",
  "vTokenSymbol": "vUSDC",
  "supplyApyPercent": 1.23,
  "borrowApyPercent": 1.45,
  "totalSupplyUnderlying": 123456.78,
  "totalBorrowsUnderlying": 98765.43,
  "supplyRatePerBlock": 1.1e-9,
  "blocksPerYear": 10512000,
  "vTokenAddress": "0x...",
  "underlyingAddress": "0x...",
  "type": "stable" // stable | wrapped | token
}
```
Notes:
- Le champ `type` permet d’identifier rapidement la nature de l’actif (stablecoin, wrapped, ou autre token).
- Les marchés inclus sont filtrés pour exclure toute pool avec mint/supply ou borrow en pause.

### 4) quote-swap — Estimation de prix (on-chain aggregator) + coût gas
- **But**: obtenir le meilleur prix disponible sur BSC via un moteur on-chain (sans clé API) et estimer le coût gas.
- **Utilisation**:
  - `npm run quote-swap -- --from USDT --to BUSD --amount 10000`
  - Raccourcis/alias: `--to BTC` est accepté et mappé automatiquement vers `BTCB` sur BSC.
  - Important (npm): séparer la commande et ses options par `--`.
- **Options**:
  - `--from <SYM>`: symbole source
  - `--to <SYM>`: symbole destination
  - `--amount <units>`: montant en unités humaines du token source
  - `--engine <oneinch|pcs>`: moteur de quote (défaut: `oneinch`).
  - `--slippage <percent>`: tolérance slippage (%) pour calculer `amountOutMin` (défaut 0).
- **Sortie**: JSON `{ ok, from, to, amountIn, amountOut, amountOutMin, valueInUSD, valueOutUSD, provider, gas: { source, gasPriceGwei, gasLimit, txCostBNB, txCostUSD }, tradingFeeBpsApprox }`

#### Timeouts RPC
- Pour éviter les blocages sur les appels `getAmountsOut`, un timeout est appliqué (par défaut 7000 ms).
- Personnalisable via `SERVER_RPC_CALL_TIMEOUT_MS` dans `.env`.

#### PancakeSwap v3
- Pour activer v3, renseignez `SERVER_PCS_V3_QUOTER` (adresse Quoter/QuoterV2 BSC) dans `.env`.
- Vous pouvez contrôler les frais v3 via `--fee-tiers` ou `SERVER_PCS_V3_FEE_TIERS`.
- Le slippage `--slippage` calcule `amountOutMin` à partir de `amountOut`.

### 5) borrow-scan — Suivi des intérêts d’emprunt
- **But**: analyser les emprunts en cours d’une adresse Venus, calculer les intérêts cumulés, le taux annualisé réalisé et une projection N heures.
- **Utilisation**:
  - One‑off: `node --enable-source-maps server/dist/index.js borrow-scan --account 0x... --projection-hours 12`
  - Boucle: `node --enable-source-maps server/dist/index.js borrow-scan --account 0x... --repeat`
- **Options**:
  - `--account <address>`: adresse BSC (obligatoire)
  - `--days <n>`: fenêtre historique jours (défaut 365)
  - `--from-block <n>`: bloc de départ (prioritaire sur `--days`)
  - `--projection-hours <n>`: projection (défaut 12)
  - `--log <path>`: NDJSON de sortie (défaut `logs/borrow.ndjson`)
  - `--repeat`: exécution périodique; l’intervalle est `SERVER_BORROW_INTERVAL_HOURS` (défaut 12h)
- **Champs de sortie (résumé)**:
  - `totals.currentDebtUSD`, `totals.interestAccruedTotalUSD`, `totals.currentWeightedBorrowApyPercent`, `totals.realizedAprPercent`, `totals.projectedInterestNextHoursUSD`

### 6) pools-snapshot — Snapshot des pools actives (RPC)
- **But**: interroger le Comptroller Venus via RPC pour récupérer les core markets actifs et écrire un snapshot JSON.
- **Utilisation**:
  - `node --enable-source-maps server/dist/index.js pools-snapshot`
- **Options**:
  - `--out <path>`: chemin de sortie (défaut `data/pools.json`)
- **Sorties**:
  - `data/pools.json`: métadonnées des marchés (network, comptroller, `assetSymbol`, `vTokenSymbol`, `vTokenAddress`, `underlyingAddress`, `blocksPerYear`, `type`).
  - `data/pools/<symbol>.json`: série journalière append‑only par token, même format que `data/old/*`:
     - `{ timestamp, totalSupplyUsd, totalBorrowUsd, debtCeilingUsd, apyBase, apyReward, apyBaseBorrow, apyRewardBorrow }`
     - déduplication par jour (1 point par jour UTC), trié par timestamp ascendant.

### 7) clean-data — Nettoyage des données brutes
- **But**: supprimer l’enveloppe type réponse API et ne garder qu’un objet `{ data: [...] }` pour chaque fichier de `data/raw/*.json`, écrit dans `data/*.json`.
- **Utilisation**:
  - `npm run clean-data -w server`
- **Notes**:
  - Le script détecte `{ status, data }`, des tableaux ou des structures proches; la sortie est normalisée en `{ data: [...] }`.

  

## UI temps réel (dev)
- Démarrer: `npm run dev:front` (Vite sur `http://localhost:5173`)
- Dev complet: `npm run dev:all` (UI + simulation; l’UI lit les logs produits)
- Endpoints exposés par le plugin Vite en dev/preview:
  - `GET /api/actions` → `{ ok, events }`
  - `GET /api/balance` → `{ ok, points }`
  - `GET /api/actions/stream` (SSE)
  - `GET /api/balance/stream` (SSE)
  - `GET /api/markets` et `/api/markets/stream` pour `data/markets.json`
  - `GET /api/pools` (si disponible) pour `data/pools.json`
- Réinitialisation rapide depuis l’UI: `GET /api/reset` (vide les logs et place un flag `data/reset.flag` déclenchant la reprise côté simulateur).

## Logs et données
- Formats NDJSON: une ligne JSON par événement/point.
- Fichiers par défaut:
  - `logs/actions.ndjson`, `logs/balance.ndjson`, `logs/per-block.ndjson`, `logs/borrow.ndjson`
  - `logs/state.json` (snapshot), `data/markets.json` (marchés du dernier tick), `data/reset.flag` (signal de reset)
- Rotation des logs (simulateur):
  - `SERVER_LOG_MAX_BYTES` et `SERVER_LOG_MAX_FILES` (défauts implicites: actions/balance 10 MiB, per‑block 200 MiB, conservation 5 fichiers)

## Configuration (variables d’environnement)
- Conventions: `SERVER_*` côté Node/CLI, `CLIENT_*` côté UI (Vite), non préfixées = partagées.
- Principales variables serveur:
  - `SERVER_BSC_RPC_URL`: URL RPC BNB Chain
  - `SERVER_CORE_COMPTROLLER_ADDRESS`: adresse Comptroller core Venus
  - `SERVER_PCS_V2_ROUTER`, `SERVER_WBNB_ADDRESS`: adresses PancakeSwap v2 / WBNB
  - `SERVER_ETHERSCAN_API_KEY` (ou `ETHERSCAN_API_KEY`): clé Etherscan v2 (gas tracker BSC `chainid=56`)
  - `SERVER_MIN_NET_APY_DIFF_BPS`: seuil de décision (bps)
  - `SERVER_ENABLE_APY_HISTORY`: activer l’enrichissement APY historiques (défaut true)
  - `SERVER_LOG_ACTIONS_PATH`, `SERVER_LOG_BALANCE_PATH`, `SERVER_LOG_BLOCKS_PATH`, `SERVER_LOG_STATE_PATH`
  - `SERVER_LOG_MAX_BYTES`, `SERVER_LOG_MAX_FILES`
  - `SERVER_BORROW_INTERVAL_HOURS`, `SERVER_BORROW_DAYS_LOOKBACK`, `SERVER_LOG_BORROW_PATH`
- Variables UI (Vite) pour résoudre les chemins:
  - `LOG_ACTIONS`, `LOG_BALANCE`, `LOG_BLOCKS`, `DATA_MARKETS` (ou variantes `CLIENT_*`/`SERVER_*`)
  - Résolution: essaie d’abord les env, puis `../logs/*` (racine repo), puis `logs/*` (dossier `frontend/`).

## Docker / Compose
- Fichiers fournis:
  - `Dockerfile.server`: build du serveur (CLI)
  - `Dockerfile.frontend`: build du front (Vite preview)
  - `docker-compose.yml`: orchestre 3 services
    - `server`: lance la simulation (logs + data montés)
    - `frontend`: sert l’UI sur `:5173` (accessible depuis l’extérieur)
    - `pools-cron`: tâche cron journalière (02:00 UTC) qui exécute `pools-snapshot` et met à jour `data/markets.json`

### Démarrer
```bash
docker compose up --build -d
```

### Arrêter
```bash
docker compose down
```

## Lexique
- **Core pool**: marché « core » de Venus (mint non pausé, isListed).
- **vToken**: token de marché (ex: vUSDC) qui représente la position sur Venus.
- **Underlying**: actif sous‑jacent (ex: USDC, BNB) d’un vToken.
- **APY**: Annual Percentage Yield, rendement annualisé avec capitalisation.
- **APR**: Annual Percentage Rate, taux annualisé sans capitalisation.
- **bps (basis points)**: 1 bps = 0,01% (100 bps = 1%).
- **Rate per block**: taux périodique par bloc, converti en APY via le nombre de blocs/an (`blocksPerYear`).
- **Quote live**: route et sortie de swap déterminées on‑chain (PancakeSwap v2 `getAmountsOut`).
- **Frais de swap**: pertes implicites liées au chemin de swap (approximation en bps si pas de quote live).
- **Coût gas**: coût estimé de la transaction de switch (redeem + swap + mint), en BNB puis converti en USD.
- **NDJSON**: Newline‑Delimited JSON, format « 1 JSON par ligne ».
- **SSE**: Server‑Sent Events, flux d’updates pour la UI.

## Scripts NPM (racine)
- `npm run build`: build du serveur
- `npm run start`: `check` par défaut
- `npm run check`, `npm run dry-run`, `npm run simulate`, `npm run apy-history`, `npm run quote-swap`
- `npm run dev:front`: UI (Vite)
- `npm run dev:all`: UI + simulation en parallèle
  
### Raccourcis racine (scripts utiles)
- `npm run clean-data`: nettoie `data/raw/*.json` vers `data/*.json` (objet `{ data: [...] }`).


