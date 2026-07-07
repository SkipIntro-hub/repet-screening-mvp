# Especificación Técnica de Integración: Módulo de Screening RePET (v1.3)
**Destinatarios:** Equipo de Desarrollo Backend, Frontend y Seguridad/Compliance  
**Objetivo:** Implementar la validación automatizada y en tiempo real de clientes contra el Registro de Personas y Entidades vinculadas a actos de Terrorismo (RePET) de la República Argentina en la plataforma de onboarding propietaria.

---

## 1. Arquitectura de Datos e Ingesta

Para asegurar disponibilidad 24/7 y evitar latencias o caídas durante el proceso de onboarding, el padrón debe ser almacenado localmente y sincronizado en segundo plano de forma periódica.

### A. Modelo de Base de Datos (Propuesta SQL)
Se deben crear dos tablas dedicadas (o colecciones si se usa NoSQL) para el padrón oficial:

```sql
-- Tabla de Personas Físicas RePET
CREATE TABLE repet_persons (
    id VARCHAR(50) PRIMARY KEY, -- ID provisto por la base RePET (ej. "123")
    first_name VARCHAR(150) NOT NULL,
    second_name VARCHAR(150),
    third_name VARCHAR(150),
    fourth_name VARCHAR(150),
    normalized_full_name VARCHAR(600) NOT NULL, -- Nombre completo concatenado y normalizado para indexación
    list_type VARCHAR(100), -- ONU, Nacional, etc.
    un_list_type VARCHAR(100),
    reference_number VARCHAR(100), -- Ej. "QDi.192"
    listed_on VARCHAR(50), -- Fecha de alta
    raw_json TEXT NOT NULL, -- Registro JSON completo original para auditoría
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE INDEX idx_normalized_full_name ON repet_persons(normalized_full_name);

-- Tabla de Documentos Asociados a Personas
CREATE TABLE repet_person_documents (
    id INT AUTO_INCREMENT PRIMARY KEY,
    person_id VARCHAR(50) NOT NULL,
    document_type VARCHAR(50), -- DNI, Pasaporte, Cédula
    document_number VARCHAR(50) NOT NULL, -- Número limpio (solo dígitos/letras)
    FOREIGN KEY (person_id) REFERENCES repet_persons(id) ON DELETE CASCADE
);

CREATE INDEX idx_document_number ON repet_person_documents(document_number);

-- Tabla de Entidades Jurídicas RePET
CREATE TABLE repet_entities (
    id VARCHAR(50) PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    normalized_name VARCHAR(255) NOT NULL,
    un_list_type VARCHAR(100),
    raw_json TEXT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);
```

### B. Proceso de Sincronización (Cron Job)
Un servicio programado en background (diario o semanal, sugerido 03:00 AM) deberá:
1. Descargar los JSON oficiales:
   * **Personas:** `https://repet.jus.gob.ar/xml/personas.json`
   * **Entidades:** `https://repet.jus.gob.ar/xml/entidades.json`
2. Si la conexión falla, reintentar 3 veces con exponencial backoff. Si persiste el fallo, mantener los datos existentes en BD y generar una alerta crítica en los logs del sistema.
3. Si la descarga es exitosa:
   * Iniciar una transacción de base de datos.
   * Limpiar las tablas temporales y cargar los registros nuevos.
   * Generar el campo `normalized_full_name` concatenando los nombres que existan y aplicando la función de normalización descripta en el apartado 2.
   * Confirmar la transacción.

---

## 2. Motor de Comparación (Matching Engine)

El motor de comparación consta de tres capas consecutivas: **Normalización**, **Fuzzy Matching con Penalizaciones** y **Exact Match por Documento**.

### A. Normalización de Texto
Antes de cualquier comparación, ambas cadenas (el nombre ingresado por el cliente y el nombre almacenado en base de datos) deben ser normalizadas mediante la siguiente función:

