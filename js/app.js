// Controlador de la app: pestañas, selección de estación/plataforma, sesión de captura,
// polling del SIC, tarjetas de monitoreo y flujo de auditoría (hora + identidad).

const POLL_INTERVAL_MS = 15000; // igual al apiFreq del kiosco oficial (CONFIG.apiFreq = 15)
const LIMITE_FILAS_SESION = 1000; // al llegar a esto, se descarga esa parte y se vacia localStorage (ver rotarParteSesion)

let paradasPlanas = {};       // stopId -> "Estacion Plataforma"
let estacionesAgrupadas = {}; // estacion -> [{stopId, plataforma, nombreCompleto}]
let session = null;
let pollTimer = null;
let currentStopId = null;
let currentPlatformRows = [];
// Caches de Última Atención/Próxima Llegada para cuando se está mirando Monitoreo sin una
// sesión de captura activa (ver pollTick) -- cuando hay sesión, se usan las de session.caches.
let monitorCaches = { historyCache: {}, approachingCache: {} };
// stopId -> {lat, lon} -- las coordenadas de una parada no cambian, se consulta una sola vez
// por parada (ver obtenerCoordsParada) y se reutiliza el resto de la sesión.
let paradaCoordsCache = {};
let auditSeleccion = null; // { route, destination, tripId, vehicleMc, marcada:{} }
let ultimoPollExitosoMs = null; // Date.now() del último fetchStopMessages que sí respondió -- ver actualizarPollEstadoUI
let wakeLock = null; // sentinel del Screen Wake Lock, solo mientras hay sesión de captura activa

// --- referencias DOM ---
const estacionSelect = document.getElementById('estacionSelect');
const plataformaSelect = document.getElementById('plataformaSelect');
const toggleSessionBtn = document.getElementById('toggleSessionBtn');
const sessionStatusEl = document.getElementById('sessionStatus');
const relojEstadoEl = document.getElementById('relojEstado');
const pollEstadoEl = document.getElementById('pollEstado');
const alertBannerEl = document.getElementById('alertBanner');
const cardsEl = document.getElementById('cards');
const sessionsArchiveEl = document.getElementById('sessionsArchive');
const auditEmptyEl = document.getElementById('auditEmpty');
const auditCardEl = document.getElementById('auditCard');
const auditButtonsEl = document.getElementById('auditButtons');
const btnMarcarHora = document.getElementById('btnMarcarHora');
const btnIdentidadSi = document.getElementById('btnIdentidadSi');
const btnIdentidadNo = document.getElementById('btnIdentidadNo');
const busFisicoWrapEl = document.getElementById('busFisicoWrap');
const numeroBusFisicoInput = document.getElementById('numeroBusFisico');
const btnGuardarBusFisico = document.getElementById('btnGuardarBusFisico');
const btnVolverMonitoreo = document.getElementById('btnVolverMonitoreo');
const startSessionDialog = document.getElementById('startSessionDialog');
const startSessionForm = document.getElementById('startSessionForm');
const auditorInput = document.getElementById('auditorInput');
const startEstacionLabel = document.getElementById('startEstacionLabel');
const btnAbrirSorpresa = document.getElementById('btnAbrirSorpresa');
const sorpresaFormEl = document.getElementById('sorpresaForm');
const sorpresaRutaInput = document.getElementById('sorpresaRuta');
const sorpresaIdInput = document.getElementById('sorpresaId');
const btnGuardarSorpresa = document.getElementById('btnGuardarSorpresa');

// --- pestañas ---
function cambiarTab(tab) {
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
    document.getElementById('tab-principal').classList.toggle('active', tab === 'principal');
    document.getElementById('tab-auditoria').classList.toggle('active', tab === 'auditoria');
}

document.querySelectorAll('.tab-btn').forEach(b => b.addEventListener('click', () => cambiarTab(b.dataset.tab)));
btnVolverMonitoreo.addEventListener('click', () => {
    auditSeleccion = null;
    renderizarAuditoria();
    cambiarTab('principal');
});

// --- selección de estación / plataforma ---
function poblarEstaciones() {
    const nombres = Object.keys(estacionesAgrupadas).sort((a, b) => a.localeCompare(b));
    estacionSelect.innerHTML = nombres.map(n => `<option value="${n}">${n}</option>`).join('');
    if (nombres.length) poblarPlataformas(nombres[0]);
}

