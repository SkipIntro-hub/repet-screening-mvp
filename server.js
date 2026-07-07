import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Cache local en memoria
let cache = {
  personas: [],
  entidades: [],
  lastUpdated: null,
  status: 'pending'
};

const PERSONAS_URL = 'https://repet.jus.gob.ar/xml/personas.json';
const ENTIDADES_URL = 'https://repet.jus.gob.ar/xml/entidades.json';

// Directorio y archivos de respaldo local en caso de que falle la conexión con RePET
const CACHE_DIR = path.join(__dirname, 'cache');
const BACKUP_PERSONAS = path.join(CACHE_DIR, 'personas_backup.json');
const BACKUP_ENTIDADES = path.join(CACHE_DIR, 'entidades_backup.json');

// Cargar respaldos de forma síncrona al inicio para evitar esperas en Vercel (Cold Starts)
try {
  if (fs.existsSync(BACKUP_PERSONAS)) {
    cache.personas = JSON.parse(fs.readFileSync(BACKUP_PERSONAS, 'utf-8'));
    cache.status = 'ready';
    cache.lastUpdated = fs.statSync(BACKUP_PERSONAS).mtime.toISOString();
  }
  if (fs.existsSync(BACKUP_ENTIDADES)) {
    cache.entidades = JSON.parse(fs.readFileSync(BACKUP_ENTIDADES, 'utf-8'));
  }
  console.log(`Caché inicializada síncronamente: ${cache.personas.length} personas, ${cache.entidades.length} entidades.`);
} catch (err) {
  console.warn('Error en carga síncrona inicial:', err.message);
}

// Normalización de texto (elimina acentos, mayúsculas, caracteres especiales)
function normalizeString(str) {
  if (!str) return '';
  return str
    .toString()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '') // Quita acentos
    .toUpperCase()
    .trim()
    .replace(/[^A-Z0-9\s]/g, ''); // Deja letras, números y espacios
}

// Algoritmo Jaro-Winkler para búsqueda difusa (Fuzzy Matching)
// Algoritmo Jaro-Winkler puro para búsqueda difusa (Fuzzy Matching)
function pureJaroWinkler(s1, s2) {
  s1 = normalizeString(s1);
  s2 = normalizeString(s2);

  if (s1 === s2) return 1.0;
  if (s1.length === 0 || s2.length === 0) return 0.0;

  const matchWindow = Math.floor(Math.max(s1.length, s2.length) / 2) - 1;
  const s1Matches = new Array(s1.length).fill(false);
  const s2Matches = new Array(s2.length).fill(false);

  let matches = 0;
  let transpositions = 0;

  // Encontrar coincidencias dentro del rango
  for (let i = 0; i < s1.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(s2.length - 1, i + matchWindow);

    for (let j = start; j <= end; j++) {
      if (!s2Matches[j] && s1[i] === s2[j]) {
        s1Matches[i] = true;
        s2Matches[j] = true;
        matches++;
        break;
      }
    }
  }

  if (matches === 0) return 0.0;

  // Encontrar transposiciones
  let k = 0;
  for (let i = 0; i < s1.length; i++) {
    if (s1Matches[i]) {
      while (!s2Matches[k]) k++;
      if (s1[i] !== s2[k]) {
        transpositions++;
      }
      k++;
    }
  }

  const jaro = (matches / s1.length + matches / s2.length + (matches - transpositions / 2) / matches) / 3.0;

  // Factor de Winkler (Prefijo común de hasta 4 caracteres)
  let prefixLength = 0;
  const maxPrefix = Math.min(4, Math.min(s1.length, s2.length));
  for (let i = 0; i < maxPrefix; i++) {
    if (s1[i] === s2[i]) {
      prefixLength++;
    } else {
      break;
    }
  }

  const winklerScalingFactor = 0.1;
  const jaroWinkler = jaro + prefixLength * winklerScalingFactor * (1.0 - jaro);
  return parseFloat(jaroWinkler.toFixed(4));
}