```javascript
function normalizeString(str) {
  if (!str) return '';
  return str
    .toString()
    .normalize('NFD') // Descompone caracteres con acentos
    .replace(/[\u0300-\u036f]/g, '') // Elimina diacríticos (acentos, diéresis)
    .replace(/[^a-zA-Z0-9\s]/g, '') // Elimina caracteres especiales y puntuación
    .replace(/\s+/g, ' ') // Colapsa múltiples espacios en uno solo
    .trim()
    .toUpperCase(); // Trabajar en mayúsculas
}
```

### B. Algoritmo de Similitud Jaro-Winkler Optimizado
Se utilizará el algoritmo de **Jaro-Winkler** con un factor de prefijo (scaling factor) estándar de `0.1` y un máximo de `4` caracteres de prefijo. 

Para mitigar falsos positivos producidos por nombres cortos o alias parciales (ej. coincidencia crítica entre el cliente `"Roberto Iturra"` y el alias de RePET `"ROBERTO"`), se deben programar **dos penalizaciones adicionales**:

#### 1. Penalización por Palabra Única (Single Word Penalty)
Se aplica cuando una de las cadenas comparadas consta de una única palabra y la otra contiene múltiples palabras.
*   **Fórmula:** Si `palabras(cajaA) == 1` Y `palabras(cajaB) > 1` (o viceversa):
    $$\text{Score final} = \text{Score Jaro-Winkler} \times 0.75$$ (Castigo del 25%).

#### 2. Penalización por Diferencia de Longitud (Length Penalty)
Se aplica si una cadena es significativamente más corta que la otra, evitando falsos positivos por coincidencia de prefijos accidentales.
*   **Fórmula:** 
    $$\text{Ratio} = \frac{\min(\text{longitudA}, \text{longitudB})}{\max(\text{longitudA}, \text{longitudB})}$$
    Si el $\text{Ratio} < 0.7$, aplicar:
    $$\text{Score final} = \text{Score final} \times \text{Ratio}$$

```javascript
// Pseudo-código del Jaro-Winkler con Penalizaciones
function calculateMatchScore(clientName, dbName) {
  const cleanClient = normalizeString(clientName);
  const cleanDb = normalizeString(dbName);
  
  if (cleanClient === cleanDb) return 1.0;
  
  // 1. Obtener similitud Jaro-Winkler base (puro)
  let score = jaroWinklerPure(cleanClient, cleanDb);
  
  // 2. Aplicar Penalización por Palabra Única
  const wordsClient = cleanClient.split(' ').length;
  const wordsDb = cleanDb.split(' ').length;
  if ((wordsClient === 1 && wordsDb > 1) || (wordsDb === 1 && wordsClient > 1)) {
    score = score * 0.75;
  }
  
  // 3. Aplicar Penalización por Diferencia de Longitud
  const lenClient = cleanClient.length;
  const lenDb = cleanDb.length;
  const ratio = Math.min(lenClient, lenDb) / Math.max(lenClient, lenDb);
  if (ratio < 0.7) {
    score = score * ratio;
  }
  
  return score;
}
```

### C. Cobertura del Input — Token-Set (NUEVO en v1.3)
*   **Problema que resuelve:** El matching de cadena completa (2.B) penaliza por diferencia de longitud, lo cual protege contra falsos positivos de alias cortos pero hunde las búsquedas parciales legítimas. Caso real detectado en pruebas: input `"BASET AZZOUZ"` contra el registro `"ABD AL-BASET AZZOUZ"` (QDi.371) arroja 52.8% — VERDE con umbral 80 — a pesar de que los dos tokens del input están literalmente contenidos en el registro.
*   **Principio:** En lugar de preguntar “¿qué tan parecidas son las dos cadenas completas?”, esta señal pregunta “¿qué proporción de lo que se busca está contenida en el registro?”. La dirección es siempre input → registro, nunca al revés: el registro puede tener tokens de sobra sin castigar el score.
*   **Regla:** Cobertura = (tokens del input con contraparte JW ≥ 0.85 en el registro) / (tokens totales del input). Si Cobertura ≥ umbral_cobertura (parámetro configurable, default 80%), el registro entra al ranking como candidato AMARILLO.