function poblarPlataformas(estacionNombre) {
    const lista = estacionesAgrupadas[estacionNombre] || [];
    plataformaSelect.innerHTML = lista.map(p => `<option value="${p.stopId}">${p.plataforma || p.nombreCompleto}</option>`).join('');
    currentStopId = lista.length ? lista[0].stopId : null;
    cardsEl.innerHTML = '';
    monitorCaches = { historyCache: {}, approachingCache: {} };
    ultimoPollExitosoMs = null;
    if (session) {
        session.meta.lastStopId = currentStopId;
        guardarSesion(session);
    }
    if (currentStopId) iniciarPolling();
}

function seleccionarEnSelects(stopId) {
    const nombreCompleto = paradasPlanas[stopId];
    if (!nombreCompleto) return;
    const { estacion } = splitEstacionPlataforma(nombreCompleto);
    estacionSelect.value = estacion;
    const lista = estacionesAgrupadas[estacion] || [];
    plataformaSelect.innerHTML = lista.map(p => `<option value="${p.stopId}">${p.plataforma || p.nombreCompleto}</option>`).join('');
    plataformaSelect.value = stopId;
}

estacionSelect.addEventListener('change', () => poblarPlataformas(estacionSelect.value));
plataformaSelect.addEventListener('change', () => {
    currentStopId = plataformaSelect.value;
    cardsEl.innerHTML = '';
    monitorCaches = { historyCache: {}, approachingCache: {} };
    ultimoPollExitosoMs = null;
    if (session) {
        session.meta.lastStopId = currentStopId;
        guardarSesion(session);
    }
    if (currentStopId) iniciarPolling();
});

// --- sesión: encendido / apagado ---
function actualizarUIBotonSesion(activa) {
    toggleSessionBtn.textContent = activa ? 'Detener captura' : 'Iniciar captura';
    toggleSessionBtn.classList.toggle('activa', activa);
    sessionStatusEl.textContent = activa && session ? `Sesión activa — auditor: ${session.meta.auditor} — estación: ${session.meta.estacion}` : '';
    estacionSelect.disabled = activa; // una sesión = una estación (no se cambia de estación a mitad de sesión)
}

toggleSessionBtn.addEventListener('click', () => {
    if (session) {
        // El polling NO se detiene: Monitoreo sigue en vivo (igual que la pantalla física)
        // aunque se apague la grabación -- solo se deja de escribir en el CSV desde aquí.
        monitorCaches = session.caches;
        archivarSesionActiva();
        session = null;
        liberarWakeLock();
        actualizarUIBotonSesion(false);
        auditSeleccion = null;
        renderizarAuditoria();
        renderizarSesionesArchivadas();
    } else {
        if (!currentStopId) { alert('Selecciona primero una estación y plataforma.'); return; }
        startEstacionLabel.textContent = estacionSelect.value;
        auditorInput.value = '';
        startSessionDialog.showModal();
    }
});

startSessionForm.addEventListener('submit', (ev) => {
    const submitter = ev.submitter;
    if (!submitter || submitter.value !== 'default') return; // se canceló, el dialog se cierra solo
    const auditor = auditorInput.value.trim();
    if (!auditor) { ev.preventDefault(); alert('Debes indicar el nombre del auditor.'); return; }
    session = iniciarSesion({ estacion: estacionSelect.value, auditor });
    session.meta.lastStopId = currentStopId;
    guardarSesion(session);
    actualizarUIBotonSesion(true);
    iniciarPolling();
    solicitarWakeLock();
});

// --- sesiones archivadas (pendientes de descarga, normalmente hasta el final del día) ---
function renderizarSesionesArchivadas() {
    const lista = listarSesionesArchivadas();
    if (!lista.length) {
        sessionsArchiveEl.classList.add('hidden');
        sessionsArchiveEl.innerHTML = '';
        return;
    }
    sessionsArchiveEl.classList.remove('hidden');
    sessionsArchiveEl.innerHTML = `<h3>Sesiones guardadas en este dispositivo (${lista.length})</h3>` +
        lista.map((s) => {
            const d = new Date(s.meta.startTime);
            const fechaHora = `${d.toLocaleDateString()} ${d.toLocaleTimeString()}`;
            return `
            <div class="sesion-archivada${s.meta.descargada ? ' descargada' : ''}">
                <span>${s.meta.estacion} — ${fechaHora} — ${s.meta.auditor} — parte ${s.meta.parte || 1} — ${s.rows.length} filas${s.meta.descargada ? ' (ya descargada)' : ''}</span>
                <button type="button" class="btn-secundario" data-id="${s.meta.id}" data-accion="descargar">Descargar CSV</button>
                <button type="button" class="btn-secundario" data-id="${s.meta.id}" data-accion="eliminar">Eliminar</button>
            </div>`;
        }).join('');

    sessionsArchiveEl.querySelectorAll('button[data-accion="descargar"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const s = listarSesionesArchivadas().find((x) => x.meta.id === btn.dataset.id);
            if (!s) return;
            descargarCsvSesion(s, s.meta.parte);
            marcarSesionDescargada(s.meta.id);
            renderizarSesionesArchivadas();
        });
    });
    sessionsArchiveEl.querySelectorAll('button[data-accion="eliminar"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            if (!confirm('¿Eliminar esta sesión del dispositivo? Hazlo solo si ya descargaste y guardaste el CSV en tu equipo.')) return;
            eliminarSesionArchivada(btn.dataset.id);
            renderizarSesionesArchivadas();
        });
    });
}

