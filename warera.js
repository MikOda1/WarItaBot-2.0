// src/warera.js
// Wrapper minimale per l'API pubblica (non ufficiale) di WarEra.
// L'API è una API tRPC esposta su https://api2.warera.io/trpc
// Documentazione "live" (schema auto-generato): https://api2.warera.io/docs
//
// Formato di una chiamata GET tRPC:
//   GET https://api2.warera.io/trpc/<namespace>.<procedura>?input=<JSON con encodeURIComponent>
// Risposta:
//   { result: { data: ... } }         in caso di successo
//   { error:  { json: { message } } } in caso di errore

const BASE_URL = 'https://api2.warera.io/trpc';

// Alcuni endpoint (es. referral, ranking) richiedono un'API key generata in
// Warera -> Impostazioni -> API Tokens. Va messa nel file .env come WARERA_API_KEY.
const API_KEY = process.env.WARERA_API_KEY;

// --- Resilienza di rete -----------------------------------------------------
// WarEra sta dietro Cloudflare e gli hosting economici hanno spesso un DNS
// traballante: capita di vedere ETIMEDOUT/EAI_AGAIN anche quando il gioco è
// perfettamente online. Senza retry, un singolo blip di due secondi faceva
// fallire un intero report o un giro di Contract Hunter. Con il retry, la
// stragrande maggioranza di questi errori si risolve da sola.

// Quanto aspettare al massimo una singola richiesta prima di considerarla
// persa. Senza questo, una richiesta appesa può bloccare tutto il giro.
const REQUEST_TIMEOUT_MS = Number(process.env.WARERA_TIMEOUT_MS) || 15000;

// Quanti tentativi in tutto (1 = nessun retry). 3 = tentativo iniziale + 2
// ritentativi.
const MAX_ATTEMPTS = Number(process.env.WARERA_RETRIES) || 3;

// Errori di rete "transitori": ha senso riprovare. Sono guasti del
// trasporto, non risposte dell'applicazione.
const RETRIABLE_NETWORK_CODES = new Set([
  'UND_ERR_CONNECT_TIMEOUT', // connessione non stabilita in tempo
  'UND_ERR_HEADERS_TIMEOUT', // risposta non arrivata in tempo
  'UND_ERR_SOCKET', // socket chiuso a metà
  'ETIMEDOUT',
  'ECONNRESET',
  'ECONNREFUSED',
  'EAI_AGAIN', // DNS temporaneamente non risolvibile
  'ENOTFOUND', // su hosting con DNS lento a volte è transitorio
  'EPIPE',
]);

// Errore lanciato quando la rete non ha funzionato (a differenza di un
// errore applicativo di WarEra, che è una risposta valida ma negativa).
// Chi chiama può distinguerli con `err.isNetworkError` e decidere se fare
// rumore nei log o silenziosamente saltare il giro.
class WareraNetworkError extends Error {
  constructor(message, endpoint, cause) {
    super(message);
    this.name = 'WareraNetworkError';
    this.endpoint = endpoint;
    this.isNetworkError = true;
    this.cause = cause;
  }
}

// Errore applicativo: la chiamata è arrivata a destinazione, ma WarEra ha
// risposto con un errore (endpoint sbagliato, parametri sbagliati, 404...).
// Riprovare non serve a niente.
class WareraApiError extends Error {
  constructor(message, endpoint, status) {
    super(message);
    this.name = 'WareraApiError';
    this.endpoint = endpoint;
    this.status = status;
    this.isNetworkError = false;
  }
}

