"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";

const ROWS = 84;
const COLS = 220;

const vertexShader = /* glsl */ `
  uniform float uTime;
  uniform vec2 uMouse;
  uniform float uMouseStrength;
  attribute vec2 aGrid;
  varying float vHeight;
  varying float vFade;

  float bump(vec2 p, vec2 c, float r) {
    vec2 d = (p - c) / r;
    return exp(-dot(d, d));
  }

  // A soft, slowly breathing relief: a few overlapping masses read as a
  // figure in front of a background, the way a real depth map does.
  float field(vec2 p, float t) {
    float h = 0.0;
    h += 1.00 * bump(p, vec2(0.64 + 0.03 * sin(t * 0.31), 0.58), 0.15);
    h += 0.62 * bump(p, vec2(0.63 + 0.02 * sin(t * 0.27), 0.36), 0.075);
    h += 0.45 * bump(p, vec2(0.30 + 0.05 * cos(t * 0.22), 0.66), 0.21);
    h += 0.28 * bump(p, vec2(0.86, 0.78 + 0.03 * sin(t * 0.35)), 0.17);
    h += 0.05 * sin(p.x * 17.0 + t * 0.7) * sin(p.y * 9.0 - t * 0.45);
    h += 0.55 * uMouseStrength * bump(p, uMouse, 0.07);
    return h;
  }

  void main() {
    float h = field(aGrid, uTime);
    vec3 pos = vec3((aGrid.x - 0.5) * 4.6, h * 0.62, (aGrid.y - 0.5) * 2.8);
    vHeight = h;
    vFade = smoothstep(0.0, 0.14, aGrid.x) * smoothstep(1.0, 0.86, aGrid.x)
          * smoothstep(0.0, 0.18, aGrid.y) * smoothstep(1.0, 0.82, aGrid.y);
    gl_Position = projectionMatrix * modelViewMatrix * vec4(pos, 1.0);
  }
`;

const fragmentShader = /* glsl */ `
  varying float vHeight;
  varying float vFade;

  void main() {
    // Brightness follows height, exactly like a depth map: near reads white,
    // far fades to nothing. Only the closest peaks pick up a warm tint.
    float near = clamp(vHeight, 0.0, 1.2);
    vec3 grey = vec3(0.16 + 0.84 * smoothstep(0.0, 1.0, near));
    vec3 warm = vec3(1.0, 0.78, 0.55);
    vec3 color = mix(grey, warm, smoothstep(0.8, 1.15, near) * 0.55);
    float alpha = vFade * (0.18 + 0.82 * smoothstep(0.02, 0.9, near));
    gl_FragColor = vec4(color, alpha);
  }
`;

