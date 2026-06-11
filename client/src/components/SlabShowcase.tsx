/**
 * SlabShowcase — Three.js homepage hero rendering real MintVault graded
 * slabs. Front face composes the actual generated label (top strip) above
 * the real card scan, exactly like a physical slab; back face composes the
 * back label; sides are frosted acrylic. Clicking a slab opens a cert
 * overlay linking to the public certificate page.
 *
 * Three.js is dynamically imported inside useEffect so it stays code-split
 * and never blocks page parse. Falls back to a CSS 3D stack on mobile or
 * when WebGL is unavailable.
 */
import { useEffect, useRef, useState } from "react";
import type * as ThreeNS from "three";

export interface SlabShowcaseItem {
  certNumber: string;
  dbId: number;
  grade: number;
  gradeLabel: string;
  gradeStrengthScore: number | null;
  cardName: string;
  setName: string | null;
  cardGame: string | null;
  labelType: string;
  frontLabelUrl: string;
  backLabelUrl: string | null;
  frontScanUrl: string | null;
}

interface SlabShowcaseProps {
  items: SlabShowcaseItem[];
  className?: string;
}

// Arc layout — filled from the centre out (index 0 = centre slab).
const POSITIONS = [
  { x: 0.0, y: 0.0, z: 0.0, rotY: 0.0, rotX: 0.0 },
  { x: -2.2, y: -0.3, z: -0.8, rotY: 0.18, rotX: 0.04 },
  { x: 2.2, y: -0.3, z: -0.8, rotY: -0.18, rotX: 0.04 },
  { x: -4.2, y: -0.6, z: -1.8, rotY: 0.32, rotX: 0.06 },
  { x: 4.2, y: -0.6, z: -1.8, rotY: -0.32, rotX: 0.06 },
  { x: -1.1, y: 1.9, z: -1.2, rotY: 0.12, rotX: -0.05 },
  { x: 1.1, y: 1.9, z: -1.2, rotY: -0.12, rotX: -0.05 },
  { x: 0.0, y: -2.2, z: -2.0, rotY: 0.0, rotX: 0.08 },
];

function gradeColor(grade: number): string {
  if (grade >= 10) return "#D4AF37";
  if (grade >= 9) return "#c8a020";
  if (grade >= 8) return "#22c55e";
  if (grade >= 7) return "#3b82f6";
  if (grade >= 6) return "#f59e0b";
  if (grade >= 5) return "#ea580c";
  if (grade >= 4) return "#ef4444";
  return "#991b1b";
}

function canWebGL(): boolean {
  try {
    const c = document.createElement("canvas");
    return !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    return false;
  }
}

/** Load an image for canvas composition. Resolves null on failure. */
function loadImageEl(url: string | null): Promise<HTMLImageElement | null> {
  if (!url) return Promise.resolve(null);
  return new Promise((resolve) => {
    const img = new Image();
    // No crossOrigin needed — images come from the same-origin
    // /api/public/slab-image proxy, so the canvas stays untainted.
    img.onload = () => resolve(img);
    img.onerror = () => {
      console.warn("[SlabShowcase] image load failed:", url);
      resolve(null);
    };
    img.src = url;
  });
}

/**
 * Compose a slab face: label strip at the top (its natural landscape
 * aspect), card scan (front face) or branded dark body (back face) below.
 * 512×716 matches the 63×88mm slab face aspect.
 */
function composeFaceCanvas(label: HTMLImageElement | null, scan: HTMLImageElement | null): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = 512;
  canvas.height = 716;
  const ctx = canvas.getContext("2d")!;

  ctx.fillStyle = "#0c0c0a";
  ctx.fillRect(0, 0, 512, 716);

  let labelBottom = 0;
  if (label) {
    // Label keeps its own aspect, full width.
    const h = Math.round((label.height / label.width) * 512);
    ctx.drawImage(label, 0, 0, 512, h);
    labelBottom = h;
  }

  if (scan) {
    // Fit the scan inside the remaining area, centred, with a small inset.
    const areaY = labelBottom + 8;
    const areaH = 716 - areaY - 8;
    const areaW = 512 - 16;
    const s = Math.min(areaW / scan.width, areaH / scan.height);
    const w = scan.width * s;
    const h = scan.height * s;
    ctx.drawImage(scan, (512 - w) / 2, areaY + (areaH - h) / 2, w, h);
  } else if (label) {
    // Back face / no scan: branded dark body under the label.
    ctx.fillStyle = "#D4AF37";
    ctx.textAlign = "center";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText("MINTVAULT", 256, (716 + labelBottom) / 2);
    ctx.font = "16px sans-serif";
    ctx.fillText("CERTIFIED", 256, (716 + labelBottom) / 2 + 32);
  } else {
    // No label at all — full branded fallback.
    ctx.fillStyle = "#D4AF37";
    ctx.textAlign = "center";
    ctx.font = "bold 28px sans-serif";
    ctx.fillText("MINTVAULT", 256, 358);
    ctx.font = "16px sans-serif";
    ctx.fillText("CERTIFIED", 256, 390);
  }

  return canvas;
}

