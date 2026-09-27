import type { ButtonHTMLAttributes, ReactNode } from "react";
import { cn } from "@/lib/utils";

type ArcadeButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  children: ReactNode;
  variant?: "primary" | "secondary" | "danger" | "ghost";
};

export function ArcadeButton({
  children,
  className,
  variant = "primary",
  ...props
}: ArcadeButtonProps) {
  const variants = {
    primary:
      "border-primary bg-primary text-primary-foreground shadow-[4px_4px_0_var(--panel)] hover:bg-accent",
    secondary:
      "border-primary bg-card text-foreground shadow-[4px_4px_0_var(--primary)] hover:bg-secondary",
    danger:
      "border-alert bg-alert text-alert-foreground shadow-[4px_4px_0_var(--card)] hover:brightness-110",
    ghost:
      "border-transparent bg-transparent text-muted-foreground hover:border-primary hover:text-foreground",
  };

  return (
    <button
      className={cn(
        "inline-flex min-h-11 items-center justify-center gap-2 border-2 px-4 py-2 font-display text-[10px] leading-5 uppercase transition-[transform,box-shadow,background-color] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40 active:translate-x-1 active:translate-y-1 active:shadow-none",
        variants[variant],
        className,
      )}
      {...props}
    >
      {children}
    </button>
  );
}