#### Guardas obligatorias:
1.  **Mínimo 2 tokens en el input:** Un input de una sola palabra no activa esta señal (evita que “ROBERTO” matchee contra medio padrón — mantiene la filosofía de la penalización por palabra única).
2.  **Cada token del registro se usa una sola vez** como contraparte (asignación sin repetición).
3.  **Umbral por token:** JW ≥ 0.85, no igualdad exacta — tolera variantes de transliteración reales del padrón (“AZZOUZ” vs “AZOUZ” da JW 0.875; con corte 0.90 se escaparía).
4.  **AMARILLO como techo:** La cobertura total también se da en subsets genéricos (“JUAN PEREZ” dentro de “JUAN CARLOS PEREZ GONZALEZ”); eso debe alertar — en screening de sanciones se prefiere el falso positivo — pero lo resuelve el oficial, no un bloqueo automático. ROJO queda reservado para identidad completa (2.B ≥ 90%) o documento.

#### Implementación de referencia:
```javascript
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
      const s = jaroWinklerPure(tk, cand);
      if (s > best) { best = s; bestIdx = i; }
    });
    if (best >= perTokenThreshold) { used.add(bestIdx); covered++; }
  }
  return covered / ta.length; // proporción del input cubierta
}
```

#### Integración de las cuatro señales:
```javascript
function screeningState(client, person,
                        cfg = { jwYellow: 0.75, jwRed: 0.90, coverage: 0.80 }) {
  if (documentExactMatch(client, person)) return { state: 'ROJO', via: 'DOCUMENT' };
 
  const candidates = [person.normalized_full_name, ...person.aliases];
  const jwScore = Math.max(...candidates.map(c => calculateMatchScore(client.name, c)));
  if (jwScore >= cfg.jwRed) return { state: 'ROJO', via: 'FULL_NAME', score: jwScore };
 
  const coverage = Math.max(...candidates.map(c => tokenSetCoverage(client.name, c)));
  if (jwScore >= cfg.jwYellow || coverage >= cfg.coverage) {
    return { state: 'AMARILLO',
             via: coverage >= cfg.coverage ? 'TOKEN_SET' : 'FULL_NAME',
             score: jwScore, coverage };
  }
  return { state: 'VERDE', score: jwScore, coverage };
}
```

---

## 3. Resultados y Ranking (NUEVO en v1.2)

El motor evalúa el padrón completo (personas + alias + entidades, según el tipo de sujeto) y devuelve la lista de candidatos con score ≥ umbral AMARILLO, ordenada por score descendente. Está prohibido cortar la búsqueda en el primer registro que supere el umbral: con ~1.500 registros el recorrido completo es computacionalmente trivial, y cortar antes produce el defecto de devolver el primer hit y no el mejor.

1.  **El estado del screening (VERDE/AMARILLO/ROJO)** se determina por el score máximo global, nunca por el primer hit.
2.  **La bandeja del Oficial de Cumplimiento** muestra el top-5 de candidatos con sus scores y la vía de cada match (nombre principal / alias / documento), no solo el mejor — el contexto de los candidatos cercanos ayuda a resolver falsos positivos.
3.  **Ante empate de score, priorizar:** match por documento > match por nombre principal > match por alias; y a igual vía, el registro con alias_quality = `"Good"`.
4.  **El registro de auditoría** guarda el candidato de score máximo; la constancia puede listar el top-5 en caso de match.

---

## 4. Flujo Funcional del Onboarding (Compliance & UX)

El proceso de screening se ejecuta de forma asíncrona en el backend de la plataforma de onboarding al completarse el ingreso de datos de identidad del usuario.

