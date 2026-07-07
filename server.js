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
function getJaroWinklerSimilarity(s1, s2) {
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

  let finalScore = jaroWinkler;

  // 1. Penalización para palabras únicas contra nombres compuestos (evita que "ROBERTO" coincida con "ROBERTO ITURRA" con puntaje crítico)
  const w1 = s1.split(/\s+/).filter(Boolean).length;
  const w2 = s2.split(/\s+/).filter(Boolean).length;
  if ((w1 === 1 && w2 > 1) || (w2 === 1 && w1 > 1)) {
    finalScore *= 0.75; // Penalización del 25%
  }

  // 2. Penalización por diferencia de caracteres proporcional si la diferencia es alta (evita falsos positivos por subcadenas muy cortas)
  const maxLen = Math.max(s1.length, s2.length);
  const minLen = Math.min(s1.length, s2.length);
  if (maxLen > 0) {
    const lenRatio = minLen / maxLen;
    if (lenRatio < 0.7) {
      const penalty = 0.8 + (lenRatio * 0.2); // Factor de penalización suave entre 0.8 y 0.94
      finalScore *= penalty;
    }
  }

  return parseFloat(finalScore.toFixed(4));
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

// Endpoint de Screening / Búsqueda Difusa (Fuzzy Match)
app.get('/api/search', (req, res) => {
  const query = req.query.q;
  const threshold = parseFloat(req.query.threshold) || 0.8; // Porcentaje mínimo para alertar

  if (!query) {
    return res.status(400).json({ error: 'Falta el parámetro de búsqueda "q".' });
  }

  const results = [];
  const cleanQuery = normalizeString(query);

  // 1. Evaluar Personas
  cache.personas.forEach(p => {
    const fullName = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].filter(Boolean).join(' ');
    
    // Comparar contra nombre completo
    let maxScore = getJaroWinklerSimilarity(query, fullName);
    let matchedField = 'Nombre Completo';
    let matchedValue = fullName;

    // Comparar contra alias
    if (p.INDIVIDUAL_ALIAS && Array.isArray(p.INDIVIDUAL_ALIAS)) {
      p.INDIVIDUAL_ALIAS.forEach(alias => {
        if (alias.ALIAS_NAME) {
          const score = getJaroWinklerSimilarity(query, alias.ALIAS_NAME);
          if (score > maxScore) {
            maxScore = score;
            matchedField = `Alias (${alias.QUALITY || 'Alternativo'})`;
            matchedValue = alias.ALIAS_NAME;
          }
        }
      });
    }

    // Coincidencia exacta de documento (si es numérico o alfanumérico)
    let hasDirectDocMatch = false;
    if (p.INDIVIDUAL_DOCUMENT && Array.isArray(p.INDIVIDUAL_DOCUMENT)) {
      p.INDIVIDUAL_DOCUMENT.forEach(doc => {
        if (doc.NUMBER && cleanQuery.length >= 6) {
          const cleanDoc = normalizeString(doc.NUMBER);
          if (cleanDoc === cleanQuery || cleanDoc.includes(cleanQuery) || cleanQuery.includes(cleanDoc)) {
            hasDirectDocMatch = true;
          }
        }
      });
    }

    // Agregar si supera el umbral o si hay match exacto de documento
    if (maxScore >= threshold || hasDirectDocMatch) {
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
        score: hasDirectDocMatch ? 1.0 : maxScore,
        matchedField: hasDirectDocMatch ? 'Coincidencia de Documento' : matchedField,
        matchedValue: hasDirectDocMatch ? 'Documento Identidad' : matchedValue
      });
    }
  });

  // 2. Evaluar Entidades
  cache.entidades.forEach(e => {
    const entityName = e.FIRST_NAME;
    let maxScore = getJaroWinklerSimilarity(query, entityName);
    let matchedField = 'Nombre de Entidad';
    let matchedValue = entityName;

    if (e.ENTITY_ALIAS && Array.isArray(e.ENTITY_ALIAS)) {
      e.ENTITY_ALIAS.forEach(alias => {
        if (alias.ALIAS_NAME) {
          const score = getJaroWinklerSimilarity(query, alias.ALIAS_NAME);
          if (score > maxScore) {
            maxScore = score;
            matchedField = `Alias de Entidad`;
            matchedValue = alias.ALIAS_NAME;
          }
        }
      });
    }

    if (maxScore >= threshold) {
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
        score: maxScore,
        matchedField,
        matchedValue
      });
    }
  });

  // Ordenar de mayor a menor similitud (score)
  results.sort((a, b) => b.score - a.score);

  res.json({
    query,
    threshold,
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
