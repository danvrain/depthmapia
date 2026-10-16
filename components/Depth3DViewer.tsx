"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";

/**
 * `depth`: the whole frame is the depth map and is also what gets drawn.
 * `sideBySide`: original on the left half, depth on the right — the depth
 * displaces the surface and the original colours it.
 */
export type ViewerLayout = "depth" | "sideBySide";

const vertexShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec4 uDepthRect;
  uniform float uAmount;
  uniform float uInvert;
  varying vec2 vUv;
  varying float vDepth;

  void main() {
    float d = texture2D(uTex, uDepthRect.xy + uv * uDepthRect.zw).r;
    d = mix(d, 1.0 - d, uInvert);
    vDepth = d;
    vUv = uv;
    gl_Position = projectionMatrix * modelViewMatrix
                * vec4(position + vec3(0.0, 0.0, d * uAmount), 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  uniform sampler2D uTex;
  uniform vec4 uColorRect;
  uniform float uUseColor;
  varying vec2 vUv;
  varying float vDepth;

  void main() {
    vec3 source = texture2D(uTex, uColorRect.xy + vUv * uColorRect.zw).rgb;
    vec3 color = mix(vec3(vDepth), source, uUseColor);
    // Slightly darker far away, so the relief still reads when the frame is
    // seen straight on.
    color *= 0.72 + 0.28 * vDepth;
    gl_FragColor = vec4(color, 1.0);
  }
`;

const RECT_FULL = new THREE.Vector4(0, 0, 1, 1);
const RECT_LEFT = new THREE.Vector4(0, 0, 0.5, 1);
const RECT_RIGHT = new THREE.Vector4(0.5, 0, 0.5, 1);

/**
 * Shows a depth result as a relief you can turn with the mouse — the fastest
 * way to tell whether the depth actually came out right before taking it into
 * another tool.
 */
export function Depth3DViewer({
  src,
  kind,
  layout,
  invert,
}: {
  src: string;
  kind: "video" | "image";
  layout: ViewerLayout;
  invert: boolean;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const amountRef = useRef(0.35);
  const [amount, setAmount] = useState(0.35);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    amountRef.current = amount;
  }, [amount]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      setFailed(true);
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setClearColor(0x050506, 1);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";
    renderer.domElement.style.cursor = "grab";
    renderer.domElement.style.touchAction = "none";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(38, 1, 0.05, 20);
    camera.position.set(0, 0, 3);

    let texture: THREE.Texture;
    let video: HTMLVideoElement | null = null;
    let disposed = false;

    if (kind === "video") {
      video = document.createElement("video");
      video.src = src;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.crossOrigin = "anonymous";
      void video.play().catch(() => {});
      texture = new THREE.VideoTexture(video);
    } else {
      texture = new THREE.TextureLoader().load(src, () => build());
    }
    // Depth is sampled as raw values: any colour-space conversion would
    // bend the curve and distort the relief.
    texture.colorSpace = THREE.NoColorSpace;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;

    const uniforms = {
      uTex: { value: texture },
      uDepthRect: { value: layout === "sideBySide" ? RECT_RIGHT : RECT_FULL },
      uColorRect: { value: layout === "sideBySide" ? RECT_LEFT : RECT_FULL },
      uUseColor: { value: layout === "sideBySide" ? 1 : 0 },
      uInvert: { value: invert ? 1 : 0 },
      uAmount: { value: amountRef.current },
    };
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      side: THREE.DoubleSide,
    });

    const rig = new THREE.Group();
    scene.add(rig);
    let mesh: THREE.Mesh | null = null;

    const build = () => {
      if (disposed || mesh) return;
      const source = texture.image as
        | HTMLVideoElement
        | HTMLImageElement
        | undefined;
      const w =
        (source as HTMLVideoElement)?.videoWidth ||
        (source as HTMLImageElement)?.naturalWidth ||
        16;
      const h =
        (source as HTMLVideoElement)?.videoHeight ||
        (source as HTMLImageElement)?.naturalHeight ||
        9;
      const aspect = (layout === "sideBySide" ? w / 2 : w) / h;
      const height = 1.5;
      // Dense enough that silhouettes hold their shape when tilted.
      const geometry = new THREE.PlaneGeometry(
        height * aspect,
        height,
        Math.round(260 * Math.min(aspect, 2)),
        260,
      );
      mesh = new THREE.Mesh(geometry, material);
      mesh.position.z = -amountRef.current / 2;
      rig.add(mesh);
      // Wide clips need to sit further back to fit.
      camera.position.z = Math.max(2.4, 1.25 * height * Math.max(aspect, 1));
    };

    if (video) {
      if (video.readyState >= 1) build();
      else video.addEventListener("loadedmetadata", build, { once: true });
    }

    /* --- interaction -------------------------------------------------- */

    const target = { x: 0.35, y: -0.18 };
    const current = { x: 0, y: 0 };
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    let idleSince = performance.now();

    const onDown = (e: PointerEvent) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
      renderer.domElement.setPointerCapture(e.pointerId);
      renderer.domElement.style.cursor = "grabbing";
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      target.x = THREE.MathUtils.clamp(target.x + (e.clientX - lastX) * 0.006, -1.1, 1.1);
      target.y = THREE.MathUtils.clamp(target.y + (e.clientY - lastY) * 0.005, -0.8, 0.6);
      lastX = e.clientX;
      lastY = e.clientY;
    };
    const onUp = () => {
      dragging = false;
      idleSince = performance.now();
      renderer.domElement.style.cursor = "grab";
    };
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      camera.position.z = THREE.MathUtils.clamp(
        camera.position.z + e.deltaY * 0.0025,
        1.2,
        6,
      );
    };
    renderer.domElement.addEventListener("pointerdown", onDown);
    renderer.domElement.addEventListener("pointermove", onMove);
    renderer.domElement.addEventListener("pointerup", onUp);
    renderer.domElement.addEventListener("pointercancel", onUp);
    renderer.domElement.addEventListener("wheel", onWheel, { passive: false });

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = width / height;
      camera.updateProjectionMatrix();
    };
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(container);
    resize();

    let frame = 0;
    const tick = (now: number) => {
      // After a few idle seconds it sways on its own so the depth stays legible.
      if (!dragging && now - idleSince > 2500) {
        target.x = Math.sin(now / 2600) * 0.45;
      }
      current.x += (target.x - current.x) * 0.08;
      current.y += (target.y - current.y) * 0.08;
      rig.rotation.y = current.x;
      rig.rotation.x = current.y;
      uniforms.uAmount.value = amountRef.current;
      if (mesh) mesh.position.z = -amountRef.current / 2;
      renderer.render(scene, camera);
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);

    return () => {
      disposed = true;
      cancelAnimationFrame(frame);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener("wheel", onWheel);
      if (video) {
        video.pause();
        video.removeAttribute("src");
        video.load();
      }
      mesh?.geometry.dispose();
      material.dispose();
      texture.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [src, kind, layout, invert]);

  if (failed) {
    return (
      <p className="rounded-2xl border border-[var(--color-edge)] p-6 text-sm text-white/50">
        Tu navegador no pudo abrir la vista 3D.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div
        ref={containerRef}
        className="aspect-video w-full overflow-hidden rounded-2xl border border-[var(--color-edge)]"
      />
      <div className="flex items-center gap-4 text-xs text-white/50">
        <span className="shrink-0">Relieve</span>
        <input
          type="range"
          min={0}
          max={0.9}
          step={0.01}
          value={amount}
          onChange={(e) => setAmount(Number(e.target.value))}
          className="w-full accent-white"
          aria-label="Intensidad del relieve"
        />
        <span className="hidden shrink-0 sm:inline">
          Arrastra para girar · rueda para acercar
        </span>
      </div>
    </div>
  );
}
