// -----------------------------------------------------------------------------
// Runtime texts (English and French): feature and option names, the status
// of the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { EXTERNAL_COUNT, FEATURES } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Helios ventilation', 'Ventilation Helios');

export const FEATURE_NAMES = {
  [FEATURES.MODE]: both('Operating mode', 'Mode de fonctionnement'),
  [FEATURES.FAN_STAGE]: both('Fan stage', 'Niveau de ventilation'),
  [FEATURES.FAN_PERCENT]: both('Fan level (%)', 'Niveau de ventilation (%)'),
  [FEATURES.PARTY]: both('Party mode active', 'Mode fête actif'),
  [FEATURES.PARTY_LEFT]: both('Party mode: time left', 'Mode fête : temps restant'),
  [FEATURES.STANDBY]: both('Standby mode active', 'Mode veille actif'),
  [FEATURES.STANDBY_LEFT]: both('Standby mode: time left', 'Mode veille : temps restant'),
  [FEATURES.TEMP_OUTDOOR]: both('Outdoor air temperature', 'Température de l’air extérieur'),
  [FEATURES.TEMP_SUPPLY]: both('Supply air temperature', 'Température de l’air soufflé'),
  [FEATURES.TEMP_EXHAUST]: both('Exhaust air temperature', 'Température de l’air rejeté'),
  [FEATURES.TEMP_EXTRACT]: both('Extract air temperature', 'Température de l’air extrait'),
  [FEATURES.SUPPLY_RPM]: both(
    'Supply fan speed (rpm)',
    'Vitesse du ventilateur de soufflage (tr/min)',
  ),
  [FEATURES.EXTRACT_RPM]: both(
    'Extract fan speed (rpm)',
    'Vitesse du ventilateur d’extraction (tr/min)',
  ),
  [FEATURES.FILTER_DUE]: both('Filter change due', 'Changement des filtres à faire'),
  [FEATURES.FILTER_DAYS]: both('Filter: days left', 'Filtres : jours restants'),
  [FEATURES.FAULT]: both('Fault', 'Défaut'),
  [FEATURES.WARNING]: both('Warning', 'Avertissement'),
  [FEATURES.PARTY_START]: both('Start the party mode', 'Démarrer le mode fête'),
  [FEATURES.PARTY_STOP]: both('Stop the party mode', 'Arrêter le mode fête'),
};
for (let i = 1; i <= EXTERNAL_COUNT; i += 1) {
  FEATURE_NAMES[`humidity-${i}`] = both(`Humidity sensor ${i}`, `Capteur d’humidité ${i}`);
  FEATURE_NAMES[`co2-${i}`] = both(`CO2 sensor ${i}`, `Capteur de CO2 ${i}`);
}

export const MODE_NAMES = {
  auto: both('Automatic', 'Automatique'),
  manual: both('Manual', 'Manuel'),
};

