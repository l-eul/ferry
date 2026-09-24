import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium tracking-wide",
  {
    variants: {
      variant: {
        mute: "border-border bg-surface-2 text-muted",
        ok: "border-ok/25 bg-ok/10 text-ok",
        warn: "border-warn/25 bg-warn/10 text-warn",
        bad: "border-bad/25 bg-bad/10 text-bad",
        fg: "border-border bg-accent/10 text-fg",
      },
    },
    defaultVariants: { variant: "mute" },
  },
);

function Badge({
  className,
  variant,
  ...props
}: React.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return <span className={cn(badgeVariants({ variant }), className)} {...props} />;
}

export { Badge, badgeVariants };
