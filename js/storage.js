// Persistencia de la sesión de auditoría en el dispositivo mientras dura el trabajo de campo.
// Cada fila se escribe en localStorage de inmediato (no solo en memoria) para que una sesión
// sobreviva a un cierre accidental del navegador o recarga de página -- el trabajo de campo
// es costoso y no se puede repetir por perder datos.

const SESSION_KEY = 'sic_audit_session_v1';
const ARCHIVE_KEY = 'sic_audit_sessions_archive_v1';

function iniciarSesion({ estacion, auditor }) {
    const session = {
        meta: {
            id: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            estacion,
            auditor,
            startTime: ahoraSincronizado()
        },
        rows: [],
        caches: { historyCache: {}, approachingCache: {} }
    };
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
    return session;
}

function cargarSesion() {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
}

function guardarSesion(session) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
}

function agregarFilas(session, nuevasFilas) {
    session.rows.push(...nuevasFilas);
    guardarSesion(session);
    return session;
}

function listarSesionesArchivadas() {
    const raw = localStorage.getItem(ARCHIVE_KEY);
    return raw ? JSON.parse(raw) : [];
}

function guardarArchivo(lista) {
    localStorage.setItem(ARCHIVE_KEY, JSON.stringify(lista));
}

// Al detener la captura NO se descarga de inmediato: el auditor está en la calle,
// no donde vaya a recoger el archivo (su computador/equipo). La sesión queda guardada
// en el dispositivo, pendiente de descarga, para que se puedan hacer varias sesiones
// durante el día (distintas estaciones u horarios pico) y descargarlas todas al final,
// cuando el auditor regrese a su equipo.
function archivarSesionActiva() {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const session = JSON.parse(raw);
    session.meta.endTime = ahoraSincronizado();
    session.meta.descargada = false;
    const archivo = listarSesionesArchivadas();
    archivo.push(session);
    guardarArchivo(archivo);
    localStorage.removeItem(SESSION_KEY);
    return session;
}

function marcarSesionDescargada(id) {
    const archivo = listarSesionesArchivadas();
    const s = archivo.find((x) => x.meta.id === id);
    if (s) s.meta.descargada = true;
    guardarArchivo(archivo);
}

function eliminarSesionArchivada(id) {
    guardarArchivo(listarSesionesArchivadas().filter((x) => x.meta.id !== id));
}

function haySesionActiva() {
    return localStorage.getItem(SESSION_KEY) !== null;
}
