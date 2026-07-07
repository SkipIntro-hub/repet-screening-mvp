// Estado Global de la Aplicación en Frontend
const state = {
  currentTab: 'personas', // 'personas' o 'entidades'
  dbSearchQuery: '',
  dbPage: 1,
  dbLimit: 10,
  dbTotalPages: 1,
  dbTotalItems: 0,
};

// Elementos del DOM
const elements = {
  syncStatus: document.getElementById('syncStatus'),
  btnRefresh: document.getElementById('btnRefresh'),
  statPersonas: document.getElementById('statPersonas'),
  statEntidades: document.getElementById('statEntidades'),
  statLastUpdate: document.getElementById('statLastUpdate'),
  
  screeningForm: document.getElementById('screeningForm'),
  clientNameInput: document.getElementById('clientName'),
  thresholdInput: document.getElementById('threshold'),
  thresholdValue: document.getElementById('thresholdValue'),
  coverageInput: document.getElementById('coverage'),
  coverageValue: document.getElementById('coverageValue'),
  btnRunScreening: document.getElementById('btnRunScreening'),
  
  resultsContainer: document.getElementById('resultsContainer'),
  resultsTitle: document.getElementById('resultsTitle'),
  resultsCountBadge: document.getElementById('resultsCountBadge'),
  resultsList: document.getElementById('resultsList'),
  screeningWelcome: document.getElementById('screeningWelcome'),
  
  tabButtons: document.querySelectorAll('.tab-btn'),
  dbSearchInput: document.getElementById('dbSearchInput'),
  dbTable: document.getElementById('dbTable'),
  tableHeaderRow: document.getElementById('tableHeaderRow'),
  tableBody: document.getElementById('tableBody'),
  
  paginationInfo: document.getElementById('paginationInfo'),
  btnPrevPage: document.getElementById('btnPrevPage'),
  btnNextPage: document.getElementById('btnNextPage'),
  currentPageNum: document.getElementById('currentPageNum'),
};

// -------------------------------------------------------------
// Inicialización y Carga de Estadísticas
// -------------------------------------------------------------
async function loadStats() {
  try {
    const res = await fetch('/api/stats');
    const stats = await res.json();
    
    // Actualizar números del Dashboard
    elements.statPersonas.textContent = stats.totalPersonas.toLocaleString() || '0';
    elements.statEntidades.textContent = stats.totalEntidades.toLocaleString() || '0';
    
    if (stats.lastUpdated) {
      const date = new Date(stats.lastUpdated);
      elements.statLastUpdate.textContent = date.toLocaleTimeString() + ' - ' + date.toLocaleDateString();
    } else {
      elements.statLastUpdate.textContent = 'Pendiente';
    }

    // Actualizar indicador de estado
    const indicator = elements.syncStatus.querySelector('.pulse-indicator');
    const textStatus = elements.syncStatus.querySelector('.status-text');
    
    indicator.className = 'pulse-indicator';
    if (stats.status === 'ready') {
      indicator.classList.add('ready');
      textStatus.textContent = 'En línea (Caché RePET)';
    } else if (stats.status === 'loading') {
      indicator.classList.add('loading');
      textStatus.textContent = 'Sincronizando...';
    } else {
      indicator.classList.add('error');
      textStatus.textContent = 'Error de Conexión';
    }
  } catch (error) {
    console.error('Error cargando estadísticas:', error);
  }
}

// Sincronización Manual
async function handleSync() {
  const indicator = elements.syncStatus.querySelector('.pulse-indicator');
  const textStatus = elements.syncStatus.querySelector('.status-text');
  
  indicator.className = 'pulse-indicator loading';
  textStatus.textContent = 'Actualizando...';
  elements.btnRefresh.disabled = true;

  try {
    const res = await fetch('/api/refresh', { method: 'POST' });
    await res.json();
    await loadStats();
    await loadDatabaseExplorer();
  } catch (error) {
    console.error('Error sincronizando datos:', error);
  } finally {
    elements.btnRefresh.disabled = false;
  }
}

// -------------------------------------------------------------
// Explorador de Base de Datos (Panel Derecho)
// -------------------------------------------------------------
async function loadDatabaseExplorer() {
  const { currentTab, dbSearchQuery, dbPage, dbLimit } = state;
  
  // Renderizar Headers de la tabla según la pestaña
  renderTableHeader();
  
  // Mostrar Spinner en el body
  elements.tableBody.innerHTML = `<tr><td colspan="4" class="text-center">Cargando datos...</td></tr>`;

  try {
    const url = `/api/list?type=${currentTab}&page=${dbPage}&limit=${dbLimit}&search=${encodeURIComponent(dbSearchQuery)}`;
    const res = await fetch(url);
    const data = await res.json();

    state.dbTotalPages = data.totalPages || 1;
    state.dbTotalItems = data.total || 0;
    
    renderTableBody(data.results);
    renderPagination();
  } catch (error) {
    console.error('Error cargando explorador de base de datos:', error);
    elements.tableBody.innerHTML = `<tr><td colspan="4" class="text-center" style="color: var(--accent-rose);">Error al obtener datos del servidor.</td></tr>`;
  }
}

