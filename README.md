# Terre 1:1

La Terre entière à l'échelle 1:1, en 3D dans le navigateur. Volez comme Superman ou courez à Mach 1, du ras des vagues jusqu'à la Lune, Mars et au-delà.

**Jouer en ligne : https://lilianrobert.github.io/terre-1-1/**

## Ce qu'on y trouve

- **Toute la planète** chargée au fil du vol, comme Google Maps : relief réel, images satellite, fleuves, lacs, côtes (la dune du Pilat, l'estuaire de la Gironde, le Mont-Saint-Michel…).
- **Océans vivants** : houle, écume, reflets, vent.
- **Ciel physique** : diffusion atmosphérique, nuages, lever et coucher du soleil, ombres, vrai ciel étoilé du jour.
- **Villes en 3D** à partir d'OpenStreetMap : immeubles haussmanniens, maisons, tours de verre, forêts (couleurs d'automne selon la date).
- **Monuments de Paris** modélisés : tour Eiffel (illuminée et scintillante la nuit), Arc de Triomphe, Notre-Dame, Sacré-Cœur, Montparnasse, Pyramide du Louvre, Grande Arche.
- **Espace réel** : la Lune (site d'Apollo 11, lever de Terre), Mars (Olympus Mons, Valles Marineris), tout le système solaire aux vraies positions du jour, Voie lactée, 5 000 étoiles.
- **Bang supersonique** au passage du mur du son.
- **Missiles et astéroïdes** : tirez depuis l'espace, champignon nucléaire, cratères qui se creusent sous les tirs concentrés jusqu'au manteau en fusion, couches géologiques visibles, villes et monuments détruits. Un astéroïde en mer déclenche un **tsunami** qui déferle sur les côtes.

## Commandes

| Touche | Action |
| --- | --- |
| `Z` `Q` `S` `D` + souris | se déplacer, regarder (WASD en QWERTY) |
| `Espace` / `C` | monter / descendre, sauter en course |
| `Maj` | super-vitesse |
| `F` | vol ou course |
| `0` | monter en orbite |
| `T` / `G` | faire défiler l'heure |
| `K` | rechercher un lieu |
| `X` ou clic droit | tirer là où vous regardez |
| `V` | missile ou astéroïde |
| `P` | mode photo |
| `M` | couper le son |

Le bouton **Commandes** en bas de l'écran ouvre toutes les options : lieux, monuments, Lune, Mars et planètes, qualité, effacer les cratères.

## Lancer en local

Aucune installation : il suffit d'un serveur web statique.

```bash
python serve.py
```

puis ouvrir http://localhost:8765. Sous Windows, double-cliquez sur `Lancer la Terre.bat`.

## Technique

JavaScript pur avec [three.js](https://threejs.org) (r160), sans étape de build. Terrain en quadtree sur une sphère cubique avec niveaux de détail, origine flottante, calcul des tuiles dans des Web Workers, atmosphère en raymarching, éphémérides réelles (éléments JPL, Lune de Meeus), sons entièrement synthétisés en Web Audio.

## Données et crédits

- Images satellite © Esri, Maxar, Earthstar Geographics (World Imagery, usage non commercial)
- Relief : AWS Terrain Tiles (Mapzen / Terrarium)
- Bâtiments, forêts et eau © contributeurs OpenStreetMap (ODbL), tuiles OpenFreeMap
- Recherche de lieux : Nominatim / OpenStreetMap
- Textures des planètes : Solar System Scope (CC BY 4.0)
- Étoiles : Yale Bright Star Catalog via d3-celestial
- Bibliothèques : three.js (MIT), earcut (ISC)

Le code de ce dépôt est sous licence MIT. Les données et images ci-dessus restent soumises à leurs propres licences.