### Reglas de UX para evitar el delito de Tipping-Off (Revelación)
> [!IMPORTANT]
> Bajo las directivas de la Unidad de Información Financiera (UIF), está prohibido informar al cliente que está siendo investigado o bloqueado por sospechas de financiamiento del terrorismo.
>
> *   **Acción si es VERDE:** El cliente continúa el onboarding normalmente sin enterarse del chequeo.
> *   **Acción si es AMARILLO o ROJO:** 
>     1. El backend marca la cuenta internamente en estado `PENDIENTE_VERIFICACION_COMPLIANCE`.
>     2. El frontend de onboarding **no interrumpe el flujo abruptamente con un mensaje de error**.
>     3. En su lugar, al llegar al final del onboarding se le muestra una pantalla genérica de revisión técnica: *"Hemos recibido tus datos correctamente. Estamos validando tu documentación en nuestros sistemas. Este proceso puede demorar hasta 24 horas hábiles."*
>     4. Se crea un caso de alerta de alta prioridad en la bandeja del Oficial de Cumplimiento.

---

## 5. Interfaz del Oficial de Cumplimiento (Panel de Admin)

Los desarrolladores de Backoffice deben proveer una sección para el equipo de Compliance que contenga:

1.  **Bandeja de Entrada de Alertas:** Listado de registros en estado `PENDIENTE_VERIFICACION_COMPLIANCE` ordenados por nivel de riesgo (`CRÍTICO` o `ADVERTENCIA`).
2.  **Pantalla de Resolución del Caso:**
    *   **Datos del Cliente:** Nombre completo cargado, foto del DNI y número de documento.
    *   **Datos de Coincidencia RePET (Top-5):** Mostrar el top-5 de candidatos del ranking para dar contexto al analista.
    *   **Herramienta de Comparación Visual:** Resaltar con colores las palabras que coinciden para facilitar la lectura.
    *   **Acciones Operativas:**
        *   `[Descartar Alerta (Falso Positivo)]` -> Libera la cuenta al instante, pasa a estado aprobado y continúa el flujo de onboarding del cliente.
        *   `[Confirmar Alerta (Bloqueo Preventivo)]` -> Bloquea definitivamente el onboarding, congela el perfil del cliente, y dispara la generación automática del Reporte de Operación Sospechosa (ROS) interno para la UIF.

---

## 6. Auditoría e Historial de Screening (Legalmente Requerido)

Es una obligación legal de compliance auditar cada screening realizado. Cada vez que se procese un onboarding, se debe guardar un registro inmutable en la tabla `compliance_screening_logs`. El campo `matched_via` debe soportar el valor `TOKEN_SET` y registrar ambos umbrales aplicados (JW y cobertura).

| Campo | Tipo | Descripción |
| :--- | :--- | :--- |
| `id` | UUID | Identificador único del registro de auditoría |
| `onboarding_id` | FK | Relación con el proceso de onboarding del cliente |
| `client_name_searched`| VARCHAR | Nombre completo tal cual ingresó el cliente |
| `client_doc_searched` | VARCHAR | Documento ingresado por el cliente |
| `search_timestamp` | TIMESTAMP | Fecha y hora exacta de la consulta |
| `applied_jw_threshold` | DECIMAL(3,2) | Umbral de Jaro-Winkler configurado (ej: 0.75) |
| `applied_coverage_threshold` | DECIMAL(3,2) | Umbral de Cobertura de Tokens configurado (ej: 0.80) |
| `highest_match_score` | DECIMAL(5,2) | El porcentaje máximo de similitud encontrado (0.00 a 100.00) |
| `matched_via` | ENUM | Vía del match: `DOCUMENT`, `FULL_NAME`, `ALIAS`, `TOKEN_SET` |
| `matched_record_id` | VARCHAR | ID del sospechoso en la base RePET si hubo match (null si no hubo) |
| `compliance_status` | ENUM | `APPROVED`, `MANUAL_REVIEW`, `BLOCKED` |
| `resolved_by` | FK | ID del usuario/analista que resolvió el caso de alerta |

