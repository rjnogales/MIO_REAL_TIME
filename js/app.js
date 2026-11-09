// Controlador de la app: pestañas, selección de estación/plataforma, sesión de captura,
// polling del SIC, tarjetas de monitoreo y flujo de auditoría (hora + identidad).

const POLL_INTERVAL_MS = 15000; // igual al apiFreq del kiosco oficial (CONFIG.apiFreq = 15)

let paradasPlanas = {};       // stopId -> "Estacion Plataforma"
let estacionesAgrupadas = {}; // estacion -> [{stopId, plataforma, nombreCompleto}]
let session = null;
let pollTimer = null;
let currentStopId = null;
let currentPlatformRows = [];
// Caches de Última Atención/Próxima Llegada para cuando se está mirando Monitoreo sin una
// sesión de captura activa (ver pollTick) -- cuando hay sesión, se usan las de session.caches.
let monitorCaches = { historyCache: {}, approachingCache: {} };
let auditSeleccion = null; // { route, destination, tripId, vehicleMc, marcada:{} }

// --- referencias DOM ---
const estacionSelect = document.getElementById('estacionSelect');
const plataformaSelect = document.getElementById('plataformaSelect');
const toggleSessionBtn = document.getElementById('toggleSessionBtn');
const sessionStatusEl = document.getElementById('sessionStatus');
const relojEstadoEl = document.getElementById('relojEstado');
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
                <span>${s.meta.estacion} — ${fechaHora} — ${s.meta.auditor} — ${s.rows.length} filas${s.meta.descargada ? ' (ya descargada)' : ''}</span>
                <button type="button" class="btn-secundario" data-id="${s.meta.id}" data-accion="descargar">Descargar CSV</button>
                <button type="button" class="btn-secundario" data-id="${s.meta.id}" data-accion="eliminar">Eliminar</button>
            </div>`;
        }).join('');

    sessionsArchiveEl.querySelectorAll('button[data-accion="descargar"]').forEach((btn) => {
        btn.addEventListener('click', () => {
            const s = listarSesionesArchivadas().find((x) => x.meta.id === btn.dataset.id);
            if (!s) return;
            descargarCsvSesion(s);
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
        auditor: session.meta.auditor
    };
}

function filaDesdeMensaje(m, now) {
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
            agregarFilas(session, [filaError]);
        }
        return; // se deja el hueco, sin reintento inmediato
    }
    const localDespues = Date.now();

    const serverTime = extraerTimestampServidor(messages);
    if (serverTime !== null) actualizarOffsetReloj(serverTime, localAntes, localDespues);
    const now = ahoraSincronizado();

    if (session) {
        // Los mensajes tipo 5-9 son metadatos auxiliares que ni el propio kiosco oficial usa
        // para nada (ver acta, sección 2) y que nunca se lograron descifrar -- solo repiten
        // trip_id/stop_id sin aportar nada a la auditoría. Se dejaron de registrar el 2026-11-09
        // porque eran el 74% de las filas del CSV (ver acta, sección 13) sin ningún valor para
        // comparar hora predicha vs. real ni identidad del bus. Los tipos 0 (plataforma),
        // 1 (predicción), 2 (alerta) y 4 (reloj del servidor) sí se siguen guardando siempre,
        // igual que cualquier mensaje no reconocido (criterio: solo se descarta lo que ya está
        // identificado y confirmado como irrelevante).
        const mensajesParaCsv = messages.filter(m => !(Array.isArray(m) && m[0] >= 5 && m[0] <= 9));
        const filasCrudas = mensajesParaCsv.map(m => filaDesdeMensaje(m, now));
        agregarFilas(session, filasCrudas);
    }

    const mensajesValidos = messages.filter(m => Array.isArray(m));
    const { predicciones, alertas } = extraerPredicciones(mensajesValidos);
    const caches = session ? session.caches : monitorCaches;
    currentPlatformRows = agruparPrediccionesPorRuta(predicciones, currentStopId, now, caches);
    if (session) guardarSesion(session);

    renderizarCards(currentPlatformRows);
    renderizarAlertas(alertas);
    if (auditSeleccion) actualizarPrediccionAuditoria();
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
        return `
        <div class="card-ruta">
            <div class="card-header">
                <span class="route-badge">${r.route}</span>
                <span class="card-destino">${r.destination}</span>
                <button class="btn-auditar" data-route="${r.route}" data-destino="${r.destination}">Auditar</button>
            </div>
            <div class="card-tiempos">
                <div class="tiempo-col"><label>Última Atención</label><span class="${last.estado}">${last.texto}</span><small>${r.lastDeparted?.vehicleMc || ''}</small></div>
                <div class="tiempo-col"><label>Próxima Llegada</label><span class="${next.estado}">${next.texto}</span><small>${r.nextArrival?.vehicleMc || ''}</small></div>
                <div class="tiempo-col"><label>Siguiente</label><span class="${foll.estado}">${foll.texto}</span><small>${r.following?.vehicleMc || ''}</small></div>
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
    if (fila && fila.nextArrival) {
        auditSeleccion.vehicleMc = fila.nextArrival.vehicleMc;
        if (auditSeleccion.tripId === null) auditSeleccion.tripId = fila.nextArrival.tripId;
    }
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
    agregarFilas(session, [fila]);
    auditSeleccion.marcada.hora = fila.hora_llegada_auditor;
    actualizarResumenMarcas();
});

btnIdentidadSi.addEventListener('click', () => {
    if (!auditSeleccion || !session) return;
    const fila = construirFilaAuditoria('AUDITORIA_IDENTIDAD');
    fila.identidad_ok = 'si';
    agregarFilas(session, [fila]);
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
    agregarFilas(session, [fila]);
    auditSeleccion.marcada.identidad = `no coincide (bus real: ${numero})`;
    busFisicoWrapEl.classList.add('hidden');
    numeroBusFisicoInput.value = '';
    actualizarResumenMarcas();
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
