# App de auditoría del SIC del MIO — primera versión funcional

Requerimientos y decisiones: [`../ACTAS/2026-11-05_requerimientos_app_auditoria_SIC.md`](../ACTAS/2026-11-05_requerimientos_app_auditoria_SIC.md) (referencia por tema; el detalle narrativo de cada decisión está en el [histórico](../ACTAS/2026-11-05_requerimientos_app_auditoria_SIC_historico.md))

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

## Notas de diseño importantes (ver acta §3-4 para el detalle completo)

Conceptos (fantasma, sorpresa, fuentes de datos, filtro de grabación, reloj sincronizado, corte cada 1000 filas, descarga diferida) ya están en el acta — acá solo lo que no está ahí, dónde vive cada cosa en el código:

- `data/paradas.js`: snapshot estático del catálogo de paradas (269 plataformas) porque el endpoint oficial no tiene CORS. Si Metrocali abre/renombra estaciones, re-descargar y actualizar a mano.
- `js/vehiculos.js`: resuelve el código corto de la API al número físico del bus ("MC XXXXX").
- `js/reloj.js`: sincronización del reloj contra el servidor (mensaje tipo 4 del SIC).
- `js/api.js` (`fetchBusesProximosGps`): cruce con SIUR para `eta_gps` y `distancia_gps_m` (bus/parada vía `bus.php`/`paradas.php`, haversine, línea recta — no es distancia de calle).
- `js/storage.js`: archivo de sesiones en `localStorage` (clave `sic_audit_sessions_archive_v1`), lista "Sesiones guardadas en este dispositivo" para descarga diferida.
- Una sesión queda ligada a una sola estación (selector bloqueado mientras hay sesión activa); sí se puede cambiar de plataforma dentro de ella.
- A diferencia del kiosco oficial, esta app nunca descarta una predicción por no tener ETA o vehículo resuelto — todo se registra (sujeto al filtro del acta §4).
