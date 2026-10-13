import { useState } from "react";
import { Search, Bell, Menu } from "lucide-react";
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
              className="w-full h-10 pl-9 pr-3 text-sm rounded-lg bg-secondary/50 border border-border placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
            />
          </label>
        </form>

        <div className="ml-auto flex items-center gap-1">
          <ThemeToggle />
          <button
            type="button"
            disabled
            title="Notifications are coming in a later phase"
            className="relative p-2 rounded-md text-muted-foreground opacity-50 cursor-not-allowed"
            aria-label="Notifications (coming soon)"
          >
            <Bell className="h-4 w-4" strokeWidth={1.75} />
          </button>
        </div>
      </div>
    </header>
  );
}
