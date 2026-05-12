import { CheckCircle2, Circle, Clock, Truck } from "lucide-react";

const STAGES = [
  { key: "submitted",       label: "Submitted",     desc: "Order placed and payment confirmed" },
  { key: "received",        label: "Received",      desc: "Cards arrived at MintVault facility" },
  { key: "in_queue",        label: "In Queue",      desc: "Waiting to be graded" },
  { key: "grading",         label: "Being Graded",  desc: "Currently under examination" },
  { key: "quality_check",   label: "Quality Check", desc: "Grade being verified" },
  { key: "slab_production", label: "Slab Production", desc: "Card being encapsulated" },
  { key: "shipping",        label: "Shipping",      desc: "On its way back to you" },
  { key: "delivered",       label: "Delivered",     desc: "Tracking shows delivered" },
];

interface Props {
  currentStatus: string;
  trackingNumber?: string | null;
  statusUpdatedAt?: string | null;
  compact?: boolean;
}

export default function GradingTimeline({ currentStatus, trackingNumber, statusUpdatedAt, compact }: Props) {
  const currentIdx = STAGES.findIndex(s => s.key === currentStatus);

  if (compact) {
    const stage = STAGES[currentIdx] ?? STAGES[0];
    return (
      <div className="flex items-center gap-2">
        <span className="w-2 h-2 rounded-full bg-[#D4AF37] animate-pulse flex-shrink-0" />
        <span className="text-[#1A1A1A] text-sm font-medium">{stage.label}</span>
        {statusUpdatedAt && (
          <span className="text-[#888888] text-xs">· {new Date(statusUpdatedAt).toLocaleDateString("en-GB")}</span>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="relative">
        {/* Vertical line */}
        <div className="absolute left-4 top-5 bottom-5 w-0.5 bg-[#E8E4DC]" />

        <div className="space-y-3">
          {STAGES.map((stage, idx) => {
            const isComplete = idx < currentIdx;
            const isCurrent  = idx === currentIdx;
            const isFuture   = idx > currentIdx;

            return (
              <div key={stage.key} className="flex items-start gap-4 relative">
                {/* Dot */}
                <div className={`flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center z-10 border-2 ${
                  isComplete ? "bg-emerald-500 border-emerald-500" :
                  isCurrent  ? "bg-[#D4AF37] border-[#D4AF37]" :
                               "bg-white border-[#E8E4DC]"
                }`}>
                  {isComplete ? (
                    <CheckCircle2 size={14} className="text-white" />
                  ) : isCurrent ? (
                    <Clock size={14} className="text-[#1A1400]" />
                  ) : (
                    <Circle size={14} className="text-[#CCCCCC]" />
                  )}
                </div>

                {/* Content */}
                <div className="pt-1 pb-3 min-w-0">
                  <p className={`text-sm font-semibold ${
                    isComplete ? "text-emerald-600" :
                    isCurrent  ? "text-[#1A1A1A]" :
                                 "text-[#AAAAAA]"
                  }`}>
                    {stage.label}
                    {isCurrent && <span className="ml-2 text-[9px] font-bold uppercase text-[#D4AF37] bg-[#D4AF37]/10 px-1.5 py-0.5 rounded">Current</span>}
                  </p>
                  {!isFuture && (
                    <p className="text-xs text-[#888888] mt-0.5">{stage.desc}</p>
                  )}
                  {isCurrent && stage.key === "shipping" && trackingNumber && (
                    <div className="flex items-center gap-1.5 mt-1">
                      <Truck size={12} className="text-[#D4AF37]" />
                      <a
                        href={`https://www.royalmail.com/track-your-item#/tracking-results/${trackingNumber}`}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-[#D4AF37] text-xs hover:underline font-mono"
                      >
                        {trackingNumber}
                      </a>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
