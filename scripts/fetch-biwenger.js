// scripts/fetch-biwenger.js
// ─────────────────────────────────────────────────────
// Descarga datos públicos de LaLiga desde Biwenger:
// - Jugadores (precios, puntos, tendencias, jForm)
// - Histórico de precios (prices.json)
// - Histórico de jornadas por jugador (history.json)
// - Stats de goleadores (football-data.org)
// - Noticias fantasy (RSS)
//
// NO descarga datos de ligas privadas ni equipos personales.
// ─────────────────────────────────────────────────────

'use strict';

const https = require('https');
const fs    = require('fs');

const EMAIL    = process.env.BIWENGER_EMAIL;
const PASSWORD = process.env.BIWENGER_PASSWORD;
const VERSION  = '630';
const FD_TOKEN = '00308a91cfc84b248611ecc22550c9de';

const RSS_SOURCES = [
  { id:'jp', label:'Jornada Perfecta', url:'https://www.jornadaperfecta.com/feed/' },
  { id:'as', label:'AS Fantasy',       url:'https://fantasy.as.com/feed/' },
  { id:'cm', label:'Comuniate',        url:'https://www.comuniate.com/feed/' },
  { id:'rv', label:'Relevo Fantasy',   url:'https://www.relevo.com/rss/noticias/' },
];

if (!EMAIL || !PASSWORD) {
  console.error('❌ Faltan Secrets en GitHub: BIWENGER_EMAIL / BIWENGER_PASSWORD');
  process.exit(1);
}

