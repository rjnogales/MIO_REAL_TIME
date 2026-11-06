// Acceso a los datos públicos del SIC del MIO.
// Fuentes confirmadas por inspección del frontend oficial del kiosco (mio_kiosco_v3.html):
//   - API de llegadas:   https://vdv-cali.utryt.com.co/interfaces/ura/instant_V2
//   - Catálogo de paradas: https://www.utryt.com.co/priuebas/SIC/assets/paradas.json
// Ambas son públicas (alcanzables por internet normal, no requieren la red interna de Metrocali).

const API_BASE = 'https://vdv-cali.utryt.com.co/interfaces/ura/instant_V2';
const RETURN_LIST = 'StopPointName,LineName,DestinationName,EstimatedTime,VehicleId,PlannedDepartureTime,DirectionId,TripId,MessageText';
const PARADAS_URL = 'https://www.utryt.com.co/priuebas/SIC/assets/paradas.json';
const PARADAS_CACHE_KEY = 'sic_paradas_cache_v1';

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
