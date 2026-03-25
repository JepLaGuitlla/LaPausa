// scripts/engine.js — La Pausa Fantasy
// ─────────────────────────────────────────────────────────────────
// Motor analítico puro. Sin DOM. Sin render.
// Todas las funciones reciben los datos como parámetros.
// Depende de: nada. Es el núcleo independiente.
// ─────────────────────────────────────────────────────────────────

'use strict';

// ══════════════════════════════════════════════════════════════════
// HELPERS INTERNOS
// ══════════════════════════════════════════════════════════════════

function _getPriceRange(price) {
  const m = price / 1000000;
  if (m < 0.15) return null;
  if (m < 1)    return '0.15-1M';
  if (m < 3)    return '1-3M';
  if (m < 6)    return '3-6M';
  if (m < 12)   return '6-12M';
  return '+12M';
}

// Pesos degradados jForm — la jornada más reciente pesa más
const JFORM_PESOS = [1.0, 0.8, 0.6, 0.4, 0.2];

// ── Media real combinada: 60% temporada + 40% jForm ponderada ────
function calcMediaReal(player) {
  const pj           = (player.playedHome || 0) + (player.playedAway || 0);
  const mediaTemporada = pj > 0 ? (player.pts || player.points || 0) / pj : null;

  const jForm  = (player.jForm || []).slice(0, 5);
  const validos = jForm
    .map((v, i) => ({ v, peso: JFORM_PESOS[i] }))
    .filter(x => x.v !== null && x.v !== undefined && x.v >= 0);

  if (validos.length < 3) return mediaTemporada;

  const sumPesos  = validos.reduce((s, x) => s + x.peso, 0);
  const mediaJForm = validos.reduce((s, x) => s + x.v * x.peso, 0) / sumPesos;

  if (mediaTemporada === null) return mediaJForm;
  return mediaTemporada * 0.6 + mediaJForm * 0.4;
}

// ══════════════════════════════════════════════════════════════════
// 1. EFICIENCIA
// Compara la media real de un jugador con la media esperada
// para jugadores de su misma posición y rango de precio.
// Devuelve % sobre/bajo la media esperada (ej: +32 = 32% mejor)
// ══════════════════════════════════════════════════════════════════

function calcMediasEsperadas(players) {
  const grupos = {};
  players.forEach(p => {
    const pos   = (p.position || p.pos || '').toString().split('/')[0];
    const rango = _getPriceRange(p.price);
    if (!pos || !rango) return;
    const jForm = (p.jForm || []).filter(v => v !== null && v !== undefined && v >= 0);
    if (jForm.length < 5) return;
    const media = jForm.reduce((s, v) => s + v, 0) / jForm.length;
    const key   = `${pos}_${rango}`;
    if (!grupos[key]) grupos[key] = [];
    grupos[key].push(media);
  });

  const medias = {};
  Object.entries(grupos).forEach(([key, vals]) => {
    medias[key] = vals.reduce((s, v) => s + v, 0) / vals.length;
  });
  return medias;
}

function calcEficiencia(player, mediasEsperadas) {
  const pos   = (player.position || player.pos || '').toString().split('/')[0];
  const rango = _getPriceRange(player.price);
  if (!pos || !rango) return null;

  const jForm = (player.jForm || []).filter(v => v !== null && v !== undefined && v >= 0);
  if (jForm.length < 5) return null;

  const mediaReal     = jForm.reduce((s, v) => s + v, 0) / jForm.length;
  const key           = `${pos}_${rango}`;
  const mediaEsperada = mediasEsperadas[key];
  if (!mediaEsperada || mediaEsperada === 0) return null;

  return Math.round(((mediaReal - mediaEsperada) / mediaEsperada) * 100);
}

// ══════════════════════════════════════════════════════════════════
// 2. PRECIO JUSTO
// Curva gaussiana σ=2M€. Compara contra todos de misma posición
// ponderando por proximidad de precio.
// precio_justo = media_real × (precio_medio_ponderado / media_media_ponderada)
// ══════════════════════════════════════════════════════════════════

const SIGMA_M = 2.0;