// ── HELPERS ──────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function request(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, raw: data, headers: res.headers }));
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function requestJSON(options, body = null) {
  return new Promise((resolve, reject) => {
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try   { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

const COMMON_HEADERS = {
  'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Accept':          '*/*',
  'Accept-Language': 'es-ES,es;q=0.9',
  'Origin':          'https://biwenger.as.com',
  'Referer':         'https://biwenger.as.com/',
  'x-version':       VERSION,
};

// ── 1. LOGIN ─────────────────────────────────────────

async function login() {
  console.log('🔐 Login en Biwenger...');
  const payload = JSON.stringify({ email: EMAIL, password: PASSWORD });

  const res = await requestJSON({
    hostname: 'biwenger.as.com',
    path:     '/api/v2/auth/login',
    method:   'POST',
    headers:  {
      ...COMMON_HEADERS,
      'Content-Type':   'application/json',
      'Content-Length': Buffer.byteLength(payload),
    }
  }, payload);

  if (res.status !== 200) {
    console.error('❌ Login fallido. Status:', res.status);
    process.exit(1);
  }

  const token = res.body?.data?.token || res.body?.token;
  if (!token) { console.error('❌ No se encontró token'); process.exit(1); }

  console.log('✅ Login correcto');
  return token;
}

// ── 2. JUGADORES (público, sin auth) ─────────────────

async function fetchPlayers() {
  console.log('📥 Descargando jugadores LaLiga...');

  const cbName = 'jsonp_cb';
  const res = await request({
    hostname: 'cf.biwenger.com',
    path:     `/api/v2/competitions/la-liga/data?lang=es&score=5&callback=${cbName}`,
    method:   'GET',
    headers:  COMMON_HEADERS,
  });

  if (res.status !== 200) {
    console.error('❌ Error jugadores. Status:', res.status);
    process.exit(1);
  }

  const match = res.raw.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
  if (!match) { console.error('❌ No se pudo parsear JSONP'); process.exit(1); }

  const parsed     = JSON.parse(match[1]);
  const rawPlayers = parsed?.data?.players;
  const rawTeams   = parsed?.data?.teams || {};

  if (!rawPlayers) { console.error('❌ Sin jugadores en la respuesta'); process.exit(1); }

  const arr = Array.isArray(rawPlayers) ? rawPlayers : Object.values(rawPlayers);
  console.log(`✅ ${arr.length} jugadores descargados`);

  return arr.map(p => {
    const tid     = p.teamID || null;
    const teamObj = rawTeams[tid] || rawTeams[String(tid)] || null;
    return {
      id:         p.id,
      slug:       p.slug || null,
      name:       p.name,
      position:   p.position,
      price:      p.price          || 0,
      points:     p.points         || 0,
      trend:      p.priceIncrement || 0,
      playedHome: p.playedHome     || 0,
      playedAway: p.playedAway     || 0,
      teamName:   teamObj?.name    || p.teamName || '',
      teamId:     teamObj?.id      || null,
      status:     p.fitness?.[0]?.status || 'ok',
      jForm:      (p.fitness || []).slice(0, 5).map(f =>
        typeof f === 'number' ? f : (f?.points ?? null)
      ),
      clausula: p.clause || null,
    };
  });
}

// ── 3. NOTICIAS RSS ───────────────────────────────────

async function fetchNews() {
  console.log('📰 Descargando noticias fantasy (RSS)...');
  const all = [];

  for (const src of RSS_SOURCES) {
    try {
      const url  = new URL(src.url);
      const res  = await request({
        hostname: url.hostname,
        path:     url.pathname + (url.search || ''),
        method:   'GET',
        timeout:  8000,
        headers:  { 'User-Agent': COMMON_HEADERS['User-Agent'] },
      });

      if (res.status !== 200) continue;

      const items = [...res.raw.matchAll(/<item>([\s\S]*?)<\/item>/g)];
      items.slice(0, 8).forEach(m => {
        const getText = tag => {
          const r = m[1].match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?<\\/${tag}>`));
          return r ? r[1].trim() : '';
        };
        all.push({
          source: src.label,
          title:  getText('title'),
          link:   getText('link'),
          date:   getText('pubDate'),
        });
      });
    } catch(e) {
      console.warn(`⚠️ Error RSS ${src.label}:`, e.message);
    }
  }

  console.log(`✅ ${all.length} noticias descargadas`);
  return all;
}

// ── 4. STATS GOLEADORES (football-data.org) ───────────

async function fetchPlayerStats() {
  console.log('📊 Descargando estadísticas goleadores...');

  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'api.football-data.org',
      path:     '/v4/competitions/PD/scorers?limit=100',
      method:   'GET',
      timeout:  10000,
      headers:  { 'X-Auth-Token': FD_TOKEN },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        if (res.statusCode !== 200) {
          console.warn('⚠️ football-data status:', res.statusCode);
          resolve(null); return;
        }
        try {
          const body    = JSON.parse(data);
          const scorers = body?.scorers || [];
          const players = scorers.map(s => ({
            id:             String(s.player?.id || ''),
            name:           s.player?.name || '',
            team:           s.team?.name || '',
            position:       s.player?.position || '',
            nationality:    s.player?.nationality || '',
            appearances:    parseInt(s.playedMatches) || 0,
            goals:          parseInt(s.goals)         || 0,
            assists:        parseInt(s.assists)        || 0,
            penalties:      parseInt(s.penalties)      || 0,
            minutesPerGoal: (s.goals && s.playedMatches)
              ? Math.round((s.playedMatches * 90) / s.goals) : null,
          }));
          console.log(`✅ ${players.length} goleadores descargados`);
          resolve({ source: 'football-data', updatedAt: new Date().toISOString(), players });
        } catch(e) {
          console.warn('⚠️ Error parseando stats:', e.message);
          resolve(null);
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error',   () => resolve(null));
    req.end();
  });
}

// ── 5. HISTÓRICO DE PRECIOS ───────────────────────────

function updatePlayerPrices(players) {
  const FILE     = 'data/prices.json';
  const MAX_DAYS = 90;
  const today    = new Date().toISOString().slice(0, 10);

  let prices = {};
  try {
    if (fs.existsSync(FILE)) prices = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  } catch(e) {
    console.warn('⚠️ No se pudo leer prices.json, iniciando desde cero');
  }

  let updated = 0;
  for (const p of players) {
    if (!p.id || !p.price) continue;
    const id = String(p.id);
    if (!prices[id]) prices[id] = [];
    const todayIdx = prices[id].findIndex(e => e.d === today);
    const entry = { d: today, p: p.price };
    if (todayIdx >= 0) prices[id][todayIdx] = entry;
    else { prices[id].push(entry); updated++; }
    if (prices[id].length > MAX_DAYS) prices[id] = prices[id].slice(-MAX_DAYS);
  }

  fs.writeFileSync(FILE, JSON.stringify(prices), 'utf8');
  console.log(`💰 prices.json — ${Object.keys(prices).length} jugadores · ${updated} nuevas entradas`);
}

// ── 6. HISTÓRICO DE JORNADAS POR JUGADOR ─────────────

const HISTORY_FILE      = 'data/history.json';
const HISTORY_BATCH     = 50;
const HISTORY_BATCH_SZ  = 2;
const HISTORY_PAUSE     = 2000;

async function fetchPlayerHistory(playerId, token) {
  const path = `/api/v2/players/${playerId}?fields=*,reports(points,home,match(*,round))`;
  return new Promise((resolve) => {
    const req = https.request({
      hostname: 'biwenger.as.com',
      path,
      method:   'GET',
      timeout:  12000,
      headers:  { ...COMMON_HEADERS, 'Authorization': `Bearer ${token}`, 'x-lang': 'es' },
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
      res.on('end', () => {
        if (res.statusCode === 429) { resolve({ rateLimited: true }); return; }
        if (res.statusCode !== 200) { resolve({ rateLimited: false, history: null }); return; }
        try {
          const data    = JSON.parse(raw);
          const reports = data?.data?.reports || [];
          const history = {};
          reports.forEach(r => {
            const round = r.match?.round;
            if (!round) return;
            history[round] = {
              pts:  r.points ?? null,
              home: r.home   ?? null,
            };
          });
          resolve({ rateLimited: false, history });
        } catch(e) {
          resolve({ rateLimited: false, history: null });
        }
      });
    });
    req.on('timeout', () => { req.destroy(); resolve({ rateLimited: false, history: null }); });
    req.on('error',   () => resolve({ rateLimited: false, history: null }));
    req.end();
  });
}

async function updateJornadas(players, token) {
  let jornadas = {};
  try {
    if (fs.existsSync(HISTORY_FILE)) jornadas = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
  } catch(e) {
    console.warn('⚠️ No se pudo leer history.json, iniciando desde cero');
  }

  const pending = players
    .filter(p => p.id && !jornadas[String(p.id)])
    .slice(0, HISTORY_BATCH);

  console.log(`\n📖 Jornadas: ${pending.length} jugadores nuevos (de ${players.length} total)`);
  if (!pending.length) { console.log('✅ Jornadas al día'); return; }

  let done = 0, rateLimited = false;

  for (let i = 0; i < pending.length; i += HISTORY_BATCH_SZ) {
    if (rateLimited) break;
    const batch = pending.slice(i, i + HISTORY_BATCH_SZ);
    const results = await Promise.all(batch.map(p => fetchPlayerHistory(p.id, token)));

    results.forEach((res, j) => {
      if (res.rateLimited) { rateLimited = true; return; }
      if (res.history) {
        jornadas[String(batch[j].id)] = res.history;
        done++;
      }
    });

    if (i + HISTORY_BATCH_SZ < pending.length) await sleep(HISTORY_PAUSE);
  }

  fs.writeFileSync(HISTORY_FILE, JSON.stringify(jornadas), 'utf8');
  console.log(`✅ Jornadas guardadas — ${done} nuevos · ${Object.keys(jornadas).length} total`);
  if (rateLimited) console.warn('⚠️ Rate limit alcanzado — se retomará mañana');
}

// ── MAIN ─────────────────────────────────────────────

async function main() {
  try {
    console.log('🚀 La Pausa Fantasy — Actualizando datos\n');

    // Login necesario para jornadas históricas
    const token   = await login();
    const players = await fetchPlayers();

    console.log('\n--- Datos públicos (paralelo) ---');
    const [news, playerStats] = await Promise.all([
      fetchNews(),
      fetchPlayerStats(),
    ]);

    // Asegurar carpeta data/
    if (!fs.existsSync('data')) fs.mkdirSync('data', { recursive: true });

    const output = {
      updatedAt:   new Date().toISOString(),
      players,
      news,
      playerStats,
    };

    fs.writeFileSync('data/data.json', JSON.stringify(output, null, 2), 'utf8');
    console.log('\n💾 data/data.json guardado');

    updatePlayerPrices(players);
    await updateJornadas(players, token);

    console.log(`\n📊 Jugadores: ${players.length}`);
    console.log(`📰 Noticias:  ${news.length}`);
    console.log(`⚽ Stats:     ${playerStats?.players?.length || 0}`);
    console.log('\n✅ Todo listo');

  } catch(err) {
    console.error('❌ Error inesperado:', err.message);
    process.exit(1);
  }
}

main();
