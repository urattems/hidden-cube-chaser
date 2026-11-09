# Hidden Cube Chaser

Overlay Aion 2 qui guide vers les cubes cachés : marqueurs sur la carte d'angle du jeu, sonar de
proximité, et un petit encart qui dit d'un coup d'œil si la carte est bien lue.

## Comment ça marche

- **Le cube** : les données viennent du **worker Aion 2 de Questlog**, lu directement dans
  `C:\Program Files\Questlog\resources\app.asar` et lancé dans notre propre processus. Questlog
  n'est jamais modifié. Quand il se met à jour, Chaser utilise son nouveau décodeur au prochain
  lancement. Le worker écoute le trafic du jeu avec Npcap, en lecture seule. Le paquet
  `EnvObjSpawn_NT` donne la position exacte du cube. Le serveur ne l'envoie que si le cube est à
  portée (environ 40 à 60 m).
- **Toi** : le réseau ne donne qu'une **estimation** de ta position (± 3 à 20 m, plus précise
  juste après un buff ou une compétence). Chaser lit donc aussi la **carte d'angle du jeu** (la
  mini-carte en bas à droite) et la compare aux tuiles de carte d'Aion 2 - Map Overlay. Il en
  déduit ta **position exacte, à environ 1 m près**, plusieurs fois par seconde. C'est de la
  lecture d'écran passive, comme Map Overlay : rien n'est injecté dans le jeu.
  - Le zoom de la carte d'angle se calibre tout seul au premier passage, puis se recalibre si
    tu zoomes.
  - Une fenêtre qui recouvre une partie de la carte ne gêne pas : la carte est découpée en 3 × 3
    morceaux, et une majorité d'accord suffit.
  - Au bord d'une zone, la carte d'angle laisse voir le décor là où la carte de référence montre
    la mer. Chaser repère cette mer à sa couleur et ne compare que la terre : les morceaux posés
    sur la mer ne votent pas, et la majorité demandée baisse d'autant (5 morceaux sur terre au
    minimum).
  - Dans un donjon, une grotte, ou si la carte d'angle est fermée, Chaser revient à
    l'estimation de Questlog. Il ne donne jamais une position douteuse pour une position exacte :
    les distances estimées sont précédées de « ≈ ».
- **Les cubes sont dessinés sur la carte d'angle du jeu** (en bas à droite), à leur place exacte
  et numérotés, dès que Chaser y lit ta position. Un cube hors du cadre devient une flèche au
  bord avec sa distance. La carte d'angle doit être **ouverte**. Les marqueurs n'apparaissent
  jamais dans les captures d'écran, sinon la lecture de la carte les confondrait avec le terrain.
- **L'encart** reste affiché tant que le jeu tourne. Sa pastille est **verte** (« Carte OK ») quand
  les marqueurs peuvent être dessinés, **orange** quand Chaser cherche la carte ou attend une
  première position, **rouge** quand la carte n'est pas lue (fermée, cachée) ou que la capture a un
  problème. En dessous, une ligne par cube : son numéro, sa couleur, sa distance, et l'écart de
  hauteur s'il dépasse 2 m.
- **Groupes d'emplacements** : chaque cube appartient à un groupe d'emplacements possibles (95
  groupes et 1440 emplacements à Verteron, 59 et 1371 à Altgard, lus dans le client par
  aion2maps). Avec l'option **Montrer où un cube ouvert peut réapparaître** (décochée
  par défaut), un cube ouvert fait apparaître tous les emplacements de son groupe en points bleus
  sur la carte d'angle : il reviendra sur l'un d'eux. Un point devient gris quand tu passes à
  moins de 30 m sans qu'un cube y soit annoncé (pendant 5 min, car la réapparition peut tarder).
  Le plus proche hors du cadre devient une flèche au bord. Les points disparaissent dès que le
  nouveau cube est détecté, ou après 30 min. Le journal note le délai de chaque réapparition.
  Données : `node tools\extract-cube-spots.js <dossier aion2maps>` régénère `src\data\cube-spots.json`.
- **Le sonar** suit le cube ouvert le plus proche. Il bipe de plus en plus vite, aigu et fort en
  approchant, sans saut à l'arrivée, et les derniers mètres s'entendent le mieux. S'il redescend,
  tu t'éloignes. Quand la carte est lue, il suit ta position exacte sans retard. Sinon il suit
  l'estimation, lissée, et reste moins fiable : vérifie que l'encart est vert. Un cube annoncé est
  toujours entendu, au rythme le plus lent au-delà de 60 m.

## Installation sur un autre PC

1. Installer **Questlog** (il installe aussi **Npcap**). Il n'a pas besoin d'être ouvert ensuite.
2. Installer **Aion 2 - Map Overlay** et ouvrir une fois Verteron et Altgard dans son éditeur :
   Chaser utilise ses tuiles de carte pour la position exacte. Sans lui, Chaser fonctionne
   quand même, avec la position estimée.
