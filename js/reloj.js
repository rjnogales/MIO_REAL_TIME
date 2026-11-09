// Sincronización de reloj: compensa el desfase entre el reloj del dispositivo y el reloj
// del servidor del SIC, usando el mensaje tipo 4 que manda la API en cada respuesta
// ([4, version, timestampServidorMs], ej. [4,"2.0",1793895726405]).
//
// Sin esto, toda la auditoría (CSV, marcas del auditor, estado Próxima Llegada/LLEGANDO)
// dependía del reloj del celular -- en campo se detectaron desfases de hasta 4 minutos,
// suficientes para invalidar la comparación hora predicha vs. hora real.

let relojOffsetMs = 0;
let relojSincronizado = false;

// Llamar en cada ciclo de polling que traiga mensaje tipo 4, con el momento local justo
// antes y justo después del fetch (se promedian para compensar la latencia de red).
function actualizarOffsetReloj(serverTimeMs, localAntes, localDespues) {
    const localEstimado = (localAntes + localDespues) / 2;
    relojOffsetMs = serverTimeMs - localEstimado;
    relojSincronizado = true;
}

// "Ahora" corregido al reloj del servidor del SIC. Usar siempre esta función en vez de
// Date.now() para cualquier dato que vaya a compararse contra las predicciones del sistema
// o que vaya a quedar en el CSV de auditoría.
function ahoraSincronizado() {
    return Date.now() + relojOffsetMs;
}

// Desfase actual (servidor - dispositivo) en ms, o null si aún no se recibió ningún
// mensaje tipo 4 en esta sesión del navegador.
function offsetRelojActual() {
    return relojSincronizado ? relojOffsetMs : null;
}