export const STAGE_NAMES = {
  1: both('Stage 1', 'Niveau 1'),
  2: both('Stage 2', 'Niveau 2'),
  3: both('Stage 3', 'Niveau 3'),
  4: both('Stage 4', 'Niveau 4'),
};

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Helios unit (easyControls, Modbus TCP), then save.',
    'Saisissez l’adresse IP de votre centrale Helios (easyControls, Modbus TCP), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  configUnreadable: (wait) =>
    both(
      `The configuration could not be read from Gladys; next try in ${wait.en}. Stopping the party mode still works with the last address known.`,
      `La configuration n’a pas pu être lue depuis Gladys ; nouvel essai dans ${wait.fr}. L’arrêt du mode fête fonctionne toujours avec la dernière adresse connue.`,
    ),
  otherUnit: (kept, seen) =>
    both(
      `Another device answers at this address (MAC ${seen}, expected ${kept}): its values are not shown and the commands are refused. If it is your unit (board replaced), press "Test the connection" to accept it.`,
      `Un autre appareil répond à cette adresse (MAC ${seen}, attendue ${kept}) : ses valeurs ne sont pas affichées et les commandes sont refusées. Si c’est bien votre centrale (carte remplacée), appuyez sur « Tester la connexion » pour l’accepter.`,
    ),
  accepted: (seen) =>
    both(
      `Unit accepted with the MAC address ${seen}.`,
      `Centrale acceptée avec l’adresse MAC ${seen}.`,
    ),
  memoryUnreadable: both(
    ' The state file in /data cannot be read: the mode, fan stage and party start commands are refused until it can.',
    ' Le fichier d’état dans /data est illisible : le mode, le niveau de ventilation et le démarrage du mode fête sont refusés tant qu’il l’est.',
  ),
  connecting: both('Reading the unit…', 'Lecture de la centrale…'),
  waiting: (wait) =>
    both(
      `Next read of the unit in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la centrale dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, and that the unit runs easyControls 2.01 or later with Modbus enabled.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, et que la centrale a easyControls 2.01 ou plus récent avec le Modbus activé.`,
    ),
  failing: (reason, wait) =>
    both(
      `The unit answered badly (${reason}); next try in ${wait.en}.`,
      `La centrale a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  summary: (values) => {
    const parts = [];
    if (values.standby === true) {
      parts.push(both('standby mode', 'mode veille'));
    } else if (values.fanStage === 0) {
      parts.push(both('fans stopped (stage 0)', 'ventilateurs arrêtés (niveau 0)'));
    } else if (Number.isInteger(values.fanStage)) {
      parts.push(both(`stage ${values.fanStage}`, `niveau ${values.fanStage}`));
    }
    if (values.mode === 0 || values.mode === 1) {
      parts.push(values.mode === 0 ? both('automatic', 'automatique') : both('manual', 'manuel'));
    }
    if (values.party === true) parts.push(both('party mode', 'mode fête'));
    if (Number.isInteger(values.errors) && values.errors > 0) {
      parts.push(both(`FAULT (code ${values.errors})`, `DÉFAUT (code ${values.errors})`));
    }
    if (values.filterDue === true) parts.push(both('filter change due', 'filtres à changer'));
    if (parts.length === 0) {
      return both('Helios: state unknown.', 'Helios : état inconnu.');
    }
    return both(
      `Helios: ${parts.map((p) => p.en).join(', ')}.`,
      `Helios : ${parts.map((p) => p.fr).join(', ')}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  badButton: both('A button only takes 1: not sent.', 'Un bouton ne prend que 1 : non envoyé.'),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address in the configuration: not sent.',
    'Aucune adresse valide dans la configuration : non envoyée.',
  ),
  noAddressKnown: both(
    'No address of the unit known yet (configuration not read): not sent.',
    'Aucune adresse de la centrale connue pour l’instant (configuration non lue) : non envoyée.',
  ),
  notStarted: both(
    'The configuration has not been read from Gladys yet: not sent.',
    'La configuration n’a pas encore été lue depuis Gladys : non envoyée.',
  ),
  memoryUnreadable: both(
    'The state file in /data cannot be read: not sent.',
    'Le fichier d’état dans /data est illisible : non envoyée.',
  ),
  memoryNotSaved: both(
    'The state could not be written to /data: not sent.',
    'L’état n’a pas pu être écrit dans /data : non envoyée.',
  ),
  unitStandby: both(
    'The unit is in standby mode: this command could start the fans, and Gladys never ends a standby. Not sent.',
    'La centrale est en mode veille : cette commande pourrait relancer les ventilateurs, et Gladys ne met jamais fin à une veille. Non envoyée.',
  ),
  unitStopped: both(
    'The fans are stopped (stage 0): this command could start them, and Gladys never restarts them. Not sent.',
    'Les ventilateurs sont arrêtés (niveau 0) : cette commande pourrait les relancer, et Gladys ne les relance jamais. Non envoyée.',
  ),
  notManual: both(
    'The unit is in automatic mode, where it sets the fan stage itself: switch the operating mode to manual first. Not sent.',
    'La centrale est en mode automatique, où elle règle elle-même le niveau de ventilation : passez d’abord le mode de fonctionnement en manuel. Non envoyée.',
  ),
  otherUnit: both(
    'Another device answers at this address (another MAC address): press "Test the connection" to accept it if it is your unit. Not sent.',
    'Un autre appareil répond à cette adresse (autre adresse MAC) : appuyez sur « Tester la connexion » pour l’accepter si c’est bien votre centrale. Non envoyée.',
  ),
  noIdentity: both(
    'The MAC address of the unit could not be read just before: not sent.',
    'L’adresse MAC de la centrale n’a pas pu être relue juste avant : non envoyée.',
  ),
  unreadable: both('unreadable', 'illisible'),
  notAppliedYet: both('not applied yet', 'pas encore appliquée'),
  readBackDiffers: both('another value read back', 'autre valeur relue'),
  otherClient: both(
    'another Modbus client read the unit at the same time',
    'un autre client Modbus lisait la centrale au même moment',
  ),
  stopPending: both(
    'Party mode stop not sent yet, still trying to reach the unit: check the party mode in a few seconds.',
    'Arrêt du mode fête pas encore envoyé, connexion à la centrale en cours : vérifiez le mode fête dans quelques secondes.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    'Another command to the unit is still running: not sent.',
    'Une autre commande vers la centrale est encore en cours : non envoyée.',
  ),
  protectMeanwhile: both(
    'The party mode was stopped meanwhile: not sent.',
    'Le mode fête a été arrêté entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The unit answered too slowly to send the command in time: not sent.',
    'La centrale a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The state of the unit could not be read just before (${reason}): command not sent.`,
      `L’état de la centrale n’a pas pu être relu juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The unit refused the command (${reason}): not applied.`,
      `La centrale a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The unit could not be reached (${reason}): command not sent.`,
      `La centrale n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the unit in a few seconds.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la centrale dans quelques secondes.`,
    ),
};
