import { Link } from "wouter";
import { Shield, ArrowRightLeft, Key, BookOpen, ChevronRight } from "lucide-react";

export default function OwnershipPage() {
  return (
    <div className="min-h-screen py-12 px-4">
      <div className="max-w-2xl mx-auto">

        {/* Header */}
        <div className="text-center mb-12">
          <div className="inline-flex items-center justify-center w-16 h-16 rounded-2xl mb-6"
            style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)" }}>
            <Key className="w-8 h-8 text-[#1A1400]" />
          </div>
          <h1 className="text-4xl font-black text-[#1A1A1A] tracking-tight uppercase mb-3">
            Ownership Portal
          </h1>
          <p className="text-[#666666] text-sm max-w-md mx-auto leading-relaxed">
            Register first-time ownership of your graded card, or transfer an existing ownership record to a new owner.
          </p>
        </div>

        {/* Two large option cards */}
        <div className="space-y-4 mb-10">

          {/* Register Ownership */}
          <Link href="/claim">
            <div className="group relative z-[3] border border-[#D4AF37]/25 bg-[#FAFAF8] rounded-2xl p-7 cursor-pointer hover:border-[#D4AF37]/60 hover:bg-white transition-all duration-200">
              <div className="flex items-start gap-5">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{ background: "linear-gradient(135deg,#D4AF37 0%,#B8960C 100%)" }}>
                  <Shield className="w-6 h-6 text-[#1A1400]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h2 className="text-lg font-bold text-[#1A1A1A] uppercase tracking-wide">Register Ownership</h2>
                    <ChevronRight className="w-5 h-5 text-[#D4AF37]/50 group-hover:text-[#D4AF37] transition-colors flex-shrink-0" />
                  </div>
                  <p className="text-[#666666] text-sm leading-relaxed mb-4">
                    First time claiming this card? Use your one-time claim code — the unique registration code included with your graded slab — to link this certificate to your email address.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[#D4AF37]/50 bg-[#FAFAF8] rounded-full px-3 py-1">
                      <Key className="w-3 h-3" /> One-time claim code
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[#D4AF37]/50 bg-[#FAFAF8] rounded-full px-3 py-1">
                      Email verification
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Link>

          {/* Transfer Ownership */}
          <Link href="/transfer">
            <div className="group relative z-[3] border border-[#E8E4DC] bg-white rounded-2xl p-7 cursor-pointer hover:border-[#D4AF37]/40 hover:bg-[#FAFAF8] transition-all duration-200">
              <div className="flex items-start gap-5">
                <div className="w-12 h-12 rounded-xl flex items-center justify-center flex-shrink-0 border border-[#D4AF37]/30 bg-[#FAFAF8]">
                  <ArrowRightLeft className="w-6 h-6 text-[#D4AF37]" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center justify-between gap-2 mb-1">
                    <h2 className="text-lg font-bold text-[#1A1A1A] uppercase tracking-wide">Transfer Ownership</h2>
                    <ChevronRight className="w-5 h-5 text-[#D4AF37]/30 group-hover:text-[#D4AF37]/70 transition-colors flex-shrink-0" />
                  </div>
                  <p className="text-[#666666] text-sm leading-relaxed mb-4">
                    Already the registered owner? Transfer your ownership record to a new owner. Both parties confirm by email before the ownership reference is updated in the MintVault registry.
                  </p>
                  <div className="flex flex-wrap gap-3">
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[#D4AF37]/40 bg-white rounded-full px-3 py-1">
                      Two-step confirmation
                    </span>
                    <span className="inline-flex items-center gap-1.5 text-[10px] font-bold uppercase tracking-widest text-[#D4AF37]/40 bg-white rounded-full px-3 py-1">
                      Registry updated instantly
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </Link>
        </div>

        {/* What is an Ownership Reference */}
        <div className="relative z-[3] border border-[#E8E4DC] rounded-2xl p-6 bg-[#FAFAF8]">
          <div className="flex items-start gap-3 mb-4">
            <BookOpen className="w-5 h-5 text-[#D4AF37]/60 flex-shrink-0 mt-0.5" />
            <h3 className="text-sm font-bold text-[#D4AF37]/80 uppercase tracking-widest">About Ownership</h3>
          </div>
          <div className="space-y-3 text-xs text-[#999999] leading-relaxed">
            <p>
              <span className="text-[#444444] font-semibold">One-time claim code</span> — the physical code included with your graded slab. Used once to register ownership. Cannot be reused after registration.
            </p>
            <p>
              <span className="text-[#444444] font-semibold">Ownership reference</span> — your active, unique ownership record linked to this certificate in the MintVault registry. Generated automatically when you register. Updated on every ownership transfer. This is your proof of registered ownership.
            </p>
            <p>
              Ownership is stored against your email address in the MintVault registry. To verify a certificate or check ownership status, use the{" "}
              <Link href="/verify" className="text-[#D4AF37] hover:underline">Certificate Lookup</Link>.
            </p>
          </div>
        </div>

      </div>
    </div>
  );
}
