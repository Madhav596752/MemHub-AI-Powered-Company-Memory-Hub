import { useNavigate } from "react-router-dom";
import {
  ResponsiveContainer,
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { Sparkles, ArrowRight, Upload, MessageSquare, Cpu, GitBranch } from "lucide-react";
import StatCard from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { currentUser, stats, knowledgeOverview, recentActivity, promptSuggestions, knowledgeItems } from "@/data/mockData";

const iconMap = { Upload, MessageSquare, Cpu, GitBranch };
const activityColor = {
  upload: "bg-primary/10 border-primary/20 text-primary",
  process: "bg-cyan-500/10 border-cyan-500/20 text-cyan-400",
  query: "bg-purple-500/10 border-purple-500/20 text-purple-400",
  graph: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400",
};

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

export default function Dashboard() {
  const navigate = useNavigate();

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tighter">
          {greeting()}, {currentUser.name.split(" ")[0]} <span className="inline-block">👋</span>
        </h1>
        <p className="mt-2 text-muted-foreground">
          Here's what's happening with your company knowledge.
        </p>
      </div>

      {/* AI search bar */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center gap-2 text-primary text-sm">
          <Sparkles className="h-4 w-4" strokeWidth={1.75} />
          <span className="font-medium">Ask MemHub</span>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            navigate("/app/assistant");
          }}
          className="mt-3 flex items-center gap-2"
        >
          <input
            placeholder="Ask anything about your company…"
            className="flex-1 h-12 rounded-xl bg-secondary/50 border border-border px-4 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
          />
          <Button type="submit" className="h-12 px-5 rounded-xl">
            Ask <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </form>
        <div className="mt-4 flex flex-wrap gap-2">
          {promptSuggestions.map((s) => (
            <button
              key={s}
              onClick={() => navigate("/app/assistant")}
              className="text-xs font-mono px-3 py-1.5 rounded-full border border-border bg-background/50 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {stats.map((s) => (
          <StatCard key={s.label} {...s} />
        ))}
      </div>

      {/* Chart + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl border border-border bg-card p-6">
          <div className="flex items-center justify-between">
            <div>
              <h2 className="text-lg font-semibold tracking-tight">Knowledge Overview</h2>
              <p className="text-xs text-muted-foreground font-mono mt-1">Last 7 days · docs · chunks · queries</p>
            </div>
            <div className="flex items-center gap-3 text-[11px] font-mono">
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-primary" /> Docs</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-cyan-400" /> Chunks</span>
              <span className="flex items-center gap-1.5"><span className="h-2 w-2 rounded-full bg-purple-400" /> Queries</span>
            </div>
          </div>
          <div className="mt-6 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={knowledgeOverview} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                <defs>
                  <linearGradient id="g-docs" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.4} />
                    <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="g-chunks" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#06B6D4" stopOpacity={0.35} />
                    <stop offset="100%" stopColor="#06B6D4" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="g-queries" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#A855F7" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#A855F7" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                    borderRadius: 12,
                    fontSize: 12,
                  }}
                  cursor={{ stroke: "hsl(var(--primary))", strokeWidth: 1, strokeOpacity: 0.3 }}
                />
                <Area type="monotone" dataKey="chunks" stroke="#06B6D4" strokeWidth={2} fill="url(#g-chunks)" />
                <Area type="monotone" dataKey="queries" stroke="#A855F7" strokeWidth={2} fill="url(#g-queries)" />
                <Area type="monotone" dataKey="docs" stroke="hsl(var(--primary))" strokeWidth={2} fill="url(#g-docs)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Recent Activity</h2>
          <ul className="mt-4 space-y-4">
            {recentActivity.map((a, i) => {
              const Icon = iconMap[a.icon] || Cpu;
              return (
                <li key={i} className="flex items-start gap-3">
                  <span className={`h-8 w-8 rounded-lg border flex items-center justify-center shrink-0 ${activityColor[a.type]}`}>
                    <Icon className="h-4 w-4" strokeWidth={1.75} />
                  </span>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm truncate">{a.title}</p>
                    <p className="text-xs text-muted-foreground font-mono mt-0.5">{a.user} · {a.time}</p>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {/* Recently added */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Recently Added Knowledge</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate("/app/knowledge")}>
            View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
        <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
          {knowledgeItems.slice(0, 6).map((k) => (
            <div key={k.id} className="rounded-xl border border-border bg-background/50 p-4 hover:border-primary/40 transition-colors">
              <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{k.type}</p>
              <h3 className="mt-2 text-sm font-medium tracking-tight line-clamp-1">{k.title}</h3>
              <p className="mt-1 text-xs text-muted-foreground line-clamp-2">{k.description}</p>
              <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                <span>{k.author}</span>
                <span>{k.chunks} chunks</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}