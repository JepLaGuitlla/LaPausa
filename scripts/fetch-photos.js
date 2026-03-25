// scripts/fetch-photos.js
// ─────────────────────────────────────────────────────
// Descarga las fotos de todos los jugadores desde
// Biwenger CDN y las guarda en img/players/{id}.avif
//
// Se ejecuta desde GitHub Actions, no toca nada más.
// Solo descarga fotos que no existan todavía.
// ─────────────────────────────────────────────────────

const https = require('https');
const fs    = require('fs');
const path  = require('path');

const DATA_FILE  = 'data/data.json';
const OUTPUT_DIR = 'img/players';
const CDN_BASE   = 'https://cf.biwenger.com/img/players/large';
const DELAY_MS   = 80;   // pausa entre descargas para no saturar el CDN
const MAX_ERRORS = 20;   // si hay muchos errores consecutivos, para

// ── Crear carpeta si no existe ────────────────────────
if (!fs.existsSync(OUTPUT_DIR)) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  console.log(`📁 Carpeta ${OUTPUT_DIR} creada`);
}

// ── Leer jugadores desde data.json ───────────────────
if (!fs.existsSync(DATA_FILE)) {
  console.error(`❌ No se encontró ${DATA_FILE}. Ejecuta fetch-biwenger.js primero.`);
  process.exit(1);
}

const raw     = fs.readFileSync(DATA_FILE, 'utf8');
const json    = JSON.parse(raw);
const players = json.players || [];

if (!players.length) {
  console.error('❌ No hay jugadores en data.json');
  process.exit(1);
}

console.log(`📸 ${players.length} jugadores encontrados`);

// ── Filtrar los que ya tienen foto ───────────────────
const pending = players.filter(p => {
  const file = path.join(OUTPUT_DIR, `${p.id}.avif`);
  return !fs.existsSync(file);
});

console.log(`⬇️  ${pending.length} fotos nuevas para descargar (${players.length - pending.length} ya existían)`);

if (pending.length === 0) {
  console.log('✅ Todas las fotos ya estaban descargadas');
  process.exit(0);
}

// ── Descarga individual ───────────────────────────────
function downloadPhoto(playerId) {
  return new Promise((resolve) => {
    const url      = `${CDN_BASE}/${playerId}.avif`;
    const filePath = path.join(OUTPUT_DIR, `${playerId}.avif`);

    const req = https.get(url, {
      timeout: 10000,
      headers: {
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept':          'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        'Accept-Language': 'es-ES,es;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Referer':         'https://biwenger.as.com/',
        'Origin':          'https://biwenger.as.com',
        'Sec-Fetch-Dest':  'image',
        'Sec-Fetch-Mode':  'no-cors',
        'Sec-Fetch-Site':  'cross-site',
      }
    }, (res) => {
      if (res.statusCode === 200) {
        const chunks = [];
        res.on('data', chunk => chunks.push(chunk));
        res.on('end', () => {
          fs.writeFileSync(filePath, Buffer.concat(chunks));
          resolve({ ok: true, id: playerId });
        });
      } else {
        // Foto no disponible en el CDN (jugador sin foto) — no es error grave
        resolve({ ok: false, id: playerId, status: res.statusCode });
      }
    });

    req.on('error', (err) => {
      resolve({ ok: false, id: playerId, error: err.message });
    });

    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, id: playerId, error: 'timeout' });
    });
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// ── Loop principal ────────────────────────────────────
async function run() {
  let ok = 0, skip = 0, errors = 0, consecutive = 0;

  for (let i = 0; i < pending.length; i++) {
    const p      = pending[i];
    const result = await downloadPhoto(p.id);

    if (result.ok) {
      ok++;
      consecutive = 0;
      if (ok % 50 === 0) console.log(`  ✅ ${ok} descargadas...`);
    } else {
      skip++;
      consecutive++;
      if (consecutive >= MAX_ERRORS) {
        console.error(`❌ ${MAX_ERRORS} errores consecutivos — posible bloqueo del CDN. Parando.`);
        break;
      }
    }

    // Pequeña pausa para no saturar
    if (i < pending.length - 1) await sleep(DELAY_MS);
  }

  console.log(`\n📸 Resultado:`);
  console.log(`   ✅ Descargadas:      ${ok}`);
  console.log(`   ⏭️  Sin foto en CDN:  ${skip}`);
  console.log(`   📁 Total en carpeta: ${fs.readdirSync(OUTPUT_DIR).length}`);
}

run().catch(err => {
  console.error('❌ Error inesperado:', err.message);
  process.exit(1);
});