// Algoritmo Jaro-Winkler personalizado (con penalización por palabra única y diferencia de longitud)
function getJaroWinklerSimilarity(s1, s2) {
  const clean1 = normalizeString(s1);
  const clean2 = normalizeString(s2);

  let score = pureJaroWinkler(clean1, clean2);

  // 1. Penalización para palabras únicas contra nombres compuestos
  const w1 = clean1.split(/\s+/).filter(Boolean).length;
  const w2 = clean2.split(/\s+/).filter(Boolean).length;
  if ((w1 === 1 && w2 > 1) || (w2 === 1 && w1 > 1)) {
    score *= 0.75; // Penalización del 25%
  }

  // 2. Penalización por diferencia de longitud
  const maxLen = Math.max(clean1.length, clean2.length);
  const minLen = Math.min(clean1.length, clean2.length);
  if (maxLen > 0) {
    const lenRatio = minLen / maxLen;
    if (lenRatio < 0.7) {
      score *= lenRatio;
    }
  }

  return parseFloat(score.toFixed(4));
}

// Cobertura del Input — Token-Set (NUEVO en v1.3)
function tokenSetCoverage(clientName, dbName, perTokenThreshold = 0.85) {
  const ta = normalizeString(clientName).split(' ').filter(Boolean);
  const tb = normalizeString(dbName).split(' ').filter(Boolean);
  if (ta.length < 2) return 0; // guarda: mínimo 2 tokens en el input

  const used = new Set();
  let covered = 0;
  for (const tk of ta) {
    let best = 0, bestIdx = -1;
    tb.forEach((cand, i) => {
      if (used.has(i)) return;
      const s = pureJaroWinkler(tk, cand);
      if (s > best) {
        best = s;
        bestIdx = i;
      }
    });
    if (best >= perTokenThreshold) {
      used.add(bestIdx);
      covered++;
    }
  }
  return parseFloat((covered / ta.length).toFixed(4));
}

// Descarga inicial y almacenamiento local
async function refreshData() {
  console.log('Iniciando descarga de datos desde RePET...');
  cache.status = 'loading';

  try {
    if (!fs.existsSync(CACHE_DIR)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
    }

    // Petición HTTP con User-Agent
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36' };
    
    let personasData = [];
    let entidadesData = [];

    try {
      const resPersonas = await fetch(PERSONAS_URL, { headers });
      if (!resPersonas.ok) throw new Error(`HTTP ${resPersonas.status}`);
      personasData = await resPersonas.json();
      // Guardar respaldo
      fs.writeFileSync(BACKUP_PERSONAS, JSON.stringify(personasData, null, 2));
      console.log(`Personas actualizadas desde RePET: ${personasData.length} registros.`);
    } catch (err) {
      console.warn(`Error descargando personas desde RePET: ${err.message}. Intentando leer del respaldo local...`);
      if (fs.existsSync(BACKUP_PERSONAS)) {
        personasData = JSON.parse(fs.readFileSync(BACKUP_PERSONAS, 'utf-8'));
        console.log(`Cargadas personas desde respaldo: ${personasData.length} registros.`);
      } else {
        console.error('No hay respaldo local disponible para Personas.');
      }
    }

    try {
      const resEntidades = await fetch(ENTIDADES_URL, { headers });
      if (!resEntidades.ok) throw new Error(`HTTP ${resEntidades.status}`);
      entidadesData = await resEntidades.json();
      // Guardar respaldo
      fs.writeFileSync(BACKUP_ENTIDADES, JSON.stringify(entidadesData, null, 2));
      console.log(`Entidades actualizadas desde RePET: ${entidadesData.length} registros.`);
    } catch (err) {
      console.warn(`Error descargando entidades desde RePET: ${err.message}. Intentando leer del respaldo local...`);
      if (fs.existsSync(BACKUP_ENTIDADES)) {
        entidadesData = JSON.parse(fs.readFileSync(BACKUP_ENTIDADES, 'utf-8'));
        console.log(`Cargadas entidades desde respaldo: ${entidadesData.length} registros.`);
      } else {
        console.error('No hay respaldo local disponible para Entidades.');
      }
    }

    cache.personas = personasData;
    cache.entidades = entidadesData;
    cache.lastUpdated = new Date().toISOString();
    cache.status = 'ready';
    console.log('Sincronización de caché de RePET finalizada con éxito.');
  } catch (globalErr) {
    cache.status = 'error';
    console.error('Error crítico sincronizando datos del RePET:', globalErr);
  }
}

