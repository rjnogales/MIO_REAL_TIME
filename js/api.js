// Acceso a los datos públicos del SIC del MIO.
// Fuentes confirmadas por inspección del frontend oficial del kiosco (mio_kiosco_v3.html):
//   - API de llegadas:   https://vdv-cali.utryt.com.co/interfaces/ura/instant_V2
//   - Catálogo de paradas: https://www.utryt.com.co/priuebas/SIC/assets/paradas.json
// Ambas son públicas (alcanzables por internet normal, no requieren la red interna de Metrocali).

const API_BASE = 'https://vdv-cali.utryt.com.co/interfaces/ura/instant_V2';
const RETURN_LIST = 'StopPointName,LineName,DestinationName,EstimatedTime,VehicleId,PlannedDepartureTime,DirectionId,TripId,MessageText';
const PARADAS_URL = 'https://www.utryt.com.co/priuebas/SIC/assets/paradas.json';
const PARADAS_CACHE_KEY = 'sic_paradas_cache_v1';

// Segunda fuente, independiente del SIC: servicios.siur.com.co (app pública "Buscarutas MIO
// Cali"), con CORS abierto (confirmado con curl). Da el tiempo de llegada calculado por posición
// GPS real del bus, no por horario programado como el SIC -- se usa como comparación, no como
// reemplazo. El campo numeroDeBus de esta API es el mismo código corto que vehicle_raw del SIC
// (confirmado cruzando ambas respuestas para el mismo StopId/parada en el mismo instante).
const SIUR_BASE = 'https://servicios.siur.com.co/buscarutas/api';

async function fetchBusesProximosGps(stopId) {
    const res = await fetch(`${SIUR_BASE}/buses_proximos_a_llegar.php?parada=${encodeURIComponent(stopId)}`, { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    return Array.isArray(data?.buses) ? data.buses : [];
}

// "2 min" -> 2. SIUR da el conteo en minutos enteros (resolución mucho más gruesa que los
// milisegundos del SIC) -- cualquier comparación entre las dos fuentes tiene un ruido de
// hasta +-1 min que no es divergencia real, solo redondeo.
function parseCuentaRegresivaMin(texto) {
    const m = /(-?\d+)/.exec(texto || '');
    return m ? parseInt(m[1], 10) : null;
}

function buildStopUrl(stopId) {
    return `${API_BASE}?StopId=${encodeURIComponent(stopId)}&ReturnList=${encodeURIComponent(RETURN_LIST)}`;
}

// Devuelve el texto crudo de la respuesta (una línea JSON-array por mensaje) ya separado en array de arrays.
// No descarta ninguna línea, ni siquiera las que no logre parsear (se devuelven como {parseError:true, texto}).
async function fetchStopMessages(stopId) {
    const res = await fetch(buildStopUrl(stopId), { cache: 'no-store' });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const text = await res.text();
    return text.split('\n')
        .map(l => l.trim())
        .filter(Boolean)
        .map(line => {
            try { return JSON.parse(line); }
            catch (e) { return { parseError: true, texto: line }; }
        });
}

// Extrae el timestamp de servidor del mensaje tipo 4 ([4, version, timestampMs]) que la API
// manda al inicio de cada respuesta. Ver js/reloj.js para cómo se usa.
function extraerTimestampServidor(messages) {
    const m4 = messages.find(m => Array.isArray(m) && m[0] === 4 && typeof m[2] === 'number');
    return m4 ? m4[2] : null;
}

// Catálogo de paradas: StopId -> "Nombre Estacion Plataforma" (ej. "Alamos A1").
// www.utryt.com.co NO envía cabecera Access-Control-Allow-Origin en este endpoint (confirmado
// con curl -D-), así que un fetch() desde el navegador falla por CORS en cuanto la app se sirve
// desde un origen distinto -- por eso se usa PARADAS_SNAPSHOT (data/paradas.js) como fuente
// principal. Igual se intenta un refresco en vivo por si en el futuro habilitan CORS; si
// funciona, se cachea y se usa esa versión más nueva.
async function loadParadas() {
    try {
        const res = await fetch(PARADAS_URL, { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const data = await res.json();
        localStorage.setItem(PARADAS_CACHE_KEY, JSON.stringify(data));
        return data;
    } catch (e) {
        const cached = localStorage.getItem(PARADAS_CACHE_KEY);
        if (cached) return JSON.parse(cached);
        return PARADAS_SNAPSHOT;
    }
}

// Separa "Alamos A1" en {estacion: "Alamos", plataforma: "A1"}.
// Si el nombre no termina en el patrón LetraNúmero, se trata todo como nombre de estación sin plataforma identificada.
function splitEstacionPlataforma(nombreCompleto) {
    const m = nombreCompleto.match(/^(.*)\s+([A-Za-z]\d+)$/);
    if (m) return { estacion: m[1].trim(), plataforma: m[2].trim() };
    return { estacion: nombreCompleto.trim(), plataforma: '' };
}

// Agrupa el catálogo plano {stopId: nombreCompleto} en {estacion: [{stopId, plataforma, nombreCompleto}, ...]}.
function agruparPorEstacion(paradas) {
    const estaciones = {};
    for (const [stopId, nombreCompleto] of Object.entries(paradas)) {
        const { estacion, plataforma } = splitEstacionPlataforma(nombreCompleto);
        if (!estaciones[estacion]) estaciones[estacion] = [];
        estaciones[estacion].push({ stopId, plataforma, nombreCompleto });
    }
    for (const lista of Object.values(estaciones)) {
        lista.sort((a, b) => a.plataforma.localeCompare(b.plataforma, undefined, { numeric: true }));
    }
    return estaciones;
}