/** Horizontal scan lines, joined point to point within each row. */
function buildGeometry() {
  const grid = new Float32Array(ROWS * COLS * 2);
  for (let r = 0, i = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS; c++, i += 2) {
      grid[i] = c / (COLS - 1);
      grid[i + 1] = r / (ROWS - 1);
    }
  }

  const indices: number[] = [];
  for (let r = 0; r < ROWS; r++) {
    for (let c = 0; c < COLS - 1; c++) {
      const a = r * COLS + c;
      indices.push(a, a + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  // Positions are computed in the shader; three still wants the attribute.
  geometry.setAttribute(
    "position",
    new THREE.BufferAttribute(new Float32Array(ROWS * COLS * 3), 3),
  );
  geometry.setAttribute("aGrid", new THREE.BufferAttribute(grid, 2));
  geometry.setIndex(indices);
  // The shader moves vertices off the placeholder positions, so frustum
  // culling against them would hide the mesh.
  geometry.boundingSphere = new THREE.Sphere(new THREE.Vector3(), 10);
  return geometry;
}

/**
 * Decorative relief behind the hero. It pauses whenever `paused` is set —
 * depth inference saturates the GPU and the two should never compete — and
 * also while scrolled out of view or in a background tab.
 */
export function DepthHero({
  paused = false,
  className,
}: {
  paused?: boolean;
  className?: string;
}) {
  const containerRef = useRef<HTMLDivElement>(null);
  const pausedRef = useRef(paused);
  const kickRef = useRef<() => void>(() => {});

  useEffect(() => {
    pausedRef.current = paused;
    kickRef.current();
  }, [paused]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // No WebGL: the hero copy still stands on its own.
    }

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75));
    renderer.setClearColor(0x000000, 0);
    container.appendChild(renderer.domElement);
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 50);

    const uniforms = {
      uTime: { value: 0 },
      uMouse: { value: new THREE.Vector2(0.5, 0.5) },
      uMouseStrength: { value: 0 },
    };
    const geometry = buildGeometry();
    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader,
      fragmentShader,
      transparent: true,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    const lines = new THREE.LineSegments(geometry, material);
    const rig = new THREE.Group();
    rig.add(lines);
    scene.add(rig);

    const pointer = { x: 0, y: 0, active: 0 };
    const eased = { x: 0, y: 0, active: 0 };

    const resize = () => {
      const { width, height } = container.getBoundingClientRect();
      if (!width || !height) return;
      renderer.setSize(width, height, false);
      renderer.domElement.style.width = `${width}px`;
      renderer.domElement.style.height = `${height}px`;
      camera.aspect = width / height;
      // Portrait screens pull back and aim higher, which drops the relief into
      // the empty lower half instead of running it behind the copy.
      const portrait = camera.aspect < 1;
      const distance = portrait ? 6.4 : 4.4;
      camera.position.set(0, distance * 0.42, distance);
      camera.lookAt(0, portrait ? 2 : 0.12, 0);
      camera.updateProjectionMatrix();
    };

    const onPointerMove = (event: PointerEvent) => {
      const rect = container.getBoundingClientRect();
      pointer.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
      pointer.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
      pointer.active = 1;
    };
    const onPointerLeave = () => {
      pointer.active = 0;
    };

    let visible = true;
    let frame = 0;
    let running = false;
    let last = performance.now();
    let elapsed = 0;

    const render = () => {
      renderer.render(scene, camera);
    };

    const tick = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      elapsed += dt;

      eased.x += (pointer.x - eased.x) * 0.05;
      eased.y += (pointer.y - eased.y) * 0.05;
      eased.active += (pointer.active - eased.active) * 0.06;

      uniforms.uTime.value = elapsed;
      uniforms.uMouse.value.set(0.5 + eased.x * 0.5, 0.5 + eased.y * 0.55);
      uniforms.uMouseStrength.value = eased.active;
      rig.rotation.y = eased.x * 0.16;
      rig.rotation.x = eased.y * 0.05;

      render();
      frame = requestAnimationFrame(tick);
    };

    const sync = () => {
      const shouldRun =
        visible && !pausedRef.current && !document.hidden && !reducedMotion;
      if (shouldRun && !running) {
        running = true;
        last = performance.now();
        frame = requestAnimationFrame(tick);
      } else if (!shouldRun && running) {
        running = false;
        cancelAnimationFrame(frame);
      }
    };
    kickRef.current = sync;

    const observer = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      sync();
    });
    observer.observe(container);

    const resizeObserver = new ResizeObserver(() => {
      resize();
      if (!running) render();
    });
    resizeObserver.observe(container);

    resize();
    uniforms.uTime.value = 6; // a settled pose for the static frame
    render();
    sync();

    window.addEventListener("pointermove", onPointerMove);
    document.documentElement.addEventListener("pointerleave", onPointerLeave);
    document.addEventListener("visibilitychange", sync);

    return () => {
      kickRef.current = () => {};
      cancelAnimationFrame(frame);
      observer.disconnect();
      resizeObserver.disconnect();
      window.removeEventListener("pointermove", onPointerMove);
      document.documentElement.removeEventListener("pointerleave", onPointerLeave);
      document.removeEventListener("visibilitychange", sync);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, []);

  return <div ref={containerRef} aria-hidden className={className} />;
}