function calcPrecioJusto(player, allPlayers) {
  const pos = (player.position || player.pos || '').toString().split('/')[0];
  if (!pos || pos === 'MD' || pos === '?') return null;
  if (!player.price || player.price < 500000) return null;

  const mediaReal = calcMediaReal(player);
  if (!mediaReal || mediaReal <= 0) return null;

  const precioM    = player.price / 1e6;
  const candidatos = allPlayers.filter(p => {
    if (p.id === player.id) return false;
    const pPos = (p.position || p.pos || '').toString().split('/')[0];
    if (pPos !== pos) return false;
    if (!p.price || p.price < 1e6) return false;
    const med = calcMediaReal(p);
    return med !== null && med > 0;
  });

  if (candidatos.length < 3) return null;

  let sumPesosPrecio = 0, sumPesosMedia = 0, sumPesos = 0;
  candidatos.forEach(p => {
    const pM   = p.price / 1e6;
    const med  = calcMediaReal(p);
    if (!med || med <= 0) return;
    const dist = Math.abs(pM - precioM);
    const peso = Math.exp(-(dist * dist) / (2 * SIGMA_M * SIGMA_M));
    sumPesosPrecio += pM  * peso;
    sumPesosMedia  += med * peso;
    sumPesos       += peso;
  });

  if (sumPesos < 0.1 || sumPesosMedia < 0.01) return null;

  const precioMedioPond  = sumPesosPrecio / sumPesos;
  const mediaMediaPond   = sumPesosMedia  / sumPesos;
  const ratioPrecioMedia = precioMedioPond / mediaMediaPond;
  const precioJusto      = Math.round(mediaReal * ratioPrecioMedia * 1e6);
  const difEuros         = precioJusto - player.price;
  const difPct           = Math.round((difEuros / player.price) * 100);

  return {
    precioJusto,
    difEuros,
    difPct,
    mediaReal:        Math.round(mediaReal * 10) / 10,
    ratioPrecioMedia: Math.round(ratioPrecioMedia * 100) / 100,
    n:                candidatos.length,
  };
}

// ══════════════════════════════════════════════════════════════════
// 3. ESTADO DE MERCADO
// Cruza infravaloración con reacción del mercado (prices history)
// Señales: VENTA OBLIGATORIA, DESPERTAR, HYPE, EXPLOSIÓN,
//          COMPRAR YA, INERCIA OCULTA, DESPLOME
// ══════════════════════════════════════════════════════════════════

