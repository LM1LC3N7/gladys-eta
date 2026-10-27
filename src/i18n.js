// -----------------------------------------------------------------------------
// Texts shown in Gladys (connection status, button, the errors device), in
// English and French. The names of the variables and of the blocks come from
// the ETAtouch, in the language of its display.
// -----------------------------------------------------------------------------

/** The text of `texts` in `language`, English otherwise. */
export const word = (texts, language) => texts[language] ?? texts.en;

export const both = (en, fr) => ({ en, fr });

/** Two messages one after the other, in each language. */
export const join = (...messages) =>
  both(messages.map((m) => m.en).join(' '), messages.map((m) => m.fr).join(' '));

/** "25 s" / "3 min" / "2 h", for the pauses. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 120) {
    return both(`${seconds} s`, `${seconds} s`);
  }
  const minutes = Math.round(seconds / 60);
  if (minutes < 120) {
    return both(`${minutes} min`, `${minutes} min`);
  }
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const ERRORS_DEVICE = both('ETA errors', 'Erreurs ETA');

/** The features of the errors device, by role (frozen keys). */
export const ERROR_FEATURES = {
  alarm: both('Active error', 'Erreur active'),
  'error-count': both('Active errors', 'Erreurs actives'),
  'last-error': both('Last error', 'Dernière erreur'),
};

/** The reasons of a failure, by EtaError kind. */
const REASONS = {
  network: both('no answer from the ETAtouch', "pas de réponse de l'ETAtouch"),
  timeout: both('no answer in time', 'pas de réponse à temps'),
  forbidden: both(
    'access refused (is the LAN access turned on?)',
    "accès refusé (l'accès LAN est-il activé ?)",
  ),
  not_found: both(
    'no ETAtouch webservices on this port (8080?)',
    'pas de webservices ETAtouch sur ce port (8080 ?)',
  ),
  unavailable: both('the ETAtouch answered an error', "l'ETAtouch a répondu une erreur"),
  bad_response: both(
    'an answer that is not an ETAtouch one',
    "une réponse qui n'est pas celle d'un ETAtouch",
  ),
  size: both('an answer too large', 'une réponse trop grande'),
  http: both('an unexpected answer', 'une réponse inattendue'),
  internal: both('an internal error', 'une erreur interne'),
};

export const reasonOf = (err) => REASONS[err?.kind] ?? REASONS.internal;

/** Connection statuses and button answers. */
export const T = {
  noConfig: both(
    'Enter the IP address of the ETAtouch (touch display of the boiler).',
    "Saisissez l'adresse IP de l'ETAtouch (écran tactile de la chaudière).",
  ),
  addressPath: both(
    'Enter the address alone (for example 192.168.1.50), without a path.',
    "Saisissez l'adresse seule (par exemple 192.168.1.50), sans chemin.",
  ),
  addressInvalid: both(
    'This address is not an IP address nor a host name of the network.',
    "Cette adresse n'est ni une adresse IP ni un nom d'hôte du réseau.",
  ),
  connecting: both('Connecting to the ETAtouch...', "Connexion à l'ETAtouch..."),
  discovering: (done, total) =>
    both(
      `Reading the menu of the ETAtouch: ${done}/${total} variables...`,
      `Lecture du menu de l'ETAtouch : ${done}/${total} variables...`,
    ),
  connected: (read, unreadable, reduced) =>
    both(
      `Connected: ${read} values read${unreadable ? `, ${unreadable} unreadable` : ''}${
        reduced ? ' (API older than 1.2: reduced mode)' : ''
      }.`,
      `Connecté : ${read} valeurs lues${unreadable ? `, ${unreadable} illisibles` : ''}${
        reduced ? ' (API antérieure à 1.2 : mode réduit)' : ''
      }.`,
    ),
  partial: both(
    'The menu was read in part only (too long or too large): add the devices shown, or choose "Main values".',
    "Le menu n'a été lu qu'en partie (trop long ou trop grand) : ajoutez les appareils affichés, ou choisissez « Valeurs principales ».",
  ),
  unreachable: (reason, wait) =>
    both(
      `Not connected: ${reason.en}. Next try in ${wait.en}.`,
      `Non connecté : ${reason.fr}. Nouvel essai dans ${wait.fr}.`,
    ),
  rateLimited: (wait) =>
    both(
      `The ETAtouch asked to slow down: next read in ${wait.en}.`,
      `L'ETAtouch a demandé de ralentir : prochaine lecture dans ${wait.fr}.`,
    ),
  busy: both(
    'A read of the ETAtouch is in progress, try again in a moment.',
    "Une lecture de l'ETAtouch est en cours, réessayez dans un instant.",
  ),
  wait: (wait) =>
    both(
      `To spare the ETAtouch, the next read is in ${wait.en}.`,
      `Pour ménager l'ETAtouch, la prochaine lecture a lieu dans ${wait.fr}.`,
    ),
  readOnly: both(
    'This integration is read only: nothing can be changed on the boiler from Gladys.',
    'Cette intégration est en lecture seule : rien ne peut être modifié sur la chaudière depuis Gladys.',
  ),
  notRead: both(
    'Not read in the last cycle of the ETAtouch.',
    "Non lu lors du dernier cycle de l'ETAtouch.",
  ),
};
