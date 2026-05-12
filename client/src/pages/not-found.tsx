import { Link } from "wouter";

export default function NotFound() {
  return (
    <div className="px-4 py-24 text-center">
      <h1 className="text-5xl font-bold text-[#D4AF37] mb-4 glow-gold" data-testid="text-404-title">404</h1>
      <p className="text-gray-400 mb-8" data-testid="text-404-message">
        This page doesn't exist.
      </p>
      <Link href="/">
        <button
          className="border border-[#D4AF37] bg-black text-[#D4AF37] px-6 py-2.5 rounded font-medium tracking-wide transition-all btn-gold-glow hover:bg-[#D4AF37]/10"
          data-testid="button-go-home"
        >
          Go Home
        </button>
      </Link>
    </div>
  );
}
