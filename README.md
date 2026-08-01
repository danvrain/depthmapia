# DepthMapIA

Plataforma para convertir videos cortos en mapas de profundidad. El usuario sube
un video de hasta **25 MB**, recorta el tramo que le interesa (hasta **15
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
archivo de entrada.

### Framerate constante

La salida se muestrea sobre una rejilla temporal fija, no copiando los tiempos
del origen. Las cámaras de teléfono graban a framerate variable, y arrastrar esa
irregularidad produce micro-trabones muy visibles en un mapa de profundidad,
donde no hay motion blur ni textura que los disimule.

Medido con una fuente que alterna 30 y 24 fps: copiando los tiempos del origen
la salida tenía intervalos de 0 a 66 ms entre frames; con la rejilla, todos los
intervalos son idénticos y la duración se conserva. Como efecto secundario, el
total de frames pasa a ser exacto en vez de estimado.

El framerate de la rejilla nunca baja del pico del origen. Esa misma fuente
promedia 26.52 fps, y muestrearla a 27 descartaba 29 de sus 240 frames — los que
solo existen en los tramos a 30 fps. Descartar frames *es* el tirón. Subiendo al
estándar siguiente (30 fps) se pierden 2 en vez de 29, y a cambio se duplican
algunos en los tramos lentos, que se nota mucho menos.

### Capturas para motores de video por IA

Dos formas de sacar un still, pensadas para alimentar modelos image-to-video:

- **Capturar frame (PNG)** en el editor: exporta el frame donde esté la línea
  blanca, a la resolución original del video (mayor que la del procesado). El
  nombre incluye el segundo, p. ej. `clip-frame-6s00.png`.
- **Primer frame en profundidad**: se publica en cuanto existe, sin esperar a
  que termine el clip, para flujos condicionados por profundidad.

### Formatos de salida

- **Video**: MP4 o WebM según lo que el navegador pueda codificar.
- **Secuencia PNG (ZIP)**: un PNG sin pérdida por frame, nombrados
  `depth_00001.png` en adelante. No pasa por ningún codificador de video, así
  que evita tanto la negociación de códecs como los artefactos de compresión —
  útil para VFX y para pipelines de IA sensibles al bandeo. A cambio pesa mucho
  más, del orden de 100 MB por cada 15 s a 1280 px.

El ZIP se escribe en streaming, agregando cada PNG conforme se produce en vez de
acumularlos todos en memoria, y se almacena sin deflate: el PNG ya viene
comprimido, así que recomprimir cuesta tiempo y no ahorra nada.

### Opciones disponibles

- **Modelos**: Depth Anything V2 Small (por defecto), V2 Base y V1 Small. Ver
  las licencias más abajo antes de usar la app comercialmente.
- **Salida**: escala de grises, colormap *inferno*, u original + depth lado a lado.
- **Estabilizar**: suaviza el rango de profundidad entre frames. El modelo
  normaliza cada frame de forma independiente, lo que provoca un parpadeo muy
  visible en video; esta opción lo elimina casi por completo. Activado por defecto.
- **Invertir**: cambia la convención a cerca = negro.
- **Calidad**: Alta, Muy alta o Máxima. Los mapas de profundidad son lisos y se
  comprimen a casi nada bajo codificación de calidad constante, que es justo
  donde aparece el bandeo — y profundidad bandeada es profundidad cuantizada.
  Medido a 1280x720: Alta da 0.11 Mbps, Muy alta 0.40 Mbps y Máxima 6.11 Mbps.
  Por defecto Máxima, que fija el bitrate en función de resolución y framerate.
- **Suavizado temporal**: mezcla cada píxel con el del frame anterior, con la
  fuerza escalada según cuánto cambió ese píxel. El ruido temporal es un cambio
  pequeño en zonas realmente estáticas, mientras que el movimiento produce
  cambios grandes; suavizar todo por igual obliga a elegir entre dejar
  vibración en el fondo o arrastrar lo que se mueve.

  Medido sobre un fondo ruidoso con un borde en movimiento, con la mezcla fija
  la vibración bajaba a 1.13 niveles pero el error en los bordes móviles subía a
  38.91. Con la mezcla adaptativa la vibración queda en 1.60 y el error en 2.14
  — por debajo incluso de no suavizar (3.00), porque quita ruido sin arrastrar.
  Por defecto Fuerte, ya que el compromiso desapareció.

### Desenfoque de movimiento

Un mapa de profundidad no tiene barrido propio: el modelo dibuja cada frame
perfectamente nítido. A 24-30 fps eso hace que el ojo lea el movimiento como
una sucesión de saltos, porque falta lo que en cine aporta el obturador.

Mezclar una fracción del frame anterior lo reintroduce. Medido sobre un borde
duro desplazándose 8 px por frame a 25 fps, el salto medio entre frames baja de
180 a 36 con el nivel Sutil, a cambio de un 24% menos de definición en el borde;
el nivel Cinematográfico llega a 26 perdiendo un 43%.

A diferencia del suavizado temporal, esta mezcla es deliberadamente uniforme:
el arrastre en los bordes en movimiento es justamente el efecto buscado.

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
opcional — sin él se usa WASM sobre CPU, bastante más lento.

### Contenedor de salida

El códec se elige codificando un frame de prueba con cada candidato y quedándose
con el primero que sobrevive al vaciado del codificador — `isConfigSupported` no
es de fiar. El orden es H.264, HEVC, AV1, VP9 y por último VP8.

Que un códec esté disponible no implica que lo estén todos sus perfiles: hay
codificadores que rechazan el perfil High que se elige por defecto pero aceptan
Main o Baseline. Por eso H.264 se prueba con varios `fullCodecString` explícitos
y con `prefer-software` antes de descartarlo — es la diferencia entre un MP4 y un
WebM con VP8.

Los cuatro primeros van en MP4. VP8 solo se usa si ningún otro funciona, y en ese
caso la salida es WebM: VP8 dentro de un MP4 produce un archivo que la mayoría de
reproductores no abre. La UI indica siempre el contenedor y el códec obtenidos, y
la consola registra cuáles se descartaron y por qué.

## Licencias de los modelos

El archivo `LICENSE` del repositorio de Depth Anything V2 es Apache-2.0, pero
**cubre solo el código**. Los pesos se licencian aparte, y eso únicamente se
indica en su README:

| Modelo | Licencia | Uso comercial |
|---|---|---|
| Depth Anything V2 Small | Apache-2.0 | Permitido |
| Depth Anything V2 Base | CC-BY-NC-4.0 | **No permitido** |
| Depth Anything V1 Small | Apache-2.0 | Permitido |

La app muestra la licencia junto a cada modelo y avisa al seleccionar uno no
comercial. Si vas a cobrar por el servicio, quédate en las variantes Small.

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
