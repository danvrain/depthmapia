# DepthMapIA

Plataforma para convertir videos cortos en mapas de profundidad. El usuario sube
un video de hasta **15 segundos** y **20 MB**, la app genera el mapa de
profundidad y le entrega el video listo para descargar.

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

## Requisitos del navegador

| | Mínimo | Recomendado |
|---|---|---|
| Inferencia | WASM (CPU) | WebGPU |
| Codificación | WebCodecs | WebCodecs con H.264 |

Chrome y Edge actualizados dan la mejor experiencia. Si WebGPU no está
disponible, la app cae automáticamente a CPU (más lento). Si el navegador no
puede codificar H.264, se usa VP9 dentro del mismo contenedor MP4.

## Estructura

```
app/                 UI (Next.js App Router, export estático)
components/          Dropzone
lib/                 Límites, catálogo de modelos, tipos compartidos
workers/             Worker con decodificación, inferencia y codificación
```

Los límites de 15 s y 20 MB están en `lib/constants.ts` y se validan dos veces:
en la UI antes de descargar el modelo, y otra vez dentro del worker.
