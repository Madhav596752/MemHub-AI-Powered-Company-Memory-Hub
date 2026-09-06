import { Link } from "react-router-dom";
import { Brain } from "lucide-react";

export default function Logo({ className = "", iconOnly = false, to = "/" }) {
  return (
    <Link
      to={to}
      className={`inline-flex items-center gap-2 select-none group ${className}`}
    >
      <span className="relative flex h-8 w-8 items-center justify-center rounded-lg bg-primary text-primary-foreground shadow-sm ring-1 ring-primary/40">
        <Brain className="h-4 w-4" strokeWidth={2} />
        <span className="absolute -bottom-0.5 -right-0.5 h-2 w-2 rounded-full bg-cyan-400 ring-2 ring-background" />
      </span>
      {!iconOnly && (
        <span className="text-lg font-semibold tracking-tight">
          MemHub
        </span>
      )}
    </Link>
  );
}
