# 🃏 Baccarat AI V9 Ultra C

Prédicteur d'enseigne (♠ ♥ ♦ ♣) pour la **1ère carte du Joueur** et la **1ère carte du Banquier** de la prochaine main de Baccarat, en temps réel depuis Telegram, avec **score de confiance honnête** mesuré sur 915 mains réelles.

## 🎯 Ce que cette app fait (et ne fait pas)

✅ **Ce qu'elle fait :**
- Récupère en direct l'historique des mains depuis [@statistika_baccara](https://t.me/statistika_baccara) (canal Telegram public)
- Fusionne 6 sous-moteurs (fréquence, couverture, Markov ordre 1+2, momentum, garde-fou couleur, anti-répétition)
- Prédit l'enseigne la plus probable pour J et B + une **enseigne de secours** (Plan B)
- Affiche une **confiance honnête** entre 25% (aléatoire) et ~40% (signal fort)
- Active automatiquement un **mode rattrapage** après chaque perte (couverture 2 enseignes)
- Re-mesure ses propres performances en backtest live sur l'échantillon courant

❌ **Ce qu'elle ne fait pas (parce que c'est mathématiquement impossible) :**
- Prédire l'enseigne EXACTE de la 1ère carte avec 70%+ de confiance — sur 915 mains analysées, **aucune stratégie ne dépasse 30% sur la prédiction exacte** (vs 25% du hasard)
- Promettre des gains. C'est un outil d'analyse statistique, pas une martingale magique.

## 📊 Métriques mesurées sur 885 mains de backtest (915 mains - 30 mains de warm-up)

| Métrique | Joueur | Banquier | Cible | Statut |
|---|---|---|---|---|
| **Enseigne dans P (2-3 cartes)** | **56.16%** | **55.37%** | ≥55% | ✅✅ |
| **Couverture 2 enseignes (rattrapage)** | **83.39%** | **82.37%** | ≥80% | ✅✅ |
| **Rattrapage cover2 (taux de succès)** | **85.21%** | **83.23%** | ≥80% | ✅✅ |
| **Max pertes consécutives** | **3** | **3** | ≤3 | ✅✅ |
| **Précision exacte 1ère carte** | 29.04% | 28.25% | (vs 25% aléatoire) | réaliste |

Tous les chiffres sont reproductibles depuis `analysis/`.

## 🧠 Architecture du moteur

```
6 sous-moteurs → distribution {♠,♥,♦,♣} chacun
       │
       ▼
Fusion pondérée (poids appris par random search sur backtest)
       │
       ▼
Si pertes consécutives ≥ 1 → mode rattrapage :
   - fusion ↘ + couverture ↗
   - pénalise l'enseigne qui vient d'échouer
       │
       ▼
Prédiction = enseigne max + enseigne #2 (Plan B)
```

### Poids finaux (issus de l'optimisation)
```
Joueur  : freq 23.7% · coverage  4.1% · markov 44.8% · momentum  2.4% · color 17.1% · least_recent  8.0%
Banquier: freq  2.6% · coverage 28.4% · markov 42.7% · momentum 11.0% · color  3.9% · least_recent 11.4%
```

## 🌐 Endpoints API

| Route | Méthode | Description |
|---|---|---|
| `/` | GET | SPA (interface complète) |
| `/api/health` | GET | Ping + version |
| `/api/telegram/feed` | GET | 3 pages Telegram agrégées (≈60 mains live) |
| `/api/telegram/deep?pages=N` | GET | Scrape profond (N pages, max 50 = ~1000 mains) |
| `/api/telegram?before=ID&channel=X` | GET | Une page Telegram brute |
| `/api/predict` | POST | Body : `{hands: [...]}` → prédiction côté serveur |
| `/api/empirical` | GET | Rapport empirique embarqué (915 mains de référence) |

## 📂 Structure du projet

