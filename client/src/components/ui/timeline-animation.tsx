"use client";

import { cn } from "@/lib/utils";
import { motion, type Variants } from "framer-motion";
import type { ReactNode } from "react";

interface TimelineContentProps {
  children: ReactNode;
  animationNum: number;
  timelineRef: React.RefObject<HTMLDivElement | null>;
  customVariants?: Variants;
  as?: "div" | "p" | "span" | "section";
  className?: string;
}

export function TimelineContent({
  children,
  animationNum,
  customVariants,
  as = "div",
  className,
}: TimelineContentProps) {
  const defaultVariants: Variants = {
    hidden: { opacity: 0, y: 20, filter: "blur(8px)" },
    visible: {
      opacity: 1,
      y: 0,
      filter: "blur(0px)",
      transition: { delay: animationNum * 0.15, duration: 0.5 },
    },
  };

  const Component = motion[as];

  return (
    <Component
      initial="hidden"
      whileInView="visible"
      viewport={{ once: true, amount: 0.3 }}
      custom={animationNum}
      variants={customVariants || defaultVariants}
      className={cn(className)}
    >
      {children}
    </Component>
  );
}
