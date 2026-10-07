// src/index.js

// Forza il fuso orario dell'intero processo su Roma (gestisce da solo il
// passaggio CET/CEST). DEVE stare qui, prima di qualunque `new Date(...)` o
// `require`, altrimenti alcuni moduli potrebbero già aver "letto" il fuso
// orario di default (UTC su molti host, Wispbyte incluso) e restare
// indietro/avanti di qualche ora rispetto all'ora italiana.
process.env.TZ = 'Europe/Rome';

require('dotenv').config();
const {
  Client,
  GatewayIntentBits,
  SlashCommandBuilder,
  EmbedBuilder,
  REST,
  Routes,
} = require('discord.js');
const cron = require('node-cron');
const fs = require('fs');
const warera = require('./warera');

const { DISCORD_TOKEN, CLIENT_ID, GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !CLIENT_ID) {
  console.error('Mancano DISCORD_TOKEN o CLIENT_ID nel file .env');
  process.exit(1);
}

// --- Helper: formattazione dati WarEra -------------------------------------

const ETHIC_AXES = [
  { key: 'militarism', pos: 'Espansionista', neg: 'Pacifista' },
  { key: 'isolationism', pos: 'Isolazionista', neg: 'Diplomatico' },
  { key: 'imperialism', pos: 'Imperialista', neg: 'Repubblicano' },
  { key: 'industrialism', pos: 'Industrialista', neg: 'Agrario' },
];

function formatEthics(ethics) {
  if (!ethics) return 'n/d';
  const parts = [];
  for (const axis of ETHIC_AXES) {
    const v = ethics[axis.key];
    if (!v) continue;
    const label = v > 0 ? axis.pos : axis.neg;
    const level = Math.abs(v) >= 2 ? 'Fanatico' : 'Normale';
    parts.push(`${label} (${level})`);
  }
  if (ethics.unethical) parts.push('Senza scrupoli');
  return parts.length ? parts.join('\n') : 'Nessuna etica attiva';
}

const COMBAT_SKILLS = [
  { key: 'attack', label: 'Attacco' },
  { key: 'precision', label: 'Precisione', percent: true },
  { key: 'criticalChance', label: 'Prob. critico', percent: true },
  { key: 'criticalDamages', label: 'Danni critici', percent: true },
  { key: 'armor', label: 'Armatura' },
  { key: 'dodge', label: 'Schiva' },
  { key: 'health', label: 'Salute' },
  { key: 'lootChance', label: 'Prob. bottino', percent: true },
  { key: 'hunger', label: 'Sazietà' },
];

const ECONOMIC_SKILLS = [
  { key: 'entrepreneurship', label: 'Imprenditoria' },
  { key: 'energy', label: 'Energia' },
  { key: 'production', label: 'Produzione' },
  { key: 'companies', label: 'Aziende' },
  { key: 'management', label: 'Gestione' },
];

function formatSkillGroup(skills, group) {
  if (!skills) return 'n/d';
  return group
    .filter((s) => skills[s.key])
    .map((s) => {
      const skill = skills[s.key];
      const val = skill.value ?? '?';
      const suffix = s.percent ? '%' : '';
      return `**${s.label}:** Lv ${skill.level ?? '?'} · ${val}${suffix}`;
    })
    .join('\n');
}

const ITEM_NAMES_IT = {
  steel: 'Acciaio',
  iron: 'Ferro',
  oil: 'Petrolio',
  lithium: 'Litio',
  aluminum: 'Alluminio',
  wood: 'Legno',
  stone: 'Pietra',
  food: 'Cibo',
  wheat: 'Grano',
  fish: 'Pesce',
  water: 'Acqua',
  coal: 'Carbone',
  weapons: 'Armi',
  ammo: 'Munizioni',
  fuel: 'Carburante',
};

function itemNameIt(code) {
  if (!code) return 'n/d';
  return ITEM_NAMES_IT[code] ?? code.charAt(0).toUpperCase() + code.slice(1);
}

// --- Gestione errori degli automatismi -------------------------------------

// Logga un errore in modo proporzionato alla sua gravità. Un buco di rete
// (DNS che non risolve, Cloudflare irraggiungibile) non è un bug del bot e
// non serve che sputi 20 righe di stack trace ogni 2 minuti: basta una riga.
// Gli errori veri invece vanno stampati per intero, stack compreso.
function logTaskError(taskName, err) {
  if (err?.isNetworkError) {
    console.warn(`🌐 ${taskName}: WarEra irraggiungibile (${err.message}). Riprovo al prossimo giro.`);
    return;
  }
  if (err?.name === 'WareraApiError') {
    console.error(`⚠️ ${taskName}: ${err.message}`);
    return;
  }
  console.error(`❌ Errore in ${taskName}:`, err);
}

// Impedisce che due esecuzioni dello stesso job si accavallino. Serve perché
// con i retry un giro può durare più dei 2 minuti che separano un tick di
// cron dal successivo: senza lock partirebbe un secondo giro sopra il primo,
// raddoppiando le chiamate all'API proprio mentre è in difficoltà (ed è
// probabilmente la causa degli errori identici ripetuti nello stesso secondo).
const runningTasks = new Set();

function withLock(taskName, fn) {
  return async (...args) => {
    if (runningTasks.has(taskName)) {
      console.warn(`⏭️ ${taskName}: giro precedente ancora in corso, salto questo tick.`);
      return undefined;
    }
    runningTasks.add(taskName);
    try {
      return await fn(...args);
    } finally {
      runningTasks.delete(taskName);
    }
  };
}