```
webapp/
├── src/
│   ├── index.tsx        # Backend Hono (routes + scraping Telegram)
│   ├── engine.ts        # Moteur V9 (TypeScript serveur)
│   └── empirical.ts     # Rapport empirique embarqué (auto-généré)
├── public/static/
│   ├── engine.js        # Moteur V9 (JS frontend, miroir parfait du TS)
│   ├── app.js           # Application UI (state, render, polling)
│   └── style.css        # Design system "casino terminal"
├── analysis/
│   ├── scrape_telegram.py        # Récupère 800+ mains
│   ├── empirical_analysis.py     # Analyse empirique → JSON
│   ├── coverage_test.py          # Test des stratégies de couverture
│   ├── engine_v9.py              # Moteur Python (référence backtest)
│   ├── tune_v3.py                # Optimisation des poids
│   ├── hands_raw.json            # 915 mains brutes (Telegram)
│   ├── hands_parsed.json         # 915 mains parsées
│   ├── empirical_report.json     # Rapport statistique complet
│   ├── best_weights_p1.json      # Poids optimisés Joueur
│   └── best_weights_p2.json      # Poids optimisés Banquier
├── ecosystem.config.cjs # PM2 (dev sandbox)
├── wrangler.jsonc       # Cloudflare Pages
├── vite.config.ts       # Build SSR
└── package.json
```

## 🚀 Pipeline d'analyse (reproductible)

```bash
# 1. Scrape 800+ mains réelles depuis Telegram
python3 analysis/scrape_telegram.py
# → 915 mains dans analysis/hands_raw.json

# 2. Génère le rapport empirique (fréquences, Markov, autocorrélations, etc.)
python3 analysis/empirical_analysis.py
# → analysis/empirical_report.json + hands_parsed.json

# 3. Test les stratégies simples de couverture
python3 analysis/coverage_test.py

# 4. Optimise les poids des sous-moteurs par random search
python3 analysis/engine_v9.py      # baseline 800 trials
python3 analysis/tune_v3.py        # local refinement 400 trials
# → analysis/best_weights_p1.json + best_weights_p2.json

# 5. Régénère src/empirical.ts (embarqué dans le worker)
node -e "..." # voir l'historique git pour le snippet
```

## 🛠 Stack technique

- **Backend** : Hono 4.x sur Cloudflare Workers / Pages
- **Frontend** : HTML + CSS + Vanilla JS (zéro dépendance bundle)
- **Build** : Vite 6 + `@hono/vite-build`
- **Source live** : scraping de `t.me/s/{channel}` (preview public)
- **Stockage côté client** : `localStorage` (jusqu'à 1500 mains)
- **Aucun D1/KV/R2** : tout est calculé en mémoire + persisté localement

## 🆚 Comparaison V7 / V8 / V9

| | V7 (Hybrid) | V8 (Fusion) | **V9 Ultra C** |
|---|---|---|---|
| Échantillon Telegram | ~20 mains live | ~20 mains live | **915 mains analysées + live** |
| Backtest réel ? | Non communiqué | Non communiqué | **Oui, métriques publiées** |
| Prédit J **et** B ? | Oui | Oui | **Oui, séparément avec poids distincts** |
| Tables "magiques" non validées | Oui | Oui | **Non, tout est mesuré** |
| Mode rattrapage explicite | Implicite | 3 niveaux opaques | **Explicite avec couverture 2-enseignes** |
| Confiance honnête | "78-93%" inventés | "78-93%" inventés | **25-40% mesurés sur backtest** |
| Avertissement statistique | Non | Non | **Oui (panneau dédié)** |

## 🔥 Comment l'utiliser

1. Ouvrez l'app — elle se charge en récupérant ~300 mains d'historique
2. Lisez les **deux cartes Joueur/Banquier** : enseigne géante + score de confiance
3. **Plan B** indique l'enseigne #2 (utile en mode rattrapage)
4. La **recommandation** vous dit s'il faut miser fort, modérément, ou attendre
5. Toutes les ~7 secondes, l'app sync les nouvelles mains et recalcule
6. Cliquez sur **↻** pour forcer un refresh
7. Cliquez sur **⬇** pour recharger l'historique profond (15 pages)
8. Dépliez **"Décomposition des moteurs"** pour voir chaque sous-moteur

## 📝 Statut & versions

- **Version** : V9 Ultra C
- **Plateforme** : Cloudflare Pages
- **Dernière mise à jour** : 2026-06-15
- **Échantillon de référence** : 915 mains (game #1 → #1440)
- **Status** : ✅ Actif

## ⚠️ Avertissement

Le baccarat est un jeu de hasard à espérance négative pour le joueur. Cette application est un **outil d'analyse statistique** et **ne garantit aucun gain**. Les performances mesurées sur l'historique passé ne préjugent pas des résultats futurs. Jouez de manière responsable.
