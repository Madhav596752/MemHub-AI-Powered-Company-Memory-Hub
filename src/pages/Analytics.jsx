import { useNavigate } from "react-router-dom";
import { FileText, Info } from "lucide-react";
import { ResponsiveContainer, XAxis, YAxis, CartesianGrid, Tooltip, BarChart, Bar, PieChart, Pie, Cell } from "recharts";
import StatCard from "@/components/StatCard";
import EmptyState from "@/components/EmptyState";
import { Button } from "@/components/ui/button";
import {
  useCompanyOverview,
  documentCounts,
  graphTotals,
  totalBytes,
  typeBreakdown,
  uploadsByMonth,
  processingOutcomes,
  topDocumentsByEntities,
  formatBytes,
  formatCount,
} from "@/utils/companyOverview";

const pieColors = ["#5E6AD2", "#06B6D4", "#A855F7", "#F59E0B", "#EC4899"];

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: 12,
  fontSize: 12,
};

// What the app does not store today, so it cannot be charted honestly.
const notTracked = [
  "AI question history, query counts and usage over time (/api/ask does not save questions or answers)",
  "Search volume, popular topics and search success rates (/api/search does not save queries)",
  "Which documents are cited or opened most often",
  "Answer quality, feedback or confidence (the assistant has no feedback storage yet)",
  "Vector-index status per document (an indexing failure is only reported during the upload request)",
  "Growth of the knowledge graph over time (only its current totals are available)",
  "Documents that were uploaded and later deleted (deleted documents leave no record)",
];

function Card({ title, subtitle, className = "", children }) {
  return (
    <div className={`rounded-2xl border border-border bg-card p-6 ${className}`}>
      <h2 className="text-lg font-semibold tracking-tight">{title}</h2>
      {subtitle && <p className="text-xs text-muted-foreground font-mono mt-1">{subtitle}</p>}
      {children}
    </div>
  );
}

const NoData = ({ children }) => (
  <p className="mt-6 text-center text-muted-foreground font-mono text-xs py-10">{children}</p>
);