function numberFmt(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 'n/d';
  const abs = Math.abs(n);
  if (abs >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (abs >= 1_000) return `${(n / 1_000).toFixed(2)}K`;
  return Number.isInteger(n) ? String(n) : n.toFixed(2);
}

// Formatta un numero con segno esplicito (+/-), utile per mostrare variazioni.
function signedFmt(n) {
  if (typeof n !== 'number' || Number.isNaN(n)) return 'n/d';
  const f = numberFmt(n);
  return n > 0 ? `+${f}` : f;
}

// Tabella delle variazioni (Δ danni settimanali/totali/ricchezza) per i
// membri presenti in entrambi i report messi a confronto.
function buildMemberDeltaFields(members1, members2) {
  const map1 = new Map(members1.map((m) => [m.username, m]));
  const map2 = new Map(members2.map((m) => [m.username, m]));
  const common = [...map2.keys()]
    .filter((u) => map1.has(u))
    .sort((a, b) => a.localeCompare(b, 'it', { sensitivity: 'base' }));

  if (common.length === 0) {
    return [{ name: '📈 Variazione membri', value: 'Nessun membro presente in entrambi i report.' }];
  }

  const NAME_W = 8;
  const VAL_W = 7; // i valori con segno (es. "+123.4K") potrebbero troncare l'ultimo carattere in rari casi
  const col = (s, len) => String(s).slice(0, len).padEnd(len, ' ');
  const colR = (s, len) => String(s).slice(0, len).padStart(len, ' ');
  const row = (name, v1, v2, v3) =>
    `${col(name, NAME_W)} ${colR(v1, VAL_W)} ${colR(v2, VAL_W)} ${colR(v3, VAL_W)}`;

  const headerRow = row('Nome', 'ΔSett.', 'ΔTot.', 'ΔRicch.');
  const separator = '-'.repeat(headerRow.length);
  const MAX_FIELD_VALUE = 1024;
  const wrap = (lines) => '```\n' + lines.join('\n') + '\n```';

  const fields = [];
  let current = [headerRow, separator];

  for (const u of common) {
    const a = map1.get(u);
    const b = map2.get(u);
    const dWeekly = (b.weeklyDamage ?? 0) - (a.weeklyDamage ?? 0);
    const dTotal = (b.totalDamage ?? 0) - (a.totalDamage ?? 0);
    const dWealth = (b.wealth ?? 0) - (a.wealth ?? 0);
    const line = row(u, signedFmt(dWeekly), signedFmt(dTotal), signedFmt(dWealth));
    const candidate = current.concat([line]);
    if (wrap(candidate).length <= MAX_FIELD_VALUE) {
      current = candidate;
    } else {
      fields.push({
        name: fields.length === 0 ? '📈 Variazione membri (comuni ai due report)' : '\u200b',
        value: wrap(current),
      });
      current = [headerRow, separator, line];
    }
  }
  if (current.length > 2) {
    fields.push({
      name: fields.length === 0 ? '📈 Variazione membri (comuni ai due report)' : '\u200b',
      value: wrap(current),
    });
  }
  return fields;
}

async function resolveUsername(userId) {
  if (!userId) return 'n/d';
  try {
    const user = await warera.getUserLite(userId);
    return user?.username ?? userId;
  } catch {
    return userId;
  }
}

// Raccoglie tutte le statistiche di un membro usate nei report e nelle
// classifiche. weeklyDamage/totalDamage/wealth/totalBounty sono campi
// confermati (rankings.userBounty è lo stesso campo usato dall'endpoint
// ranking.getRanking del gioco per il "Total Bounty" globale). Le donazioni
// alla MU NON passano da qui: non esiste un campo "donazioni" dentro
// rankings, vanno prese dall'endpoint dedicato donation.getManyPaginated
// (vedi fetchMuDonations più sotto).
async function getMemberStats(userId) {
  try {
    // parseResponse può restituire undefined su risposte valide ma vuote:
    // il `?? {}` evita che una di queste faccia crashare l'intero report.
    const u = (await warera.getUserLite(userId)) ?? {};
    const r = u.rankings ?? {};
    return {
      userId,
      username: u.username ?? userId,
      weeklyDamage: r.weeklyUserDamages?.value ?? null,
      totalDamage: r.userDamages?.value ?? null,
      wealth: r.userWealth?.value ?? null,
      totalBounty: r.userBounty?.value ?? null,
      failed: false,
    };
  } catch (err) {
    // Log compatto: durante un buco di rete questa riga uscirebbe una volta
    // per ogni membro della MU, e 25 stack trace non aiutano nessuno.
    console.warn(`⚠️ Statistiche non recuperate per ${userId}: ${err.message}`);
    return {
      failed: true,
      userId,
      username: userId,
      weeklyDamage: null,
      totalDamage: null,
      wealth: null,
      totalBounty: null,
    };
  }
}

// Converte un codice paese a 2 lettere (es. "it") in emoji bandiera 🇮🇹
// usando i simboli indicatori regionali Unicode.
function flagEmoji(code) {
  if (!code || code.length !== 2) return '';
  const upper = code.toUpperCase();
  const base = 0x1f1e6; // 🇦
  return String.fromCodePoint(...[...upper].map((c) => base + c.charCodeAt(0) - 65));
}

async function resolveCountryName(countryId) {
  if (!countryId) return 'n/d';
  try {
    const country = await warera.getCountryById(countryId);
    if (!country?.name) return countryId;
    const flag = flagEmoji(country.code);
    return flag ? `${flag} ${country.name}` : country.name;
  } catch {
    return countryId;
  }
}

// --- Funzioni di ricerca (usano search.searchAnything: restituisce solo ID,
// gia' ordinati per pertinenza da WarEra, non oggetti con username) --------

async function findUserIdByName(searchTerm) {
  try {
    const results = await warera.raw('search.searchAnything', { searchText: searchTerm });
    const ids = results.userIds || [];
    if (ids.length === 0) {
      console.log(`⚠️ Nessun utente trovato per "${searchTerm}".`);
      return null;
    }
    console.log(`✅ Trovato utente per "${searchTerm}": ${ids[0]}`);
    return ids[0];
  } catch (err) {
    console.error('❌ Errore nella ricerca utente:', err);
    return null;
  }
}

async function findMuIdByName(searchTerm) {
  try {
    const results = await warera.raw('search.searchAnything', { searchText: searchTerm });
    const ids = results.muIds || [];
    if (ids.length === 0) {
      console.log(`⚠️ Nessuna MU trovata per "${searchTerm}".`);
      return null;
    }
    console.log(`✅ Trovata MU per "${searchTerm}": ${ids[0]}`);
    return ids[0];
  } catch (err) {
    console.error('❌ Errore nella ricerca MU:', err);
    return null;
  }
}

async function findRegionIdByName(searchTerm) {
  try {
    const results = await warera.raw('search.searchAnything', { searchText: searchTerm });
    const ids = results.regionIds || [];
    if (ids.length === 0) {
      console.log(`⚠️ Nessuna regione trovata per "${searchTerm}".`);
      return null;
    }
    console.log(`✅ Trovata regione per "${searchTerm}": ${ids[0]}`);
    return ids[0];
  } catch (err) {
    console.error('❌ Errore nella ricerca regione:', err);
    return null;
  }
}

// --- Funzione per costruire l'embed del report MU (riutilizzabile) ---------

async function buildMuReportEmbed(muId, isAutomatic = false) {
  let mu;
  try {
    mu = await warera.getMuById(muId);
  } catch (err) {
    throw new Error(`Impossibile recuperare la MU con ID ${muId}. Verifica che l'ID sia corretto.`);
  }

  const nazioneMu = await resolveCountryName(mu.country);
  const memberIds = mu.members ?? [];
  const members = [];
  let errorCount = 0;

  for (const memberId of memberIds) {
    const stats = await getMemberStats(memberId);
    members.push(stats);
    if (stats.weeklyDamage === null && stats.totalDamage === null && stats.wealth === null) {
      errorCount++;
    }
    await new Promise((r) => setTimeout(r, 250));
  }

  const errorMessage = errorCount > 0 ? `\n⚠️ ${errorCount} membro/i non recuperato/i correttamente.` : '';

  // Ordine alfabetico: resta stabile nel tempo, utile per confrontare lo
  // stesso giocatore report dopo report (a differenza dell'ordine per danni).
  members.sort((a, b) => a.username.localeCompare(b.username, 'it', { sensitivity: 'base' }));

  // --- Tabella allineata a colonne, senza bordi laterali ---------------
  // Colonne strette apposta: la larghezza dell'embed su Discord varia in
  // base alla finestra/zoom di chi legge, quindi solo una riga corta e'
  // garantita a non andare mai a capo, indipendentemente dal client.
  const NAME_W = 8;
  const VAL_W = 7;
  const col = (s, len) => String(s).slice(0, len).padEnd(len, ' ');
  const colR = (s, len) => String(s).slice(0, len).padStart(len, ' ');
  const row = (name, v1, v2, v3) =>
    `${col(name, NAME_W)} ${colR(v1, VAL_W)} ${colR(v2, VAL_W)} ${colR(v3, VAL_W)}`;

  const headerRow = row('Nome', 'Sett.', 'Tot.', 'Ricch.');
  const separator = '-'.repeat(headerRow.length);

  const MAX_FIELD_VALUE = 1024;
  const wrap = (lines) => '```\n' + lines.join('\n') + '\n```';

  const memberFields = [];
  let currentLines = [headerRow, separator];

  for (const m of members) {
    const line = row(m.username, numberFmt(m.weeklyDamage), numberFmt(m.totalDamage), numberFmt(m.wealth));
    const candidate = currentLines.concat([line]);
    if (wrap(candidate).length <= MAX_FIELD_VALUE) {
      currentLines = candidate;
    } else {
      memberFields.push({
        name: memberFields.length === 0 ? '📋 Membri (ordine alfabetico)' : '\u200b',
        value: wrap(currentLines),
      });
      currentLines = [headerRow, separator, line];
    }
  }
  if (currentLines.length > 2) {
    memberFields.push({
      name: memberFields.length === 0 ? '📋 Membri (ordine alfabetico)' : '\u200b',
      value: wrap(currentLines),
    });
  }
  if (memberFields.length === 0) {
    memberFields.push({ name: '📋 Membri', value: 'Nessun membro trovato in questa MU.' });
  }

  const hq = mu.activeUpgradeLevels?.headquarters ?? 0;
  const dorm = mu.activeUpgradeLevels?.dormitories ?? 0;
  const r = mu.rankings ?? {};

  const embed = new EmbedBuilder()
    .setTitle(`🛡️ ${mu.name}`)
    .setColor(0xd69e2e)
    .setThumbnail(mu.avatarUrl ?? null)
    .addFields(
      { name: '👥 Membri', value: numberFmt(memberIds.length), inline: true },
      { name: '🌍 Nazionalità', value: nazioneMu, inline: true },
      { name: '🤝 Reputazione mercenaria', value: mu.mercenaryReputation != null ? mu.mercenaryReputation.toFixed(2) : 'n/d', inline: true },
      { name: '💥 Danni settimanali MU', value: numberFmt(r.muWeeklyDamages?.value), inline: true },
      { name: '💥 Danni totali MU', value: numberFmt(r.muDamages?.value), inline: true },
      { name: '\u200b', value: '\u200b', inline: true },
      { name: '🏢 Quartier generale', value: `Livello ${hq} — ${hq > 0 ? 'Attivo ✅' : 'Non attivo ❌'}`, inline: true },
      { name: '🛌 Dormitori', value: `Livello ${dorm} — ${dorm > 0 ? 'Attivi ✅' : 'Non attivi ❌'}`, inline: true },
      ...memberFields,
    )
    .setFooter({ text: `${isAutomatic ? 'Report automatico' : 'Generato'} il ${new Date().toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}${errorMessage}` });

  return { embed, members, mu };
}

// --- Funzione helper per convertire date GG-MM-AAAA <-> YYYY-MM-DD ---
function parseItalianDate(dateStr) {
  const parts = dateStr.split('-');
  if (parts.length !== 3) return null;
  const day = parseInt(parts[0], 10);
  const month = parseInt(parts[1], 10);
  const year = parseInt(parts[2], 10);
  if (isNaN(day) || isNaN(month) || isNaN(year)) return null;
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
}

function formatItalianDate(isoDate) {
  const parts = isoDate.split('-');
  if (parts.length !== 3) return isoDate;
  return `${parts[2]}/${parts[1]}/${parts[0]}`;
}

// --- 1. Definizione degli slash command -------------------------------------

const commands = [
  new SlashCommandBuilder()
    .setName('warera-countries')
    .setDescription('Elenca tutte le nazioni di WarEra'),

  new SlashCommandBuilder()
    .setName('warera-country')
    .setDescription('Scheda riassuntiva di una nazione')
    .addStringOption((opt) =>
      opt.setName('nome').setDescription('Nome della nazione (es. Italy)').setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('warera-user')
    .setDescription('Scheda profilo di un giocatore (cerca per ID o nome)')
    .addStringOption((opt) =>
      opt.setName('cerca')
        .setDescription('ID utente OPPURE nome del giocatore')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('warera-mu')
    .setDescription('Scheda riassuntiva di una MU (cerca per ID o nome)')
    .addStringOption((opt) =>
      opt.setName('cerca')
        .setDescription('ID MU OPPURE nome della MU')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('warera-mu-report')
    .setDescription('Mostra il report completo della MU con le statistiche di tutti i membri')
    .addStringOption((opt) =>
      opt.setName('id').setDescription('ID della MU (dalla URL della MU)').setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('warera-region')
    .setDescription('Scheda riassuntiva di una regione (cerca per ID o nome)')
    .addStringOption((opt) =>
      opt.setName('cerca')
        .setDescription('ID regione OPPURE nome della regione')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('warera-news')
    .setDescription('Mostra gli ultimi articoli pubblicati su WarEra'),

  new SlashCommandBuilder()
    .setName('warera-raw')
    .setDescription('[Debug] Chiama un endpoint WarEra grezzo e mostra il JSON')
    .addStringOption((opt) =>
      opt
        .setName('endpoint')
        .setDescription('es. user.getUserLite, mu.getById, region.getById')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt
        .setName('parametri')
        .setDescription('JSON dei parametri, es. {"userId":"123"} (default {})')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('campo')
        .setDescription('Path del campo da isolare, es. "rankings". Vuoto = elenco chiavi.')
        .setRequired(false),
    )
    .addStringOption((opt) =>
      opt
        .setName('metodo')
        .setDescription('GET (default) o POST — alcuni endpoint come company.getCompanies richiedono POST')
        .setRequired(false)
        .addChoices({ name: 'GET', value: 'GET' }, { name: 'POST', value: 'POST' }),
    ),

  new SlashCommandBuilder()
    .setName('report')
    .setDescription('Invia manualmente il report della MU configurata (MOSTRA TUTTI I MEMBRI)'),

  new SlashCommandBuilder()
    .setName('confronta')
    .setDescription('Confronta due report salvati di giorni diversi')
    .addStringOption((opt) =>
      opt.setName('data1')
        .setDescription('Prima data (formato GG-MM-AAAA, es. 07-09-2026)')
        .setRequired(true),
    )
    .addStringOption((opt) =>
      opt.setName('data2')
        .setDescription('Seconda data (formato GG-MM-AAAA, es. 08-09-2026)')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('forza-report')
    .setDescription('[TEST] Salva manualmente un report per una data specifica')
    .addStringOption((opt) =>
      opt.setName('data')
        .setDescription('Data nel formato GG-MM-AAAA (es. 06-09-2026)')
        .setRequired(true),
    ),

  new SlashCommandBuilder()
    .setName('contratto')
    .setDescription('Mostra i contratti mercenari attivi, ordinati per prezzo/k decrescente')
    .addNumberOption((opt) =>
      opt.setName('soglia')
        .setDescription('Prezzo minimo per K di danni (es. 0.1). Vuoto = mostra tutti')
        .setRequired(false),
    ),

  new SlashCommandBuilder()
    .setName('classifica')
    .setDescription('Aggiorna subito la classifica della MU (invece di aspettare il lunedì alle 8:00)'),

].map((c) => c.toJSON());

// --- 2. Registrazione dei comandi su Discord --------------------------------

async function registerCommands() {
  const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN);
  const route = GUILD_ID
    ? Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID)
    : Routes.applicationCommands(CLIENT_ID);

  await rest.put(route, { body: commands });
  console.log(`Slash command registrati ${GUILD_ID ? `sul server ${GUILD_ID}` : 'globalmente'}.`);
}

// --- 3. Client Discord e gestione delle interazioni -------------------------

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// ------------------- VARIABILI PER IL REPORT AUTOMATICO -------------------
const REPORT_CHANNEL_ID = process.env.REPORT_CHANNEL_ID;
const MU_ID = process.env.MU_ID;

// ------------------- FUNZIONE PER INVIARE IL REPORT (AUTOMATICO) ---------
async function sendAutomaticReport() {
  if (!REPORT_CHANNEL_ID) {
    console.error('❌ REPORT_CHANNEL_ID non configurato!');
    return;
  }
  if (!MU_ID) {
    console.error('❌ MU_ID non configurato!');
    return;
  }

  try {
    const channel = client.channels.cache.get(REPORT_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Canale ${REPORT_CHANNEL_ID} non trovato!`);
      return;
    }

    console.log('⏰ Generazione report automatico delle 9:00...');
    const { embed, members, mu } = await buildMuReportEmbed(MU_ID, true);
    
    const reportData = {
      date: new Date().toISOString().split('T')[0],
      timestamp: new Date().toISOString(),
      mu: {
        id: MU_ID,
        name: mu.name,
        country: mu.country,
        memberCount: mu.members?.length || 0,
        weeklyDamage: mu.rankings?.muWeeklyDamages?.value || 0,
        totalDamage: mu.rankings?.muDamages?.value || 0,
        reputation: mu.mercenaryReputation || 0,
      },
      members: members.map(m => ({
        userId: m.userId,
        username: m.username,
        weeklyDamage: m.weeklyDamage,
        totalDamage: m.totalDamage,
        wealth: m.wealth,
        totalBounty: m.totalBounty,
      }))
    };

    // Salvaguardia storico: se durante la generazione l'API era
    // irraggiungibile, `members` è pieno di null. Salvare quel report
    // sovrascriverebbe lo snapshot buono del giorno e rovinerebbe per
    // sempre i delta della classifica (ricchezza, bounty, record), che si
    // basano proprio su questi numeri. Meglio pubblicare l'embed con i dati
    // parziali ma NON toccare reports.json.
    const failedCount = members.filter((m) => m.failed).length;
    const tooManyFailures = members.length > 0 && failedCount > members.length / 2;

    if (tooManyFailures) {
      console.warn(
        `⚠️ Report NON salvato: ${failedCount}/${members.length} membri non recuperati ` +
          '(probabile problema di rete). Lo storico resta intatto.',
      );
      await channel.send({ embeds: [embed] });
      return;
    }

    const reportsPath = './reports.json';
    let reports = [];
    if (fs.existsSync(reportsPath)) {
      const content = fs.readFileSync(reportsPath, 'utf8');
      reports = JSON.parse(content);
    }
    
    const existingIndex = reports.findIndex(r => r.date === reportData.date);
    if (existingIndex >= 0) {
      reports[existingIndex] = reportData;
    } else {
      reports.push(reportData);
    }
    fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));

    await channel.send({ embeds: [embed] });
    console.log(`✅ Report automatico inviato e salvato per il ${reportData.date}`);

  } catch (error) {
    logTaskError('report automatico', error);
  }
}

// ------------------- CLASSIFICA MU (SETTIMANALE) ----------------------------
// Un solo messaggio (modificato ad ogni aggiornamento, niente spam) nel
// canale LEADERBOARD_CHANNEL_ID con il Top 5 di 10 classifiche: 5 "della
// settimana scorsa" + 5 "generali/assolute" (in totale, sempre aggiornate
// al momento dell'invio). Si aggiorna UNA VOLTA A SETTIMANA, il lunedì alle
// 8:00, e riferisce sulla settimana appena conclusa (lunedì-domenica). Puoi
// anche forzarla a mano in qualsiasi momento con /classifica (utile per
// testare: se lanciata a metà settimana userà lo storico più recente
// disponibile invece dell'ultima settimana completa).
//
// Fonti dati (confermate dalla documentazione community dell'API WarEra,
// non più tentativi):
//  - danni/ricchezza: rankings.weeklyUserDamages / userDamages / userWealth
//    (già in uso da prima)
//  - bounty: rankings.userBounty — confermato essere lo stesso campo usato
//    dal ranking globale "Total Bounty" del gioco (non esiste una variante
//    "settimanale" nativa: la settimanale è quindi un delta sul totale)
//  - donazioni alla MU: endpoint dedicato donation.getManyPaginated, che
//    restituisce le singole donazioni con importo e data — sommate qui per
//    utente, sia per la settimana scorsa (filtrate per data) sia in totale.
//    Questi dati sono ESATTI, non dipendono dallo storico salvato dal bot.
const LEADERBOARD_CHANNEL_ID = process.env.LEADERBOARD_CHANNEL_ID;
const MEDALS = ['🥇', '🥈', '🥉', '4️⃣', '5️⃣']; // emoji per tutte e 5 le posizioni, stesso formato

function medal(rank) {
  return MEDALS[rank] ?? `${rank + 1}.`;
}

// Data di N giorni fa in formato YYYY-MM-DD (stesso formato di reportData.date).
function daysAgoIso(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().split('T')[0];
}

// Formatta una data YYYY-MM-DD come GG/MM, per etichette leggibili tipo
// "dal 07/09" quando una classifica si basa su uno storico parziale.
function formatDateIt(dateIso) {
  const d = new Date(dateIso);
  return d.toLocaleDateString('it-IT', { day: '2-digit', month: '2-digit' });
}

// Mezzanotte (00:00) del lunedì di N settimane fa rispetto ad oggi.
// mondayMidnight(0) = lunedì di questa settimana, mondayMidnight(1) = lunedì
// della settimana scorsa. Usato per calcolare i confini esatti "settimana
// scorsa" (lunedì-domenica), a prescindere da quando /classifica viene lanciato.
function mondayMidnight(weeksAgo = 0) {
  const d = new Date();
  const day = d.getDay(); // 0 = domenica, 1 = lunedì, ...
  const diffToMonday = day === 0 ? 6 : day - 1;
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() - diffToMonday - weeksAgo * 7);
  return d;
}

// Trova, tra gli snapshot salvati, quello con data più vicina a targetIso
// SENZA MAI guardare avanti nel tempo (entro toleranceDays giorni indietro).
// Un report preso "nel futuro" rispetto al confine che cerchiamo (es. lo
// snapshot di lunedì quando cerchiamo "fine settimana scorsa" = domenica)
// mescolerebbe dati della settimana sbagliata nel delta, dando un numero
// sbagliato: per questo si guarda solo indietro, mai avanti.
function findClosestReport(reports, targetIso, toleranceDays) {
  if (reports.length === 0) return null;
  const targetMs = new Date(targetIso).getTime();
  let best = null;
  let bestDiff = Infinity;
  for (const r of reports) {
    const rMs = new Date(r.date).getTime();
    if (rMs > targetMs) continue; // mai nel futuro rispetto al target
    const diff = targetMs - rMs;
    if (diff < bestDiff) {
      bestDiff = diff;
      best = r;
    }
  }
  if (!best) return null;
  const diffDays = bestDiff / (1000 * 60 * 60 * 24);
  return diffDays <= toleranceDays ? best : null;
}

// Scarica TUTTE le donazioni ricevute dalla MU (tutta la cronologia,
// paginata). Ogni elemento: { userId, amount, createdAt, ... }. Un tetto di
// 100 pagine (~10.000 donazioni) evita loop infiniti/troppe chiamate su MU
// molto vecchie o molto attive.
async function fetchMuDonations(muId) {
  const all = [];
  let cursor;
  let page = 0;
  do {
    const data = await warera.getDonationsByMu(muId, 100, cursor);
    const items = data.items ?? data.donations ?? [];
    all.push(...items);
    cursor = data.nextCursor ?? null;
    page++;
    if (cursor) await new Promise((r) => setTimeout(r, 150));
  } while (cursor && page < 100);
  return all;
}

// NOTA: avevamo provato a prendere bounty/mercenary contract settimanali dal
// registro transazioni dell'utente (transaction.getPaginatedTransactions /
// inventoryAccount.getInventoryAccounts), che è la fonte esatta mostrata
// nella tab "Questa settimana" del profilo in-game. Verificato però che
// quell'endpoint è legato al login personale (cookie di sessione) di chi lo
// chiama: risponde solo con i PROPRI dati, non con quelli degli altri
// membri. Per un bot che deve leggere fino a 25 membri della MU con una
// sola API key non è utilizzabile, quindi non viene più chiamato:
//  - 🎯 Bounty settimanale: stimata dal dato pubblico rankings.userBounty
//    (delta sugli snapshot del bot, vedi withWeeklyBounty più sotto).
//  - 💼 Contratti mercenari settimanali: NESSUNA fonte pubblica per-utente
//    trovata finora, quindi il campo è stato rimosso dalla classifica
//    piuttosto che mostrare una stima inventata o sempre a zero.
function buildRanking(list, valueFn) {
  return list
    .map((m) => ({ username: m.username, value: valueFn(m) }))
    .filter((e) => typeof e.value === 'number' && !Number.isNaN(e.value))
    .sort((a, b) => b.value - a.value)
    .slice(0, 5);
}

function formatRankingField(title, entries, formatter = numberFmt, emptyText = 'Dati non disponibili.', inline = true) {
  const value = entries.length === 0
    ? emptyText
    : entries.map((e, i) => `${medal(i)} **${e.username}** — ${formatter(e.value)}`).join('\n');
  return { name: title, value, inline };
}

async function computeLeaderboards() {
  const mu = await warera.getMuById(MU_ID);
  const memberIds = mu.members ?? [];

  // Dati LIVE (attuali): interrogati ora, ad ogni /classifica, per ogni
  // membro della MU. Alimentano sia le classifiche generali/totali sia i
  // danni settimanali (rankings.weeklyUserDamages è già un valore tracciato
  // dal gioco stesso, quindi qui non serve nessun calcolo del bot).
  const current = [];
  for (const id of memberIds) {
    current.push(await getMemberStats(id));
    await new Promise((r) => setTimeout(r, 250));
  }
  const usernameByUserId = new Map(current.map((m) => [m.userId, m.username]));

  // Confini esatti della "settimana scorsa" (lunedì 00:00 -> lunedì 00:00
  // successivo). /classifica gira di lunedì mattina alle 8-9, quindi "ora"
  // (i dati live) coincide col confine di fine-settimana-scorsa: per questo
  // sia i dati live sia le transazioni/report di "settimana scorsa" usano
  // questa stessa finestra, dando numeri coerenti tra loro.
  const thisMonday = mondayMidnight(0);
  const lastMonday = mondayMidnight(1);
  const lastSundayIso = new Date(thisMonday.getTime() - 24 * 3600 * 1000).toISOString().split('T')[0];

  const reportsPath = './reports.json';
  let reports = [];
  if (fs.existsSync(reportsPath)) {
    reports = JSON.parse(fs.readFileSync(reportsPath, 'utf8'));
  }
  const oldestReport = reports.length
    ? reports.reduce((a, b) => (new Date(a.date) < new Date(b.date) ? a : b))
    : null;

  // Baseline per "aumento ricchezza" e "danni ultimi 30gg": idealmente lo
  // snapshot esatto del periodo target (fine settimana scorsa / 30 giorni
  // fa). Se il bot non ha ancora abbastanza storico (i report partono dal 7
  // settembre), invece di non mostrare nulla usiamo il report più VECCHIO
  // che abbiamo: è comunque una stima utile, e lo etichettiamo con la data
  // reale coperta invece di spacciarlo per un periodo che non è.
  const wealthBaselineReport = findClosestReport(reports, lastSundayIso, 3) ?? oldestReport;
  const wealthBaselineMap = new Map((wealthBaselineReport?.members ?? []).map((m) => [m.username, m]));

  const monthBaselineReport = findClosestReport(reports, daysAgoIso(30), 4) ?? oldestReport;
  const monthBaselineMap = new Map((monthBaselineReport?.members ?? []).map((m) => [m.username, m]));

  // Record danni settimanali in assoluto: il massimo weeklyDamage mai visto
  // in tutti gli snapshot salvati finora (più il valore attuale). Risoluzione
  // giornaliera: più snapshot ci sono nel tempo, più il record è preciso.
  const recordMap = new Map();
  const feedRecord = (username, weeklyDamage) => {
    if (typeof weeklyDamage !== 'number') return;
    const prev = recordMap.get(username) ?? -Infinity;
    if (weeklyDamage > prev) recordMap.set(username, weeklyDamage);
  };
  for (const rep of reports) {
    for (const m of rep.members ?? []) feedRecord(m.username, m.weeklyDamage);
  }
  for (const m of current) feedRecord(m.username, m.weeklyDamage);
  const recordWeekly = [...recordMap.entries()].map(([username, value]) => ({ username, value }));

  const withWeeklyWealthIncrease = current.map((m) => {
    const past = wealthBaselineMap.get(m.username);
    const value = past && typeof past.wealth === 'number' && typeof m.wealth === 'number'
      ? m.wealth - past.wealth
      : null;
    return { username: m.username, value };
  });

  const withMonthlyDamage = current.map((m) => {
    const past = monthBaselineMap.get(m.username);
    const value = past && typeof past.totalDamage === 'number' && typeof m.totalDamage === 'number'
      ? m.totalDamage - past.totalDamage
      : null;
    return { username: m.username, value };
  });

  // Bounty settimanale: STIMA a delta sul dato pubblico rankings.userBounty
  // (live per ogni membro, via getMemberStats) rispetto alla stessa baseline
  // usata per "aumento ricchezza" — idealmente fine settimana scorsa, o il
  // report più vecchio disponibile se il bot non ha ancora abbastanza storico.
  const withWeeklyBounty = current.map((m) => {
    const past = wealthBaselineMap.get(m.username);
    const value = past && typeof past.totalBounty === 'number' && typeof m.totalBounty === 'number'
      ? m.totalBounty - past.totalBounty
      : null;
    return { username: m.username, value };
  });

  // Donazioni: dati ESATTI dall'endpoint dedicato. Stessa finestra
  // "settimana scorsa" di bounty/contratti/danni, per coerenza.
  const donations = await fetchMuDonations(MU_ID);
  const weekStartMs = lastMonday.getTime();
  const weekEndMs = thisMonday.getTime();
  const weeklyDonationTotals = new Map();
  const allTimeDonationTotals = new Map();
  for (const d of donations) {
    const username = usernameByUserId.get(d.userId) ?? d.userId;
    const amount = typeof d.amount === 'number' ? d.amount : 0;
    allTimeDonationTotals.set(username, (allTimeDonationTotals.get(username) ?? 0) + amount);
    const createdMs = new Date(d.createdAt).getTime();
    if (createdMs >= weekStartMs && createdMs < weekEndMs) {
      weeklyDonationTotals.set(username, (weeklyDonationTotals.get(username) ?? 0) + amount);
    }
  }
  const weeklyDonationsList = [...weeklyDonationTotals.entries()].map(([username, value]) => ({ username, value }));
  const totalDonationsList = [...allTimeDonationTotals.entries()].map(([username, value]) => ({ username, value }));

  return {
    muName: mu.name,
    wealthBaselineDate: wealthBaselineReport?.date ?? null,
    monthBaselineDate: monthBaselineReport?.date ?? null,
    // weeklyDamage: valore LIVE preso ora dall'API (rankings.weeklyUserDamages
    // di ogni membro, via getMemberStats), esattamente come lo mostra il
    // gioco stesso in questo momento — nessun calcolo o snapshot del bot di
    // mezzo, quindi non può "sbagliare" o restare indietro.
    weeklyDamage: buildRanking(current, (m) => m.weeklyDamage),
    monthlyDamage: buildRanking(withMonthlyDamage, (m) => m.value),
    // Stima a delta sul dato pubblico (vedi sopra) — niente contratti
    // mercenari per-membro: nessuna fonte pubblica disponibile per adesso.
    weeklyBounty: buildRanking(withWeeklyBounty, (m) => m.value),
    weeklyWealthIncrease: buildRanking(withWeeklyWealthIncrease, (m) => m.value),
    weeklyDonations: buildRanking(weeklyDonationsList, (m) => m.value),
    recordWeeklyDamage: buildRanking(recordWeekly, (m) => m.value),
    totalDamage: buildRanking(current, (m) => m.totalDamage),
    totalDonations: buildRanking(totalDonationsList, (m) => m.value),
    totalBounty: buildRanking(current, (m) => m.totalBounty),
    totalWealth: buildRanking(current, (m) => m.wealth),
  };
}

// Due embed separati invece di uno solo lunghissimo:
//  1) "Settimana scorsa" — le classifiche che si azzerano/ricalcolano ogni
//     settimana
//  2) "Generali" — i totali storici, sempre aggiornati al momento dell'invio
// I campi sono `inline: true`, quindi Discord li dispone in griglia (3 per
// riga) invece che uno sotto l'altro: molto più rapido da scansionare a
// colpo d'occhio, sia su desktop che su mobile.
function buildLeaderboardEmbeds(lb) {
  const wealthLabel = lb.wealthBaselineDate
    ? `💰 Aumento ricchezza (stima dal ${formatDateIt(lb.wealthBaselineDate)})`
    : '💰 Aumento ricchezza (stima)';
  const monthLabel = lb.monthBaselineDate
    ? `📈 Danni dal ${formatDateIt(lb.monthBaselineDate)} (stima)`
    : '📈 Danni ultimi 30gg (stima)';

  const bountyLabel = lb.wealthBaselineDate
    ? `🎯 Bounty (stima dal ${formatDateIt(lb.wealthBaselineDate)})`
    : '🎯 Bounty (stima)';

  const weeklyEmbed = new EmbedBuilder()
    .setTitle(`🏆 Classifica — ${lb.muName}`)
    .setColor(0xffd700)
    .setDescription(
      '📅 **Settimana scorsa** (lunedì → domenica)\n' +
      '-# 💥 🎁 sono dati live/esatti dall\'API. 📈 🎯 💰 sono stime basate ' +
      'sullo storico raccolto dal bot (WarEra non espone questi totali per periodo, ' +
      'e i contratti mercenari per membro non sono pubblici).',
    )
    .addFields(
      formatRankingField('💥 Danni', lb.weeklyDamage),
      formatRankingField(monthLabel, lb.monthlyDamage, numberFmt, 'In attesa di storico.'),
      formatRankingField('🎁 Donazioni alla MU', lb.weeklyDonations, numberFmt, 'Nessuna donazione registrata.'),
      formatRankingField(bountyLabel, lb.weeklyBounty, numberFmt, 'In attesa di storico.'),
      formatRankingField(wealthLabel, lb.weeklyWealthIncrease, signedFmt, 'In attesa di storico.'),
    );

  const totalEmbed = new EmbedBuilder()
    .setColor(0xb8860b)
    .setDescription('🌍 **Classifiche generali** — tutti valori live dall\'API, sempre esatti')
    .addFields(
      formatRankingField('🔥 Record danni settimanali*', lb.recordWeeklyDamage),
      formatRankingField('💥 Danni totali', lb.totalDamage),
      formatRankingField('🎁 Donazioni totali', lb.totalDonations, numberFmt, 'Nessuna donazione registrata.'),
      formatRankingField('🎯 Bounty totali', lb.totalBounty),
      formatRankingField('👑 Ricchezza totale', lb.totalWealth),
    )
    .setFooter({
      text:
        '* record settimanale = massimo osservato dal bot da quando è attivo, non un dato ufficiale del gioco. ' +
        'Le stime settimanali si affinano più il bot resta online.',
    })
    .setTimestamp();

  return [weeklyEmbed, totalEmbed];
}

async function sendLeaderboard() {
  if (!MU_ID || !LEADERBOARD_CHANNEL_ID) return;
  try {
    const channel = client.channels.cache.get(LEADERBOARD_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Canale classifica ${LEADERBOARD_CHANNEL_ID} non trovato!`);
      return;
    }

    const lb = await computeLeaderboards();
    const embeds = buildLeaderboardEmbeds(lb);

    // Ogni /classifica (o lo schedule del lunedì) manda un messaggio NUOVO,
    // non edita quello della settimana scorsa: il canale è dedicato solo a
    // questo, quindi accumulare i messaggi va bene anzi crea uno storico
    // consultabile settimana per settimana.
    await channel.send({ embeds });
  } catch (err) {
    logTaskError('classifica', err);
  }
}

// ------------------- CONTRACT HUNTER (ASTE CONTRATTI MERCENARI) -----------
// Ogni 2 minuti:
//  - cerca le ASTE di contratti mercenari ancora aperte (status "active" =
//    su cui è ancora possibile fare un'offerta; se WarEra segnala in altro
//    modo che un'asta non accetta più offerte, es. un campo tipo
//    "acceptingBids"/"biddingClosed", va aggiunto qui al filtro)
//  - le mostra in UN SOLO report, evidenziando con 🔥 quelle sopra soglia
//  - se non è cambiato nulla dall'ultimo giro, non tocca Discord
//  - se qualcosa è cambiato, MODIFICA il messaggio precedente invece di
//    mandarne uno nuovo, così il canale non si riempie di messaggi
const CONTRACT_CHANNEL_ID = process.env.CONTRACT_CHANNEL_ID;
// Soglia di prezzo/k sopra la quale un'asta viene evidenziata nel report
// (non filtra più nulla: tutte le aste attive restano visibili).
const CONTRACT_MIN_PERK = process.env.CONTRACT_MIN_PERK ? parseFloat(process.env.CONTRACT_MIN_PERK) : null;
const HUNTER_STATE_PATH = './contract-hunter-state.json';

function loadHunterState() {
  try {
    if (fs.existsSync(HUNTER_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(HUNTER_STATE_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Errore lettura contract-hunter-state.json:', err);
  }
  return { messageId: null, signature: null };
}

function saveHunterState(state) {
  try {
    fs.writeFileSync(HUNTER_STATE_PATH, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('Errore salvataggio contract-hunter-state.json:', err);
  }
}

// "tra 3 minuti", "tra un minuto", "scaduto"...
function formatRelativeExpiry(expiresAt) {
  const diffMs = new Date(expiresAt).getTime() - Date.now();
  if (diffMs <= 0) return 'scaduto';
  const mins = Math.round(diffMs / 60000);
  if (mins < 1) return 'tra pochi secondi';
  if (mins === 1) return 'tra un minuto';
  if (mins < 60) return `tra ${mins} minuti`;
  const hours = Math.round(mins / 60);
  return hours === 1 ? "tra un'ora" : `tra ${hours} ore`;
}

async function contractHunter() {
  if (!CONTRACT_CHANNEL_ID) return;
  try {
    const channel = client.channels.cache.get(CONTRACT_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Canale contratti ${CONTRACT_CHANNEL_ID} non trovato!`);
      return;
    }

    const data = await warera.getMercenaryContracts(50);
    const items = (data.items ?? []).filter((c) => c.status === 'active');
    items.sort((a, b) => b.currentPerK - a.currentPerK);

    // Firma dei dati rilevanti: se è identica a quella dell'ultimo giro non
    // c'è nessuna novità, quindi non tocchiamo Discord.
    const signature = JSON.stringify(
      items.map((c) => [c._id, c.currentPerK, c.currentPayout, c.expiresAt]),
    );
    const state = loadHunterState();
    if (signature === state.signature && state.messageId) return;

    let embeds;
    if (items.length === 0) {
      embeds = [
        new EmbedBuilder()
          .setTitle('🏹 Contract Hunter')
          .setColor(0x2b6cb0)
          .setDescription('Nessuna asta di contratti mercenari attiva al momento.')
          .setTimestamp(),
      ];
    } else {
      const nazioni = await Promise.all(items.map((c) => resolveCountryName(c.forCountry)));
      const anyHighlighted = CONTRACT_MIN_PERK != null && items.some((c) => c.currentPerK >= CONTRACT_MIN_PERK);

      // Discord: max 25 field/embed e max 10 embed/messaggio -> fino a 200
      // aste per messaggio, paginate a gruppi di 20.
      const CHUNK_SIZE = 20;
      const chunks = [];
      for (let i = 0; i < items.length; i += CHUNK_SIZE) {
        chunks.push(items.slice(i, i + CHUNK_SIZE));
      }

      embeds = chunks.slice(0, 10).map((chunk, idx) => {
        const startIdx = idx * CHUNK_SIZE;
        const embed = new EmbedBuilder()
          .setColor(anyHighlighted ? 0xf1c40f : 0x2b6cb0)
          .setTimestamp();

        if (idx === 0) {
          embed
            .setTitle('🏹 Contract Hunter')
            .setDescription(
              `Aste attive: **${items.length}**` +
                (CONTRACT_MIN_PERK != null ? ` · 🔥 evidenziate sopra **${CONTRACT_MIN_PERK}/k**` : ''),
            );
        }

        chunk.forEach((c, i) => {
          const globalIdx = startIdx + i;
          const highlighted = CONTRACT_MIN_PERK != null && c.currentPerK >= CONTRACT_MIN_PERK;
          const sideEmoji = c.forCountrySide === 'attacker' ? '⚔️' : '🛡️';
          const scade = formatRelativeExpiry(c.expiresAt);

          embed.addFields({
            name: `${highlighted ? '🔥 ' : ''}#${globalIdx + 1} — ${nazioni[globalIdx]} ${sideEmoji}`,
            value:
              `💰 Prezzo: **${c.currentPerK.toFixed(3)}/k**\n` +
              `🎯 Danni minimi: ${numberFmt(c.minimumDamage)}\n` +
              `💵 Payout: ${numberFmt(c.currentPayout)}\n` +
              `${c.professionalsOnly ? '🔒 Solo professionisti' : '🔓 Aperto a tutti'}\n` +
              `⏳ Scade: ${scade}`,
          });
        });

        return embed;
      });
    }

    if (state.messageId) {
      try {
        const msg = await channel.messages.fetch(state.messageId);
        await msg.edit({ embeds });
      } catch {
        // Messaggio precedente non più trovabile (cancellato a mano, ecc.)
        const sent = await channel.send({ embeds });
        state.messageId = sent.id;
      }
    } else {
      const sent = await channel.send({ embeds });
      state.messageId = sent.id;
    }

    state.signature = signature;
    saveHunterState(state);
  } catch (err) {
    logTaskError('Contract Hunter', err);
  }
}

// ------------------- ALERT CONTRATTI DELLA PROPRIA MU ----------------------
// Ogni 2 minuti: cerca il contratto mercenario ATTIVO attualmente vinto
// dalla tua MU (MU_ID) e, se è diverso dall'ultimo già segnalato, manda un
// messaggio che tagga il ruolo MU_CONTRACT_ROLE_ID con danni richiesti e
// costo. Una MU ha sempre al massimo un contratto vinto alla volta.
const MU_CONTRACT_CHANNEL_ID = process.env.MU_CONTRACT_CHANNEL_ID;
const MU_CONTRACT_ROLE_ID = process.env.MU_CONTRACT_ROLE_ID;
const MU_NOTIFIED_PATH = './mu-contracts-notified.json';

function loadMuNotified() {
  try {
    if (fs.existsSync(MU_NOTIFIED_PATH)) {
      return JSON.parse(fs.readFileSync(MU_NOTIFIED_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('Errore lettura mu-contracts-notified.json:', err);
  }
  return [];
}

function saveMuNotified(list) {
  try {
    fs.writeFileSync(MU_NOTIFIED_PATH, JSON.stringify(list.slice(-500), null, 2));
  } catch (err) {
    console.error('Errore salvataggio mu-contracts-notified.json:', err);
  }
}

// Contratto attualmente vinto dalla tua MU: il campo giusto è
// "currentWinner" (contiene l'ID della MU che si è aggiudicata l'asta),
// verificato in precedenza chiamando /warera-raw su
// mercenaryContractAuction.getPaginatedAuctions.
function contractMuId(c) {
  return c.currentWinner ?? null;
}

// Cache leggera in memoria: checkMuContracts gira ogni 2 minuti e più
// contratti possono riferirsi alla stessa battaglia, non serve richiamare
// l'API ogni volta per la stessa battaglia.
const battleCountriesCache = new Map();

// Dato l'ID della battaglia legata a un contratto mercenario (campo
// `c.battle`), risale a chi combatte: { attackerId, defenderId, attacker,
// defender } con i nomi già risolti. Se l'endpoint non risponde come
// previsto (nomi di campo diversi, endpoint cambiato...) torna null invece
// di far fallire l'alert: il messaggio del contratto va comunque inviato,
// semplicemente senza l'informazione sulla battaglia.
async function getBattleCountries(battleId) {
  if (!battleId) return null;
  if (battleCountriesCache.has(battleId)) return battleCountriesCache.get(battleId);
  try {
    const battle = await warera.getBattleById(battleId);
    const attackerId = battle.attacker_country_id ?? battle.attackerCountryId;
    const defenderId = battle.defender_country_id ?? battle.defenderCountryId;
    if (!attackerId || !defenderId) return null;
    const [attacker, defender] = await Promise.all([
      resolveCountryName(attackerId),
      resolveCountryName(defenderId),
    ]);
    const result = { attackerId, defenderId, attacker, defender };
    battleCountriesCache.set(battleId, result);
    return result;
  } catch (err) {
    console.error(`Errore recupero battaglia ${battleId} per contratto:`, err.message);
    return null;
  }
}

async function checkMuContracts() {
  if (!MU_ID || !MU_CONTRACT_CHANNEL_ID || !MU_CONTRACT_ROLE_ID) return;
  try {
    const channel = client.channels.cache.get(MU_CONTRACT_CHANNEL_ID);
    if (!channel) {
      console.error(`❌ Canale alert contratti MU ${MU_CONTRACT_CHANNEL_ID} non trovato!`);
      return;
    }

    const data = await warera.getMercenaryContracts(50);
    const items = (data.items ?? []).filter(
      (c) => c.status === 'active' && contractMuId(c) === MU_ID,
    );

    const notified = loadMuNotified();
    const notifiedSet = new Set(notified);
    const newOnes = items.filter((c) => !notifiedSet.has(c._id));
    if (newOnes.length === 0) return;

    for (const c of newOnes) {
      const battle = await getBattleCountries(c.battle);

      const embed = new EmbedBuilder()
        .setTitle('🔥 Contratto attivo! Clicca quì per la battaglia!')
        .setColor(0xe53e3e)
        .addFields(
          { name: '🎯 Danni richiesti', value: numberFmt(c.minimumDamage), inline: true },
          { name: '💰 Costo', value: `${c.currentPerK.toFixed(3)}/k`, inline: true },
          { name: '💵 Payout', value: numberFmt(c.currentPayout), inline: true },
        );

      if (c.battle) {
        embed.setURL(`https://app.warera.io/battle/${c.battle}`);
      }
      if (battle) {
        const sideEmoji = c.forCountrySide === 'attacker' ? '⚔️' : '🛡️';
        const favoredName = c.forCountrySide === 'attacker' ? battle.attacker : battle.defender;
        embed.setDescription(
          `⚔️ **${battle.attacker}** 🆚 **${battle.defender}**\n` +
          `${sideEmoji} Contratto a favore di **${favoredName}**`,
        );
      }

      await channel.send({
        content: `<@&${MU_CONTRACT_ROLE_ID}> 🔥 **Contratto attivo! Fate fuoco!'**`,
        embeds: [embed],
        allowedMentions: { roles: [MU_CONTRACT_ROLE_ID] },
      });
    }

    saveMuNotified([...notified, ...newOnes.map((c) => c._id)]);
  } catch (err) {
    logTaskError('alert contratti MU', err);
  }
}

// ------------------- QUANDO IL BOT È PRONTO --------------------------------
client.once('ready', () => {
  console.log(`✅ Bot connesso come ${client.user.tag}`);

  // --- Programma il report giornaliero alle 9:00 (UNA SOLA VOLTA) con fuso orario ITALIANO ---
  if (REPORT_CHANNEL_ID && MU_ID) {
    cron.schedule('0 9 * * *', withLock('report automatico', async () => {
      await sendAutomaticReport();
    }), {
      timezone: 'Europe/Rome'  // Imposta il fuso orario italiano
    });
    console.log('⏰ Report automatico programmato per le 9:00 ogni giorno (fuso orario: Europe/Rome)');
  } else {
    console.warn('⚠️ Report automatico NON programmato: mancano REPORT_CHANNEL_ID o MU_ID');
  }

  // --- Classifica MU: ogni lunedì alle 8:00, riferita alla settimana scorsa ---
  if (MU_ID && LEADERBOARD_CHANNEL_ID) {
    cron.schedule('0 8 * * 1', withLock('classifica', async () => {
      await sendLeaderboard();
    }), {
      timezone: 'Europe/Rome',
    });
    console.log(`🏆 Classifica programmata ogni lunedì alle 8:00 nel canale ${LEADERBOARD_CHANNEL_ID} (forzabile con /classifica).`);
  } else {
    console.warn('⚠️ Classifica NON programmata: mancano MU_ID o LEADERBOARD_CHANNEL_ID');
  }

  // --- Alert contratti della propria MU, ogni 2 minuti ---
  if (MU_ID && MU_CONTRACT_CHANNEL_ID && MU_CONTRACT_ROLE_ID) {
    cron.schedule('*/2 * * * *', withLock('alert contratti MU', checkMuContracts));
    console.log(`🔔 Alert contratti MU attivo ogni 2 minuti nel canale ${MU_CONTRACT_CHANNEL_ID}.`);
  } else {
    console.warn('⚠️ Alert contratti MU NON programmato: mancano MU_ID, MU_CONTRACT_CHANNEL_ID o MU_CONTRACT_ROLE_ID');
  }

  // --- Contract Hunter: aste contratti mercenari, ogni 2 minuti ---
  if (CONTRACT_CHANNEL_ID) {
    cron.schedule('*/2 * * * *', withLock('Contract Hunter', contractHunter));
    console.log(
      `🏹 Contract Hunter attivo ogni 2 minuti nel canale ${CONTRACT_CHANNEL_ID}` +
        (CONTRACT_MIN_PERK != null ? ` (evidenzia sopra ${CONTRACT_MIN_PERK}/k)` : ' (nessuna soglia impostata)'),
    );
  } else {
    console.warn('⚠️ Contract Hunter NON programmato: manca CONTRACT_CHANNEL_ID');
  }
});

// ------------------- GESTIONE DEI COMANDI SLASH ----------------------------
client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  try {
    // --- /warera-countries ---------------------------------------------
    if (interaction.commandName === 'warera-countries') {
      await interaction.deferReply();
      const countries = await warera.getAllCountries();
      const names = countries.slice(0, 40).map((c) => c.name).join(', ');
      await interaction.editReply(`**Nazioni (prime 40):** ${names}`);
    }

    // --- /warera-country --------------------------------------------------
    if (interaction.commandName === 'warera-country') {
      await interaction.deferReply();
      const nome = interaction.options.getString('nome');
      const countries = await warera.getAllCountries();
      const match = countries.find((c) => c.name.toLowerCase() === nome.toLowerCase());
      if (!match) {
        await interaction.editReply(`Nessuna nazione trovata con nome "${nome}".`);
        return;
      }
      const country = await warera.getCountryById(match._id);

      let government = null;
      try {
        government = await warera.getGovernmentByCountryId(country._id);
      } catch {}

      let ethicsText = 'n/d';
      if (country.rulingParty) {
        try {
          const party = await warera.getPartyById(country.rulingParty);
          ethicsText = formatEthics(party.ethics);
        } catch {}
      }

      const [presidente, vicePresidente, ministroDifesa, ministroEsteri, ministroEconomia] =
        government
          ? await Promise.all([
              resolveUsername(government.president),
              resolveUsername(government.vicePresident),
              resolveUsername(government.minOfDefense),
              resolveUsername(government.minOfForeignAffairs),
              resolveUsername(government.minOfEconomy),
            ])
          : ['n/d', 'n/d', 'n/d', 'n/d', 'n/d'];

      const embed = new EmbedBuilder()
        .setTitle(`${flagEmoji(country.code) || '🏳️'} ${country.name}`)
        .setColor(0x2b6cb0)
        .addFields(
          { name: '👥 Popolazione', value: numberFmt(country.currentPopulation), inline: true },
          { name: '🟢 Giocatori attivi', value: numberFmt(country.rankings?.countryActivePopulation?.value), inline: true },
          { name: '🏛️ Congresso', value: numberFmt(government?.congressMembers?.length), inline: true },
          {
            name: '👑 Governo',
            value:
              `**Presidente:** ${presidente}\n` +
              `**Vicepresidente:** ${vicePresidente}\n` +
              `**Min. Difesa:** ${ministroDifesa}\n` +
              `**Min. Esteri:** ${ministroEsteri}\n` +
              `**Min. Economia:** ${ministroEconomia}`,
          },
          { name: '⚖️ Etiche del partito', value: ethicsText },
          { name: '🏭 Specializzazione', value: itemNameIt(country.specializedItem), inline: true },
          { name: '📈 Bonus produzione', value: `${country.strategicResources?.bonuses?.productionPercent ?? 0}%`, inline: true },
          {
            name: '💰 Tassazione',
            value:
              `Reddito: ${country.taxes?.income ?? 0}%  ·  ` +
              `Mercato: ${country.taxes?.market ?? 0}%  ·  ` +
              `Lavoro autonomo: ${country.taxes?.selfWork ?? 0}%`,
          },
        );
      await interaction.editReply({ embeds: [embed] });
    }

    // --- /warera-user (cerca per ID o nome) ------------------------------
    if (interaction.commandName === 'warera-user') {
      await interaction.deferReply();
      const searchTerm = interaction.options.getString('cerca');
      
      const isId = /^[0-9a-fA-F]{24}$/.test(searchTerm); // ID WarEra = 24 caratteri esadecimali (MongoDB ObjectId)
      let userId = searchTerm;
      let usedName = null;
      
      if (!isId) {
        const foundId = await findUserIdByName(searchTerm);
        if (!foundId) {
          await interaction.editReply(`❌ Nessun giocatore trovato con il nome "${searchTerm}".\n📌 Se il nome contiene caratteri speciali (es. _), prova con l'ID.`);
          return;
        }
        userId = foundId;
        usedName = searchTerm;
      }
      
      try {
        const user = await warera.getUserLite(userId);
        
        const [nazione, muNome] = await Promise.all([
          resolveCountryName(user.country),
          user.mu ? warera.getMuById(user.mu).then((m) => m?.name ?? user.mu).catch(() => user.mu) : 'Nessuna',
        ]);

        // Aziende: prima l'elenco degli ID, poi i dettagli di ciascuna
        // (massimo 12 aziende per giocatore nel gioco).
        let aziendeText = 'Nessuna azienda';
        try {
          const companiesList = await warera.getCompaniesByUserId(userId, 20);
          const companyIds = (companiesList.items ?? []).slice(0, 12);
          if (companyIds.length > 0) {
            const companies = await Promise.all(
              companyIds.map((id) => warera.getCompanyById(id).catch(() => null)),
            );
            aziendeText = companies
              .filter(Boolean)
              .map((c) => {
                const lvl = c.activeUpgradeLevels ?? {};
                const stato = c.disabledAt ? 'Disabilitata ❌' : 'Attiva ✅';
                return (
                  `**${itemNameIt(c.itemCode) ?? c.name ?? 'n/d'}** — ${stato}\n` +
                  `Magazzino Lv${lvl.storage ?? 0}, Automazione Lv${lvl.automatedEngine ?? 0}, ` +
                  `Dipendenti: ${c.workerCount ?? 0}`
                );
              })
              .join('\n');
            if (!aziendeText) aziendeText = 'Nessuna azienda';
          }
        } catch {
          aziendeText = 'n/d (errore nel recupero)';
        }

        const r = user.rankings ?? {};
        const embed = new EmbedBuilder()
          .setTitle(`🪖 ${user.username ?? userId}`)
          .setColor(0x38a169)
          .setThumbnail(user.avatarUrl ?? null)
          .addFields(
            { name: '🌍 Nazionalità', value: nazione, inline: true },
            { name: '⚔️ MU', value: muNome, inline: true },
            { name: '⭐ Livello', value: numberFmt(user.leveling?.level), inline: true },
            { name: '💰 Ricchezza totale', value: numberFmt(r.userWealth?.value), inline: true },
            { name: '💥 Danni settimanali', value: numberFmt(r.weeklyUserDamages?.value), inline: true },
            { name: '💥 Danni totali', value: numberFmt(r.userDamages?.value), inline: true },
            { name: '⚔️ Abilità di combattimento', value: formatSkillGroup(user.skills, COMBAT_SKILLS) },
            { name: '💼 Abilità economiche', value: formatSkillGroup(user.skills, ECONOMIC_SKILLS) },
            { name: '🏭 Aziende', value: aziendeText },
          )
          .setFooter({ text: usedName ? `Ricerca per nome: "${usedName}"` : `ID: ${userId}` });
          
        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error(error);
        await interaction.editReply(`❌ Errore nel recuperare i dati. Verifica che ${isId ? 'l\'ID' : 'il nome'} sia corretto.`);
      }
    }

    // --- /warera-mu (cerca per ID o nome) --------------------------------
    if (interaction.commandName === 'warera-mu') {
      await interaction.deferReply();
      const searchTerm = interaction.options.getString('cerca');
      
      const isId = /^[0-9a-fA-F]{24}$/.test(searchTerm); // ID WarEra = 24 caratteri esadecimali (MongoDB ObjectId)
      let muId = searchTerm;
      let usedName = null;
      
      if (!isId) {
        const foundId = await findMuIdByName(searchTerm);
        if (!foundId) {
          await interaction.editReply(`❌ Nessuna MU trovata con il nome "${searchTerm}".\n📌 Se il nome contiene caratteri speciali, prova con l'ID.`);
          return;
        }
        muId = foundId;
        usedName = searchTerm;
      }
      
      try {
        const mu = await warera.getMuById(muId);
        const nazione = await resolveCountryName(mu.country);

        const r = mu.rankings ?? {};
        const hq = mu.activeUpgradeLevels?.headquarters ?? 0;
        const dorm = mu.activeUpgradeLevels?.dormitories ?? 0;

        const embed = new EmbedBuilder()
          .setTitle(`🛡️ ${mu.name}`)
          .setColor(0xd69e2e)
          .setThumbnail(mu.avatarUrl ?? null)
          .addFields(
            { name: '👥 Membri', value: numberFmt(mu.members?.length), inline: true },
            { name: '🌍 Nazionalità', value: nazione, inline: true },
            { name: '🤝 Reputazione mercenaria', value: mu.mercenaryReputation != null ? mu.mercenaryReputation.toFixed(2) : 'n/d', inline: true },
            { name: '💥 Danni settimanali', value: numberFmt(r.muWeeklyDamages?.value), inline: true },
            { name: '💥 Danni totali', value: numberFmt(r.muDamages?.value), inline: true },
            { name: '🏢 Quartier generale', value: `Livello ${hq} — ${hq > 0 ? 'Attivo ✅' : 'Non attivo ❌'}` },
            { name: '🛌 Dormitori', value: `Livello ${dorm} — ${dorm > 0 ? 'Attivi ✅' : 'Non attivi ❌'}` },
          )
          .setFooter({ text: usedName ? `Ricerca per nome: "${usedName}"` : `ID: ${muId}` });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error(error);
        await interaction.editReply(`❌ Errore nel recuperare i dati. Verifica che ${isId ? 'l\'ID' : 'il nome'} sia corretto.`);
      }
    }

    // --- /warera-mu-report ----------------------------------------------
    if (interaction.commandName === 'warera-mu-report') {
      await interaction.deferReply();
      const id = interaction.options.getString('id');
      try {
        const { embed } = await buildMuReportEmbed(id, false);
        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(`❌ ${err.message}`);
      }
    }

    // --- /warera-region (cerca per ID o nome) -----------------------------
    if (interaction.commandName === 'warera-region') {
      await interaction.deferReply();
      const searchTerm = interaction.options.getString('cerca');
      
      const isId = /^[0-9a-fA-F]{24}$/.test(searchTerm); // ID WarEra = 24 caratteri esadecimali (MongoDB ObjectId)
      let regionId = searchTerm;
      let usedName = null;
      
      if (!isId) {
        const foundId = await findRegionIdByName(searchTerm);
        if (!foundId) {
          await interaction.editReply(`❌ Nessuna regione trovata con il nome "${searchTerm}".\n📌 Se il nome contiene caratteri speciali, prova con l'ID.`);
          return;
        }
        regionId = foundId;
        usedName = searchTerm;
      }
      
      try {
        const region = await warera.getRegionById(regionId);

        const [nazioneOriginale, nazioneAttuale] = await Promise.all([
          resolveCountryName(region.initialCountry),
          resolveCountryName(region.country),
        ]);

        const bunker = region.activeUpgradeLevels?.bunker ?? 0;
        const baseLevel = region.activeUpgradeLevels?.base ?? 0;

        const embed = new EmbedBuilder()
          .setTitle(`🗺️ ${region.name}`)
          .setColor(0x805ad5)
          .addFields(
            { name: '🏳️ Nazione di appartenenza', value: nazioneOriginale, inline: true },
            { name: '🚩 Nazione attuale', value: nazioneAttuale, inline: true },
            { name: '🛡️ Bunker', value: `Livello ${bunker} — ${bunker > 0 ? 'Attivo ✅' : 'Non attivo ❌'}` },
            {
              name: '🎖️ Base Militare',
              value: `Livello ${baseLevel} — ${baseLevel > 0 ? 'Attiva ✅' : 'Non attiva ❌'}\n*(dato preso così com'è dall'API WarEra: se è 0 nonostante sia stata costruita, potrebbe non essere ancora aggiornato lato server)*`,
            },
          )
          .setFooter({ text: usedName ? `Ricerca per nome: "${usedName}"` : `ID: ${regionId}` });

        await interaction.editReply({ embeds: [embed] });
      } catch (error) {
        console.error(error);
        await interaction.editReply(`❌ Errore nel recuperare i dati. Verifica che ${isId ? 'l\'ID' : 'il nome'} sia corretto.`);
      }
    }

    // --- /warera-news -------------------------------------------------------
    if (interaction.commandName === 'warera-news') {
      await interaction.deferReply();
      const result = await warera.getLatestArticles(5);
      const items = result.items ?? result;
      const list = items
        .slice(0, 5)
        .map((a) => `• ${a.title ?? a.name ?? a._id}`)
        .join('\n');
      await interaction.editReply(`**Ultimi articoli:**\n${list}`);
    }

    // --- /warera-raw (debug) -------------------------------------------------
    if (interaction.commandName === 'warera-raw') {
      await interaction.deferReply();
      const endpoint = interaction.options.getString('endpoint');
      const paramsStr = interaction.options.getString('parametri') || '{}';
      const campo = interaction.options.getString('campo');
      const metodo = interaction.options.getString('metodo') || 'GET';
      let params;
      try {
        params = JSON.parse(paramsStr);
      } catch {
        await interaction.editReply('I "parametri" devono essere un JSON valido, es. {"userId":"123"}');
        return;
      }
      const data = metodo === 'POST' ? await warera.rawPost(endpoint, params) : await warera.raw(endpoint, params);
      const base = Array.isArray(data) ? data[0] : data;

      let output;
      if (!campo) {
        const keys = base && typeof base === 'object' ? Object.keys(base) : [];
        output =
          `Chiavi disponibili${Array.isArray(data) ? ' (nel primo elemento)' : ''}:\n` +
          keys.map((k) => `• ${k}`).join('\n');
      } else {
        const value = campo
          .split('.')
          .reduce((acc, key) => (acc == null ? undefined : acc[key]), base);
        let json = JSON.stringify(value, null, 2);
        if (json === undefined) json = 'undefined (campo non trovato)';
        if (json.length > 1800) {
          if (value && typeof value === 'object') {
            const keys = Array.isArray(value)
              ? value.map((_, i) => String(i))
              : Object.keys(value);
            json =
              `(troppo grande per essere mostrato per intero, ${keys.length} chiavi)\n` +
              keys.map((k) => `• ${k}`).join('\n');
          } else {
            json = json.slice(0, 1800) + '\n... (troncato)';
          }
        }
        output = '```\n' + json + '\n```';
      }
      await interaction.editReply(output);
    }

    // ------------------- COMANDO /REPORT (MANUALE) -------------------------
    if (interaction.commandName === 'report') {
      await interaction.deferReply({ ephemeral: true });

      if (!MU_ID) {
        await interaction.editReply('❌ MU_ID non configurato nelle variabili d\'ambiente!');
        return;
      }

      try {
        const { embed, members, mu } = await buildMuReportEmbed(MU_ID, false);
        
        const reportData = {
          date: new Date().toISOString().split('T')[0],
          timestamp: new Date().toISOString(),
          mu: {
            id: MU_ID,
            name: mu.name,
            country: mu.country,
            memberCount: mu.members?.length || 0,
            weeklyDamage: mu.rankings?.muWeeklyDamages?.value || 0,
            totalDamage: mu.rankings?.muDamages?.value || 0,
            reputation: mu.mercenaryReputation || 0,
          },
          members: members.map(m => ({
            userId: m.userId,
            username: m.username,
            weeklyDamage: m.weeklyDamage,
            totalDamage: m.totalDamage,
            wealth: m.wealth,
            totalBounty: m.totalBounty,
          }))
        };

        const reportsPath = './reports.json';
        let reports = [];
        if (fs.existsSync(reportsPath)) {
          const content = fs.readFileSync(reportsPath, 'utf8');
          reports = JSON.parse(content);
        }
        
        const existingIndex = reports.findIndex(r => r.date === reportData.date);
        if (existingIndex >= 0) {
          reports[existingIndex] = reportData;
        } else {
          reports.push(reportData);
        }
        fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));

        await interaction.channel.send({ embeds: [embed] });
        await interaction.editReply('✅ Report inviato e salvato con successo!');
      } catch (err) {
        await interaction.editReply(`❌ ${err.message}`);
      }
    }

    // ------------------- COMANDO /CONFRONTA (GG-MM-AAAA) ---------------------
    if (interaction.commandName === 'confronta') {
      await interaction.deferReply();

      try {
        const data1Input = interaction.options.getString('data1');
        const data2Input = interaction.options.getString('data2');

        const data1 = parseItalianDate(data1Input);
        const data2 = parseItalianDate(data2Input);
        if (!data1 || !data2) {
          await interaction.editReply('❌ Formato data non valido. Usa GG-MM-AAAA (es. 07-09-2026)');
          return;
        }

        const reportsPath = './reports.json';
        if (!fs.existsSync(reportsPath)) {
          await interaction.editReply('❌ Nessun report salvato! Usa `/report` per generare un report.');
          return;
        }

        const content = fs.readFileSync(reportsPath, 'utf8');
        const reports = JSON.parse(content);

        if (reports.length === 0) {
          await interaction.editReply('❌ Nessun report salvato! Usa `/report` per generare un report.');
          return;
        }

        const report1 = reports.find(r => r.date === data1);
        const report2 = reports.find(r => r.date === data2);

        if (!report1) {
          await interaction.editReply(`❌ Nessun report trovato per la data **${formatItalianDate(data1)}**.`);
          return;
        }
        if (!report2) {
          await interaction.editReply(`❌ Nessun report trovato per la data **${formatItalianDate(data2)}**.`);
          return;
        }

        const mu1 = report1.mu;
        const mu2 = report2.mu;
        const members1 = report1.members || [];
        const members2 = report2.members || [];

        const usernames1 = new Set(members1.map(m => m.username));
        const usernames2 = new Set(members2.map(m => m.username));

        const newMembers = members2.filter(m => !usernames1.has(m.username));
        const leftMembers = members1.filter(m => !usernames2.has(m.username));

        const diff = {
          members: mu2.memberCount - mu1.memberCount,
          weeklyDamage: mu2.weeklyDamage - mu1.weeklyDamage,
          totalDamage: mu2.totalDamage - mu1.totalDamage,
          reputation: mu2.reputation - mu1.reputation,
        };

        const newList = newMembers.slice(0, 10).map(m => `• ${m.username}`).join('\n') || 'Nessuno';
        const leftList = leftMembers.slice(0, 10).map(m => `• ${m.username}`).join('\n') || 'Nessuno';
        const deltaFields = buildMemberDeltaFields(members1, members2);

        const embed = new EmbedBuilder()
          .setTitle(`📊 Confronto Report MU: ${mu1.name}`)
          .setColor(0xFFAA00)
          .addFields(
            {
              name: '📅 Date confrontate',
              value: `**${formatItalianDate(data1)}** → **${formatItalianDate(data2)}**`,
              inline: false
            },
            {
              name: '👥 Membri',
              value: `${mu1.memberCount} → ${mu2.memberCount} (${diff.members > 0 ? '+' : ''}${diff.members})`,
              inline: true
            },
            {
              name: '💥 Danni settimanali',
              value: `${numberFmt(mu1.weeklyDamage)} → ${numberFmt(mu2.weeklyDamage)} (${diff.weeklyDamage > 0 ? '+' : ''}${numberFmt(diff.weeklyDamage)})`,
              inline: true
            },
            {
              name: '💥 Danni totali',
              value: `${numberFmt(mu1.totalDamage)} → ${numberFmt(mu2.totalDamage)} (${diff.totalDamage > 0 ? '+' : ''}${numberFmt(diff.totalDamage)})`,
              inline: true
            },
            {
              name: '🤝 Reputazione',
              value: `${mu1.reputation?.toFixed(2) || 0} → ${mu2.reputation?.toFixed(2) || 0} (${diff.reputation > 0 ? '+' : ''}${diff.reputation?.toFixed(2) || 0})`,
              inline: true
            },
            {
              name: '🟢 Nuovi membri (entrati)',
              value: newList,
              inline: true
            },
            {
              name: '🔴 Membri usciti',
              value: leftList,
              inline: true
            },
            ...deltaFields,
          )
          .setFooter({
            text: `Report salvati: ${reports.length} giorni disponibili`
          })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

      } catch (error) {
        console.error('❌ Errore nel confronto:', error);
        await interaction.editReply(`❌ Errore: ${error.message}`);
      }
    }

    // ------------------- COMANDO /FORZA-REPORT (TEST) ------------------------
    if (interaction.commandName === 'forza-report') {
      await interaction.deferReply({ ephemeral: true });

      if (!MU_ID) {
        await interaction.editReply('❌ MU_ID non configurato!');
        return;
      }

      try {
        const dataInput = interaction.options.getString('data');
        const data = parseItalianDate(dataInput);
        if (!data) {
          await interaction.editReply('❌ Formato data non valido. Usa GG-MM-AAAA (es. 06-09-2026)');
          return;
        }

        const mu = await warera.getMuById(MU_ID);
        const members = [];
        for (const memberId of (mu.members || [])) {
          members.push(await getMemberStats(memberId));
          await new Promise(r => setTimeout(r, 250));
        }

        const reportData = {
          date: data,
          timestamp: new Date().toISOString(),
          mu: {
            id: MU_ID,
            name: mu.name,
            country: mu.country,
            memberCount: mu.members?.length || 0,
            weeklyDamage: mu.rankings?.muWeeklyDamages?.value || 0,
            totalDamage: mu.rankings?.muDamages?.value || 0,
            reputation: mu.mercenaryReputation || 0,
          },
          members: members.map(m => ({
            userId: m.userId,
            username: m.username,
            weeklyDamage: m.weeklyDamage,
            totalDamage: m.totalDamage,
            wealth: m.wealth,
            totalBounty: m.totalBounty,
          }))
        };

        const reportsPath = './reports.json';
        let reports = [];
        if (fs.existsSync(reportsPath)) {
          const content = fs.readFileSync(reportsPath, 'utf8');
          reports = JSON.parse(content);
        }
        
        const existingIndex = reports.findIndex(r => r.date === data);
        if (existingIndex >= 0) {
          reports[existingIndex] = reportData;
        } else {
          reports.push(reportData);
        }
        fs.writeFileSync(reportsPath, JSON.stringify(reports, null, 2));

        await interaction.editReply(`✅ Report salvato con successo per la data **${formatItalianDate(data)}**! Ora puoi usare \`/confronta\`.`);
      } catch (err) {
        await interaction.editReply(`❌ ${err.message}`);
      }
    }

    // ---------------- COMANDO /CONTRATTO -----------------------------------
    if (interaction.commandName === 'contratto') {
      await interaction.deferReply();
      try {
        const soglia = interaction.options.getNumber('soglia');
        const data = await warera.getMercenaryContracts(50);
        let items = (data.items ?? []).filter((c) => c.status === 'active');
        if (soglia != null) items = items.filter((c) => c.currentPerK >= soglia);
        items.sort((a, b) => b.currentPerK - a.currentPerK);
        items = items.slice(0, 10);

        if (items.length === 0) {
          await interaction.editReply(
            soglia != null
              ? `Nessun contratto attivo trovato sopra ${soglia}/k danni.`
              : 'Nessun contratto attivo al momento.',
          );
          return;
        }

        const nazioni = await Promise.all(items.map((c) => resolveCountryName(c.forCountry)));

        const embed = new EmbedBuilder()
          .setTitle('💰 Contratti mercenari attivi')
          .setColor(0x2b6cb0)
          .setDescription(
            soglia != null
              ? `Soglia minima: **${soglia}/k danni** — ordinati per prezzo/k decrescente`
              : 'Tutti i contratti attivi, ordinati per prezzo/k decrescente',
          );

        items.forEach((c, i) => {
          const lato = c.forCountrySide === 'attacker' ? 'Attaccante' : 'Difensore';
          const scade = formatRelativeExpiry(c.expiresAt);
          embed.addFields({
            name: `${nazioni[i]} — ${lato}`,
            value:
              `Prezzo: **${c.currentPerK.toFixed(3)}/k** · Danni min: ${numberFmt(c.minimumDamage)} · ` +
              `Payout: ${numberFmt(c.currentPayout)} · ${c.professionalsOnly ? 'Solo pro' : 'Aperto a tutti'} · Scade ${scade}`,
          });
        });

        await interaction.editReply({ embeds: [embed] });
      } catch (err) {
        await interaction.editReply(`❌ ${err.message}`);
      }
    }

    // ---------------- COMANDO /CLASSIFICA -----------------------------------
    if (interaction.commandName === 'classifica') {
      await interaction.deferReply({ ephemeral: true });
      try {
        if (!MU_ID) {
          await interaction.editReply('❌ MU_ID non configurato!');
          return;
        }
        if (!LEADERBOARD_CHANNEL_ID) {
          await interaction.editReply('❌ LEADERBOARD_CHANNEL_ID non configurato!');
          return;
        }
        await sendLeaderboard();
        await interaction.editReply(`✅ Classifica aggiornata in <#${LEADERBOARD_CHANNEL_ID}>.`);
      } catch (err) {
        await interaction.editReply(`❌ ${err.message}`);
      }
    }

  } catch (err) {
    console.error(err);
    const msg = `Errore nel contattare WarEra: ${err.message}`;
    if (interaction.deferred || interaction.replied) {
      await interaction.editReply(msg);
    } else {
      await interaction.reply({ content: msg, ephemeral: true });
    }
  }
});

// --- 4. Avvio ---------------------------------------------------------------

(async () => {
  await registerCommands();
  await client.login(DISCORD_TOKEN);
})();