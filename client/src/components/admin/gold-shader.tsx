import { useEffect, useRef } from "react";
import * as THREE from "three";

/**
 * GoldShader — the rotating gold "vault light" shader, ported from the admin
 * redesign reference (originally three r128 via CDN) to the npm `three` package.
 *
 * Containment rules (hard requirements):
 *  - Only mounted behind the login hero and the Overview hero band.
 *  - The RAF loop pauses whenever the canvas is not visible (scrolled out of
 *    view OR the tab is hidden) — no perpetual GPU load behind data tables.
 *  - Honours prefers-reduced-motion: renders a single static frame, no loop.
 *  - Degrades gracefully when WebGL is unavailable (host keeps its CSS gradient).
 *
 * The host <div> should be positioned (e.g. absolute inset-0) by the caller; the
 * canvas fills it. The element is aria-hidden — it is purely decorative.
 */
const VERTEX_SHADER = `void main(){gl_Position=vec4(position,1.0);}`;

const FRAGMENT_SHADER = `
precision highp float;
uniform vec2 resolution;
uniform float time;
float rnd(in float x){return fract(sin(x)*1e4);}
void main(void){
  vec2 uv=(gl_FragCoord.xy*2.0-resolution.xy)/min(resolution.x,resolution.y);
  vec2 scal=vec2(4.0,2.0);
  vec2 sz=vec2(256.0,256.0);
  uv.x=floor(uv.x*sz.x/scal.x)/(sz.x/scal.x);
  uv.y=floor(uv.y*sz.y/scal.y)/(sz.y/scal.y);
  float t=time*0.06+rnd(uv.x)*0.4;
  float lw=0.0009;
  float acc=0.0;
  for(int j=0;j<3;j++){
    for(int i=0;i<5;i++){
      acc+=lw*float(i*i)/abs(fract(t-0.01*float(j)+float(i)*0.012)*1.0-length(uv));
    }
  }
  float g=clamp(acc,0.0,1.4);
  vec3 gold=mix(vec3(0.46,0.33,0.09),vec3(0.96,0.82,0.40),clamp(g,0.0,1.0));
  vec3 col=gold*g + vec3(0.018,0.014,0.008);
  gl_FragColor=vec4(col,1.0);
}
`;

interface GoldShaderProps {
  className?: string;
}

export default function GoldShader({ className }: GoldShaderProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;

    const reduceMotion =
      typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: "low-power" });
    } catch {
      // WebGL not available — leave the host showing its CSS gradient fallback.
      return;
    }

    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(0x0d0c0a, 1);
    const canvas = renderer.domElement;
    canvas.style.display = "block";
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.appendChild(canvas);

    const scene = new THREE.Scene();
    const camera = new THREE.Camera();
    camera.position.z = 1;

    const uniforms = {
      time: { value: 1.0 },
      resolution: { value: new THREE.Vector2(1, 1) },
    };

    const material = new THREE.ShaderMaterial({
      uniforms,
      vertexShader: VERTEX_SHADER,
      fragmentShader: FRAGMENT_SHADER,
      depthTest: false,
      depthWrite: false,
    });

    const geometry = new THREE.PlaneGeometry(2, 2);
    const mesh = new THREE.Mesh(geometry, material);
    scene.add(mesh);

    const sizeToHost = () => {
      const rect = host.getBoundingClientRect();
      const w = Math.max(1, Math.floor(rect.width));
      const h = Math.max(1, Math.floor(rect.height));
      renderer.setSize(w, h, false);
      const pr = renderer.getPixelRatio();
      uniforms.resolution.value.set(w * pr, h * pr);
    };
    sizeToHost();

    let raf = 0;
    let running = false;

    const renderOnce = () => renderer.render(scene, camera);

    const frame = () => {
      raf = requestAnimationFrame(frame);
      uniforms.time.value += 0.05;
      renderOnce();
    };

    const start = () => {
      if (running || reduceMotion) return;
      running = true;
      frame();
    };

    const stop = () => {
      running = false;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
    };

    // Pause whenever the host scrolls out of view.
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries.some((e) => e.isIntersecting);
        if (visible && !document.hidden) start();
        else stop();
      },
      { threshold: 0.01 }
    );
    io.observe(host);

    // Pause when the tab/window is hidden.
    const onVisibility = () => {
      if (document.hidden) stop();
      else start();
    };
    document.addEventListener("visibilitychange", onVisibility);

    // Keep the canvas sized to the host.
    const ro = new ResizeObserver(() => {
      sizeToHost();
      if (reduceMotion || !running) renderOnce();
    });
    ro.observe(host);

    if (reduceMotion) renderOnce();

    return () => {
      stop();
      io.disconnect();
      ro.disconnect();
      document.removeEventListener("visibilitychange", onVisibility);
      geometry.dispose();
      material.dispose();
      renderer.dispose();
      if (canvas.parentNode === host) host.removeChild(canvas);
    };
  }, []);

  return <div ref={hostRef} className={className} aria-hidden="true" />;
}
