// Construcción y descarga del CSV único de la sesión.
// Orden de columnas: ver acta ACTAS/2026-11-05_requerimientos_app_auditoria_SIC.md, sección 6.

const CSV_COLUMNS = [
    'timestamp_captura', 'estacion', 'plataforma', 'stop_id', 'tipo_mensaje',
    'line_name', 'destination_name', 'direction_id', 'trip_id',
    'vehicle_raw', 'vehicle_mc', 'estimated_time', 'planned_departure_raw', 'message_text',
    'raw_mensaje',
    'bus_auditado', 'hora_llegada_auditor', 'identidad_ok', 'numero_bus_fisico', 'auditor',
    'eta_gps', // hora estimada por posición GPS real (servicios.siur.com.co), ver js/api.js -- solo tipo 1
    'distancia_gps_m' // distancia en linea recta bus-parada en metros (haversine), ver js/app.js -- solo tipo 1, solo para el bus de "Próxima Llegada" de cada ruta
];

function escaparCsv(valor) {
    if (valor === null || valor === undefined) return '';
    const s = String(valor);
    if (/[",\n;]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
}

function sesionACsv(session) {
    const lineas = [CSV_COLUMNS.join(',')];
    for (const fila of session.rows) {
        lineas.push(CSV_COLUMNS.map(c => escaparCsv(fila[c])).join(','));
    }
    return lineas.join('\r\n');
}

// parte: número de entrega dentro de la sesión (ver "corte cada 1000 filas" en js/app.js) --
// todas las sesiones llevan sufijo de parte, incluida la última (la que descarga al apagar la
// captura), para que en el computador no haya ambigüedad al unir _01, _02, ... _0n.
function nombreArchivoSesion(meta, parte) {
    const d = new Date(meta.startTime);
    const pad = n => String(n).padStart(2, '0');
    const fecha = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    const hora = `${pad(d.getHours())}${pad(d.getMinutes())}`;
    const estacionSlug = (meta.estacion || 'estacion').trim().replace(/[^\w\-]+/g, '_');
    const sufijoParte = `_${pad(parte || 1)}`;
    return `${estacionSlug}_${fecha}_${hora}${sufijoParte}.csv`;
}

function descargarCsvSesion(session, parte) {
    const csv = sesionACsv(session);
    const blob = new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8;' }); // BOM para que Excel reconozca UTF-8
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = nombreArchivoSesion(session.meta, parte ?? session.meta.parte);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
}
