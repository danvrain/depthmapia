# DepthMapIA

Plataforma para convertir videos cortos en mapas de profundidad. El usuario sube
un video de hasta **20 MB**, recorta el tramo que le interesa (hasta **15
segundos**), la app genera el mapa de profundidad y le entrega el video listo
para descargar.

## Cómo funciona

Todo el procesamiento ocurre **en el navegador del usuario**. El video nunca se
sube a un servidor.

```
video → mediabunny (decodifica) → Depth Anything V2 (transformers.js + WebGPU)
      → normalización temporal → mediabunny (codifica) → MP4 descargable
```

Esto es lo que hace posible alojarlo en cPanel: el hosting solo sirve archivos
estáticos, y el cómputo lo pone la máquina de quien sube el video. No hay costo
por video ni límites de RAM del servidor.

### Recorte

El video de origen puede durar hasta 10 minutos; lo que se limita a 15 segundos
es la selección. El editor muestra miniaturas, permite arrastrar los extremos o
deslizar la ventana completa, y reproduce solo el tramo elegido en bucle.

Solo se decodifica el tramo seleccionado — no se recorta ni se re-codifica el
archivo de entrada — y los timestamps se rebasan a cero para que el resultado no
arranque con un hueco.

### Capturas para motores de video por IA

Dos formas de sacar un still, pensadas para alimentar modelos image-to-video:

- **Capturar frame (PNG)** en el editor: exporta el frame donde esté la línea
  blanca, a la resolución original del video (mayor que la del procesado). El
  nombre incluye el segundo, p. ej. `clip-frame-6s00.png`.
- **Primer frame en profundidad**: se publica en cuanto existe, sin esperar a
  que termine el clip, para flujos condicionados por profundidad.

### Opciones disponibles

- **Modelos**: Depth Anything V2 Small (por defecto), V2 Base y V1 Small.
- **Salida**: escala de grises, colormap *inferno*, u original + depth lado a lado.
- **Estabilizar**: suaviza el rango de profundidad entre frames. El modelo
  normaliza cada frame de forma independiente, lo que provoca un parpadeo muy
  visible en video; esta opción lo elimina casi por completo. Activado por defecto.
- **Invertir**: cambia la convención a cerca = negro.

## Desarrollo

```bash
npm install
npm run dev      # http://localhost:3000
npm run build    # genera ./out
```

## Desplegar en cPanel

1. `npm run build` — genera la carpeta `out/`.
2. Entra a **cPanel → Administrador de archivos**.
3. Sube **el contenido** de `out/` (no la carpeta) dentro de `public_html/`.
   Si prefieres un subdominio o subcarpeta, súbelo ahí y ajusta `basePath` en
   `next.config.ts`.
4. Listo. No hace falta activar Node.js ni configurar nada más — son archivos
   estáticos.

> Los pesos del modelo se descargan desde el CDN de Hugging Face la primera vez
> que alguien usa la app y quedan en la caché del navegador. Si prefieres
> servirlos desde tu propio dominio, define `env.remoteHost` en
> `workers/depth.worker.ts`.

### Cabeceras recomendadas en cPanel

Sin las cabeceras COOP/COEP el navegador no puede usar `SharedArrayBuffer`, y
onnxruntime-web cae a WASM de un solo hilo (bastante más lento cuando no hay
WebGPU). Crea un `.htaccess` dentro de `public_html/`:

```apache
<IfModule mod_headers.c>
  Header set Cross-Origin-Opener-Policy "same-origin"
  Header set Cross-Origin-Embedder-Policy "credentialless"
</IfModule>
```

`credentialless` en vez de `require-corp` es importante: permite seguir
descargando los pesos del modelo desde el CDN de Hugging Face.

## Desplegar en Railway

El repo incluye `Dockerfile`, `Caddyfile` y `railway.json`. Railway detecta el
Dockerfile y sirve el export estático con Caddy, ya con las cabeceras COOP/COEP
configuradas.

```bash
railway init
railway up
```

O conecta el repo desde el dashboard de Railway y despliega en cada push.

Railway **no ofrece GPU** fuera del plan Enterprise, así que la inferencia sigue
corriendo en el navegador igual que en cPanel — Railway solo actúa como host.
La ventaja sobre cPanel es el deploy automático desde git y poder añadir un
backend después sin cambiar de proveedor.

## Requisitos del navegador

Pensada para **escritorio**. Al cargar la página se comprueban las capacidades
del navegador y se avisa antes de descargar nada:

| Navegador | Resultado |
|---|---|
| Chrome / Edge actualizados | Funciona con WebGPU (rápido) |
| Safari 26+ (macOS, iOS, iPadOS) | Funciona con WebGPU (rápido) |
| Safari 16.4 – 18 | Funciona, pero en CPU (lento) |
| Safari ≤ 16.3 | Bloqueado — sin WebCodecs |
| Móviles y tablets | Aviso: puede tardar mucho o quedarse sin memoria |

Requisitos duros: `WebCodecs` y `OffscreenCanvas`. Si falta alguno la app se
bloquea con un mensaje claro en vez de fallar a mitad del proceso. WebGPU es
opcional — sin él se usa WASM sobre CPU, bastante más lento. Si el navegador no
puede codificar H.264, se usa VP9 dentro del mismo contenedor MP4.

## Estructura

```
app/                 UI (Next.js App Router, export estático)
components/          Dropzone, editor de recorte, aviso de compatibilidad
lib/                 Límites, catálogo de modelos, tipos compartidos
workers/             Worker con decodificación, inferencia y codificación
```

Los límites están en `lib/constants.ts` (`MAX_CLIP_SECONDS`,
`MAX_SOURCE_SECONDS`, `MAX_FILE_BYTES`) y se validan dos veces: en la UI antes
de descargar el modelo, y otra vez dentro del worker, que vuelve a acotar el
rango recibido en lugar de confiar en él.