---

## 7. Batería de Casos de Prueba Obligatorios (v1.3)

El motor no pasa a producción sin aprobar todos los casos de esta batería. Cada caso compara un input de cliente contra un registro objetivo del padrón (real o sintético en ambiente de test) y verifica que el registro objetivo quede primero en el ranking con el estado esperado.

| # | Categoría | Input del cliente | Registro objetivo (padrón) | Resultado esperado |
| :--- | :--- | :--- | :--- | :--- |
| **T01** | Identidad exacta | `JUAN CARLOS PEREZ` | `JUAN CARLOS PEREZ` | ROJO, score 1.0, ranking #1 |
| **T02** | Reorden de tokens | `PEREZ JUAN CARLOS` | `JUAN CARLOS PEREZ` | ROJO, score 1.0 (token-sort), ranking #1 |
| **T03** | Guion en input | `ABDUL-RAHMAN AL-QADULI` | `ABDUL RAHMAN AL QADULI` | ROJO, score 1.0, ranking #1 |
| **T04** | Guion en padrón | `ABDUL RAHMAN AL QADULI` | `ABDUL-RAHMAN AL-QADULI` | ROJO, score 1.0, ranking #1 |
| **T05** | Apóstrofe | `SEAN O'NEIL` | `SEAN O NEIL` | ROJO, score 1.0, ranking #1 |
| **T06** | Diacríticos | `JOSÉ MARÍA GÓMEZ` | `JOSE MARIA GOMEZ` | ROJO, score 1.0, ranking #1 |
| **T07** | Espacios múltiples | `JUAN   CARLOS PEREZ` | `JUAN CARLOS PEREZ` | ROJO, score 1.0, ranking #1 |
| **T08** | Typo de 1 carácter | `JUAN CARLOS PERES` | `JUAN CARLOS PEREZ` | ≥ AMARILLO, ranking #1 |
| **T09** | Reorden + typo | `PERES JUAN CARLOS` | `JUAN CARLOS PEREZ` | ≥ AMARILLO, ranking #1 |
| **T10** | Alias | `ROBERTO CARLOS SUAREZ` | Persona con alias `ROBERTO CARLOS SUAREZ` | ROJO vía ALIAS, ranking #1 |
| **T11** | Alias parcial (control FP) | `ROBERTO ITURRA` | Alias `ROBERTO` (una palabra) | VERDE — penalización por palabra única evita falso positivo |
| **T12** | Nombre corto (control FP) | `ANA LI` | Registros largos con prefijo similar | VERDE — penalización por longitud actúa |
| **T13** | Documento exacto | `Doc 20.123.456` | `Doc 20123456` | ROJO por DOCUMENT, sin importar score de nombre |
| **T14** | Partículas | `MOHAMMED BIN SALEM AL AMRI` | `MOHAMMED BIN-SALEM AL-AMRI` | ROJO, score 1.0, ranking #1 |
| **T15** | Nombre frecuente (control FP) | `JUAN PEREZ` (sin homónimo en padrón) | — | VERDE, sin candidatos ≥ 75% |
| **T16** | Ranking correcto | Input muy similar a 2 registros | Registro A (score mayor) y B (menor) | A en ranking #1; ambos visibles en top-5 |
| **** | **Nuevos en v1.3** | | | |
| **T17** | Búsqueda parcial | `BASET AZZOUZ` | `ABD AL-BASET AZZOUZ` (QDi.371) | AMARILLO vía TOKEN_SET (cobertura 100%), ranking #1 — cadena completa sola no alcanza (52.8%) |
| **T18** | Subset genérico (control) | `JUAN PEREZ` | `JUAN CARLOS PEREZ GONZALEZ` (sintético) | AMARILLO vía TOKEN_SET — nunca ROJO (el tope es revisión manual) |
