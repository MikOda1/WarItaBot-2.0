# WarEra Discord Bot — v1.0

Bot Discord in Node.js (discord.js v14) per le community di **WarEra**.
Interroga l'API pubblica del gioco e offre comandi di
consultazione (nazioni, giocatori, MU, regioni, news) più una serie di
automatismi pensati per una MU: report giornaliero, classifica settimanale,
caccia ai contratti mercenari e alert quando la tua MU ne vince uno.

L'elenco completo e dettagliato di comandi e automatismi sta in
**[comandi-bot.md](./comandi-bot.md)**.

---

## Requisiti

- **Node.js 18 o superiore** (serve la `fetch` integrata; su versioni
  precedenti il bot non funziona)
- Un'applicazione bot su Discord
- Un hosting che tenga il processo sempre acceso, se vuoi gli automatismi
  (Wispbyte, una VPS, un Raspberry a casa… va bene qualsiasi cosa resti
  online). Gli automatismi girano solo mentre il bot è acceso: se è spento
  alle 9:00, quel report non viene recuperato.

---

## 1. Crea il bot su Discord

1. Vai su https://discord.com/developers/applications e clicca
   **New Application**.
2. Menu a sinistra → **Bot** → **Reset Token** → copia il token
   (andrà in `DISCORD_TOKEN`). Non condividerlo mai: equivale alla password
   del bot.
3. In **General Information** copia l'**Application ID** (va in `CLIENT_ID`).
4. Vai su **OAuth2 → URL Generator**, seleziona gli scope `bot` e
   `applications.commands`. Come permessi servono almeno:
   - **Send Messages**
   - **Embed Links**
   - **Read Message History** (il Contract Hunter deve poter rileggere e
     modificare il proprio messaggio)
   - **Mention Everyone** — solo se usi gli alert contratto con menzione di
     un ruolo, e solo se quel ruolo non è già menzionabile da tutti
5. Copia l'URL generato, aprilo nel browser e invita il bot sul server.
6. Attiva la **Modalità sviluppatore** in Discord
   (Impostazioni utente → Avanzate): ti servirà per copiare gli ID di
   server, canali e ruoli con il tasto destro.

---

## 2. Installa e configura

```bash
npm install
cp .env.example .env
# apri .env e compila i valori
```

Tutte le variabili sono documentate una per una dentro
**[.env.example](./.env.example)**. In sintesi:

