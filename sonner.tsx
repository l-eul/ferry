import { Toaster as Sonner } from "sonner";

function Toaster() {
  return (
    <Sonner
      theme="dark"
      className="toaster group"
      toastOptions={{
        classNames: {
          toast: "bg-surface text-fg border-border",
        },
      }}
    />
  );
}

export { Toaster };