function calcEstadoMercado(player, allPlayers, pricesData) {
  if (!player.price || player.price < 150000) return null;

  const jForm       = (player.jForm || []).slice(0, 5);
  const ultimaJ     = jForm[0];
  const penultimaJ  = jForm[1];

  const ultimas2SinPuntuar = (ultimaJ === null || ultimaJ === undefined || ultimaJ <= 0) &&
                             (penultimaJ === null || penultimaJ === undefined || penultimaJ <= 0);
  const ultimas2SinJugar   = (ultimaJ === null || ultimaJ === undefined) &&
                             (penultimaJ === null || penultimaJ === undefined);
  const ultimaDecisionTecnica = ultimaJ === 0;

  // 🚨 VENTA OBLIGATORIA
  if (ultimas2SinPuntuar && player.trend < 0) {
    const jugoYFallo = ultimaJ === 0 || penultimaJ === 0;
    return {
      estado: 'venta', icono: '🚨', label: 'VENTA OBLIGATORIA',
      desc: jugoYFallo
        ? `0 puntos en las últimas 2 jornadas y precio cayendo (▼${Math.abs(Math.round(player.trend/1000))}K€). Rendimiento nulo — vende ya.`
        : `Sin datos las últimas 2 jornadas y precio bajando. Vende antes de que siga cayendo.`,
      colorFondo: 'rgba(239,68,68,0.15)', colorTexto: '#ef4444',
    };
  }

  // 👁️ DESPERTAR
  if (ultimas2SinJugar && player.trend > 10000) {
    return {
      estado: 'despertar', icono: '👁️', label: 'DESPERTAR',
      desc: `Sin jugar las últimas 2 jornadas pero el mercado se mueve (▲${Math.round(player.trend/1000)}K€). Anticipa su vuelta.`,
      colorFondo: 'rgba(168,85,247,0.1)', colorTexto: '#a855f7',
    };
  }

  if (ultimaDecisionTecnica) return null;

  const jornadasConPuntos = jForm.filter(v => v !== null && v !== undefined && v > 0).length;
  if (jornadasConPuntos < 3) return null;

  const mediaMinAbsoluta = 3;
  const mediaJForm = jForm.map(v => v === null || v === undefined ? 0 : v)
    .reduce((s, v) => s + v, 0) / Math.max(jForm.length, 1);
  if (mediaJForm < mediaMinAbsoluta) return null;

  // Momentum de mercado
  const priceHistory = (pricesData || {})[String(player.id)] || [];
  let mom7 = 0, diasSubiendo = 0;

  if (priceHistory.length >= 2) {
    const last  = priceHistory[priceHistory.length - 1]?.p || player.price;
    const prev7 = priceHistory[Math.max(0, priceHistory.length - 8)]?.p || last;
    mom7 = prev7 > 0 ? ((last - prev7) / prev7) * 100 : 0;
    for (let i = priceHistory.length - 1; i > 0; i--) {
      if ((priceHistory[i]?.p || 0) > (priceHistory[i-1]?.p || 0)) diasSubiendo++;
      else break;
    }
  } else {
    mom7 = player.trend > 0 ? (player.trend / player.price) * 100 * 5 : 0;
    diasSubiendo = player.trend > 0 ? 1 : 0;
  }

  // Umbrales adaptativos por precio
  const precioM = player.price / 1e6;
  let umbralDormido, umbralReaccionando;
  if      (precioM < 0.5)  { umbralDormido = 25;  umbralReaccionando = 80; }
  else if (precioM < 1.0)  { umbralDormido = 15;  umbralReaccionando = 60; }
  else if (precioM < 1.5)  { umbralDormido = 10;  umbralReaccionando = 50; }
  else if (precioM < 2.0)  { umbralDormido = 8;   umbralReaccionando = 40; }
  else if (precioM < 5.0)  { umbralDormido = 3;   umbralReaccionando = 25; }
  else if (precioM < 15.0) { umbralDormido = 1.5; umbralReaccionando = 15; }
  else                     { umbralDormido = 0.8;  umbralReaccionando = 8;  }

  const mercadoDormido      = mom7 < umbralDormido;
  const mercadoReaccionando = mom7 >= umbralReaccionando;
  const mercadoBajando      = mom7 < -umbralDormido || (priceHistory.length < 2 && player.trend < -10000);

  const mediasEsp  = calcMediasEsperadas(allPlayers);
  const efic       = calcEficiencia(player, mediasEsp);
  const pj         = calcPrecioJusto(player, allPlayers);
  const margenPJ   = pj ? ((pj.precioJusto - player.price) / player.price) * 100 : null;
  const hayMargen  = margenPJ !== null && margenPJ > 30;
  const estaCaroPJ = margenPJ !== null && margenPJ < -20;

  const recientes  = jForm.slice(0, 2).filter(v => v !== null && v !== undefined);
  const anteriores = jForm.slice(2, 5).filter(v => v !== null && v !== undefined);
  const mediaRec   = recientes.length  ? recientes.reduce((s,v)=>s+v,0)  / recientes.length  : 0;
  const mediaAnt   = anteriores.length ? anteriores.reduce((s,v)=>s+v,0) / anteriores.length : 0;
  const mejorando  = mediaRec > mediaAnt * 1.2;

  // 🎭 HYPE
  if (mercadoReaccionando && mediaJForm < 6 && (estaCaroPJ || (efic !== null && efic < 5))) {
    return {
      estado: 'hype', icono: '🎭', label: 'HYPE',
      desc: `Subida fuerte (+${mom7.toFixed(1)}% en 7 días) sin rendimiento que la justifique (media 5J: ${mediaJForm.toFixed(1)} pts). Riesgo de corrección.`,
      colorFondo: 'rgba(239,68,68,0.1)', colorTexto: 'var(--red)',
    };
  }

  // 💥 EXPLOSIÓN
  if (mercadoReaccionando && (efic === null || efic > 5) && (hayMargen || efic > 10 || mediaJForm >= 6)) {
    return {
      estado: 'explosion', icono: '💥', label: 'EXPLOSIÓN',
      desc: `Subida fuerte (+${mom7.toFixed(1)}% en 7 días) respaldada por rendimiento real${efic !== null ? ` (+${efic}% sobre lo esperado)` : ` (media ${mediaJForm.toFixed(1)} pts)`}. ${hayMargen ? `Margen hasta precio justo: +${margenPJ?.toFixed(0)}%.` : ''}`,
      colorFondo: 'rgba(251,146,60,0.12)', colorTexto: '#fb923c',
    };
  }

  // 📈 COMPRAR YA
  if (mejorando && mercadoReaccionando && (efic === null || efic > 0)) {
    return {
      estado: 'rebote', icono: '📈', label: 'COMPRAR YA',
      desc: `Rendimiento mejorando (⌀${mediaRec.toFixed(1)} vs ⌀${mediaAnt.toFixed(1)} anterior). Mercado reconociéndolo (+${mom7.toFixed(1)}% en 7 días). Momento de entrar.`,
      colorFondo: 'rgba(34,197,94,0.1)', colorTexto: 'var(--green)',
    };
  }

  // 💎 INERCIA OCULTA
  if (hayMargen && mom7 >= 0 && (efic === null || efic > 10)) {
    return {
      estado: 'joya', icono: '💎', label: 'INERCIA OCULTA',
      desc: `Rinde${efic !== null ? ` +${efic}%` : ''} sobre lo esperado para su precio. El mercado aún no reacciona. Precio justo: ${pj ? (pj.precioJusto/1e6).toFixed(2)+'M€' : '—'} · Margen: +${margenPJ?.toFixed(0)}%.`,
      colorFondo: 'rgba(99,102,241,0.15)', colorTexto: '#818cf8',
    };
  }

  // 📉 DESPLOME
  if (mercadoBajando && (efic === null || efic < 0)) {
    const pjug    = (player.playedHome || 0) + (player.playedAway || 0);
    const mediaTp = pjug > 0 ? ((player.pts || 0) / pjug).toFixed(1) : '—';
    return {
      estado: 'desplome', icono: '📉', label: 'DESPLOME',
      desc: `Media 5J: ${mediaJForm.toFixed(1)} pts · Media temporada: ${mediaTp} pts. Mercado castigando${efic !== null ? ` · rinde ${efic}% bajo lo esperado` : ''}. Momento de vender.`,
      colorFondo: 'rgba(239,68,68,0.08)', colorTexto: '#f87171',
    };
  }

  return null;
}

