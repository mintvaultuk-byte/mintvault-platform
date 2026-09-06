"use client";

import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { TimelineContent } from "@/components/ui/timeline-animation";
import { VerticalCutReveal } from "@/components/ui/vertical-cut-reveal";
import { useRef } from "react";
import { Link } from "wouter";

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
          Every tier includes the same world-class grading. Choose from the currently available services and discounts.
        </TimelineContent>

      </article>

      <TimelineContent
        as="div"
        animationNum={2}
        timelineRef={pricingRef}
        customVariants={revealVariants}
      >
        <Card className="border border-[#D4AF37]/30 bg-[#0f0e0b] max-w-2xl">
          <CardHeader>
            <h3 className="text-2xl font-semibold text-white">Current grading options</h3>
            <p className="text-sm text-[#999]">
              Compare available services, features and turnaround on our current pricing page.
            </p>
          </CardHeader>
          <CardContent>
            <Link href="/pricing" className="inline-block rounded-full border border-[#D4AF37] px-6 py-3 text-[#D4AF37]">
              View current grading prices and turnaround →
            </Link>
          </CardContent>
        </Card>
      </TimelineContent>
    </div>
  );
}
