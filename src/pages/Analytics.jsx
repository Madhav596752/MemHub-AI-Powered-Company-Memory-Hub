import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, PieChart, Pie, Cell } from "recharts";
import { analytics, analyticsStats } from "@/data/mockData";
import StatCard from "@/components/StatCard";

const pieColors = ["#5E6AD2", "#06B6D4", "#A855F7", "#F59E0B", "#EC4899"];

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 12,
  fontSize: 12,
};

export default function Analytics() {
  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">Signals about how your team is using MemHub.</p>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {analyticsStats.map((c) => (
          <StatCard key={c.label} {...c} />
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">AI Queries Over Time</h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">Last 6 months</p>
          <div className="mt-6 h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={analytics.queriesOverTime} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ stroke: "hsl(var(--primary))", strokeOpacity: 0.3 }} />
                <Line type="monotone" dataKey="queries" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={{ r: 3, fill: "hsl(var(--primary))" }} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Document Types</h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">By share of ingested files</p>
          <div className="mt-4 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={analytics.docTypes} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                  {analytics.docTypes.map((_, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} stroke="hsl(var(--card))" strokeWidth={2} />)}
                </Pie>
                <Tooltip contentStyle={tooltipStyle} />
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            {analytics.docTypes.map((t, i) => (
              <div key={t.name} className="flex items-center gap-2">
                <span className="h-2 w-2 rounded-full" style={{ background: pieColors[i] }} />
                <span className="text-muted-foreground">{t.name}</span>
                <span className="ml-auto font-mono text-muted-foreground">{t.value}%</span>
              </div>
            ))}
          </div>
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Knowledge Growth</h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">Documents indexed per month</p>
          <div className="mt-6 h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={analytics.knowledgeGrowth} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                <XAxis dataKey="month" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--secondary))" }} />
                <Bar dataKey="docs" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="lg:col-span-2 rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Most Searched Topics</h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">Top 5 by query volume</p>
          <ul className="mt-4 space-y-3">
            {analytics.topTopics.map((t) => {
              const max = Math.max(...analytics.topTopics.map((x) => x.queries));
              const pct = Math.round((t.queries / max) * 100);
              return (
                <li key={t.topic}>
                  <div className="flex items-center justify-between text-sm">
                    <span className="font-medium">{t.topic}</span>
                    <span className="font-mono text-xs text-muted-foreground">{t.queries} queries</span>
                  </div>
                  <div className="mt-1.5 h-2 rounded-full bg-secondary overflow-hidden">
                    <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    </div>
  );
}
