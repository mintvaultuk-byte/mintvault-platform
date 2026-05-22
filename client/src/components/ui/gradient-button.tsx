"use client";

import type { ButtonHTMLAttributes, HTMLAttributes } from "react";
import { cn } from "@/lib/utils";

type BaseProps = {
  children?: React.ReactNode;
  width?: string;
  height?: string;
  disabled?: boolean;
};

type DivProps = BaseProps &
  Omit<HTMLAttributes<HTMLDivElement>, keyof BaseProps> & {
    as?: "div";
  };

type ButtonProps = BaseProps &
  Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof BaseProps> & {
    as: "button";
  };

type GradientButtonProps = DivProps | ButtonProps;

const GradientButton = (props: GradientButtonProps) => {
  const { children, width, height = "48px", className = "", disabled = false, as, ...rest } = props;

  const sharedClass = cn(
    "gradient-btn-wrapper relative rounded-[50px] cursor-pointer",
    "after:content-[''] after:block after:absolute after:bg-[var(--gradient-btn-bg,#0a0e1a)]",
    "after:inset-[2px] after:rounded-[48px] after:z-[1]",
    "after:transition-opacity after:duration-300 after:ease-linear",
    "flex items-center justify-center text-center",
    "transition-transform duration-200",
    "hover:scale-[1.03] active:scale-[0.98]",
    disabled && "opacity-50 cursor-not-allowed",
    className
  );

  const sharedStyle = {
    "--r": "0deg",
    minWidth: width,
    height: height,
  } as React.CSSProperties;

  const inner = (
    <span className="relative z-10 flex items-center justify-center gap-2 px-6 font-semibold text-sm tracking-wide text-[#D4AF37]">
      {children}
    </span>
  );

  if (as === "button") {
    const buttonRest = rest as Omit<ButtonHTMLAttributes<HTMLButtonElement>, keyof BaseProps>;
    return (
      <button className={sharedClass} style={sharedStyle} disabled={disabled} {...buttonRest}>
        {inner}
      </button>
    );
  }

  const divRest = rest as Omit<HTMLAttributes<HTMLDivElement>, keyof BaseProps>;
  return (
    <div
      role="button"
      tabIndex={disabled ? -1 : 0}
      className={sharedClass}
      style={sharedStyle}
      onClick={disabled ? undefined : divRest.onClick}
      onKeyDown={(e) => {
        if (disabled) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          divRest.onClick?.(e as unknown as React.MouseEvent<HTMLDivElement>);
        }
      }}
      aria-disabled={disabled}
      {...divRest}
    >
      {inner}
    </div>
  );
};

export default GradientButton;