// --- reloj sincronizado (encabezado) ---
// Muestra la hora corregida al reloj del sistema (ver js/reloj.js) y, si ya hay datos para
// calcularlo, el desfase detectado contra el reloj del dispositivo -- así el auditor ve de un
// vistazo si su dispositivo está confiable o no.
function actualizarRelojUI() {
    const ahora = new Date(ahoraSincronizado());
    const fecha = ahora.toLocaleDateString();
    const hora = ahora.toLocaleTimeString();
    const offset = offsetRelojActual();

    let desfase = 'sincronizando con el sistema…';
    let alerta = false;
    if (offset !== null) {
        const segundos = Math.round(offset / 1000);
        if (Math.abs(segundos) < 2) {
            desfase = 'reloj del dispositivo sin desfase significativo';
        } else {
            const signo = segundos > 0 ? 'atrasado' : 'adelantado';
            const abs = Math.abs(segundos);
            const mins = Math.floor(abs / 60);
            const secs = abs % 60;
            const texto = mins > 0 ? `${mins} min ${secs} s` : `${secs} s`;
            desfase = `dispositivo ${signo} ${texto} respecto al sistema`;
            alerta = abs >= 60;
        }
    }
    relojEstadoEl.textContent = `${fecha} ${hora} (hora del sistema) · ${desfase}`;
    relojEstadoEl.classList.toggle('alerta', alerta);
}

setInterval(actualizarRelojUI, 1000);

// Indicador de qué tan fresca está la última respuesta real del SIC -- independiente del reloj
// de arriba, que solo calcula hora local y sigue "corriendo" aunque el polling lleve minutos
// muerto (ver acta: el reloj no es prueba de que el polling esté vivo).
function actualizarPollEstadoUI() {
    if (!currentStopId) {
        pollEstadoEl.textContent = '';
        pollEstadoEl.classList.remove('alerta');
        return;
    }
    if (ultimoPollExitosoMs === null) {
        pollEstadoEl.textContent = 'datos del SIC: esperando primera respuesta…';
        pollEstadoEl.classList.remove('alerta');
        return;
    }
    const segundos = Math.round((Date.now() - ultimoPollExitosoMs) / 1000);
    const alerta = segundos > (POLL_INTERVAL_MS / 1000) * 2; // más de 2 ciclos sin respuesta nueva
    pollEstadoEl.textContent = alerta
        ? `⚠ datos del SIC desactualizados hace ${segundos}s — revisa pantalla/conexión`
        : `datos del SIC actualizados hace ${segundos}s`;
    pollEstadoEl.classList.toggle('alerta', alerta);
}

setInterval(actualizarPollEstadoUI, 1000);

// --- wake lock: evita que la pantalla se apague SOLA por inactividad mientras hay captura
// activa. No evita que el usuario la bloquee a propósito con el botón de encendido -- eso el
// sistema operativo nunca lo permite bloquear desde una página web. Por eso sigue siendo
// necesario el indicador de arriba (actualizarPollEstadoUI): el wake lock reduce un caso, no
// todos. Se libera solo cuando el documento pierde visibilidad, así que hay que volver a
// pedirlo cuando vuelve a estar visible.
async function solicitarWakeLock() {
    if (!session || !('wakeLock' in navigator)) return;
    try {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
    } catch (e) {
        wakeLock = null; // permiso denegado, batería baja, o navegador sin soporte -- no crítico
    }
}

function liberarWakeLock() {
    if (wakeLock) wakeLock.release().catch(() => {});
    wakeLock = null;
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session) solicitarWakeLock();
});

// --- polling del SIC ---
function iniciarPolling() {
    detenerPolling();
    pollTick();
    pollTimer = setInterval(pollTick, POLL_INTERVAL_MS);
}

function detenerPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
}

function filaBase(now) {
    return {
        timestamp_captura: formatearTimestampLocal(now),
        estacion: session.meta.estacion,
        plataforma: paradasPlanas[currentStopId] || '',
        stop_id: currentStopId,
        tipo_mensaje: '',
        line_name: '', destination_name: '', direction_id: '', trip_id: '',
        vehicle_raw: '', vehicle_mc: '', estimated_time: '', planned_departure_raw: '', message_text: '',
        raw_mensaje: '',
        bus_auditado: 'no', hora_llegada_auditor: '', identidad_ok: '', numero_bus_fisico: '',
        auditor: session.meta.auditor, eta_gps: '', distancia_gps_m: ''
    };
}

// gpsPorVehiculo: { numeroDeBus: minutosRestantes } del ciclo actual (ver pollTick) -- fuente
// independiente del SIC (servicios.siur.com.co), calculada por GPS real del bus.
// distanciaPorVehiculo: { vehicleRaw: metros } -- solo para los buses de "Próxima Llegada" de
// cada ruta (ver anexarDistanciaGps), no para todo el crudo.
function filaDesdeMensaje(m, now, gpsPorVehiculo, distanciaPorVehiculo) {
    const fila = filaBase(now);
    if (m && m.parseError) {
        fila.tipo_mensaje = 'PARSE_ERROR';
        fila.raw_mensaje = m.texto;
        return fila;
    }
    fila.tipo_mensaje = m[0];
    fila.raw_mensaje = JSON.stringify(m);
    if (m[0] === 1) {
        const vehiculo = resolveVehicle(m[5]);
        fila.line_name = m[2] ?? '';
        fila.destination_name = m[4] ?? '';
        fila.direction_id = m[3] ?? '';
        fila.trip_id = m[6] ?? '';
        fila.vehicle_raw = m[5] ?? '';
        fila.vehicle_mc = vehiculo.numero ?? '';
        fila.estimated_time = formatearEpochSiExiste(m[8]);
        fila.planned_departure_raw = formatearEpochSiExiste(m[7]);
        const minutosGps = gpsPorVehiculo ? gpsPorVehiculo[fila.vehicle_raw] : undefined;
        fila.eta_gps = (minutosGps !== undefined && minutosGps !== null) ? formatearTimestampLocal(now + minutosGps * 60000) : '';
        const metros = distanciaPorVehiculo ? distanciaPorVehiculo[fila.vehicle_raw] : undefined;
        fila.distancia_gps_m = (metros !== undefined && metros !== null) ? metros : '';
        if (auditSeleccion) {
            const mismoTrip = auditSeleccion.tripId !== null && String(auditSeleccion.tripId) === String(m[6]);
            const mismoFallback = auditSeleccion.tripId === null && auditSeleccion.route === m[2] && auditSeleccion.destination === m[4];
            if (mismoTrip || mismoFallback) fila.bus_auditado = 'si';
        }
    } else if (m[0] === 2) {
        for (let i = m.length - 1; i >= 1; i--) {
            if (typeof m[i] === 'string' && m[i].length > 5) { fila.message_text = m[i]; break; }
        }
    }
    return fila;
}

// Se usa en vez de agregarFilas() directo en cualquier punto donde se graban filas durante una
// sesión, para que el corte por límite de filas (ver rotarParteSesion) nunca se pueda olvidar
// en un punto nuevo.
function agregarFilasConLimite(nuevasFilas) {
    if (!session) return;
    agregarFilas(session, nuevasFilas);
    if (session.rows.length >= LIMITE_FILAS_SESION) rotarParteSesion();
}

// Nunca se descarta nada (ver acta): al llegar al límite se descarga esa parte tal cual está
// (misma sesión, mismo auditor/estación, numerada _01, _02, ...) y se vacía session.rows en
// localStorage para que el dispositivo no se quede sin espacio a mitad de una jornada larga.
// Los caches (historyCache/approachingCache) NO se tocan -- si se vaciaran junto con las filas,
// Última Atención/Próxima Llegada se rompería cada 1000 filas.
function rotarParteSesion() {
    descargarCsvSesion(session, session.meta.parte);
    session.rows = [];
    session.meta.parte = (session.meta.parte || 1) + 1;
    guardarSesion(session);
}

