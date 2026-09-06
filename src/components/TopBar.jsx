import { useState } from "react";
import { Search, Bell, Command, Menu } from "lucide-react";
import { useNavigate } from "react-router-dom";
import ThemeToggle from "@/components/ThemeToggle";

export default function Topbar({ onOpenMobileNav }) {
  const [q, setQ] = useState("");
  const navigate = useNavigate();

  const submit = (e) => {
    e.preventDefault();
    if (q.trim()) navigate(`/app/search?q=${encodeURIComponent(q.trim())}`);
  };

  return (
    <header
      className="sticky top-0 z-40 h-16 border-b border-border bg-background/70 glass"
    >
      <div className="h-full px-4 md:px-6 flex items-center gap-3">
        <button
          onClick={onOpenMobileNav}
          className="md:hidden p-2 -ml-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
          aria-label="Open menu"
        >
          <Menu className="h-5 w-5" />
        </button>

        <form onSubmit={submit} className="flex-1 max-w-xl">
          <label className="relative flex items-center">
            <Search className="absolute left-3 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search knowledge, docs, people…"
              className="w-full h-10 pl-9 pr-16 text-sm rounded-lg bg-secondary/50 border border-border placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
            />
            <span className="absolute right-3 hidden sm:flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
              <Command className="h-3 w-3" /> K
            </span>
          </label>
        </form>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <button
            className="relative p-2 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors"
            aria-label="Notifications"
          >
            <Bell className="h-4 w-4" strokeWidth={1.75} />
            <span className="absolute top-1.5 right-1.5 h-1.5 w-1.5 rounded-full bg-cyan-400" />
          </button>
        </div>
      </div>
    </header>
  );
}
