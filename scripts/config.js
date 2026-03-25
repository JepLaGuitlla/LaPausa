// scripts/config.js — La Pausa Fantasy
// ══════════════════════════════════════════════════════════════
// FUENTE ÚNICA DE VERDAD: constantes, umbrales, pesos.
// Cambiar aquí afecta a todo el proyecto.
// Sin lógica. Sin DOM. Solo datos.
// ══════════════════════════════════════════════════════════════

'use strict';

// ─── LIGAS ───────────────────────────────────────────────────
const LIGAS = {
  tomaquet: { id: '44700',   userId: '6541195',  label: '🍅 Tomaquet', slug: 'tomaquet' },
  enbas:    { id: '1248640', userId: '11504267', label: '⛰️ En Bas',   slug: 'enbas'    },
};

// ─── POSICIONES ───────────────────────────────────────────────
// Colores de posición (badge, campo, gráficos)
const POS_COLORS = {
  PT: '#1d6fce',
  DF: '#16a34a',
  MC: '#d97706',
  DL: '#e63329',
  MD: '#7c3aed',
};

// Mapeo numérico → sigla (Biwenger usa 1–4)
const POS_MAP = { 1: 'PT', 2: 'DF', 3: 'MC', 4: 'DL' };

// ─── PRECIO JUSTO ────────────────────────────────────────────
// Curva gaussiana: sigma de 2M€ para candidatos vecinos
const PJ_SIGMA_M = 2.0;

// Precio mínimo para calcular precio justo
const PJ_PRECIO_MIN = 500_000;

// Mínimo de candidatos para que el cálculo sea fiable
const PJ_MIN_CANDIDATOS = 3;

// ─── JFORM ────────────────────────────────────────────────────
// Pesos degradados para las últimas 5 jornadas (más reciente = más peso)
const JFORM_PESOS = [1.0, 0.8, 0.6, 0.4, 0.2];

// Media real: mix temporada + forma reciente
const JFORM_PESO_TEMPORADA = 0.6;
const JFORM_PESO_FORMA     = 0.4;

// Mínimo de jornadas válidas para usar jForm
const JFORM_MIN_VALIDAS = 3;

// ─── EFICIENCIA ───────────────────────────────────────────────
// Mínimo de jornadas válidas para calcular eficiencia
const EFIC_MIN_JORNADAS = 5;

// Rangos de precio para grupos de eficiencia (en millones €)
const PRICE_RANGES = [
  { key: '0.15-1M',  min: 0.15, max: 1   },
  { key: '1-3M',     min: 1,    max: 3   },
  { key: '3-6M',     min: 3,    max: 6   },
  { key: '6-12M',    min: 6,    max: 12  },
  { key: '+12M',     min: 12,   max: Infinity },
];

// ─── ESTADO DE MERCADO ────────────────────────────────────────
// Umbrales para señales de compra/venta
const MERCADO = {
  // Precio mínimo para calcular estado
  precio_min: 150_000,

  // Tendencia mínima para considerar "mercado sube" (€/día)
  trend_sube_min: 10_000,

  // Media mínima absoluta para señales positivas (pts/J)
  media_min_pts: 3,

  // Mínimo de jornadas con puntos para señales positivas
  min_jornadas_con_puntos: 3,

  // Infravaloración mínima (%) para señal OPORTUNIDAD
  infra_min_pct: 8,

  // Infravaloración fuerte (%) para señal PEPITA
  infra_fuerte_pct: 20,

  // Momentum mínimo (%) en 7 días para señal
  momentum_7d_min: 3,
};

// ─── FACTOR EQUIPO ────────────────────────────────────────────
// Media máxima por posición (para normalizar C3 a /10)
const FE_MEDIA_MAX_POS = { PT: 7.3, DF: 6.7, MC: 7.9, DL: 10.3 };

// Pesos por posición: [win, empate, derrota, base_over25]
const FE_PESOS = {
  PT: { w: 0.80, e: 0.50, l: -0.20, o25base: -0.30 },
  DF: { w: 0.70, e: 0.40, l: -0.10, o25base:  0.00 },
  MC: { w: 0.60, e: 0.30, l:  0.00, o25base:  0.20 },
  DL: { w: 0.50, e: 0.10, l:  0.00, o25base:  0.40 },
};

// Ponderación de componentes del Factor Equipo
const FE_PONDER = { c1: 0.50, c2: 0.30, c3: 0.20 };

// ─── RECOMENDACIONES ──────────────────────────────────────────
// Score mínimo para mostrar recomendación
const REC_SCORE_MIN = 35;

// Precio mínimo del jugador para calcular recomendación
const REC_PRECIO_MIN = 300_000;

// Ponderaciones del score (deben sumar 100)
const REC_PESOS = {
  racha:    30,
  fe:       25,
  roi:      20,
  momentum: 10,
  estado:   15, // penalizaciones
};

// ─── COMODINES ────────────────────────────────────────────────
const COMODIN_PRECIO_MAX = 1_500_000;
const COMODIN_MEDIA_MIN  = 2;
const COMODIN_JF_MIN     = 3;

// ─── UI / PAGINACIÓN ─────────────────────────────────────────
const ROWS_PER_PAGE = 50;

// Número de jugadores en los slots de ranking cards
const RANK_CARD_SLOTS = 5;

// ─── COLORES DE PUNTUACIÓN (jForm dots) ──────────────────────
const SCORE_COLORS = {
  top:  'var(--c-top)',   // >= 10
  good: 'var(--c-good)',  // >= 6
  mid:  'var(--c-mid)',   // >= 3
  low:  'var(--c-low)',   // < 3
};

// ─── DATOS / RUTAS ───────────────────────────────────────────
const DATA_PATHS = {
  tomaquet: {
    data:    './data/tomaquet/data.json',
    prices:  './data/tomaquet/prices.json',
    history: './data/tomaquet/history.json',
  },
  enbas: {
    data:    './data/enbas/data.json',
    prices:  './data/enbas/prices.json',
    history: './data/enbas/history.json',
  },
};

// ─── EXPOSICIÓN GLOBAL ───────────────────────────────────────
// Todo en un objeto para no contaminar el scope global
window.LP_CONFIG = {
  LIGAS, POS_COLORS, POS_MAP,
  PJ_SIGMA_M, PJ_PRECIO_MIN, PJ_MIN_CANDIDATOS,
  JFORM_PESOS, JFORM_PESO_TEMPORADA, JFORM_PESO_FORMA, JFORM_MIN_VALIDAS,
  EFIC_MIN_JORNADAS, PRICE_RANGES,
  MERCADO,
  FE_MEDIA_MAX_POS, FE_PESOS, FE_PONDER,
  REC_SCORE_MIN, REC_PRECIO_MIN, REC_PESOS,
  COMODIN_PRECIO_MAX, COMODIN_MEDIA_MIN, COMODIN_JF_MIN,
  ROWS_PER_PAGE, RANK_CARD_SLOTS,
  SCORE_COLORS, DATA_PATHS,
};