// Coordenadas de una parada, cacheadas en memoria (no cambian) -- se consulta paradas.php de
// cualquier ruta que pase por esta parada (la primera que funcione alcanza, es la misma
// plataforma física para todas). Si falla, NO se cachea el fallo, para reintentar en el próximo ciclo.
async function obtenerCoordsParada(route, stopId) {
    if (paradaCoordsCache[stopId]) return paradaCoordsCache[stopId];
    try {
        const lista = await fetchParadasDeRuta(route);
        const encontrada = lista.find(p => String(p.id) === String(stopId));
        if (encontrada) {
            const coords = { lat: parseFloat(encontrada.latitud), lon: parseFloat(encontrada.longitud) };
            paradaCoordsCache[stopId] = coords;
            return coords;
        }
    } catch (e) { /* SIUR no disponible este ciclo -- se reintenta el próximo */ }
    return null;
}

// Distancia en línea recta (no de calle, ver haversineMetros en api.js) entre el bus de
// "Próxima Llegada" de cada ruta y la parada -- deliberadamente acotado a esos buses (uno por
// ruta visible), no a todo el crudo de la plataforma, para no disparar un bus.php por cada una
// de las ~20-30 predicciones del ciclo.
async function anexarDistanciaGps(rows, stopId) {
    const distanciaPorVehiculo = {};
    await Promise.all(rows.map(async (row) => {
        if (!row.nextArrival || !row.nextArrival.vehicleMc) return;
        const coords = await obtenerCoordsParada(row.route, stopId);
        if (!coords) return;
        const numeroDigits = row.nextArrival.vehicleMc.replace(/^MC\s*/, '');
        let posBus;
        try { posBus = await fetchBusPosicion(numeroDigits); } catch (e) { return; }
        if (!posBus) return;
        const metros = Math.round(haversineMetros(posBus.lat, posBus.lon, coords.lat, coords.lon));
        row.nextArrival.distanciaMetros = metros;
        distanciaPorVehiculo[row.nextArrival.vehicleRaw] = metros;
    }));
    return distanciaPorVehiculo;
}

// Consulta el SIC y sincroniza el reloj SIEMPRE que haya una plataforma seleccionada, haya o
// no sesión de captura activa -- Monitoreo (y el reloj del encabezado) deben verse en vivo todo
// el tiempo, igual que la pantalla física del kiosco. El botón de captura solo controla si,
// además de mostrarse, esos datos también se graban en el CSV de la sesión.
async function pollTick() {
    if (!currentStopId) return;
    const localAntes = Date.now();
    let messages;
    try {
        messages = await fetchStopMessages(currentStopId);
    } catch (e) {
        if (session) {
            const filaError = filaBase(ahoraSincronizado());
            filaError.tipo_mensaje = 'ERROR';
            filaError.raw_mensaje = String((e && e.message) || e);
            agregarFilasConLimite([filaError]);
        }
        return; // se deja el hueco, sin reintento inmediato
    }
    const localDespues = Date.now();
    ultimoPollExitosoMs = localDespues;

    const serverTime = extraerTimestampServidor(messages);
    if (serverTime !== null) actualizarOffsetReloj(serverTime, localAntes, localDespues);
    const now = ahoraSincronizado();

    // Segunda fuente independiente (GPS real, ver js/api.js) -- no crítica: si falla este ciclo,
    // simplemente se deja eta_gps vacío, no se detiene el polling del SIC por esto.
    let gpsPorVehiculo = {};
    try {
        const buses = await fetchBusesProximosGps(currentStopId);
        for (const b of buses) {
            const minutos = parseCuentaRegresivaMin(b.cuentaRegresiva);
            if (minutos !== null) gpsPorVehiculo[b.numeroDeBus] = minutos;
        }
    } catch (e) { /* SIUR no disponible este ciclo */ }

    const mensajesValidos = messages.filter(m => Array.isArray(m));
    const { predicciones, alertas } = extraerPredicciones(mensajesValidos);
    const caches = session ? session.caches : monitorCaches;
    currentPlatformRows = agruparPrediccionesPorRuta(predicciones, currentStopId, now, caches);
    for (const row of currentPlatformRows) {
        if (row.nextArrival) {
            const minutos = gpsPorVehiculo[row.nextArrival.vehicleRaw];
            row.nextArrival.etaGpsMin = (minutos !== undefined) ? minutos : null;
        }
    }
    // Distancia (línea recta) del bus de "Próxima Llegada" de cada ruta a la parada -- se calcula
    // acá, antes de armar las filas del CSV, para poder anexarla a las filas de este mismo ciclo.
    const distanciaPorVehiculo = await anexarDistanciaGps(currentPlatformRows, currentStopId);

    if (session) {
        // Los mensajes tipo 5-9 son metadatos auxiliares que ni el propio kiosco oficial usa
        // para nada (ver acta, sección 2) y que nunca se lograron descifrar -- solo repiten
        // trip_id/stop_id sin aportar nada a la auditoría. Se dejaron de registrar el 2026-11-09
        // porque eran el 74% de las filas del CSV (ver acta, sección 13) sin ningún valor para
        // comparar hora predicha vs. real ni identidad del bus. Los tipos 0 (plataforma),
        // 1 (predicción), 2 (alerta) y 4 (reloj del servidor) sí se siguen guardando siempre,
        // igual que cualquier mensaje no reconocido (criterio: solo se descarta lo que ya está
        // identificado y confirmado como irrelevante).
        //
        // Tipo 1 (predicciones): el SIC manda TODOS los viajes de cada ruta para la próxima hora
        // (30-50 por plataforma), pero la pantalla solo muestra Última Atención, Próxima Llegada y
        // Siguiente. Desde el 2026-11-13 solo se graban esos (ver acta, sección 16): la próxima y
        // la siguiente de cada ruta, las que el SIC ya da como pasadas (fuente de Última Atención),
        // las que no traen ETA (no se pueden ubicar, se guardan por si acaso) y cualquier fila del
        // bus que se está auditando (aunque se haya atrasado y ya no sea "Próxima").
        const visibles = new Set();
        for (const r of currentPlatformRows) {
            if (r.nextArrival && r.nextArrival.msg) visibles.add(r.nextArrival.msg);
            if (r.following && r.following.msg) visibles.add(r.following.msg);
        }
        for (const p of predicciones) {
            if (p.eta === null || p.eta < now) visibles.add(p.msg);
        }
        const mensajesParaCsv = messages.filter(m => !(Array.isArray(m) && m[0] >= 5 && m[0] <= 9));
        const filasCrudas = [];
        for (const m of mensajesParaCsv) {
            const fila = filaDesdeMensaje(m, now, gpsPorVehiculo, distanciaPorVehiculo);
            const esTipo1 = Array.isArray(m) && m[0] === 1;
            if (!esTipo1 || visibles.has(m) || fila.bus_auditado === 'si') filasCrudas.push(fila);
        }
        agregarFilasConLimite(filasCrudas);
    }

    if (session) guardarSesion(session);

    renderizarCards(currentPlatformRows);
    renderizarAlertas(alertas);
    if (auditSeleccion) actualizarPrediccionAuditoria();
}