// Endpoint de estadísticas
app.get('/api/stats', (req, res) => {
  res.json({
    status: cache.status,
    totalPersonas: cache.personas.length,
    totalEntidades: cache.entidades.length,
    lastUpdated: cache.lastUpdated
  });
});

// Endpoint para forzar refresco manual
app.post('/api/refresh', async (req, res) => {
  await refreshData();
  res.json({
    status: cache.status,
    totalPersonas: cache.personas.length,
    totalEntidades: cache.entidades.length,
    lastUpdated: cache.lastUpdated
  });
});

// Endpoint para paginación y listado de base de datos
app.get('/api/list', (req, res) => {
  const type = req.query.type === 'entidades' ? 'entidades' : 'personas';
  const page = parseInt(req.query.page) || 1;
  const limit = parseInt(req.query.limit) || 20;
  const query = req.query.search ? normalizeString(req.query.search) : '';

  let list = cache[type];

  // Filtrado simple por nombre/documento
  if (query) {
    list = list.filter(item => {
      const fullName = normalizeString([item.FIRST_NAME, item.SECOND_NAME, item.THIRD_NAME, item.FOURTH_NAME].filter(Boolean).join(' '));
      const comments = normalizeString(item.COMMENTS1);
      const reference = normalizeString(item.REFERENCE_NUMBER);

      let aliasMatch = false;
      if (type === 'personas' && item.INDIVIDUAL_ALIAS) {
        aliasMatch = item.INDIVIDUAL_ALIAS.some(alias => normalizeString(alias.ALIAS_NAME).includes(query));
      } else if (type === 'entidades' && item.ENTITY_ALIAS) {
        aliasMatch = item.ENTITY_ALIAS.some(alias => normalizeString(alias.ALIAS_NAME).includes(query));
      }

      let docMatch = false;
      if (type === 'personas' && item.INDIVIDUAL_DOCUMENT) {
        docMatch = item.INDIVIDUAL_DOCUMENT.some(doc => normalizeString(doc.NUMBER).includes(query));
      }

      return fullName.includes(query) || comments.includes(query) || reference.includes(query) || aliasMatch || docMatch;
    });
  }

  const total = list.length;
  const startIndex = (page - 1) * limit;
  const endIndex = page * limit;
  const results = list.slice(startIndex, endIndex);

  res.json({
    total,
    page,
    limit,
    totalPages: Math.ceil(total / limit),
    results
  });
});