// ══════════════════════════════════════════════════════════════════
// 4. SISTEMA DE RECOMENDACIONES
// Score 0-99 combinando: racha (30%), factor partido (25%),
// ROI reciente (20%), momentum precio (10%), penalizaciones (15%)
// ══════════════════════════════════════════════════════════════════

function calcRecomendacion(player, allPlayers, pricesData) {
  if (!player || !player.price || player.price < 300000) return null;
  if (player.status === 'injured' || player.status === 'sanctioned') return null;

  let score = 0;
  const reasons  = [];
  const warnings = [];

  const jForm = (player.jForm || []).filter(v => v !== null && v !== undefined);
  const last3 = jForm.slice(0, 3);
  const last5 = jForm.slice(0, 5);

  // 1. Racha últimas 3J (30%)
  if (last3.length >= 2) {
    const avg3 = last3.reduce((s,v) => s+v, 0) / last3.length;
    const avg5 = last5.length ? last5.reduce((s,v) => s+v, 0) / last5.length : avg3;
    score += Math.min(30, (avg3 / 10) * 30);
    if      (avg3 >= 8) reasons.push(`racha élite ⌀${avg3.toFixed(1)} últimas ${last3.length}J`);
    else if (avg3 >= 6) reasons.push(`buena racha ⌀${avg3.toFixed(1)} últimas ${last3.length}J`);
    if (avg3 < avg5 - 1.5) warnings.push('forma bajando respecto a su media');
    if (last3.length === 3 && last3.every(v => v >= 5)) { score += 5; reasons.push('consistente — nunca baja de 5'); }
  }

  // 2. ROI reciente (20%)
  const precioM      = player.price / 1e6;
  const ptsRecientes = last5.reduce((s, v) => s + (v > 0 ? v : 0), 0);
  const roiReciente  = last5.length ? (ptsRecientes / last5.length) / precioM : 0;
  if (roiReciente > 0) {
    score += Math.min(20, (roiReciente / 3) * 20);
    if      (roiReciente >= 2)   reasons.push(`ROI excelente ${roiReciente.toFixed(1)} pts/M€/J`);
    else if (roiReciente >= 1.2) reasons.push(`buen ROI ${roiReciente.toFixed(1)} pts/M€/J`);
  }

  // 3. Momentum precio (10%)
  const priceHistory = (pricesData || {})[String(player.id)] || [];
  if (priceHistory.length >= 3) {
    const last  = priceHistory[priceHistory.length - 1]?.p || player.price;
    const prev7 = priceHistory[Math.max(0, priceHistory.length - 8)]?.p || last;
    const mom7  = prev7 > 0 ? ((last - prev7) / prev7) * 100 : 0;
    let diasSubiendo = 0;
    for (let i = priceHistory.length - 1; i > 0; i--) {
      if ((priceHistory[i]?.p || 0) > (priceHistory[i-1]?.p || 0)) diasSubiendo++;
      else break;
    }
    if (mom7 > 3) {
      score += Math.min(10, (mom7 / 10) * 10);
      if (diasSubiendo >= 4) reasons.push(`subiendo ${diasSubiendo} días consecutivos (+${mom7.toFixed(1)}% en 7 días)`);
      else if (mom7 >= 5)    reasons.push(`momentum fuerte +${mom7.toFixed(1)}% en 7 días`);
      else                   reasons.push(`precio en alza +${mom7.toFixed(1)}% en 7 días`);
    } else if (mom7 < -3) {
      score -= 5;
      warnings.push(`precio cayendo ${mom7.toFixed(1)}% en 7 días`);
    }
  } else {
    if (player.trend > 0) {
      score += Math.min(10, (player.trend / 200000) * 10);
      if (player.trend >= 100000) reasons.push(`precio subiendo ▲${(player.trend/1000).toFixed(0)}K€`);
    } else if (player.trend < -50000) {
      score -= 5;
      warnings.push(`precio bajando ▼${Math.abs(player.trend/1000).toFixed(0)}K€`);
    }
  }

  // 4. Penalizaciones (15%)
  if (player.status === 'doubt')      { score -= 15; warnings.push('en duda para el próximo partido'); }

  // 5. Estado de mercado como bonus/penalización
  const estado = calcEstadoMercado(player, allPlayers, pricesData);
  if (estado) {
    if (['explosion','rebote','joya'].includes(estado.estado)) score += 10;
    if (['hype','desplome','venta'].includes(estado.estado))   score -= 10;
  }

  if (score < 35) return null;

  return {
    player,
    score:       Math.round(Math.min(99, Math.max(0, score))),
    reasons,
    warnings,
    roiReciente,
    estado,
  };
}