// Si hay predicción (hora) pero sin vehículo resuelto (vehicle_mc vacío), es candidato a
// "fantasma": el sistema generó un horario pero el operador no le asignó un bus a esa tarea --
// si eso nunca se completa antes de que pase la hora, ese horario se va a esfumar sin que llegue
// ningún bus. Se marca para que el auditor lo note en el momento, no solo revisando el CSV
// después.
function renderVehiculoSlot(slot) {
    if (!slot) return '';
    if (slot.vehicleMc) return `<small>${slot.vehicleMc}</small>`;
    return '<small class="sin-bus">sin bus asignado</small>';
}

// --- pestaña principal: tarjetas ---
function renderizarCards(rows) {
    if (!rows.length) {
        cardsEl.innerHTML = '<p class="muted">Sin predicciones activas en esta plataforma por ahora.</p>';
        return;
    }
    const now = ahoraSincronizado();
    cardsEl.innerHTML = rows.map(r => {
        const last = formatearTiempo(r.lastDeparted?.eta ?? null, now, true);
        const next = formatearTiempo(r.nextArrival?.eta ?? null, now, false);
        const foll = formatearTiempo(r.following?.eta ?? null, now, false);
        const gpsMin = r.nextArrival?.etaGpsMin;
        const gpsTexto = (gpsMin !== null && gpsMin !== undefined) ? `GPS: ${gpsMin} min` : '';
        const distM = r.nextArrival?.distanciaMetros;
        const distTexto = (distM !== null && distM !== undefined) ? (distM >= 1000 ? `~${(distM / 1000).toFixed(1)} km` : `~${distM} m`) : '';
        return `
        <div class="card-ruta">
            <div class="card-header">
                <span class="route-badge">${r.route}</span>
                <span class="card-destino">${r.destination}</span>
                <button class="btn-auditar" data-route="${r.route}" data-destino="${r.destination}">Auditar</button>
            </div>
            <div class="card-tiempos">
                <div class="tiempo-col"><label>Última Atención</label><span class="${last.estado}">${last.texto}</span>${renderVehiculoSlot(r.lastDeparted)}</div>
                <div class="tiempo-col"><label>Próxima Llegada</label><span class="${next.estado}">${next.texto}</span>${renderVehiculoSlot(r.nextArrival)}${gpsTexto ? `<small class="gps-eta">${gpsTexto}</small>` : ''}${distTexto ? `<small class="dist-gps">${distTexto} en línea recta</small>` : ''}</div>
                <div class="tiempo-col"><label>Siguiente</label><span class="${foll.estado}">${foll.texto}</span>${renderVehiculoSlot(r.following)}</div>
            </div>
        </div>`;
    }).join('');

    cardsEl.querySelectorAll('.btn-auditar').forEach(btn => {
        btn.addEventListener('click', () => seleccionarParaAuditar(btn.dataset.route, btn.dataset.destino));
    });
}

