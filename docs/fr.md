# ETA

Intégration non officielle, sans lien avec ETA. Elle amène dans Gladys une
chaudière **ETA** (granulés, bûches, plaquettes : PE-K, PU, ePE-K, SH,
HACK…) équipée de l'écran tactile **ETAtouch**, par ses **webservices REST
locaux** officiels, **en lecture seule**.

> **Attention : jamais testé avec une vraie chaudière.** Cette intégration a
> été écrite à partir du document officiel « ETAtouch RESTful Webservices »
> 1.2 et de l'intégration Home Assistant homeassistant_eta_integration, et
> testée contre les réponses enregistrées d'une PE-K seulement. Les retours
> sont les bienvenus.

## Ce que vous obtenez

Un appareil Gladys par bloc du menu de l'ETAtouch, avec les noms de l'écran,
dans sa langue : **ETA Kessel** (chaudière), **ETA HK** (circuit de
chauffage), **ETA WW** (eau chaude), **ETA Sys** (système), **ETA LagerUm.**
(extraction des granulés)… selon votre installation.

Avec **Valeurs principales** (par défaut), une trentaine de valeurs :

- les états de la chaudière, des circuits, de l'eau chaude et de l'extraction
  (« Bereit », « Heizen »…) et les modes affichés ;
- les températures : chaudière, consigne chaudière, chaudière bas, fumées,
  extérieure, départ des circuits, eau chaude et sa consigne ;
- la pression de la chaudière (bar), l'oxygène résiduel, l'alimentation (%),
  la puissance demandée (kW) ;
- les granulés : stock, trémie, consommation totale, depuis l'entretien,
  depuis le décendrage, depuis le dernier vidage du cendrier (kg) ;
- les compteurs : heures à pleine charge, nombre de mises en chauffe et
  d'allumages.

Avec **Toutes les valeurs**, toutes les valeurs lisibles du menu (plusieurs
centaines, entrées et sorties comprises ; les plages horaires ne sont pas
reprises). La première lecture du menu prend alors quelques minutes.

Seules les valeurs des appareils que vous **ajoutez** sont lues ensuite,
une à une, à chaque rafraîchissement.

Les températures sont des sondes (elles n'entrent pas dans la moyenne de la
pièce). La pression est en bar ou en Pa, les heures en heures. Les kg, %, kW,
W, tr/min… n'ont pas d'unité dans Gladys (le cœur ne les propose pas pour ces
catégories) : l'unité est dans le nom, par exemple
« Zählerstände > Gesamtverbrauch (kg) ». Les kW et kWh ne sont **pas**
envoyés au tableau de bord énergie de Gladys (il les compterait comme de
l'électricité). Une valeur que la chaudière n'a pas pour l'instant (« xxx »,
« --- ») n'est pas publiée : jamais un faux 0.

L'appareil **Erreurs ETA** donne : erreur active (0/1), nombre d'erreurs
actives, dernière erreur (bloc, message, priorité, heure).

Déclencheur de scène **Erreur de la chaudière ETA** : quand une lecture
montre une erreur active jamais vue. Variables : `message`, `block` (la
partie de l'installation) et `priority` (telle que l'écran l'affiche). Les
erreurs déjà vues sont gardées (200 au plus, dans `/data`) : une erreur qui
reste ou revient ne redéclenche pas, même après un redémarrage. Jamais à la
toute première lecture (elle apprend les erreurs présentes).

Le badge de chaque appareil affiche « local », « injoignable » quand
l'ETAtouch ne répond pas, et un point orange quand une de ses valeurs n'a pas
pu être lue au dernier rafraîchissement.

## Installation

1. Sur **meineta.at**, enregistrez votre ETAtouch et **demandez l'accès
   LAN** (« LAN-Zugriff »).
2. Sur l'écran de la chaudière, dans les **réglages système**, **activez
   l'accès LAN** (« Webservices »). Notez l'adresse IP de l'écran (réglages
   réseau) ; une adresse fixe (réservation DHCP) est préférable.
3. Dans Gladys, installez l'intégration ETA, saisissez l'**adresse IP** (le
   port est 8080) et enregistrez.