function renderTableHeader() {
  if (state.currentTab === 'personas') {
    elements.tableHeaderRow.innerHTML = `
      <th style="width: 35%;">Nombre Completo</th>
      <th style="width: 20%;">Lista / Origen</th>
      <th style="width: 25%;">Documentos</th>
      <th style="width: 20%;">Referencia / Alta</th>
    `;
  } else {
    elements.tableHeaderRow.innerHTML = `
      <th style="width: 40%;">Nombre Entidad</th>
      <th style="width: 20%;">Lista / Origen</th>
      <th style="width: 20%;">Alias de Entidad</th>
      <th style="width: 20%;">Referencia</th>
    `;
  }
}

function renderTableBody(items) {
  if (!items || items.length === 0) {
    const cols = state.currentTab === 'personas' ? 4 : 4;
    elements.tableBody.innerHTML = `<tr><td colspan="${cols}" class="text-center" style="color: var(--text-secondary);">No se encontraron registros.</td></tr>`;
    return;
  }

  let html = '';
  if (state.currentTab === 'personas') {
    items.forEach(p => {
      const fullName = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].filter(Boolean).join(' ');
      
      // Formatear documentos
      let docsStr = 'N/A';
      if (p.INDIVIDUAL_DOCUMENT && p.INDIVIDUAL_DOCUMENT.length > 0) {
        docsStr = p.INDIVIDUAL_DOCUMENT.map(doc => {
          return `<span class="badge-tag">${doc.TYPE_OF_DOCUMENT || 'Doc'}: ${doc.NUMBER || ''}</span>`;
        }).join(' ');
      }

      // Distinguir tipo de fuente (UN, Nacional, etc.)
      const isUN = p.LIST_TYPE && p.LIST_TYPE.toLowerCase().includes('un');
      const isOFAC = p.REFERENCE_NUMBER && p.REFERENCE_NUMBER.toLowerCase().includes('ofac');
      const sourceBadge = isUN 
        ? '<span class="source-badge source-un">ONU</span>' 
        : (isOFAC ? '<span class="source-badge source-ofac">OFAC</span>' : '<span class="source-badge source-national">Nacional</span>');

      html += `
        <tr>
          <td>
            <div style="font-weight: 600; color: var(--text-primary);">${fullName}</div>
            <div style="font-size: 0.75rem; color: var(--text-secondary); margin-top: 0.15rem;">
              ${p.INDIVIDUAL_ALIAS && p.INDIVIDUAL_ALIAS.length > 0 ? 'Alias: ' + p.INDIVIDUAL_ALIAS.map(a => a.ALIAS_NAME).slice(0, 3).join(', ') : 'Sin Alias'}
            </div>
          </td>
          <td>
            <div style="display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start;">
              ${sourceBadge}
              <span style="font-size: 0.75rem; color: var(--text-secondary);">${p.UN_LIST_TYPE || 'RePET'}</span>
            </div>
          </td>
          <td>${docsStr}</td>
          <td>
            <div style="font-family: monospace; font-weight: 500;">${p.REFERENCE_NUMBER || 'N/A'}</div>
            <div style="font-size: 0.7rem; color: var(--text-secondary);">${p.LISTED_ON || 'S/D'}</div>
          </td>
        </tr>
      `;
    });
  } else {
    items.forEach(e => {
      const isUN = e.UN_LIST_TYPE && e.UN_LIST_TYPE.toLowerCase() !== '';
      const sourceBadge = isUN 
        ? '<span class="source-badge source-un">ONU</span>' 
        : '<span class="source-badge source-national">Nacional</span>';

      let aliases = 'N/A';
      if (e.ENTITY_ALIAS && e.ENTITY_ALIAS.length > 0) {
        aliases = e.ENTITY_ALIAS.map(a => a.ALIAS_NAME).slice(0, 2).join(', ');
      }

      html += `
        <tr>
          <td>
            <div style="font-weight: 600; color: var(--text-primary);">${e.FIRST_NAME}</div>
          </td>
          <td>
            <div style="display: flex; flex-direction: column; gap: 0.25rem; align-items: flex-start;">
              ${sourceBadge}
              <span style="font-size: 0.75rem; color: var(--text-secondary);">${e.UN_LIST_TYPE || 'RePET'}</span>
            </div>
          </td>
          <td style="color: var(--text-secondary);">${aliases}</td>
          <td>
            <div style="font-family: monospace; font-weight: 500;">${e.REFERENCE_NUMBER || 'N/A'}</div>
            <div style="font-size: 0.7rem; color: var(--text-secondary);">${e.LISTED_ON || 'S/D'}</div>
          </td>
        </tr>
      `;
    });
  }
  
  elements.tableBody.innerHTML = html;
}