function renderizarAlertas(alertas) {
    if (!alertas.length) { alertBannerEl.classList.add('hidden'); return; }
    alertBannerEl.textContent = alertas.join(' | ');
    alertBannerEl.classList.remove('hidden');
}

// --- pestaña de auditoría ---
function seleccionarParaAuditar(route, destination) {
    if (!session) {
        alert('Primero tenés que iniciar la captura (botón del encabezado) para poder auditar un bus.');
        return;
    }
    const fila = currentPlatformRows.find(r => r.route === route && r.destination === destination);
    if (!fila || !fila.nextArrival) {
        alert('No hay una próxima llegada activa para esta ruta en este momento.');
        return;
    }
    auditSeleccion = {
        route, destination,
        tripId: fila.nextArrival.tripId,
        vehicleMc: fila.nextArrival.vehicleMc,
        marcada: {}
    };
    renderizarAuditoria();
    cambiarTab('auditoria');
}

function actualizarPrediccionAuditoria() {
    if (!auditSeleccion) return;
    const fila = currentPlatformRows.find(r => r.route === auditSeleccion.route && r.destination === auditSeleccion.destination);
    if (!fila) return;
    // Buscar el MISMO viaje (tripId) entre los tres slots -- nunca asumir que "Próxima Llegada"
    // sigue siendo el bus auditado: en cuanto su ETA pasa, el sistema lo mueve a "Última
    // Atención" y promueve el siguiente bus a "Próxima Llegada". Si no se valida el tripId,
    // la pantalla (y el CSV) terminan mostrando el bus SIGUIENTE justo cuando el auditado
    // llega tarde -- que es el caso que esta auditoría más necesita medir bien.
    const candidatos = [fila.nextArrival, fila.lastDeparted, fila.following];
    const match = candidatos.find(c => c && (
        auditSeleccion.tripId !== null
            ? String(c.tripId) === String(auditSeleccion.tripId)
            : c.route === auditSeleccion.route && c.destination === auditSeleccion.destination
    ));
    if (match) {
        auditSeleccion.vehicleMc = match.vehicleMc;
        if (auditSeleccion.tripId === null) auditSeleccion.tripId = match.tripId;
    }
    // si no hay match, se deja el último vehicleMc conocido -- congelado, no se pisa con otro bus
    renderizarAuditoria();
}

function renderizarAuditoria() {
    if (!auditSeleccion) {
        auditEmptyEl.classList.remove('hidden');
        auditCardEl.classList.add('hidden');
        auditButtonsEl.classList.add('hidden');
        return;
    }
    auditEmptyEl.classList.add('hidden');
    auditCardEl.classList.remove('hidden');
    auditButtonsEl.classList.remove('hidden');
    auditCardEl.innerHTML = `
        <div class="card-header">
            <span class="route-badge">${auditSeleccion.route}</span>
            <span class="card-destino">${auditSeleccion.destination}</span>
        </div>
        <p>Bus físico predicho por el sistema: <strong>${auditSeleccion.vehicleMc || 'sin número resuelto'}</strong></p>
        <p id="auditMarcasResumen" class="muted"></p>
    `;
    actualizarResumenMarcas();
}

function actualizarResumenMarcas() {
    const resumenEl = document.getElementById('auditMarcasResumen');
    if (!resumenEl || !auditSeleccion) return;
    const partes = [];
    if (auditSeleccion.marcada.hora) partes.push('Hora marcada: ' + auditSeleccion.marcada.hora.slice(11, 19));
    if (auditSeleccion.marcada.identidad) partes.push('Identidad: ' + auditSeleccion.marcada.identidad);
    resumenEl.textContent = partes.length ? partes.join(' · ') : 'Aún sin marcas para este bus.';
}

