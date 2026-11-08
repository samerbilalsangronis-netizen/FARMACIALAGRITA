import { cva, type VariantProps } from "class-variance-authority";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

const buttonVariants = cva("button", {
  variants: { variant: { default: "button-primary", outline: "button-outline", ghost: "button-ghost", danger: "button-danger" } },
  defaultVariants: { variant: "default" },
});

export function Button({ className, variant, type = "button", ...props }: React.ComponentProps<"button"> & VariantProps<typeof buttonVariants>) {
  return <button className={twMerge(clsx(buttonVariants({ variant }), className))} type={type} {...props} />;
}