function renderPagination() {
  const startItem = state.dbTotalItems === 0 ? 0 : (state.dbPage - 1) * state.dbLimit + 1;
  const endItem = Math.min(state.dbPage * state.dbLimit, state.dbTotalItems);
  
  elements.paginationInfo.textContent = `Mostrando ${startItem}-${endItem} de ${state.dbTotalItems}`;
  elements.currentPageNum.textContent = state.dbPage;
  
  elements.btnPrevPage.disabled = state.dbPage <= 1;
  elements.btnNextPage.disabled = state.dbPage >= state.dbTotalPages;
}

// -------------------------------------------------------------
// Búsqueda y Screening de Nombres (Panel Izquierdo)
// -------------------------------------------------------------
async function handleScreeningSubmit(e) {
  e.preventDefault();
  
  const query = elements.clientNameInput.value.trim();
  const threshold = parseFloat(elements.thresholdInput.value) / 100;
  const coverage = parseFloat(elements.coverageInput.value) / 100;
  
  if (!query) return;

  // UI loading state
  elements.btnRunScreening.textContent = 'Analizando...';
  elements.btnRunScreening.disabled = true;
  elements.screeningWelcome.style.display = 'none';
  elements.resultsContainer.style.display = 'none';

  try {
    const url = `/api/search?q=${encodeURIComponent(query)}&threshold=${threshold}&coverage=${coverage}`;
    const res = await fetch(url);
    const data = await res.json();
    
    renderScreeningResults(data);
  } catch (error) {
    console.error('Error al realizar screening:', error);
    elements.resultsList.innerHTML = `<p style="color: #ff3b30; font-weight: 600; text-align: center;">Error al conectar con el motor de screening.</p>`;
    elements.resultsContainer.style.display = 'block';
  } finally {
    elements.btnRunScreening.textContent = 'Evaluar Riesgo';
    elements.btnRunScreening.disabled = false;
  }
}