// Scava nella catena di `cause` alla ricerca di un codice riconoscibile:
// "fetch failed" in superficie non dice niente, il codice vero sta uno o due
// livelli sotto (ed eventualmente dentro un AggregateError.errors).
function networkErrorCode(err) {
  let cur = err;
  for (let depth = 0; cur && depth < 5; depth += 1) {
    if (cur.code && RETRIABLE_NETWORK_CODES.has(cur.code)) return cur.code;
    if (Array.isArray(cur.errors)) {
      for (const sub of cur.errors) {
        if (sub?.code && RETRIABLE_NETWORK_CODES.has(sub.code)) return sub.code;
      }
    }
    cur = cur.cause;
  }
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Backoff esponenziale con un po' di jitter casuale: ~1s, ~2s, ~4s. Il
// jitter evita che 25 chiamate partite insieme ritentino tutte nello stesso
// identico istante.
function backoffMs(attempt) {
  const base = 1000 * 2 ** (attempt - 1);
  return base + Math.floor(Math.random() * 400);
}

/**
 * fetch con timeout + retry a backoff esponenziale.
 * Riprova solo su errori transitori (rete, 429, 5xx); su un 4xx applicativo
 * si ferma subito, perché riprovare darebbe lo stesso risultato.
 */
async function fetchWithRetry(url, options, endpoint) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    try {
      const res = await fetch(url, {
        ...options,
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });

      // 429 = rate limit, 5xx = problema temporaneo lato server: entrambi
      // meritano un altro tentativo. Se l'API dice quanto aspettare con
      // Retry-After, rispettiamo quel valore invece del nostro backoff.
      if (res.status === 429 || res.status >= 500) {
        if (attempt < MAX_ATTEMPTS) {
          const retryAfter = Number(res.headers.get('retry-after'));
          const waitMs =
            Number.isFinite(retryAfter) && retryAfter > 0
              ? retryAfter * 1000
              : backoffMs(attempt);
          console.warn(
            `⏳ ${endpoint}: HTTP ${res.status}, ritento tra ${Math.round(waitMs / 1000)}s ` +
              `(tentativo ${attempt}/${MAX_ATTEMPTS})`,
          );
          await sleep(waitMs);
          continue;
        }
        throw new WareraApiError(
          `HTTP ${res.status} da ${endpoint} dopo ${MAX_ATTEMPTS} tentativi`,
          endpoint,
          res.status,
        );
      }

      return res;
    } catch (err) {
      // Un WareraApiError che arriva qui è già definitivo: non riprovare.
      if (err instanceof WareraApiError) throw err;

      // AbortSignal.timeout() lancia un TimeoutError: è a tutti gli effetti
      // un timeout di rete, quindi trattalo come tale.
      const isTimeout = err.name === 'TimeoutError' || err.name === 'AbortError';
      const code = isTimeout ? 'UND_ERR_CONNECT_TIMEOUT' : networkErrorCode(err);

      if (!code) throw err; // errore sconosciuto: non mascherarlo con un retry

      lastError = err;
      if (attempt < MAX_ATTEMPTS) {
        const waitMs = backoffMs(attempt);
        console.warn(
          `⏳ ${endpoint}: problema di rete (${code}), ritento tra ` +
            `${Math.round(waitMs / 1000)}s (tentativo ${attempt}/${MAX_ATTEMPTS})`,
        );
        await sleep(waitMs);
        continue;
      }

      throw new WareraNetworkError(
        `Rete non disponibile su ${endpoint} (${code}) dopo ${MAX_ATTEMPTS} tentativi`,
        endpoint,
        err,
      );
    }
  }

  throw new WareraNetworkError(`Chiamata fallita su ${endpoint}`, endpoint, lastError);
}

/**
 * Chiama una qualsiasi procedura tRPC di WarEra via GET (per query semplici).
 * @param {string} endpoint - es. "user.getUserLite", "country.getAllCountries"
 * @param {object} params - parametri della procedura (oggetto, può essere {})
 */
async function callEndpoint(endpoint, params = {}) {
  const input = encodeURIComponent(JSON.stringify(params));
  const url = `${BASE_URL}/${endpoint}?input=${input}`;

  const res = await fetchWithRetry(url, { headers: buildHeaders() }, endpoint);
  return parseResponse(res, endpoint);
}

/**
 * Come callEndpoint, ma via POST con il body JSON: alcuni endpoint (es.
 * company.getCompanies) lo richiedono invece della GET.
 * @param {string} endpoint
 * @param {object} body - corpo della richiesta (va mandato cosi' com'e', NON
 *   incapsulato in {input: ...} come per la GET)
 */