export default function Analytics() {
  const navigate = useNavigate();
  const { loading, documents, status, graph, reload } = useCompanyOverview();

  const docs = documents.data || [];
  const counts = documentCounts(status, documents);
  const totals = graphTotals(graph);
  const types = typeBreakdown(docs);
  const { months, earlier } = uploadsByMonth(docs);
  const outcomes = processingOutcomes(counts);
  const topDocs = topDocumentsByEntities(docs);
  const topMax = topDocs.length ? topDocs[0].entities : 0;
  const waiting = loading && !documents.data && !documents.error;
  const hasDocs = docs.length > 0;
  const graphNote = totals.available ? undefined : totals.reason || "Unavailable right now";
  const graphWaiting = loading && !graph.data && !graph.error;

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Analytics</h1>
        <p className="mt-1 text-sm text-muted-foreground">What your company has stored in MemHub, calculated from your real documents.</p>
      </div>

      {documents.error && (
        <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 text-destructive text-sm px-4 py-3 flex items-center justify-between gap-4">
          <span>Could not load your documents. {documents.error}</span>
          <Button variant="outline" size="sm" onClick={reload}>Retry</Button>
        </div>
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Documents" value={counts ? formatCount(counts.total) : "—"} icon="FileText" loading={loading && !counts && !documents.error && !status.error} />
        <StatCard label="Storage Used" value={documents.data ? formatBytes(totalBytes(docs)) : "—"} icon="HardDrive" loading={waiting} note="Original files" />
        <StatCard label="Entities" value={totals.available ? formatCount(totals.entities) : "—"} icon="Network" loading={graphWaiting} note={graphNote} />
        <StatCard label="Relationships" value={totals.available ? formatCount(totals.relationships) : "—"} icon="Share2" loading={graphWaiting} note={graphNote} />
      </div>

      {!waiting && !documents.error && !hasDocs ? (
        <EmptyState
          icon={FileText}
          title="No documents to analyse yet"
          description="Charts appear here once your company has uploaded documents."
          action={<Button variant="outline" size="sm" onClick={() => navigate("/app/documents")}>Go to Documents</Button>}
        />
      ) : (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          <Card className="lg:col-span-2" title="Documents Uploaded Per Month" subtitle="Documents currently in your library, by upload month · last 12 months">
            {waiting ? (
              <NoData><span role="status">Loading…</span></NoData>
            ) : documents.error ? (
              <NoData>Unavailable until documents load.</NoData>
            ) : (
              <>
                <div className="mt-6 h-64">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={months} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                      <XAxis dataKey="label" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--secondary))" }} />
                      <Bar dataKey="docs" name="Documents" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <p className="mt-3 text-[11px] font-mono text-muted-foreground">
                  Deleted documents are not counted.{earlier > 0 ? ` ${earlier} older ${earlier === 1 ? "document is" : "documents are"} not shown.` : ""}
                </p>
              </>
            )}
          </Card>

          <Card title="Document Types" subtitle="Number of files by type">
            {waiting ? (
              <NoData><span role="status">Loading…</span></NoData>
            ) : documents.error ? (
              <NoData>Unavailable until documents load.</NoData>
            ) : (
              <>
                <div className="mt-4 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <PieChart>
                      <Pie data={types} dataKey="value" nameKey="name" innerRadius={50} outerRadius={80} paddingAngle={2}>
                        {types.map((_, i) => <Cell key={i} fill={pieColors[i % pieColors.length]} stroke="hsl(var(--card))" strokeWidth={2} />)}
                      </Pie>
                      <Tooltip contentStyle={tooltipStyle} />
                    </PieChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-testid="type-list">
                  {types.map((t, i) => (
                    <li key={t.name} className="flex items-center gap-2">
                      <span className="h-2 w-2 rounded-full" style={{ background: pieColors[i % pieColors.length] }} />
                      <span className="text-muted-foreground">{t.name}</span>
                      <span className="ml-auto font-mono text-muted-foreground">{t.value}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card title="Processing Outcomes" subtitle="Knowledge-graph status of your documents">
            {!counts ? (
              <NoData>{loading ? <span role="status">Loading…</span> : "Unavailable right now."}</NoData>
            ) : (
              <>
                <div className="mt-6 h-56">
                  <ResponsiveContainer width="100%" height="100%">
                    <BarChart data={outcomes} margin={{ top: 10, right: 10, left: -18, bottom: 0 }}>
                      <CartesianGrid stroke="hsl(var(--border))" strokeOpacity={0.4} vertical={false} />
                      <XAxis dataKey="name" stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} />
                      <YAxis stroke="hsl(var(--muted-foreground))" fontSize={11} tickLine={false} axisLine={false} allowDecimals={false} />
                      <Tooltip contentStyle={tooltipStyle} cursor={{ fill: "hsl(var(--secondary))" }} />
                      <Bar dataKey="value" name="Documents" fill="hsl(var(--primary))" radius={[6, 6, 0, 0]} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
                <ul className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-xs" data-testid="outcome-list">
                  {outcomes.map((o) => (
                    <li key={o.key} className="flex items-center gap-2">
                      <span className="text-muted-foreground">{o.name}</span>
                      <span className="ml-auto font-mono text-muted-foreground">{o.value}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </Card>

          <Card className="lg:col-span-2" title="Most Entities Extracted" subtitle="Top 5 processed documents · counted per document">
            {waiting ? (
              <NoData><span role="status">Loading…</span></NoData>
            ) : documents.error ? (
              <NoData>Unavailable until documents load.</NoData>
            ) : topDocs.length === 0 ? (
              <NoData>No processed document has produced entities yet.</NoData>
            ) : (
              <>
                <ul className="mt-4 space-y-3" data-testid="top-docs">
                  {topDocs.map((d) => (
                    <li key={d.id}>
                      <div className="flex items-center justify-between gap-4 text-sm">
                        <span className="font-medium truncate" title={d.name}>{d.name}</span>
                        <span className="font-mono text-xs text-muted-foreground shrink-0">{d.entities} entities · {d.relationships} relationships</span>
                      </div>
                      <div className="mt-1.5 h-2 rounded-full bg-secondary overflow-hidden">
                        <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${(d.entities / topMax) * 100}%` }} />
                      </div>
                    </li>
                  ))}
                </ul>
                <p className="mt-4 text-[11px] font-mono text-muted-foreground">
                  An entity mentioned in several documents is counted in each one, so these numbers do not add up to the graph total.
                </p>
              </>
            )}
          </Card>
        </div>
      )}

      <div className="rounded-2xl border border-dashed border-border bg-card/40 p-6" data-testid="not-tracked">
        <div className="flex items-center gap-2">
          <Info className="h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
          <h2 className="text-lg font-semibold tracking-tight">Not tracked yet</h2>
        </div>
        <p className="mt-1 text-sm text-muted-foreground">
          MemHub does not store the data needed for these metrics, so they are not shown rather than estimated.
        </p>
        <ul className="mt-3 list-disc pl-5 space-y-1 text-sm text-muted-foreground marker:text-muted-foreground">
          {notTracked.map((t) => <li key={t}>{t}</li>)}
        </ul>
      </div>
    </div>
  );
}
