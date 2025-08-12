# RealtimeDashboard

Organisme qui orchestre l'affichage des données de simulation:

- `BalanceChart` (graphique position USD)
- `PLCard` (P/L actuel, capital initial, début, temps écoulé, cumuls)
- `MarketsTable` (APY courants + historiques) — désormais affiché tout en haut du dashboard, sous le titre
- `ActionsLog` (journal live)

Styles: utiliser `src/styles/ui/organisms/_realtime-dashboard.scss` et les molécules `card`/`stat-row`.

API: `MarketsTable` consomme les données fournies par `/api/markets` ou `/api/markets/stream` via le conteneur. Le timestamp d'actualisation peut être exposé soit sous la clé `ts` (legacy) soit `timestamp` (nouveau). Le conteneur gère la compatibilité et passe une prop `lastUpdateTs` normalisée.