// Helper para evaluar un registro completo (Personas o Entidades) contra las 4 señales
function evaluateRecord(query, record, type, cfg) {
  // Coincidencia exacta de documento (si es numérico o alfanumérico)
  let docMatched = false;
  let matchedDocNumber = '';
  if (type === 'personas' && record.INDIVIDUAL_DOCUMENT && Array.isArray(record.INDIVIDUAL_DOCUMENT)) {
    const cleanQuery = normalizeString(query);
    record.INDIVIDUAL_DOCUMENT.forEach(doc => {
      if (doc.NUMBER && cleanQuery.length >= 6) {
        const cleanDoc = normalizeString(doc.NUMBER);
        if (cleanDoc === cleanQuery || cleanDoc.includes(cleanQuery) || cleanQuery.includes(cleanDoc)) {
          docMatched = true;
          matchedDocNumber = doc.NUMBER;
        }
      }
    });
  }

  if (docMatched) {
    return {
      state: 'ROJO',
      via: 'DOCUMENT',
      score: 1.0,
      coverage: 0.0,
      matchedField: 'Coincidencia de Documento',
      matchedValue: matchedDocNumber,
      isAlias: false,
      quality: ''
    };
  }

  // Evaluar nombres principales y alias
  const candidates = [];
  if (type === 'personas') {
    const fullName = [record.FIRST_NAME, record.SECOND_NAME, record.THIRD_NAME, record.FOURTH_NAME].filter(Boolean).join(' ');
    candidates.push({ name: fullName, field: 'Nombre Completo', isAlias: false, quality: '' });
    if (record.INDIVIDUAL_ALIAS && Array.isArray(record.INDIVIDUAL_ALIAS)) {
      record.INDIVIDUAL_ALIAS.forEach(alias => {
        if (alias.ALIAS_NAME) {
          candidates.push({
            name: alias.ALIAS_NAME,
            field: `Alias (${alias.QUALITY || 'Alternativo'})`,
            isAlias: true,
            quality: alias.QUALITY || ''
          });
        }
      });
    }
  } else {
    // Entidades
    candidates.push({ name: record.FIRST_NAME, field: 'Nombre de Entidad', isAlias: false, quality: '' });
    if (record.ENTITY_ALIAS && Array.isArray(record.ENTITY_ALIAS)) {
      record.ENTITY_ALIAS.forEach(alias => {
        if (alias.ALIAS_NAME) {
          candidates.push({
            name: alias.ALIAS_NAME,
            field: 'Alias de Entidad',
            isAlias: true,
            quality: 'Alternativo'
          });
        }
      });
    }
  }

  let bestEval = { state: 'VERDE', via: 'NONE', score: 0.0, coverage: 0.0, matchedField: '', matchedValue: '', isAlias: false, quality: '' };

  candidates.forEach(cand => {
    const jwScore = getJaroWinklerSimilarity(query, cand.name);
    const cov = tokenSetCoverage(query, cand.name);

    let state = 'VERDE';
    let via = 'NONE';

    if (jwScore >= cfg.jwRed) {
      state = 'ROJO';
      via = cand.isAlias ? 'ALIAS' : 'FULL_NAME';
    } else if (jwScore >= cfg.jwYellow || cov >= cfg.coverage) {
      state = 'AMARILLO';
      via = (cov >= cfg.coverage) ? 'TOKEN_SET' : (cand.isAlias ? 'ALIAS' : 'FULL_NAME');
    }

    // Clasificar severidad: ROJO > AMARILLO > VERDE
    const stateRank = { 'ROJO': 3, 'AMARILLO': 2, 'VERDE': 1 };
    const currentRank = stateRank[state];
    const bestRank = stateRank[bestEval.state];

    if (currentRank > bestRank) {
      bestEval = { state, via, score: jwScore, coverage: cov, matchedField: cand.field, matchedValue: cand.name, isAlias: cand.isAlias, quality: cand.quality };
    } else if (currentRank === bestRank) {
      // Ante mismo estado, priorizar mayor JW score
      if (jwScore > bestEval.score || (jwScore === bestEval.score && cov > bestEval.coverage)) {
        bestEval = { state, via, score: jwScore, coverage: cov, matchedField: cand.field, matchedValue: cand.name, isAlias: cand.isAlias, quality: cand.quality };
      }
    }
  });

  return bestEval;
}

