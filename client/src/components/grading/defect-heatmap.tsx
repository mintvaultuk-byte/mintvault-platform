import { useEffect, useRef } from "react";

interface Defect {
  id: number;
  x_percent: number;
  y_percent: number;
  severity: "minor" | "moderate" | "significant";
}

interface Props {
  defects: Defect[];
  width: number;
  height: number;
}

const RADIUS: Record<string, number> = { minor: 25, moderate: 40, significant: 60 };
const COLOR:  Record<string, string>  = { minor: "255,200,0", moderate: "255,120,0", significant: "220,30,30" };

export default function DefectHeatmap({ defects, width, height }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    defects.forEach(d => {
      const x = (d.x_percent / 100) * canvas.width;
      const y = (d.y_percent / 100) * canvas.height;
      const r = RADIUS[d.severity] || 30;
      const c = COLOR[d.severity] || "255,0,0";

      const gradient = ctx.createRadialGradient(x, y, 0, x, y, r);
      gradient.addColorStop(0,   `rgba(${c},0.55)`);
      gradient.addColorStop(0.5, `rgba(${c},0.25)`);
      gradient.addColorStop(1,   `rgba(${c},0)`);

      ctx.beginPath();
      ctx.arc(x, y, r, 0, Math.PI * 2);
      ctx.fillStyle = gradient;
      ctx.fill();
    });
  }, [defects, width, height]);

  return (
    <canvas
      ref={canvasRef}
      width={width}
      height={height}
      className="absolute inset-0 pointer-events-none"
      style={{ opacity: 0.4 }}
    />
  );
}
