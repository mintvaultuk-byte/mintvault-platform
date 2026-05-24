"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TimelineContent } from "@/components/ui/timeline-animation";
import { VerticalCutReveal } from "@/components/ui/vertical-cut-reveal";
import { cn } from "@/lib/utils";
import NumberFlow from "@number-flow/react";
import { CheckCheck, Clock, Shield, Zap } from "lucide-react";
import { useRef } from "react";
import { Link } from "wouter";
import GradientButton from "@/components/ui/gradient-button";

const plans = [
  {
    name: "Vault Queue",
    description: "Our most affordable option with a 40-day turnaround for collectors who aren't in a rush.",
    price: 19,
    turnaround: "40 working days",
    buttonText: "Start a submission",
    icon: <Shield size={20} />,
    features: [
      "Professional grade (1–10 scale)",
      "Subgrade breakdown",
      "NFC-enabled precision slab",
      "Online-verifiable certificate",
      "Ownership claim code",
      "Insured return shipping",
    ],
  },
  {
    name: "Standard",
    description: "The most popular tier — same quality grading with a faster 15-day turnaround.",
    price: 25,
    turnaround: "15 working days",
    buttonText: "Start a submission",
    popular: true,
    icon: <Clock size={20} />,
    features: [
      "Professional grade (1–10 scale)",
      "Subgrade breakdown",
      "NFC-enabled precision slab",
      "Online-verifiable certificate",
      "Ownership claim code",
      "Insured return shipping",
    ],
  },
  {
    name: "Express",
    description: "Priority handling with a 5-day turnaround for high-value cards and urgent submissions.",
    price: 45,
    turnaround: "5 working days",
    buttonText: "Start a submission",
    icon: <Zap size={20} />,
    features: [
      "Professional grade (1–10 scale)",
      "Subgrade breakdown",
      "NFC-enabled precision slab",
      "Online-verifiable certificate",
      "Ownership claim code",
      "Insured return shipping",
    ],
  },
];

export default function PricingAnimated() {
  const pricingRef = useRef<HTMLDivElement>(null);

  const revealVariants = {
    visible: (i: number) => ({
      y: 0,
      opacity: 1,
      filter: "blur(0px)",
      transition: {
        delay: i * 0.4,
        duration: 0.5,
      },
    }),
    hidden: {
      filter: "blur(10px)",
      y: -20,
      opacity: 0,
    },
  };

  return (
    <div className="px-4 pt-20 pb-16 min-h-screen max-w-7xl mx-auto relative" ref={pricingRef}>
      <article className="text-left mb-6 space-y-4 max-w-2xl">
        <h2 className="md:text-6xl text-4xl capitalize font-medium text-white mb-4">
          <VerticalCutReveal
            splitBy="words"
            staggerDuration={0.15}
            staggerFrom="first"
            reverse={true}
            containerClassName="justify-start"
            transition={{
              type: "spring",
              stiffness: 250,
              damping: 40,
              delay: 0,
            }}
          >
            Simple pricing, no hidden fees
          </VerticalCutReveal>
        </h2>

        <TimelineContent
          as="p"
          animationNum={0}
          timelineRef={pricingRef}
          customVariants={revealVariants}
          className="md:text-base text-sm text-[#999] w-[80%]"
        >
          Every tier includes the same world-class grading. Choose your turnaround speed. Bulk discounts from 10 cards.
        </TimelineContent>

      </article>

      <div className="grid md:grid-cols-3 gap-4 py-6">
        {plans.map((plan, index) => (
          <TimelineContent
            key={plan.name}
            as="div"
            animationNum={2 + index}
            timelineRef={pricingRef}
            customVariants={revealVariants}
          >
            <Card
              className={cn(
                "relative border",
                plan.popular ? "ring-2 ring-[#D4AF37] bg-[#0f0e0b] border-[#D4AF37]/30" : "bg-[#0f0e0b] border-[#333]"
              )}
            >
              <CardHeader className="text-left">
                <div className="flex justify-between items-start">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-10 h-10 rounded-xl bg-[#1a1400] border border-[#D4AF37]/20 flex items-center justify-center text-[#D4AF37]">
                      {plan.icon}
                    </div>
                    <h3 className="xl:text-3xl md:text-2xl text-3xl font-semibold text-white">{plan.name}</h3>
                  </div>
                  {plan.popular && (
                    <span className="bg-gradient-to-r from-[#B8960C] to-[#D4AF37] text-[#1a1400] px-3 py-1 rounded-full text-xs font-bold uppercase tracking-wider">
                      Popular
                    </span>
                  )}
                </div>
                <p className="xl:text-sm md:text-xs text-sm text-[#888] mb-4">{plan.description}</p>
                <div className="flex items-baseline gap-1">
                  <span className="text-4xl font-semibold text-white">
                    £
                    <NumberFlow value={plan.price} className="text-4xl font-semibold" />
                  </span>
                  <span className="text-[#888] ml-1">/ card</span>
                </div>
                <p className="text-xs text-[#666] mt-1">{plan.turnaround} turnaround</p>
              </CardHeader>

              <CardContent className="pt-0">
                <Link href="/submit" className="no-underline block">
                  <GradientButton height="52px" className="w-full mb-4">
                    {plan.buttonText}
                  </GradientButton>
                </Link>

                <div className="space-y-3 pt-4 border-t border-[#333]">
                  <h4 className="text-xs font-bold uppercase tracking-wider text-[#D4AF37] mb-3">What's included</h4>
                  <ul className="space-y-2.5">
                    {plan.features.map((feature, featureIndex) => (
                      <li key={featureIndex} className="flex items-center">
                        <span className="h-5 w-5 rounded-full border border-[#D4AF37]/40 grid place-content-center mr-3 flex-shrink-0">
                          <CheckCheck className="h-3 w-3 text-[#D4AF37]" />
                        </span>
                        <span className="text-sm text-[#ccc]">{feature}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </CardContent>
            </Card>
          </TimelineContent>
        ))}
      </div>
    </div>
  );
}