function renderScreeningResults(data) {
  const results = data.results || [];
  elements.resultsCountBadge.textContent = results.length;
  
  if (results.length === 0) {
    elements.resultsList.innerHTML = `
      <div class="welcome-screen" style="border-color: var(--apple-green); background: var(--apple-green-light);">
        <div class="welcome-icon" style="opacity: 1; color: var(--apple-green);">✅</div>
        <h3 style="color: var(--text-primary);">Sin Coincidencias Críticas</h3>
        <p style="color: var(--text-secondary);">No se encontraron personas o entidades en el RePET que coincidan con "${data.query}" bajo los umbrales configurados (JW: ${Math.round(data.thresholds.jwYellow * 100)}% | Cobertura: ${Math.round(data.thresholds.coverage * 100)}%).</p>
      </div>
    `;
    elements.resultsContainer.style.display = 'block';
    return;
  }

  let html = '';
  results.forEach(item => {
    // Definir nivel de riesgo y clase CSS en base al estado devuelto
    let riskClass = 'low';
    let riskLabel = 'Riesgo Bajo';
    
    if (item.state === 'ROJO') {
      riskClass = 'critical';
      riskLabel = 'CRÍTICO';
    } else if (item.state === 'AMARILLO') {
      riskClass = 'warning';
      riskLabel = 'ALERTA';
    }

    const jwScorePct = Math.round(item.score * 100);
    const covPct = Math.round(item.coverage * 100);

    // Documentos formateados
    let docsStr = 'No registra documentos en base de datos.';
    if (item.documents && item.documents.length > 0) {
      docsStr = item.documents.map(d => {
        return `<span class="badge-tag" style="background: var(--bg-system); border: 1px solid var(--border-subtle); font-size: 0.7rem; color: var(--text-primary);">
                  <strong>${d.TYPE_OF_DOCUMENT}:</strong> ${d.NUMBER} (${d.ISSUING_COUNTRY || 'Emisor no esp.'})
                </span>`;
      }).join(' ');
    }

    // Nacionalidad
    const natStr = item.nationalities && item.nationalities.length > 0
      ? item.nationalities.map(n => n.VALUE).join(', ')
      : 'No especificada';

    // Alias
    let aliasesStr = 'No registra alias.';
    if (item.aliases && item.aliases.length > 0) {
      aliasesStr = item.aliases.map(a => `${a.ALIAS_NAME} (${a.QUALITY || 'a.k.a.'})`).join(', ');
    }

    // Badges de tipo
    const typeBadge = item.type === 'persona' 
      ? '<span class="badge-tag badge-type-persona">Persona</span>' 
      : '<span class="badge-tag badge-type-entidad">Entidad</span>';

    html += `
      <div class="result-card">
        <div class="result-card-header">
          <div class="result-info">
            <span class="result-name" style="color: var(--text-primary); font-weight: 700;">${item.name}</span>
            <div class="result-meta">
              ${typeBadge}
              <span class="badge-tag">Ref: ${item.reference || 'N/A'}</span>
              <span class="badge-tag">${item.listType}</span>
            </div>
          </div>
          <div class="score-badge ${riskClass}">
            <span>${item.via === 'DOCUMENT' ? 'DOC' : jwScorePct + '%'}</span>
            <span class="score-label">${riskLabel}</span>
          </div>
        </div>

        <div class="result-details">
          <div class="matched-pill" style="font-size: 10px; padding: 4px 8px; border-radius: 6px;">
            Vía: <strong>${item.via}</strong> | Coincidencia en: <strong>${item.matchedField}</strong> (${item.matchedValue})
          </div>
          <div style="font-size: 10px; color: var(--text-secondary); margin-top: 4px; padding-left: 2px;">
            Similitud Jaro-Winkler: <strong>${jwScorePct}%</strong> | Cobertura Token-Set: <strong>${covPct}%</strong>
          </div>
          <div class="detail-row" style="margin-top: 0.5rem;">
            <span class="detail-label">Identificaciones/Pasaportes:</span>
            <div style="display: flex; flex-wrap: wrap; gap: 0.35rem; margin-top: 0.15rem;">${docsStr}</div>
          </div>
          <div class="detail-row">
            <span class="detail-label">Nacionalidad:</span>
            <span class="detail-val">${natStr}</span>
          </div>
          <div class="detail-row">
            <span class="detail-label">Alias Registrados:</span>
            <span class="detail-val" style="font-style: italic;">${aliasesStr}</span>
          </div>
          ${item.comments ? `
            <div class="detail-row">
              <span class="detail-label">Observaciones y Causa:</span>
              <div class="comments-box">${item.comments}</div>
            </div>
          ` : ''}
        </div>
      </div>
    `;
  });

  elements.resultsList.innerHTML = html;
  elements.resultsContainer.style.display = 'block';
}

// -------------------------------------------------------------
// Controladores de Eventos y Enlaces de Acciones
// -------------------------------------------------------------

// Slider de Umbral Similitud
elements.thresholdInput.addEventListener('input', (e) => {
  elements.thresholdValue.textContent = `${e.target.value}%`;
});

// Slider de Umbral Cobertura
elements.coverageInput.addEventListener('input', (e) => {
  elements.coverageValue.textContent = `${e.target.value}%`;
});

// Submit del Screening
elements.screeningForm.addEventListener('submit', handleScreeningSubmit);

// Refresco de Datos Manual
elements.btnRefresh.addEventListener('click', handleSync);

// Cambios de Pestaña (Explorer)
elements.tabButtons.forEach(btn => {
  btn.addEventListener('click', (e) => {
    elements.tabButtons.forEach(b => b.classList.remove('active'));
    e.target.classList.add('active');
    
    state.currentTab = e.target.dataset.tab;
    state.dbPage = 1;
    loadDatabaseExplorer();
  });
});

// Búsqueda en Explorador de Base de Datos (con debounce simple)
let searchTimeout;
elements.dbSearchInput.addEventListener('input', (e) => {
  clearTimeout(searchTimeout);
  searchTimeout = setTimeout(() => {
    state.dbSearchQuery = e.target.value;
    state.dbPage = 1;
    loadDatabaseExplorer();
  }, 350);
});

// Paginación
elements.btnPrevPage.addEventListener('click', () => {
  if (state.dbPage > 1) {
    state.dbPage--;
    loadDatabaseExplorer();
  }
});

elements.btnNextPage.addEventListener('click', () => {
  if (state.dbPage < state.dbTotalPages) {
    state.dbPage++;
    loadDatabaseExplorer();
  }
});

// Carga Inicial al iniciar la página
document.addEventListener('DOMContentLoaded', () => {
  loadStats();
  loadDatabaseExplorer();
});
