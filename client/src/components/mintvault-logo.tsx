export default function MintVaultLogo({ size = "md" }: { size?: "sm" | "md" | "lg" }) {
  const sizes = {
    sm: { fontSize: "24px", padding: "8px 18px", borderWidth: "2px", stroke: "0.8px" },
    md: { fontSize: "36px", padding: "14px 28px", borderWidth: "2.5px", stroke: "1px" },
    lg: { fontSize: "64px", padding: "22px 50px", borderWidth: "3px", stroke: "1.5px" },
  };
  const s = sizes[size];
  return (
    <div style={{
      display: "inline-block",
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
      }}>MINTVAULT</div>
    </div>
  );
}