4. Ouvrez l'onglet **Découverte** et ajoutez les appareils voulus.

**Sécurité** : les webservices ETAtouch répondent **sans aucun mot de passe**
à quiconque atteint le port 8080 de l'écran (c'est ainsi que le fabricant
les a conçus). Gardez la chaudière sur votre réseau local : ne redirigez
jamais ce port depuis votre box vers Internet.

## Réglages

| Réglage                        | Rôle                                                                                    |
| ------------------------------ | --------------------------------------------------------------------------------------- |
| Adresse IP de l'ETAtouch       | L'adresse de l'écran, sans chemin (`192.168.1.50`, ou `192.168.1.50:8080`).             |
| Port des webservices           | 8080.                                                                                   |
| Valeurs proposées              | « Valeurs principales » (une trentaine) ou « Toutes les valeurs » (tout le menu).       |
| Intervalle de rafraîchissement | 60 s par défaut (60 à 3600).                                                            |
| Langue des noms                | Pour l'appareil des erreurs et les messages ; les noms des valeurs viennent de l'écran. |

Le bouton **Tester la connexion** lit la chaudière une fois si l'intervalle
est écoulé depuis la dernière lecture ; sinon il affiche le temps restant et
le dernier état.

## Comment l'intégration ménage la chaudière

- Lecture seulement (des requêtes GET) : rien n'est jamais écrit sur la
  chaudière, ni valeur, ni jeu de variables.
- Une seule requête à la fois, la suivante après la réponse de la
  précédente.
- Une lecture par intervalle, jamais plus tôt : ni le bouton, ni la
  Découverte, ni un redémarrage de l'intégration ne la rapprochent (l'heure
  de chaque lecture est gardée dans `/data` avant sa première requête).
  Seuls une nouvelle adresse ou un nouveau port (un autre ETAtouch) lisent
  aussitôt.
- Le menu est lu à la première lecture, puis gardé dans `/data` ; la
  Découverte le relit au plus toutes les 10 minutes, à la lecture suivante.
  Sa lecture est bornée (2 Mo, 800 entrées, 10 minutes) : au-delà, ce qui a
  été lu est gardé et l'état le signale.
- Après un échec : nouvel essai après 1, 2, 5, 10 puis 15 minutes (jamais
  moins que l'intervalle). Si l'ETAtouch demande de ralentir (HTTP 429) :
  pause de 1 minute à 6 heures, gardée après un redémarrage.

## Firmware

Les webservices existent depuis le logiciel système 1.20.0 de l'ETAtouch.
L'API 1.2 (logiciel x.49.0 et suivants) décrit chaque valeur (`varinfo`) ;
avant, l'intégration passe en **mode réduit** : le type d'une valeur est
déduit de la valeur elle-même et son nom du menu, et l'état de connexion le
signale.

## Limites connues

- Lecture seule : ni marche/arrêt, ni consignes, ni modes, ni plages
  horaires, ni « charger l'eau chaude maintenant ». Une version future
  pourrait en proposer certaines, désactivées par défaut.
- Les identifiants des valeurs principales viennent d'une PE-K ; une autre
  chaudière peut en avoir d'autres (ballon tampon, solaire…) : choisissez
  alors « Toutes les valeurs ».
- Une valeur qui affichait « --- » sans unité lors de la lecture du menu
  n'est pas proposée ; relancez une Découverte plus tard.
- Le nom d'une valeur est celui de l'écran au moment de la lecture du menu.

## Dépannage

- **« pas de réponse de l'ETAtouch »** : vérifiez l'adresse IP, que l'accès
  LAN est activé sur l'écran, et que Gladys et la chaudière sont sur le même
  réseau.
- **« pas de webservices ETAtouch sur ce port »** : le port n'est pas 8080,
  ou l'accès LAN n'est pas activé.
- **« une réponse qui n'est pas celle d'un ETAtouch »** : l'adresse est celle
  d'un autre appareil.
- **« mode réduit »** : mettez à jour le logiciel de l'ETAtouch pour avoir
  les noms et les types exacts.
