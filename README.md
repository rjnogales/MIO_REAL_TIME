# App de auditoría del SIC del MIO — primera versión funcional

Requerimientos y decisiones completas: [`../ACTAS/2026-11-05_requerimientos_app_auditoria_SIC.md`](../ACTAS/2026-11-05_requerimientos_app_auditoria_SIC.md)

## Cómo probarla

Es una PWA sin build (HTML/CSS/JS plano, sin dependencias ni paso de compilación). Para probarla hay que servirla por `http://` o `https://` (no abrir el `index.html` con doble clic / `file://`, porque el service worker y el `<dialog>` no funcionan bien así en todos los navegadores):

```
cd CODE
npx serve .
```

o con Python si está disponible:

```
cd CODE
python -m http.server 8080
```

Y abrir la URL que indique en el navegador del celular (misma red Wi-Fi) o en el navegador del computador para probar el flujo primero.

Necesita internet real (datos móviles o Wi-Fi normal) para llegar al dominio público de predicciones — no requiere estar dentro de la red de Metrocali:
- `https://vdv-cali.utryt.com.co` — predicciones de llegada en vivo (confirmado que envía `Access-Control-Allow-Origin: *`, funciona desde el navegador sin problema).

El catálogo de paradas (`https://www.utryt.com.co/.../paradas.json`) **no** se consume en vivo: ese endpoint no envía cabecera CORS, así que un navegador serviría la app desde otro origen y el `fetch()` fallaría. Se usa un snapshot embebido (`data/paradas.js`) — ver más abajo.

## Estructura de carpetas

```
CODE/
  index.html              estructura de la app (dos pestañas, diálogo de inicio de sesión)
  manifest.webmanifest     metadatos PWA (nombre, orientación horizontal, ícono)
  sw.js                    service worker: solo cachea el shell estático, nunca los datos del SIC
  css/style.css            estilos (pensado para celular en horizontal)
  data/paradas.js          snapshot embebido del catálogo de paradas (269 plataformas), ver nota CORS abajo
  js/
    vehiculos.js           tabla de resolución de número físico de bus (MC XXXXX), copiada del kiosco oficial
    reloj.js                sincronización del reloj del dispositivo contra el reloj del servidor del SIC (ver nota abajo)
    api.js                 fetch a la API del SIC + carga del catálogo de paradas (snapshot + intento de refresco en vivo)
    logic.js                agrupación Última Atención / Próxima Llegada / Siguiente (portado del kiosco oficial)
    storage.js              persistencia de la sesión en localStorage (sobrevive a recarga/cierre accidental)
    csv.js                   construcción y descarga del CSV único de la sesión
    app.js                   controlador: pestañas, selects, botón de sesión, polling, tarjetas, auditoría
  icons/icon.svg            ícono de la PWA
```

## Notas de diseño importantes (ver acta para el detalle completo)

- **Catálogo de paradas**: se usa un snapshot embebido (`data/paradas.js`, descargado 2026-11-05, 269 plataformas de todo el sistema MIO) en vez de `DATA/estacionesCodigo.txt` (solo tenía 15 estaciones) — y en vez de un fetch en vivo, porque ese endpoint no tiene CORS habilitado (confirmado con `curl -D-`, no envía `Access-Control-Allow-Origin`). La app igual intenta refrescarlo en vivo por si algún día lo habilitan; si Metrocali agrega estaciones nuevas mientras tanto, hay que volver a descargar el JSON y actualizar `data/paradas.js` a mano.
- **Predicción del bus físico**: `vehiculos.js` resuelve el código corto que entrega la API al número real pintado en el bus ("MC XXXXX"), igual que hace la pantalla física. La pestaña de auditoría muestra ese número predicho para que el auditor solo tenga que confirmar si lo que ve coincide.
- **A diferencia del kiosco oficial**, esta app **nunca descarta** una predicción por no tener ETA o vehículo resuelto — todo se registra en el CSV (ver acta, decisión "cargar todo lo que se pueda").
- **Mapeo de campos pendiente de confirmar en campo**: `direction_id` (arr[3]) y `trip_id` (arr[6]) del mensaje tipo 1 son inferencias razonables, no confirmadas contra documentación oficial — ver comentarios en `logic.js` y la sección de pendientes del acta.
- Una sesión queda ligada a una sola estación (el selector de estación se bloquea mientras hay sesión activa), pero sí se puede cambiar de plataforma dentro de ella.
- **Mensajes tipo 5-9 ya no se registran**: eran metadatos auxiliares sin descifrar (el propio kiosco oficial tampoco los usa) y pesaban el 74% de las filas del CSV sin aportar nada a la auditoría — ver acta, sección 13, para el criterio completo de por qué estos sí se excluyen y nada más.
- **Reloj sincronizado con el sistema**: el reloj del dispositivo (celular, tablet o computador) puede estar desfasado varios minutos frente al reloj real del SIC (detectado en campo, hasta 4 min). La API manda su propia hora de servidor en cada respuesta (mensaje tipo 4, `[4,"2.0",timestampMs]`); `js/reloj.js` calcula el desfase contra el reloj local en cada ciclo de polling y lo aplica a **todo** lo que la app registra o compara (CSV, marcas del auditor, estado Próxima Llegada/LLEGANDO). El encabezado muestra la hora corregida y el desfase detectado frente al dispositivo — ver acta, sección 12.
- **Descarga diferida del CSV**: al apagar la captura (botón "Detener captura") la sesión NO se descarga en ese momento, solo se archiva en `localStorage` (clave `sic_audit_sessions_archive_v1`, ver `js/storage.js`). El auditor puede seguir encadenando sesiones el resto del día; todas quedan listadas en un recuadro amarillo "Sesiones guardadas en este dispositivo" (arriba de las tarjetas, pestaña Monitoreo), cada una con botón de descarga individual y botón de eliminar (pensado para usarse al final del día, cuando ya se guardó el CSV en el computador).