| Variabile | Obbligatoria | A cosa serve |
|---|---|---|
| `DISCORD_TOKEN` | ✅ | Token del bot |
| `CLIENT_ID` | ✅ | Application ID, per registrare gli slash command |
| `GUILD_ID` | consigliata | Server su cui registrare i comandi: appaiono subito invece che dopo un'ora |
| `MU_ID` | consigliata | La MU seguita dal bot (dall'URL `app.warera.io/mu/<id>`) |
| `REPORT_CHANNEL_ID` | opzionale | Canale del report giornaliero delle 9:00 |
| `LEADERBOARD_CHANNEL_ID` | opzionale | Canale della classifica del lunedì alle 8:00 |
| `CONTRACT_CHANNEL_ID` | opzionale | Canale del Contract Hunter |
| `CONTRACT_MIN_PERK` | opzionale | Soglia prezzo/k per evidenziare le aste con 🔥 |
| `MU_CONTRACT_CHANNEL_ID` | opzionale | Canale degli alert "contratto vinto" |
| `MU_CONTRACT_ROLE_ID` | opzionale | Ruolo da menzionare in quegli alert |
| `WARERA_API_KEY` | opzionale | API key WarEra, per rate limit più alti |
| `WARERA_TIMEOUT_MS` | opzionale | Timeout per chiamata a WarEra, default 15000 |
| `WARERA_RETRIES` | opzionale | Tentativi totali per chiamata, default 3 |

**Logica di attivazione:** ogni automatismo parte solo se le sue variabili
sono compilate. Se lasci vuoto un canale, quella funzione semplicemente non
si attiva e il bot lo segnala nei log all'avvio (`⚠️ ... NON programmato`).
Non è un errore: è il modo per accendere solo quello che ti serve.

---

## 3. Avvia

```bash
npm start
```

Al primo avvio il bot registra gli slash command, poi resta in ascolto.
Nei log vedrai una riga per ogni automatismo attivato o saltato: è il primo
posto da guardare se qualcosa non parte.

---

## 4. Fuso orario

Il bot forza l'intero processo su **Europe/Rome** alla prima riga di
`index.js`, prima di qualsiasi altra cosa. Serve perché molti hosting
girano in UTC: senza questa forzatura il report delle 9:00 arriverebbe
alle 11:00. Il cambio ora legale/solare è gestito in automatico.

Se ti serve un altro fuso, cambia quella riga **e** il campo `timezone`
nelle chiamate `cron.schedule` dentro il blocco `client.once('ready')`.

---

## 5. Come funziona il collegamento a WarEra

L'API di WarEra non è un REST tradizionale ma un'API **tRPC**, esposta su
`https://api2.warera.io/trpc`. Ogni chiamata è una GET del tipo:

```
GET https://api2.warera.io/trpc/<namespace>.<procedura>?input=<JSON URL-encoded>
```

es.

```
GET https://api2.warera.io/trpc/country.getAllCountries?input=%7B%7D
```

La risposta è `{ "result": { "data": ... } }` in caso di successo, oppure
`{ "error": { ... } }` in caso di errore. Alcuni endpoint (es.
`company.getCompanies`, le aste mercenarie) richiedono invece una **POST**
con il body JSON.

Tutto questo è incapsulato in `warera.js`, che espone tra le altre:

- `warera.getAllCountries()` / `getCountryById(countryId)`
- `warera.getUserLite(userId)`
- `warera.getMuById(muId)`
- `warera.getMercenaryContracts(perPage)`
- `warera.getDonationsByMu(muId, limit, cursor)`
- `warera.getLatestArticles(limit)`
- `warera.raw(endpoint, params)` — chiamata GET generica a **qualsiasi**
  endpoint
- `warera.rawPost(endpoint, body)` — la stessa cosa via POST

### Dove trovare altri endpoint

- Documentazione interattiva (schema auto-generato dal server):
  https://api2.warera.io/docs
- Repository community con endpoint mappati:
  - https://github.com/majimawrks/warera-fetch
  - https://github.com/WarEraProjects/api-client-py
  - https://github.com/gsipos/warera-tools

  ⚠️ Sono progetti di terze parti non ufficiali: verifica sempre il nome
  esatto degli endpoint e i parametri sui docs live prima di affidarti al
  codice di un bot in produzione.

### Rate limit e problemi di rete

L'API applica un rate limit. Il bot mette già una pausa di 250 ms tra un
membro e l'altro quando interroga una MU intera. Se vedi errori HTTP 429
persistenti (non isolati), alza quelle pause: sono i `setTimeout` dentro
`getMemberStats`, `buildMuReportEmbed` e `computeLeaderboards`.

Per i problemi di rete isolati (DNS lento, timeout, 429 o 5xx occasionali)
non devi fare niente: il bot riprova da solo, fino a 3 volte con attesa
crescente (regolabile con `WARERA_TIMEOUT_MS` e `WARERA_RETRIES`, vedi
sopra). Se questi errori compaiono a raffica e persistono, il problema è
quasi sempre la rete dell'hosting (specie su hosting economici, dove capita
un DNS traballante) o WarEra/Cloudflare stesso irraggiungibile in quel
momento — non il codice del bot. Dettagli sul comportamento in caso di
guasto in [comandi-bot.md](./comandi-bot.md#4-comportamento-in-caso-di-problemi-di-rete).

---

## 6. File generati dal bot

Creati automaticamente nella cartella di lavoro:

- `reports.json` — storico degli snapshot giornalieri della MU
- `contract-hunter-state.json` — stato del messaggio auto-aggiornante
- `mu-contracts-notified.json` — contratti già segnalati

Aggiungili a `.gitignore` insieme a `.env`, ma **non cancellarli**:
`reports.json` è lo storico su cui si basano "record danni settimanali" e
"aumento ricchezza" nella classifica. Se lo perdi, quelle voci ripartono da
zero. Se sposti il bot su un altro hosting, portatelo dietro.

---

## 7. Aggiungere nuovi comandi

1. Aggiungi una entry a `commands` in `index.js` (con
   `SlashCommandBuilder`).
2. Aggiungi la logica nel gestore `interactionCreate`.
3. Se serve un endpoint non ancora presente in `warera.js`, provalo al
   volo con `/warera-raw`, poi aggiungi una funzione dedicata nel wrapper.

---

## Problemi comuni

**I comandi non appaiono.** Se `GUILD_ID` è vuoto sono globali e Discord può
metterci un'ora. Compila `GUILD_ID` e riavvia.

**"Mancano DISCORD_TOKEN o CLIENT_ID".** Il file `.env` non esiste, è nella
cartella sbagliata (deve stare nella radice del progetto), o le righe sono
vuote.

**Un automatismo non parte.** Guarda i log all'avvio: c'è una riga `⚠️` che
dice esattamente quale variabile manca.

**Il bot non trova un canale.** L'ID è sbagliato oppure il bot non è stato
invitato su quel server / non vede quel canale. Controlla i permessi del
canale, non solo quelli globali del bot.

**Gli orari sono sfasati.** Vedi la sezione 4.

**Vedo `EAI_AGAIN` o `ConnectTimeoutError` nei log.** Il bot ci riprova da
solo (vedi "Rate limit e problemi di rete" sopra); se compaiono isolati non
è un problema. Se sono continui, quasi sempre è la rete dell'hosting o
WarEra/Cloudflare momentaneamente giù, non il bot.

---

## Nota legale

L'API di WarEra usata qui non ha una documentazione ufficiale "stabile e
garantita": è un'API interna del gioco risultata pubblicamente accessibile, e
diversi progetti community la usano in sola lettura. Questo bot fa
**esclusivamente operazioni di lettura**.

Rispetta i rate limit, non tentare azioni di scrittura (acquisti, azioni di
gioco) senza aver verificato i termini di servizio di WarEra, e non
pubblicare mai la tua API key o il token del bot Discord. Se il token
finisce per sbaglio su GitHub, rigeneralo immediatamente dal portale
sviluppatori.