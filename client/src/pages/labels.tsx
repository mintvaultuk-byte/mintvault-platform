import { Shield, Lock, QrCode, Fingerprint, Award } from "lucide-react";

const features = [
  {
    icon: <QrCode size={24} />,
    title: "QR Code Verification",
    description: "Every slab features a unique QR code linked directly to the MintVault certificate database, allowing instant verification from any device.",
  },
  {
    icon: <Lock size={24} />,
    title: "Tamper-Evident Encapsulation",
    description: "Our precision slabs use ultrasonic welding and tamper-evident seals. Any attempt to open the case is immediately visible.",
  },
  {
    icon: <Fingerprint size={24} />,
    title: "Distinctive Label Design",
    description: "MintVault labels use a precise, professional layout built around the certificate number, grade, and card details. Every label is printed consistently across the run.",
  },
  {
    icon: <Shield size={24} />,
    title: "Unique Certificate Number",
    description: "Each graded card receives a unique MintVault certificate number (e.g. MV1) that ties directly to our online verification system.",
  },
  {
    icon: <Award size={24} />,
    title: "Premium Gold-Accent Finish",
    description: "Our labels feature a clean, professional layout with gold-accent detailing that reflects the quality and prestige of the MintVault brand.",
  },
];

export default function LabelsPage() {
  return (
    <div className="px-4 py-12 max-w-3xl mx-auto">
      <h1
        className="text-3xl md:text-4xl font-bold text-[#D4AF37] tracking-widest text-center mb-4 glow-gold"
        data-testid="text-labels-title"
      >
        PREMIUM MINTVAULT LABELS
      </h1>
      <p className="text-gray-300 text-center mb-12 max-w-xl mx-auto" data-testid="text-labels-subtitle">
        Designed for clarity, security, and prestige. Every detail of our slab and label system
        is engineered to protect your investment.
      </p>

      <div className="border border-[#D4AF37]/20 rounded-lg p-6 md:p-8 mb-10">
        <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-4 glow-gold-sm" data-testid="text-slab-design-heading">
          Slab Design
        </h2>
        <div className="space-y-3 text-gray-300 leading-relaxed">
          <p data-testid="text-slab-design-body">
            The MintVault slab is a crystal-clear, UV-resistant enclosure precision-moulded to hold your card
            securely without movement or contact damage. The inner sleeve holds the card firmly in place while
            the outer shell provides maximum visibility and long-term protection.
          </p>
          <p>
            Each slab is ultrasonically sealed — meaning it cannot be opened without visible damage — ensuring
            the integrity of the grade is maintained from the moment it leaves our facility.
          </p>
        </div>
      </div>

      <h2 className="text-xl font-bold text-[#D4AF37] tracking-wide mb-6 glow-gold-sm text-center" data-testid="text-security-heading">
        Security Features
      </h2>

      <div className="space-y-6">
        {features.map((feature, i) => (
          <div
            key={i}
            className="border border-[#D4AF37]/20 rounded-lg p-5 md:p-6 flex gap-4"
            data-testid={`card-feature-${i}`}
          >
            <div className="w-12 h-12 border border-[#D4AF37]/40 rounded-lg flex items-center justify-center text-[#D4AF37] shrink-0">
              {feature.icon}
            </div>
            <div>
              <h3 className="text-[#D4AF37] font-semibold mb-1" data-testid={`text-feature-title-${i}`}>
                {feature.title}
              </h3>
              <p className="text-gray-400 text-sm leading-relaxed" data-testid={`text-feature-desc-${i}`}>
                {feature.description}
              </p>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