// Endpoint de Screening / Búsqueda Difusa (Fuzzy Match)
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  
  // Parámetros configurables de thresholds
  const jwYellow = parseFloat(req.query.threshold) || 0.75;
  const jwRed = parseFloat(req.query.jwRed) || 0.90;
  const coverage = parseFloat(req.query.coverage) || 0.80;
  const cfg = { jwYellow, jwRed, coverage };

  if (!query) {
    return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q".' });
  }

  const results = [];

  // 1. Evaluar Personas
  cache.personas.forEach(p => {
    const fullName = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].filter(Boolean).join(' ');
    const evaluation = evaluateRecord(query, p, 'personas', cfg);

    if (evaluation.state === 'ROJO' || evaluation.state === 'AMARILLO') {
      results.push({
        type: 'persona',
        id: p.DATAID,
        name: fullName,
        reference: p.REFERENCE_NUMBER,
        listType: p.UN_LIST_TYPE || 'Nacional',
        comments: p.COMMENTS1,
        aliases: p.INDIVIDUAL_ALIAS || [],
        documents: p.INDIVIDUAL_DOCUMENT || [],
        nationalities: p.NATIONALITY || [],
        state: evaluation.state,
        via: evaluation.via,
        score: evaluation.score,
        coverage: evaluation.coverage,
        matchedField: evaluation.matchedField,
        matchedValue: evaluation.matchedValue,
        isAlias: evaluation.isAlias,
        quality: evaluation.quality
      });
    }
  });

  // 2. Evaluar Entidades
  cache.entidades.forEach(e => {
    const entityName = e.FIRST_NAME;
    const evaluation = evaluateRecord(query, e, 'entidades', cfg);

    if (evaluation.state === 'ROJO' || evaluation.state === 'AMARILLO') {
      results.push({
        type: 'entidad',
        id: e.DATAID,
        name: entityName,
        reference: e.REFERENCE_NUMBER,
        listType: e.UN_LIST_TYPE || 'Nacional',
        comments: e.COMMENTS1,
        aliases: e.ENTITY_ALIAS || [],
        documents: [],
        nationalities: [],
        state: evaluation.state,
        via: evaluation.via,
        score: evaluation.score,
        coverage: evaluation.coverage,
        matchedField: evaluation.matchedField,
        matchedValue: evaluation.matchedValue,
        isAlias: evaluation.isAlias,
        quality: evaluation.quality
      });
    }
  });

  // Ordenamiento con reglas de desempate (DOCUMENT > FULL_NAME > ALIAS, y alias_quality = "Good")
  results.sort((a, b) => {
    // A. Ordenar por severidad de estado
    const stateRank = { 'ROJO': 2, 'AMARILLO': 1, 'VERDE': 0 };
    const rankDiff = stateRank[b.state] - stateRank[a.state];
    if (rankDiff !== 0) return rankDiff;

    // B. Ordenar por score descendente
    const scoreDiff = b.score - a.score;
    if (Math.abs(scoreDiff) > 0.0001) return scoreDiff;

    // C. Ordenar por vía de coincidencia (DOCUMENT > FULL_NAME > ALIAS)
    const viaRank = (item) => {
      if (item.via === 'DOCUMENT') return 3;
      if (!item.isAlias) return 2;
      return 1;
    };
    const viaDiff = viaRank(b) - viaRank(a);
    if (viaDiff !== 0) return viaDiff;

    // D. Ordenar por calidad de alias (Good > Others)
    if (a.isAlias && b.isAlias) {
      const qA = (a.quality || '').toLowerCase() === 'good' ? 1 : 0;
      const qB = (b.quality || '').toLowerCase() === 'good' ? 1 : 0;
      return qB - qA;
    }

    return 0;
  });

  // Determinar estado global (el peor de todos los candidatos)
  let globalState = 'VERDE';
  if (results.some(r => r.state === 'ROJO')) {
    globalState = 'ROJO';
  } else if (results.some(r => r.state === 'AMARILLO')) {
    globalState = 'AMARILLO';
  }

  res.json({
    query,
    thresholds: cfg,
    globalState,
    resultsCount: results.length,
    results
  });
});

// Iniciar servidor y cargar datos
app.listen(PORT, async () => {
  console.log(`==================================================`);
  console.log(`  Servidor RePET Screening ejecutándose en puerto ${PORT}`);
  console.log(`  URL Local: http://localhost:${PORT}`);
  console.log(`==================================================`);
  await refreshData();
});