export default function SlabShowcase({ items, className }: SlabShowcaseProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [selectedItem, setSelectedItem] = useState<SlabShowcaseItem | null>(null);
  const [ready, setReady] = useState(false);
  const [useFallback, setUseFallback] = useState(false);
  const selectedIndexRef = useRef<number>(-1);

  useEffect(() => {
    selectedIndexRef.current = selectedItem ? items.findIndex((i) => i.certNumber === selectedItem.certNumber) : -1;
  }, [selectedItem, items]);

  useEffect(() => {
    if (!items.length) return;
    if (window.innerWidth < 768 || !canWebGL()) {
      setUseFallback(true);
      setReady(true);
      return;
    }

    let disposed = false;
    let animationFrameId = 0;
    let cleanupFns: Array<() => void> = [];

    (async () => {
      const THREE = await import("three");
      const { RoomEnvironment } = await import("three/examples/jsm/environments/RoomEnvironment.js");
      const container = containerRef.current;
      const canvas = canvasRef.current;
      if (!container || !canvas || disposed) return;

      // ── Compose face textures from real label + scan images ──
      const faces = await Promise.all(
        items.map(async (item) => {
          const [labelImg, scanImg, backImg] = await Promise.all([
            loadImageEl(item.frontLabelUrl),
            loadImageEl(item.frontScanUrl),
            loadImageEl(item.backLabelUrl),
          ]);
          const frontTex = new THREE.CanvasTexture(composeFaceCanvas(labelImg, scanImg));
          const backTex = new THREE.CanvasTexture(composeFaceCanvas(backImg, null));
          for (const tex of [frontTex, backTex]) {
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.generateMipmaps = true;
            tex.minFilter = THREE.LinearMipmapLinearFilter;
            tex.magFilter = THREE.LinearFilter;
          }
          return { frontTex, backTex };
        })
      );
      if (disposed) return;

      // ── Renderer / scene / camera ──
      const renderer = new THREE.WebGLRenderer({
        canvas,
        antialias: true,
        alpha: true,
        powerPreference: "high-performance",
      });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
      renderer.setSize(container.clientWidth, container.clientHeight);
      renderer.toneMapping = THREE.ACESFilmicToneMapping;
      renderer.toneMappingExposure = 1.2;
      renderer.outputColorSpace = THREE.SRGBColorSpace;

      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(42, container.clientWidth / container.clientHeight, 0.1, 50);
      camera.position.set(0, 0, 9);

      const pmremGenerator = new THREE.PMREMGenerator(renderer);
      scene.environment = pmremGenerator.fromScene(new RoomEnvironment(), 0.04).texture;
      pmremGenerator.dispose();

      // ── Lights ──
      scene.add(new THREE.AmbientLight(0xffffff, 0.4));
      const keyLight = new THREE.PointLight(0xd4af37, 3.5, 20);
      keyLight.position.set(4, 5, 6);
      scene.add(keyLight);
      const fillLight = new THREE.PointLight(0x99bbdd, 1.5, 20);
      fillLight.position.set(-5, 2, 4);
      scene.add(fillLight);
      const rimLight = new THREE.PointLight(0xffffff, 2.0, 20);
      rimLight.position.set(0, 0, -6);
      scene.add(rimLight);
      const floorLight = new THREE.PointLight(0xd4af37, 0.8, 15);
      floorLight.position.set(0, -5, 3);
      scene.add(floorLight);

      // ── Slabs ──
      const slabGeo = new THREE.BoxGeometry(1.89, 2.64, 0.18);
      const acrylicMaterial = new THREE.MeshPhysicalMaterial({
        color: new THREE.Color(0xc8dde8),
        roughness: 0.05,
        metalness: 0.0,
        transmission: 0.82,
        thickness: 0.5,
        transparent: true,
        opacity: 0.92,
        envMapIntensity: 1.5,
        ior: 1.49,
      });

      const slabGroup = new THREE.Group();
      scene.add(slabGroup);
      const slabMeshes: ThreeNS.Mesh[] = [];

      items.slice(0, POSITIONS.length).forEach((item, index) => {
        const pos = POSITIONS[index];
        const materials = [
          acrylicMaterial,
          acrylicMaterial,
          acrylicMaterial,
          acrylicMaterial,
          new THREE.MeshStandardMaterial({ map: faces[index].frontTex, roughness: 0.15, metalness: 0.0 }),
          new THREE.MeshStandardMaterial({ map: faces[index].backTex, roughness: 0.15, metalness: 0.0 }),
        ];
        const mesh = new THREE.Mesh(slabGeo, materials);
        mesh.position.set(pos.x, pos.y, pos.z);
        mesh.rotation.y = pos.rotY;
        mesh.rotation.x = pos.rotX;
        mesh.userData.baseRotY = pos.rotY;
        mesh.userData.baseZ = pos.z;
        mesh.userData.autoRotSpeed = 0.004 + index * 0.0008;
        mesh.userData.certNumber = item.certNumber;
        mesh.userData.itemIndex = index;
        slabGroup.add(mesh);
        slabMeshes.push(mesh);
      });

      // ── Interaction ──
      const raycaster = new THREE.Raycaster();
      const mouse2D = new THREE.Vector2();
      const mouseRef = { x: 0, y: 0 };
      const targetGroupRot = { x: 0, y: 0 };
      const currentGroupRot = { x: 0, y: 0 };

      const toNdc = (event: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        mouse2D.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouse2D.y = -((event.clientY - rect.top) / rect.height) * 2 + 1;
      };

      const onClick = (event: MouseEvent) => {
        toNdc(event);
        raycaster.setFromCamera(mouse2D, camera);
        const hits = raycaster.intersectObjects(slabMeshes);
        if (hits.length > 0) {
          const idx = hits[0].object.userData.itemIndex as number;
          setSelectedItem(items[idx]);
        } else {
          setSelectedItem(null);
        }
      };

      const onMouseMove = (event: MouseEvent) => {
        const rect = canvas.getBoundingClientRect();
        mouseRef.x = ((event.clientX - rect.left) / rect.width) * 2 - 1;
        mouseRef.y = ((event.clientY - rect.top) / rect.height) * 2 - 1;
        toNdc(event);
        raycaster.setFromCamera(mouse2D, camera);
        canvas.style.cursor = raycaster.intersectObjects(slabMeshes).length > 0 ? "pointer" : "default";
      };

      canvas.addEventListener("click", onClick);
      canvas.addEventListener("mousemove", onMouseMove);
      cleanupFns.push(() => {
        canvas.removeEventListener("click", onClick);
        canvas.removeEventListener("mousemove", onMouseMove);
      });

      // ── Visibility pause ──
      const isVisibleRef = { current: true };
      const io = new IntersectionObserver(
        (entries) => {
          isVisibleRef.current = entries[0].isIntersecting;
        },
        { threshold: 0.1 }
      );
      io.observe(container);
      cleanupFns.push(() => io.disconnect());

      // ── Resize ──
      const onResize = () => {
        const w = container.clientWidth;
        const h = container.clientHeight;
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
        renderer.setSize(w, h);
      };
      window.addEventListener("resize", onResize);
      cleanupFns.push(() => window.removeEventListener("resize", onResize));

      // ── Animation loop ──
      const clock = new THREE.Clock();
      const animate = () => {
        animationFrameId = requestAnimationFrame(animate);
        if (!isVisibleRef.current) return;
        clock.getDelta(); // keeps elapsedTime ticking

        slabMeshes.forEach((mesh, i) => {
          const isSelected = selectedIndexRef.current === mesh.userData.itemIndex;
          if (!isSelected) {
            mesh.rotation.y = mesh.userData.baseRotY + clock.elapsedTime * mesh.userData.autoRotSpeed;
          }
          // Float bob
          mesh.position.y = POSITIONS[i].y + Math.sin(clock.elapsedTime * 0.6 + i * 1.1) * 0.06;
          // Selected slab eases forward; others ease back to base depth
          const targetZ = mesh.userData.baseZ + (isSelected ? 0.3 : 0);
          mesh.position.z += (targetZ - mesh.position.z) * 0.08;
        });

        targetGroupRot.x = mouseRef.y * -0.08;
        targetGroupRot.y = mouseRef.x * 0.12;
        currentGroupRot.x += (targetGroupRot.x - currentGroupRot.x) * 0.05;
        currentGroupRot.y += (targetGroupRot.y - currentGroupRot.y) * 0.05;
        slabGroup.rotation.x = currentGroupRot.x;
        slabGroup.rotation.y = currentGroupRot.y;

        renderer.render(scene, camera);
      };
      animate();
      setReady(true);

      cleanupFns.push(() => {
        cancelAnimationFrame(animationFrameId);
        slabMeshes.forEach((mesh) => {
          mesh.geometry.dispose();
          if (Array.isArray(mesh.material)) {
            mesh.material.forEach((m) => {
              const mat = m as ThreeNS.MeshStandardMaterial;
              if (mat.map) mat.map.dispose();
              mat.dispose();
            });
          }
        });
        scene.environment?.dispose();
        scene.clear();
        renderer.dispose();
      });
    })();

    return () => {
      disposed = true;
      cleanupFns.forEach((fn) => fn());
      cleanupFns = [];
    };
    // items identity is stable per fetch — re-init only when the list changes
  }, [items]);

  if (!items.length) return null;

  return (
    <div ref={containerRef} className={`relative w-full h-full ${className ?? ""}`}>
      {/* Loading state until first frame / fallback decided */}
      {!ready && (
        <div className="absolute inset-0 bg-gradient-to-b from-[#0c0c0a] to-[#1a1408] animate-pulse flex items-center justify-center">
          <div className="w-8 h-8 rounded-full border-2 border-[#D4AF37] border-t-transparent animate-spin" />
        </div>
      )}

      {/* WebGL canvas */}
      {!useFallback && <canvas ref={canvasRef} className="w-full h-full block" />}

      {/* CSS 3D fallback (mobile / no WebGL) */}
      {useFallback && (
        <div className="relative w-full h-full flex items-center justify-center" style={{ perspective: "1000px" }}>
          {items.slice(0, 5).map((item, i) => (
            <div
              key={item.certNumber}
              className="absolute w-28 h-40 rounded-lg shadow-2xl cursor-pointer transition-transform hover:scale-105 bg-[#0c0c0a] border border-white/10 overflow-hidden"
              style={{
                transform: `rotateY(${(i - 2) * 12}deg) translateX(${(i - 2) * 48}px) translateZ(${-Math.abs(i - 2) * 30}px)`,
                zIndex: 5 - Math.abs(i - 2),
              }}
              onClick={() => setSelectedItem(item)}
            >
              <img src={item.frontLabelUrl} alt="" className="w-full object-cover" />
              {item.frontScanUrl && (
                <img src={item.frontScanUrl} alt={item.cardName} className="w-full object-contain" />
              )}
            </div>
          ))}
        </div>
      )}

      {/* Cert overlay */}
      {selectedItem && (
        <div className="absolute bottom-0 left-0 right-0 z-20 bg-[#0c0c0a]/95 backdrop-blur-md border-t border-[#D4AF37]/30 rounded-t-2xl p-6 transform transition-transform duration-300 translate-y-0">
          <button
            onClick={() => setSelectedItem(null)}
            aria-label="Close"
            className="absolute top-4 right-4 text-white/50 hover:text-white text-2xl leading-none"
          >
            ×
          </button>

          <div className="flex items-center gap-4">
            <div
              className="shrink-0 w-16 h-16 rounded-xl flex flex-col items-center justify-center border-2"
              style={{
                borderColor: gradeColor(selectedItem.grade),
                background: gradeColor(selectedItem.grade) + "22",
              }}
            >
              <span className="text-xl font-bold tabular-nums" style={{ color: gradeColor(selectedItem.grade) }}>
                {selectedItem.grade}
              </span>
              <span className="text-[9px] uppercase tracking-widest text-white/60">{selectedItem.gradeLabel}</span>
            </div>

            <div className="flex-1 min-w-0">
              <p className="text-white font-medium truncate text-lg">{selectedItem.cardName}</p>
              {selectedItem.setName && <p className="text-white/50 text-sm truncate">{selectedItem.setName}</p>}
              <p className="text-white/30 text-xs mt-1 font-mono">{selectedItem.certNumber}</p>
            </div>

            <a
              href={`/cert/${selectedItem.certNumber}`}
              target="_blank"
              rel="noopener noreferrer"
              className="shrink-0 px-5 py-2.5 rounded-lg bg-[#D4AF37] text-[#0c0c0a] font-semibold text-sm hover:bg-[#c8a020] transition-colors"
            >
              View Certificate →
            </a>
          </div>

          <p className="text-white/25 text-xs mt-3 text-center">
            Certificate includes verifiable grading report & ownership logbook
          </p>
        </div>
      )}
    </div>
  );
}
