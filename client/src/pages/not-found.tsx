import { Link } from "wouter";
import GradientButton from "@/components/ui/gradient-button";

export default function NotFound() {
  return (
    <div className="px-4 py-24 text-center">
      <h1 className="text-5xl font-bold text-[#D4AF37] mb-4 glow-gold" data-testid="text-404-title">
        404
      </h1>
      <p className="text-gray-400 mb-8" data-testid="text-404-message">
        This page doesn't exist.
      </p>
      <Link href="/" className="no-underline inline-block">
        <GradientButton height="42px" data-testid="button-go-home">
          Go Home
        </GradientButton>
      </Link>
    </div>
  );
}
