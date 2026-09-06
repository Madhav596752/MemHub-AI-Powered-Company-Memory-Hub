import { Activity, FileText, Layers, Sparkles, Share2, MessageSquare, Target, TrendingUp, TrendingDown } from "lucide-react";

const iconMap = { Activity, FileText, Layers, Sparkles, Share2, MessageSquare, Target };

export default function StatCard({ label, value, delta, trend = "up", icon = "Activity" }) {
  const Icon = iconMap[icon] || Activity;
  const TrendIcon = trend === "up" ? TrendingUp : TrendingDown;
  const trendColor = trend === "up" ? "text-emerald-500" : "text-destructive";

  return (
    <div className="group rounded-xl border border-border bg-card p-5 transition-colors duration-200 hover:border-primary/40">
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
          {label}
        </span>
        <span className="h-8 w-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
          <Icon className="h-4 w-4" strokeWidth={1.75} />
        </span>
      </div>
      <div className="mt-4 flex items-baseline justify-between">
        <p className="text-3xl font-semibold tracking-tight">{value}</p>
        <div className={`flex items-center gap-1 text-xs font-mono ${trendColor}`}>
          <TrendIcon className="h-3.5 w-3.5" strokeWidth={2} />
          <span>{delta}</span>
        </div>
      </div>
    </div>
  );
}
