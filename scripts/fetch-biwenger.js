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

const https   = require('https');
const fs      = require('fs');
const crypto  = require('crypto');

const EMAIL    = process.env.BIWENGER_EMAIL;
const PASSWORD = process.env.BIWENGER_PASSWORD;
const VERSION  = '630';
const FD_TOKEN = '00308a91cfc84b248611ecc22550c9de';

// Liga privada de amigos (TOMAQUET) dentro de Biwenger. x-user es obligatorio
// en las llamadas de liga privada (400 sin él, aunque el login sea correcto).
const LEAGUE_ID = '44700';
const LEAGUE_USER_ID = '6541195';

// Cuenta de servicio de Firebase, con permiso limitado a Realtime Database,
// para escribir directamente liga/2026-27/managers sin pasar por la app.
// Secret opcional: si no está, se salta esa parte sin romper el resto.
const FIREBASE_SERVICE_ACCOUNT_JSON = process.env.FIREBASE_SERVICE_ACCOUNT || '';
const FIREBASE_DB_URL = 'https://tomaquet-56585-default-rtdb.europe-west1.firebasedatabase.app';

const RSS_SOURCES = [
  { id:'jp', label:'Jornada Perfecta', url:'https://www.jornadaperfecta.com/feed/' },
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

// ── 1b. RONDA DE LA LIGA PRIVADA (clasificación de la jornada actual) ─
// Reutiliza el token del login de arriba, no hace un segundo login.

async function fetchLeagueRound(token) {
  console.log('🏆 Descargando ronda de la liga privada...');

  const res = await requestJSON({
    hostname: 'biwenger.as.com',
    path:     '/api/v2/rounds/league',
    method:   'GET',
    headers: {
      ...COMMON_HEADERS,
      'Authorization': `Bearer ${token}`,
      'x-league':       LEAGUE_ID,
      'x-user':         LEAGUE_USER_ID,
      'x-lang':          'es',
    }
  });

  if (res.status !== 200) {
    console.warn('⚠️ No se pudo leer la ronda de la liga privada. Status:', res.status);
    return null;
  }

  const roundId   = res.body?.data?.round?.id;
  const standings = res.body?.data?.league?.standings;
  if (!roundId || !Array.isArray(standings) || !standings.length) {
    console.warn('⚠️ Respuesta de ronda de liga sin datos utilizables');
    return null;
  }

  console.log(`✅ Ronda ${roundId} — ${standings.length} managers`);

  return {
    roundId,
    // Orden de clasificación acumulada de la temporada (standings ya viene
    // ordenado por posición).
    standingsOrder: standings.map(s => s.name),
    // Puntos de ESTA ronda concreta por manager (null si aún no se sabe).
    roundPoints: standings.map(s => ({
      name:   s.name,
      points: (s.lineup && typeof s.lineup.points === 'number') ? s.lineup.points : null,
    })),
  };
}

// ── 1c. CAMPEONES DE JORNADA (recuento acumulado, sin mapear nombres) ─
// No sabemos traducir el id de ronda de Biwenger a "jornada N" de LaLiga,
// así que en vez de eso detectamos cuándo la ronda cambia: en ese momento,
// la ronda anterior ya se puede dar por cerrada y se cuenta su 1º/2º/3º.

const JORNADAS_LEAGUE_FILE = 'data/jornadas-biwenger.json';

function updateJornadasLiga(snapshot) {
  let state = { lastSeenRoundId: null, lastRoundPoints: null, processedRounds: [], tally: {} };
  try {
    if (fs.existsSync(JORNADAS_LEAGUE_FILE)) {
      state = Object.assign(state, JSON.parse(fs.readFileSync(JORNADAS_LEAGUE_FILE, 'utf8')));
    }
  } catch (e) {
    console.warn('⚠️ No se pudo leer jornadas-biwenger.json, iniciando desde cero');
  }

  if (!snapshot) {
    fs.writeFileSync(JORNADAS_LEAGUE_FILE, JSON.stringify(state, null, 2), 'utf8');
    return;
  }

  const roundChanged = state.lastSeenRoundId != null && state.lastSeenRoundId !== snapshot.roundId;
  const alreadyDone  = state.processedRounds.includes(state.lastSeenRoundId);

  if (roundChanged && !alreadyDone && state.lastRoundPoints) {
    const top3 = state.lastRoundPoints
      .filter(m => typeof m.points === 'number')
      .sort((a, b) => b.points - a.points)
      .slice(0, 3);

    top3.forEach((m, i) => {
      if (!state.tally[m.name]) state.tally[m.name] = [0, 0, 0];
      state.tally[m.name][i]++;
    });

    state.processedRounds.push(state.lastSeenRoundId);
    state.lastClosed = { roundId: state.lastSeenRoundId, top3, closedAt: new Date().toISOString() };
    console.log(`🏅 Ronda ${state.lastSeenRoundId} cerrada — 1º ${top3[0]?.name || '—'} · 2º ${top3[1]?.name || '—'} · 3º ${top3[2]?.name || '—'}`);
  }

  state.lastSeenRoundId  = snapshot.roundId;
  state.lastRoundPoints  = snapshot.roundPoints;
  state.updatedAt        = new Date().toISOString();

  fs.writeFileSync(JORNADAS_LEAGUE_FILE, JSON.stringify(state, null, 2), 'utf8');
  console.log(`💾 ${JORNADAS_LEAGUE_FILE} guardado (ronda actual: ${snapshot.roundId})`);
}

// ── 1d. ESPEJO DE NOMBRES EN FIREBASE (liga/2026-27/managers) ────────
// Escribe directo en Realtime Database con una cuenta de servicio propia,
// limitada solo a Realtime Database. Si el secret no está puesto, se salta
// sin romper el resto del script.

function base64url(buf) {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getFirebaseAccessToken(serviceAccount) {
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss:   serviceAccount.client_email,
    scope: 'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    aud:   'https://oauth2.googleapis.com/token',
    iat:   now,
    exp:   now + 3600,
  };
  const unsigned = base64url(Buffer.from(JSON.stringify(header))) + '.' + base64url(Buffer.from(JSON.stringify(claims)));
  const signature = crypto.createSign('RSA-SHA256').update(unsigned).sign(serviceAccount.private_key);
  const jwt = unsigned + '.' + base64url(signature);

  const body = 'grant_type=' + encodeURIComponent('urn:ietf:params:oauth:grant-type:jwt-bearer') + '&assertion=' + jwt;
  const res = await requestJSON({
    hostname: 'oauth2.googleapis.com',
    path:     '/token',
    method:   'POST',
    headers:  { 'Content-Type': 'application/x-www-form-urlencoded', 'Content-Length': Buffer.byteLength(body) },
  }, body);

  if (res.status !== 200 || !res.body?.access_token) {
    throw new Error('No se pudo obtener token de Firebase: ' + JSON.stringify(res.body));
  }
  return res.body.access_token;
}

async function writeManagersMirror(standingsOrder) {
  if (!FIREBASE_SERVICE_ACCOUNT_JSON) {
    console.log('ℹ️ Sin FIREBASE_SERVICE_ACCOUNT — no se actualiza el espejo de managers');
    return;
  }
  console.log('🪞 Actualizando espejo de managers en Firebase...');

  try {
    const serviceAccount = JSON.parse(FIREBASE_SERVICE_ACCOUNT_JSON);
    const accessToken     = await getFirebaseAccessToken(serviceAccount);
    const url             = new URL('/liga/2026-27/managers.json', FIREBASE_DB_URL);
    const body             = JSON.stringify(standingsOrder);

    const res = await requestJSON({
      hostname: url.hostname,
      path:     url.pathname,
      method:   'PUT',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type':  'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    }, body);

    if (res.status !== 200) throw new Error('PUT fallo: ' + res.status + ' ' + JSON.stringify(res.body));
    console.log(`✅ Espejo actualizado — ${standingsOrder.length} managers`);
  } catch (e) {
    console.warn('⚠️ No se pudo actualizar el espejo de managers:', e.message);
  }
}

// ── 2. JUGADORES (público, sin auth) ─────────────────

async function fetchPlayers() {
  console.log('📥 Descargando jugadores LaLiga...');

  const res = await request({
    hostname: 'cf.biwenger.com',
    path:     '/api/v2/competitions/la-liga/data?lang=es&score=5',
    method:   'GET',
    headers:  COMMON_HEADERS,
  });

  if (res.status !== 200) {
    console.error('❌ Error jugadores. Status:', res.status);
    process.exit(1);
  }

  // El endpoint devolvía JSONP (envuelto en un callback) y desde 2026-07 pasó
  // a JSON plano. Se prueba JSON directo primero y solo si falla se intenta
  // desenvolver JSONP, por si algún día vuelve a envolver la respuesta.
  let parsed;
  try {
    parsed = JSON.parse(res.raw);
  } catch (e) {
    const match = res.raw.match(/^[^(]+\(([\s\S]*)\)\s*;?\s*$/);
    if (!match) { console.error('❌ No se pudo parsear la respuesta de jugadores'); process.exit(1); }
    try {
      parsed = JSON.parse(match[1]);
    } catch (e2) {
      console.error('❌ No se pudo parsear JSONP'); process.exit(1);
    }
  }

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

    console.log('\n--- Liga privada (TOMAQUET) ---');
    const leagueRound = await fetchLeagueRound(token);
    updateJornadasLiga(leagueRound);
    if (leagueRound) await writeManagersMirror(leagueRound.standingsOrder);

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
