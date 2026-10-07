# Comandi WarITA Bot

| Comando | Cosa fa |
|---|---|
| `/warera-countries` | Elenca tutte le nazioni |
| `/warera-country nome` | Scheda nazione: popolazione, governo, etiche, tassazione |
| `/warera-user cerca` | Scheda giocatore: livello, abilità, aziende, danni, ricchezza |
| `/warera-mu cerca` | Scheda MU: membri, reputazione, danni, QG/dormitori |
| `/warera-mu-report id` | Report completo MU con tabella di tutti i membri |
| `/warera-region cerca` | Scheda regione: nazione, bunker, base militare |
| `/warera-news` | Ultimi articoli pubblicati su WarEra |
| `/warera-raw endpoint` | [Debug] Chiama un endpoint grezzo dell'API |
| `/report` | Invia e salva il report della MU configurata |
| `/confronta data1 data2` | Confronta due report salvati (MU + membri) |
| `/forza-report data` | [Test] Salva un report per una data specifica |
| `/contratto soglia` | Mostra i contratti mercenari attivi, ordinati per prezzo/k |

## Automatismi (non comandi, girano da soli)

| Cosa | Quando |
|---|---|
| Report giornaliero MU | Ogni giorno alle 9:00 (Europe/Rome) |
| Contract Hunter (tutte le aste attive, un unico messaggio che si auto-aggiorna) | Ogni 2 minuti |
| Alert contratto vinto dalla propria MU (tagga un ruolo) | Ogni 2 minuti |