async function postEndpoint(endpoint, body = {}) {
  const url = `${BASE_URL}/${endpoint}`;
  const res = await fetchWithRetry(
    url,
    {
      method: 'POST',
      headers: { ...buildHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    },
    endpoint,
  );
  return parseResponse(res, endpoint);
}

function buildHeaders() {
  const headers = {
    // L'API controlla Origin/Referer/User-Agent su alcuni endpoint: ci
    // presentiamo come farebbe il client ufficiale del gioco.
    'Origin': 'https://app.warera.io',
    'Referer': 'https://app.warera.io/',
    'User-Agent':
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  if (API_KEY) headers['X-API-Key'] = API_KEY;
  return headers;
}

async function parseResponse(res, endpoint) {
  // Anche in caso di errore tRPC il body e' JSON valido, quindi proviamo
  // sempre a leggerlo. MA: quando Cloudflare si mette di mezzo (challenge,
  // 502, pagina di manutenzione) la risposta e' HTML, e un res.json() secco
  // esploderebbe con un "Unexpected token <" incomprensibile. Leggiamo il
  // testo e lo parsiamo noi, per poter dare un errore che dice davvero cosa
  // e' successo.
  const text = await res.text();

  let data;
  try {
    data = JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, ' ');
    throw new WareraApiError(
      `Risposta non-JSON da ${endpoint} (HTTP ${res.status}). ` +
        `Probabile pagina Cloudflare o manutenzione. Inizio risposta: ${preview}`,
      endpoint,
      res.status,
    );
  }

  if (data.error) {
    const msg = data.error?.message || data.error?.json?.message || 'Errore sconosciuto';
    throw new WareraApiError(`WarEra API error su ${endpoint}: ${msg}`, endpoint, res.status);
  }

  if (!res.ok) {
    throw new WareraApiError(`HTTP ${res.status} da ${endpoint}`, endpoint, res.status);
  }

  // Alcune risposte valide non hanno `result.data`: meglio undefined che un
  // crash su proprietà di null.
  return data?.result?.data;
}

// --- Alcune procedure verificate, come scorciatoia -------------------------

const warera = {
  raw: callEndpoint, // "escape hatch" GET: chiama qualsiasi endpoint tu scopra sui docs
  rawPost: postEndpoint, // "escape hatch" POST, per gli endpoint che la richiedono

  getAllCountries: () => callEndpoint('country.getAllCountries', {}),
  getCountryById: (countryId) => callEndpoint('country.getCountryById', { countryId }),
  getGovernmentByCountryId: (countryId) =>
    callEndpoint('government.getByCountryId', { countryId }),
  getPartyById: (partyId) => callEndpoint('party.getById', { partyId }),

  getUserLite: (userId) => callEndpoint('user.getUserLite', { userId }),

  getMuById: (muId) => callEndpoint('mu.getById', { muId }),

  // Info di una battaglia (attaccante/difensore, punteggi, ecc). Usato per
  // arricchire gli alert dei contratti mercenari con "chi contro chi".
  // Nome del parametro dedotto dalla stessa convenzione delle altre
  // getXById di questo file (getMuById -> muId, getCompanyById -> companyId...).
  getBattleById: (battleId) => callEndpoint('battle.getById', { battleId }),

  getRegionById: (regionId) => callEndpoint('region.getById', { regionId }),

  getLatestArticles: (limit = 5) =>
    callEndpoint('article.getArticlesPaginated', { limit }),

  // Aziende di un giocatore: endpoint POST, con paginazione (perPage/cursor).
  // Restituisce solo gli ID; per i dettagli serve una seconda chiamata GET.
  getCompaniesByUserId: (userId, perPage = 50, cursor) =>
    postEndpoint('company.getCompanies', { userId, perPage, ...(cursor ? { cursor } : {}) }),

  getCompanyById: (companyId) => callEndpoint('company.getById', { companyId }),

  // Contratti mercenari attivi (asta): endpoint POST con paginazione.
  getMercenaryContracts: (perPage = 50) =>
    postEndpoint('mercenaryContractAuction.getPaginatedAuctions', { perPage }),

  // Donazioni fatte a una MU (cursor-paginated). Ogni elemento: { userId,
  // muId, amount, createdAt, ... }. Endpoint confermato dalla documentazione
  // community dell'API (donation.getManyPaginated). Proviamo prima GET (come
  // la maggior parte delle query tRPC "get..."); se fallisce, ripieghiamo su
  // POST, dato che alcuni endpoint di WarEra lo richiedono.
  // NOTA: il fallback su POST ha senso solo per errori APPLICATIVI (metodo
  // sbagliato). Se il problema è di rete, ritentare in POST è inutile e
  // raddoppia solo l'attesa, quindi l'errore viene rilanciato subito.
  getDonationsByMu: async (muId, limit = 100, cursor) => {
    const params = { muId, limit, ...(cursor ? { cursor } : {}) };
    try {
      return await callEndpoint('donation.getManyPaginated', params);
    } catch (err) {
      if (err.isNetworkError) throw err;
      return await postEndpoint('donation.getManyPaginated', params);
    }
  },
};

module.exports = warera;
module.exports.WareraNetworkError = WareraNetworkError;
module.exports.WareraApiError = WareraApiError;