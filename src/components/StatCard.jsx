import {
  Activity,
  FileText,
  Layers,
  Sparkles,
  Share2,
  MessageSquare,
  Target,
  CheckCircle2,
  Clock,
  AlertTriangle,
  MinusCircle,
  Network,
  HardDrive,
  TrendingUp,
  TrendingDown,
} from "lucide-react";

const iconMap = {
  Activity, FileText, Layers, Sparkles, Share2, MessageSquare, Target,
  CheckCircle2, Clock, AlertTriangle, MinusCircle, Network, HardDrive,
};

// `delta`/`trend` are optional: the trend indicator is only drawn when a real delta is passed in.
// `note` is a small caption under the value; `loading` shows a placeholder instead of the value.
export default function StatCard({ label, value, delta, trend = "up", icon = "Activity", note, loading = false }) {
  const Icon = iconMap[icon] || Activity;
  const TrendIcon = trend === "up" ? TrendingUp : TrendingDown;
  const trendColor = trend === "up" ? "text-emerald-500" : "text-destructive";

  return (
    <div className="group rounded-xl border border-border bg-card p-5 transition-colors duration-200 hover:border-primary/40" data-stat={label}>
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        <span className="h-8 w-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      <div className="mt-4 flex items-baseline justify-between">
        <p className={`text-3xl font-semibold tracking-tight ${loading ? "animate-pulse text-muted-foreground" : ""}`} data-stat-value>
          {loading ? "…" : value}
        </p>
        {delta != null && !loading && (
          <div className={`flex items-center gap-1 text-xs font-mono ${trendColor}`}>
            <TrendIcon className="h-3.5 w-3.5" strokeWidth={2} />
            <span>{delta}</span>
          </div>
        )}
      </div>
      {note && !loading && <p className="mt-2 text-[11px] font-mono text-muted-foreground leading-snug">{note}</p>}
    </div>
  );
}