// ══════════════════════════════════════════════════════════════════
// 5. RANKINGS
// ══════════════════════════════════════════════════════════════════

function calcRankingEficientes(players) {
  const mediasEsp  = calcMediasEsperadas(players);
  const MIN_PJ     = 8;
  const MIN_PTS    = 60;

  return players
    .filter(p => {
      const pj = (p.playedHome || 0) + (p.playedAway || 0);
      return p.price > 0 && (p.pts || 0) >= MIN_PTS && pj >= MIN_PJ;
    })
    .map(p => {
      const pj     = (p.playedHome || 0) + (p.playedAway || 0);
      const media  = pj > 0 ? (p.pts || 0) / pj : 0;
      const precioM = p.price / 1e6;
      const score  = (media * 0.5) + ((p.pts / precioM) * 0.3);
      const efic   = calcEficiencia(p, mediasEsp);
      return { ...p, media, score, efic };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
}

function calcRankingChollos(players) {
  return players
    .filter(p => p.price > 0 && (p.price / 1e6) <= 5 && (p.pts || 0) >= 40)
    .map(p => {
      const pj    = (p.playedHome || 0) + (p.playedAway || 0);
      const media = pj > 0 ? (p.pts || 0) / pj : 0;
      const score = media * 2 + ((p.pts || 0) / (p.price / 1e6));
      return { ...p, media, score };
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 15);
}

function calcRankingInfravalorados(players) {
  const mediasEsp = calcMediasEsperadas(players);
  return players
    .map(p => ({ ...p, efic: calcEficiencia(p, mediasEsp) }))
    .filter(p => p.efic !== null && p.efic > 0)
    .sort((a, b) => b.efic - a.efic)
    .slice(0, 15);
}

function calcRankingSobrevalorados(players) {
  const mediasEsp = calcMediasEsperadas(players);
  return players
    .map(p => ({ ...p, efic: calcEficiencia(p, mediasEsp) }))
    .filter(p => p.efic !== null && p.efic < 0)
    .sort((a, b) => a.efic - b.efic)
    .slice(0, 15);
}

// ══════════════════════════════════════════════════════════════════
// EXPORTS — disponibles globalmente en el browser
// ══════════════════════════════════════════════════════════════════

window.Engine = {
  calcMediaReal,
  calcMediasEsperadas,
  calcEficiencia,
  calcPrecioJusto,
  calcEstadoMercado,
  calcRecomendacion,
  calcRankingEficientes,
  calcRankingChollos,
  calcRankingInfravalorados,
  calcRankingSobrevalorados,
};