3. Télécharger `Hidden-Cube-Chaser-<version>-win-x64.zip` depuis les *Releases* et le
   décompresser où tu veux, par exemple dans `C:\Jeux\Hidden Cube Chaser`.
4. Lancer `Hidden Cube Chaser.exe`. Au premier lancement, Windows peut afficher « Windows a
   protégé votre ordinateur » (l'exe n'est pas signé) : *Informations complémentaires* →
   *Exécuter quand même*.
5. Zone de la mini-carte : Chaser reprend celle réglée dans Map Overlay (*Select area*). Sinon :
   menu → **Sélectionner la zone de la mini-carte…**, puis trace un rectangle autour de la carte
   d'angle, ton personnage au centre.

Si le dossier est déplacé plus tard, décoche puis recoche **Lancer avec Windows** dans le menu.

## Mises à jour

La version portable vérifie les *Releases* GitHub au démarrage, puis toutes les 6 heures. Quand
une version plus récente existe, une notification Windows s'affiche et le menu propose
**⬆ Installer la mise à jour x.y.z**. Un clic suffit : Chaser télécharge le zip, se ferme,
remplace ses fichiers et redémarre. Les réglages (dans `%AppData%`) ne bougent pas.

Le dépôt étant privé, Chaser utilise la connexion de l'outil GitHub CLI : sur un nouveau PC,
l'installer (`winget install GitHub.cli`) puis lancer une fois `gh auth login`. Sans lui, le menu
affiche « connexion GitHub requise ». Depuis les sources, la mise à jour se fait par `git pull`.

## Utilisation

- Lancer : `Hidden Cube Chaser.exe` (version portable), ou depuis les sources
  `Hidden Cube Chaser.vbs`. Une icône de cube apparaît dans la barre des tâches. Chaser démarre
  ensuite avec Windows, comme Questlog.
- L'encart s'affiche tant que le jeu tourne. Décoche **Encart toujours visible (même sans cube)**
  pour ne le voir que lorsqu'un cube est détecté. Le jeu doit être en **plein écran fenêtré**
  (borderless).
- Avec deux écrans, l'overlay s'ouvre sur l'écran principal : utilise **Déplacer l'overlay**
  pour le mettre sur l'écran du jeu.
- Icône de la barre des tâches :
  - État de la capture et de la mini-carte
  - **Déplacer l'overlay**, puis **Verrouiller** une fois placé
  - **Aperçu (démo 50 s)** pour voir l'encart et entendre le sonar sans cube
  - **Lire la mini-carte (position exacte)**, **Sélectionner la zone de la mini-carte…**,
    **Reprendre la zone de Map Overlay**, **Recalibrer le zoom de la mini-carte**
  - **Montrer où un cube ouvert peut réapparaître** (décochée par défaut)
  - Son à l'apparition, sonar de proximité, volume des deux (faible, normal ou fort)
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

## Fichiers et diagnostic

- Réglages et journal : `%AppData%\Hidden Cube Chaser\` (`settings.json`, `chaser.log`). La
  calibration de la mini-carte est gardée dans `settings.json` (`minimap.scale`).
- Données du worker : `%AppData%\Hidden Cube Chaser\worker\` (l'historique de combat est purgé
  après 6 h).
- `electron.exe tools\probe.js 30` : données brutes du worker dans `tools\probe.log`.
- `electron.exe tools\record.js 60` : trafic brut et positions dans `tools\recordings\`.
- `electron.exe tools\vision-test.js <dossier d'images mm_<ms>.png> <probe-objects.json>` :
  rejoue des captures de la carte d'angle et écrit les positions trouvées dans
  `tools\vision-test.log`.
- `electron.exe . --dump-minimap=<fichier.png>` : enregistre la zone telle que la vision la voit.

## Limites

- Npcap doit être installé (Questlog l'utilise déjà).
- Si une mise à jour de Questlog renomme ses abonnements (`hiddenCubes`, `map.positions`), Chaser
  ne recevra plus de données : le journal l'indiquera.
- Position exacte et marqueur Map Overlay : Verteron (1010) et Altgard (1110), les cartes dont
  Map Overlay a les tuiles. Ailleurs (Eltnen, Morheim…), l'overlay fonctionne avec la position
  estimée. Tant que Questlog ne connaît pas la carte (après un lancement, jusqu'au premier
  changement de zone), Chaser essaie Verteron et Altgard tour à tour.
- Sans cube à portée, la position exacte part de l'estimation de Questlog : si celle-ci est trop
  fausse, la carte d'angle n'est pas trouvée, et un buff ou une compétence la recale. Dès qu'un
  cube est annoncé, ses coordonnées servent de repère : la carte d'angle et son zoom sont retrouvés
  autour de lui, quelle que soit l'estimation.
