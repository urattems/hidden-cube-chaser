# Hidden Cube Chaser

Overlay Aion 2 qui guide vers les cubes cachés : distance, flèche, radar et marqueur exact sur
la carte du jeu (via Aion 2 - Map Overlay).

## Comment ça marche

- Les données viennent du **worker Aion 2 de Questlog**, lu directement dans
  `C:\Program Files\Questlog\resources\app.asar` et lancé dans notre propre processus. Questlog
  n'est jamais modifié. Quand il se met à jour, Chaser utilise son nouveau décodeur au prochain
  lancement.
- Le worker écoute le trafic du jeu avec Npcap, en lecture seule. Le paquet `EnvObjSpawn_NT`
  donne la position exacte du cube. Le serveur ne l'envoie que si le cube est à portée (environ
  40 à 60 m).
- Ta propre position est **estimée** par Questlog (à ± 10 m environ). Elle redevient précise
  juste après un buff, une compétence ou une téléportation. La distance affiche donc « ≈ » et une
  marge d'erreur.

## Installation sur un autre PC

1. Installer **Questlog** (il installe aussi **Npcap**). Il n'a pas besoin d'être ouvert ensuite.
2. Télécharger `Hidden-Cube-Chaser-<version>-win-x64.zip` depuis les *Releases* et le
   décompresser où tu veux, par exemple dans `C:\Jeux\Hidden Cube Chaser`.
3. Lancer `Hidden Cube Chaser.exe`. Au premier lancement, Windows peut afficher « Windows a
   protégé votre ordinateur » (l'exe n'est pas signé) : *Informations complémentaires* →
   *Exécuter quand même*.
4. Facultatif : installer Aion 2 - Map Overlay pour le marqueur exact sur la carte.

Si le dossier est déplacé plus tard, décoche puis recoche **Lancer avec Windows** dans le menu.

## Utilisation

- Lancer : `Hidden Cube Chaser.exe` (version portable), ou depuis les sources
  `Hidden Cube Chaser.vbs`. Une icône de cube apparaît dans la barre des tâches. Chaser démarre
  ensuite avec Windows, comme Questlog.
- L'overlay ne s'affiche que si le jeu tourne **et** qu'un cube est détecté. Le jeu doit être en
  **plein écran fenêtré** (borderless).
- Icône de la barre des tâches :
  - **Déplacer l'overlay**, puis **Verrouiller** une fois placé
  - **Aperçu (démo 50 s)** pour voir l'overlay sans cube
  - **Flèche** : nord de la carte en haut (par défaut, toujours juste), ou sens de déplacement
    (expérimental, dépend de la précision de la position)
  - Son à l'apparition, sonar de proximité (bips plus rapides en approchant)
  - **Visible en stream / enregistrement** : décoché par défaut, l'overlay est invisible dans
    OBS, Discord et les captures d'écran. Coche-le pour le montrer, et utilise la *Capture
    d'écran* (Display Capture) d'OBS : la *Capture de jeu* ne voit jamais les overlays.
  - **Marqueur dans Map Overlay** : écrit `Chaser_-_Cube_cache_verteron.json` et
    `..._altgard.json` dans `%LocalAppData%\Aion2MapOverlayData\routes`. Ouvre cette route dans
    Map Overlay quand tu chasses : le cube actif apparaît à son emplacement exact sur la carte, et
    la route se met à jour toute seule.

## Depuis les sources

```powershell
npm install
node node_modules\electron\install.js   # si npm n'a pas téléchargé Electron
npm start                               # ou : npm run demo
powershell -ExecutionPolicy Bypass -File tools\build-portable.ps1   # zip portable dans build\
```

## Fichiers

- Réglages et journal : `%AppData%\Hidden Cube Chaser\` (`settings.json`, `chaser.log`)
- Données du worker : `%AppData%\Hidden Cube Chaser\worker\` (l'historique de combat est purgé
  après 6 h)
- Diagnostic : `node_modules\electron\dist\electron.exe tools\probe.js 30` écrit les données
  brutes dans `tools\probe.log`

## Limites

- Npcap doit être installé (Questlog l'utilise déjà).
- Si une mise à jour de Questlog renomme ses abonnements (`hiddenCubes`, `map.positions`), Chaser
  ne recevra plus de données : le journal l'indiquera.
- Cartes du marqueur Map Overlay : Verteron (1010) et Altgard (1110). Ailleurs, l'overlay
  fonctionne quand même (distance, flèche, radar).