function construirFilaAuditoria(tipo) {
    const now = ahoraSincronizado();
    const fila = filaBase(now);
    fila.tipo_mensaje = tipo;
    fila.line_name = auditSeleccion.route;
    fila.destination_name = auditSeleccion.destination;
    fila.trip_id = auditSeleccion.tripId ?? '';
    fila.vehicle_mc = auditSeleccion.vehicleMc ?? '';
    fila.bus_auditado = 'si';
    return fila;
}

btnMarcarHora.addEventListener('click', () => {
    if (!auditSeleccion || !session) return;
    const fila = construirFilaAuditoria('AUDITORIA_HORA');
    fila.hora_llegada_auditor = fila.timestamp_captura;
    agregarFilasConLimite([fila]);
    auditSeleccion.marcada.hora = fila.hora_llegada_auditor;
    actualizarResumenMarcas();
});

btnIdentidadSi.addEventListener('click', () => {
    if (!auditSeleccion || !session) return;
    const fila = construirFilaAuditoria('AUDITORIA_IDENTIDAD');
    fila.identidad_ok = 'si';
    agregarFilasConLimite([fila]);
    auditSeleccion.marcada.identidad = 'sí coincide';
    busFisicoWrapEl.classList.add('hidden');
    actualizarResumenMarcas();
});

btnIdentidadNo.addEventListener('click', () => {
    busFisicoWrapEl.classList.remove('hidden');
    numeroBusFisicoInput.value = '';
    numeroBusFisicoInput.focus();
});

btnGuardarBusFisico.addEventListener('click', () => {
    if (!auditSeleccion || !session) return;
    const numero = numeroBusFisicoInput.value.trim();
    if (!numero) return;
    const fila = construirFilaAuditoria('AUDITORIA_IDENTIDAD');
    fila.identidad_ok = 'no';
    fila.numero_bus_fisico = numero;
    agregarFilasConLimite([fila]);
    auditSeleccion.marcada.identidad = `no coincide (bus real: ${numero})`;
    busFisicoWrapEl.classList.add('hidden');
    numeroBusFisicoInput.value = '';
    actualizarResumenMarcas();
});

// --- bus sorpresa: llega un bus en una ruta vigilada, pero su ID no corresponde a ninguno de
// los pronosticados (ni Última Atención, ni Próxima Llegada, ni Siguiente) -- distinto de
// "Identidad: No coincide", que asume que el bus que llegó SÍ es el trip que se está auditando,
// solo que con número físico equivocado. Independiente de auditSeleccion a propósito: el
// sistema debe preguntar la ruta, no asumirla de una tarjeta ya elegida.
btnAbrirSorpresa.addEventListener('click', () => {
    if (!session) { alert('Primero tenés que iniciar la captura para poder registrar un bus sorpresa.'); return; }
    sorpresaFormEl.classList.remove('hidden');
    sorpresaRutaInput.value = '';
    sorpresaIdInput.value = '';
    sorpresaRutaInput.focus();
});

btnGuardarSorpresa.addEventListener('click', () => {
    if (!session) return;
    const ruta = sorpresaRutaInput.value.trim();
    const numero = sorpresaIdInput.value.trim();
    if (!ruta || !numero) { alert('Hace falta la ruta y el número del bus.'); return; }
    const now = ahoraSincronizado();
    const fila = filaBase(now);
    fila.tipo_mensaje = 'AUDITORIA_SORPRESA';
    fila.line_name = ruta;
    fila.numero_bus_fisico = numero;
    fila.hora_llegada_auditor = fila.timestamp_captura;
    agregarFilasConLimite([fila]);
    sorpresaFormEl.classList.add('hidden');
});

// --- arranque ---
async function init() {
    actualizarRelojUI();
    try {
        paradasPlanas = await loadParadas();
    } catch (e) {
        alert('No se pudo cargar el catálogo de paradas (sin conexión). Vuelve a intentar con internet disponible.');
        return;
    }
    estacionesAgrupadas = agruparPorEstacion(paradasPlanas);
    poblarEstaciones();

    session = cargarSesion();
    if (session) {
        actualizarUIBotonSesion(true);
        if (session.meta.lastStopId) {
            currentStopId = session.meta.lastStopId;
            seleccionarEnSelects(currentStopId);
        }
        iniciarPolling();
        solicitarWakeLock();
    } else {
        actualizarUIBotonSesion(false);
    }
    renderizarAuditoria();
    renderizarSesionesArchivadas();

    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('sw.js').catch(() => { /* instalación como PWA es opcional, no bloquea el uso */ });
    }
}

window.addEventListener('DOMContentLoaded', init);
