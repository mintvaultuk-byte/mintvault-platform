export default function MintVaultWordmark({ size = "md" }: { size?: "xs" | "sm" | "md" | "lg" | "xl" }) {
  const sizes = {
    xs: { fontSize: "13px", padding: "3px 8px", borderWidth: "1.5px", stroke: "0.4px" },
    sm: { fontSize: "20px", padding: "6px 16px", borderWidth: "2px",   stroke: "0.6px" },
    md: { fontSize: "28px", padding: "10px 22px", borderWidth: "2.5px", stroke: "0.9px" },
    lg: { fontSize: "48px", padding: "16px 36px", borderWidth: "3px",   stroke: "1.2px" },
    xl: { fontSize: "72px", padding: "22px 50px", borderWidth: "3.5px", stroke: "1.5px" },
  };
  const s = sizes[size];
  return (
    <div className="inline-block mx-auto" style={{
      border: `${s.borderWidth} solid #D4AF37`,
      padding: s.padding,
    }}>
      <div style={{
                fontWeight: 900,
        fontSize: s.fontSize,
        color: "#D4AF37",
        letterSpacing: "0.04em",
        lineHeight: 0.9,
        WebkitTextStroke: `${s.stroke} #D4AF37`,
        textShadow: "0 0 1px #D4AF37",
        whiteSpace: "nowrap",
      }}>MINTVAULT</div>
    </div>
  );
}
