// Lógica de agrupación de predicciones (Última Atención / Próxima Llegada / Siguiente),
// portada del frontend oficial del kiosco (función processData en mio_kiosco_v3.html),
// porque "Última Atención" no viene como tal en la API: se infiere comparando ciclos
// de consulta sucesivos (si un bus que estaba "por llegar" desaparece de la lista futura,
// se asume que ya pasó).
//
// Mapeo de campos del mensaje tipo 1, confirmado contra el código fuente del kiosco:
//   arr[2] = ruta (LineName)
//   arr[3] = sentido (DirectionId) -- no usado por el kiosco, pero consistente con los datos observados
//   arr[4] = destino (DestinationName)
//   arr[5] = código corto de vehículo -> resolver con resolveVehicle() para el número físico (MC XXXXX)
//   arr[6] = no usado por el kiosco -- probablemente TripId (ReturnList lo pide)
//   arr[7] = no usado por el kiosco -- probablemente PlannedDepartureTime (ReturnList lo pide)
//   arr[8] = EstimatedTime en ms (confirmado explícitamente en comentario del código fuente)
// arr[6] y arr[7] quedan documentados como hipótesis, no confirmados -- ver acta, sección "Pendientes".

// A diferencia del kiosco, aquí NUNCA se descartan predicciones (ni por ETA nula ni por
// vehículo sin resolver): el registro crudo de auditoría debe conservar todo.
function extraerPredicciones(messages) {
    const predicciones = [];
    const alertas = [];
    for (const arr of messages) {
        if (!Array.isArray(arr)) continue;
        if (arr[0] === 1) {
            const etaRaw = arr[8];
            const eta = (etaRaw !== null && etaRaw !== undefined) ? parseInt(etaRaw, 10) : null;
            const vehiculo = resolveVehicle(arr[5]);
            predicciones.push({
                route: arr[2] ?? '?',
                destination: arr[4] ?? '---',
                directionId: arr[3] ?? null,
                tripId: arr[6] ?? null,
                plannedDepartureRaw: arr[7] ?? null,
                vehicleRaw: arr[5] ?? null,
                vehicleMc: vehiculo.numero,
                eta
            });
        } else if (arr[0] === 2 && arr[1] === null) {
            for (let i = arr.length - 1; i >= 1; i--) {
                if (typeof arr[i] === 'string' && arr[i].length > 5) {
                    alertas.push(arr[i]);
                    break;
                }
            }
        }
    }
    return { predicciones, alertas };
}

// Orden visual de las tarjetas: la ruta cuyo próximo bus llega primero, arriba -- a diferencia
// del kiosco oficial (que ordena por prefijo de ruta E/T/P/A/C-F fijo), aquí lo que importa en
// campo es de un vistazo cuál hay que mirar ahora. Las rutas sin próxima llegada activa quedan
// al final.
function ordenarRutas(rows) {
    return rows.slice().sort((a, b) => {
        const ea = a.nextArrival ? a.nextArrival.eta : Infinity;
        const eb = b.nextArrival ? b.nextArrival.eta : Infinity;
        if (ea !== eb) return ea - eb;
        return a.route.localeCompare(b.route, undefined, { numeric: true, sensitivity: 'base' });
    });
}

// caches: { historyCache: {}, approachingCache: {} } -- se persisten en storage.js entre ciclos
// de la misma plataforma, igual que el kiosco las persiste en localStorage.
function agruparPrediccionesPorRuta(predicciones, stopId, now, caches) {
    const grupos = {};
    for (const p of predicciones) {
        const key = `${stopId}|${p.route}|${p.destination}`;
        if (!grupos[key]) grupos[key] = { key, route: p.route, destination: p.destination, predicciones: [] };
        grupos[key].predicciones.push(p);
    }

    const resultado = [];
    for (const g of Object.values(grupos)) {
        g.predicciones.sort((a, b) => (a.eta ?? Infinity) - (b.eta ?? Infinity));
        const conEta = g.predicciones.filter(p => p.eta !== null);
        const past = conEta.filter(p => p.eta < now).reverse(); // más reciente primero
        const future = conEta.filter(p => p.eta >= now);

        const currentNext = future[0] || null;
        const lastKnownNext = caches.approachingCache[g.key];

        if (past.length > 0) {
            caches.historyCache[g.key] = past[0];
        } else if (lastKnownNext && (!currentNext || lastKnownNext.vehicleRaw !== currentNext.vehicleRaw || lastKnownNext.tripId !== currentNext.tripId)) {
            caches.historyCache[g.key] = lastKnownNext;
        }

        if (currentNext) {
            caches.approachingCache[g.key] = currentNext;
        }

        resultado.push({
            route: g.route,
            destination: g.destination,
            lastDeparted: caches.historyCache[g.key] || null,
            nextArrival: currentNext,
            following: future[1] || null
        });
    }

    return ordenarRutas(resultado);
}

// Formato de tiempo igual al kiosco: "< 1 min", "N min", "LLEGANDO", "---".
function formatearTiempo(etaMs, now, esPasado) {
    if (etaMs === null || etaMs === undefined) return { texto: '---', estado: 'sin-dato' };
    if (esPasado) {
        let elapsed = Math.round((now - etaMs) / 60000);
        if (elapsed > 45) elapsed = 45;
        return { texto: elapsed <= 0 ? '< 1 min' : `${elapsed} min`, estado: 'pasado' };
    }
    const diff = Math.round((etaMs - now) / 60000);
    if (diff <= 0) return { texto: 'LLEGANDO', estado: 'llegando' };
    return { texto: `${diff} min`, estado: 'futuro' };
}
