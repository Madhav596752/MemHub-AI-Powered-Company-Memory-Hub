import { useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Sparkles, ArrowRight, Upload, GitBranch, AlertTriangle, FileText, Search, Library, AlertCircle } from "lucide-react";
import StatCard from "@/components/StatCard";
import { Button } from "@/components/ui/button";
import { useAuth } from "@/contexts/AuthContext";
import { promptSuggestions } from "@/data/mockData";
import {
  useCompanyOverview,
  documentCounts,
  graphTotals,
  totalBytes,
  recentActivity,
  formatBytes,
  formatCount,
  formatRelative,
} from "@/utils/companyOverview";

const MAX_QUESTION_LENGTH = 1000; // same limit as POST /api/ask

const activityStyle = {
  upload: { Icon: Upload, cls: "bg-primary/10 border-primary/20 text-primary" },
  processed: { Icon: GitBranch, cls: "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" },
  failed: { Icon: AlertTriangle, cls: "bg-destructive/10 border-destructive/20 text-destructive" },
};

const quickLinks = [
  { to: "/app/search", label: "Search", text: "Search your company's memory", Icon: Search },
  { to: "/app/knowledge", label: "Knowledge Base", text: "Browse documents and their status", Icon: Library },
  { to: "/app/documents", label: "Documents", text: "Upload and manage files", Icon: FileText },
  { to: "/app/assistant", label: "AI Assistant", text: "Ask questions with cited sources", Icon: Sparkles },
];

const segmentCls = { processed: "bg-emerald-500", failed: "bg-destructive", skipped: "bg-amber-400", awaiting: "bg-muted-foreground/50" };

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
}

function ErrorBox({ message, onRetry }) {
  return (
    <div role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 text-destructive text-sm px-4 py-3 flex items-center justify-between gap-4">
      <span>{message}</span>
      {onRetry && <Button variant="outline" size="sm" onClick={onRetry}>Retry</Button>}
    </div>
  );
}

export default function Dashboard() {
  const navigate = useNavigate();
  const { user } = useAuth();
  const { loading, documents, status, graph, reload } = useCompanyOverview();
  const [question, setQuestion] = useState("");
  const inputRef = useRef(null);

  // The Dashboard does not call /api/ask itself: it hands the question to the AI Assistant page,
  // which submits it through the existing authenticated API and renders the answer and citations.
  function askAssistant(e) {
    e.preventDefault();
    const q = question.trim();
    if (!q) return;
    navigate("/app/assistant", { state: { question: q } });
  }

  const docs = documents.data || [];
  const counts = documentCounts(status, documents);
  const totals = graphTotals(graph);
  const activity = recentActivity(docs, 6);
  const recentDocs = docs.slice(0, 6); // the API returns newest first
  const showSkeleton = loading && !counts;
  const countValue = (key) => (counts ? formatCount(counts[key]) : "—");
  const noCounts = !loading && !counts;
  const graphNote = totals.available ? undefined : totals.reason || "Unavailable right now";
  const graphNotice =
    status.data && status.data.enabled === false
      ? "The knowledge graph is not configured on this server, so documents are skipped and entity totals are unavailable."
      : status.data && status.data.enabled && status.data.connected === false
        ? "The knowledge graph could not be reached just now. Entity and relationship totals may be unavailable."
        : "";

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-8">
      {/* Header */}
      <div>
        <h1 className="text-3xl md:text-4xl font-semibold tracking-tighter">
          {greeting()}, {user?.name?.split(" ")[0]} <span className="inline-block">👋</span>
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
        <form onSubmit={askAssistant} className="mt-3 flex items-center gap-2">
          <input
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            maxLength={MAX_QUESTION_LENGTH}
            aria-label="Ask MemHub a question"
            placeholder="Ask a question about your company's documents…"
            className="flex-1 min-w-0 h-12 rounded-xl bg-secondary/50 border border-border px-4 text-sm placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
          />
          <Button type="submit" disabled={!question.trim()} className="h-12 px-5 rounded-xl">
            Ask <ArrowRight className="h-4 w-4 ml-1.5" />
          </Button>
        </form>
        <p className="mt-2 text-xs text-muted-foreground font-mono">
          Answers are generated only from your organization's indexed documents, with their sources.
        </p>
        <div className="mt-4 flex flex-wrap gap-2">
          {promptSuggestions.map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => {
                setQuestion(s);
                inputRef.current?.focus();
              }}
              className="text-xs font-mono px-3 py-1.5 rounded-full border border-border bg-background/50 text-muted-foreground hover:text-foreground hover:border-primary/40 transition-colors text-left"
            >
              {s}
            </button>
          ))}
        </div>
      </div>

      {/* Request-level problems that affect the numbers below */}
      {status.error && documents.data && (
        <ErrorBox message={`Document counts could not be loaded (${status.error}). Showing a tally of the loaded documents instead.`} onRetry={reload} />
      )}
      {noCounts && <ErrorBox message={`Could not load document counts. ${status.error || documents.error}`} onRetry={reload} />}

      {/* Document stats */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Total Documents" value={countValue("total")} icon="FileText" loading={showSkeleton} />
        <StatCard label="Processed" value={countValue("processed")} icon="CheckCircle2" loading={showSkeleton} note="Added to the knowledge graph" />
        <StatCard label="Awaiting Processing" value={countValue("awaiting")} icon="Clock" loading={showSkeleton} note="No processing record yet" />
        <StatCard label="Failed" value={countValue("failed")} icon="AlertTriangle" loading={showSkeleton} note="Can be retried in the Knowledge Base" />
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard label="Entities" value={totals.available ? formatCount(totals.entities) : "—"} icon="Network" loading={loading && !graph.data && !graph.error} note={graphNote} />
        <StatCard label="Relationships" value={totals.available ? formatCount(totals.relationships) : "—"} icon="Share2" loading={loading && !graph.data && !graph.error} note={graphNote} />
        <StatCard label="Skipped" value={countValue("skipped")} icon="MinusCircle" loading={showSkeleton} note="Graph off, or no text to analyse" />
        <StatCard label="Stored Files" value={documents.data ? formatBytes(totalBytes(docs)) : "—"} icon="HardDrive" loading={loading && !documents.data && !documents.error} note={documents.data ? `${docs.length} ${docs.length === 1 ? "file" : "files"}` : undefined} />
      </div>

      {/* Quick links */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {quickLinks.map(({ to, label, text, Icon }) => (
          <Link key={to} to={to} className="group rounded-xl border border-border bg-card p-4 flex items-center gap-3 hover:border-primary/40 transition-colors">
            <span className="h-9 w-9 rounded-lg bg-secondary border border-border flex items-center justify-center text-muted-foreground group-hover:text-primary group-hover:border-primary/30 transition-colors shrink-0">
              <Icon className="h-4 w-4" strokeWidth={1.75} />
            </span>
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium tracking-tight">{label}</span>
              <span className="block text-xs text-muted-foreground truncate">{text}</span>
            </span>
            <ArrowRight className="h-3.5 w-3.5 text-muted-foreground group-hover:text-primary transition-colors shrink-0" />
          </Link>
        ))}
      </div>

      {/* Processing overview + Activity */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Processing Overview</h2>
          <p className="text-xs text-muted-foreground font-mono mt-1">Knowledge-graph status of your documents</p>

          {graphNotice && (
            <p className="mt-4 flex items-start gap-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-400">
              <AlertCircle className="h-3.5 w-3.5 mt-0.5 shrink-0" /> {graphNotice}
            </p>
          )}

          {showSkeleton ? (
            <p role="status" className="mt-6 text-center text-muted-foreground font-mono text-xs py-6">Loading dashboard…</p>
          ) : !counts ? (
            <p className="mt-6 text-center text-muted-foreground font-mono text-xs py-6">Processing status is unavailable right now.</p>
          ) : counts.total === 0 ? (
            <p className="mt-6 text-center text-muted-foreground font-mono text-xs py-6">No documents yet. Upload one to see its processing status here.</p>
          ) : (
            <>
              <div
                role="img"
                aria-label={`${counts.processed} processed, ${counts.failed} failed, ${counts.skipped} skipped, ${counts.awaiting} awaiting processing, of ${counts.total} documents`}
                className="mt-6 flex h-3 rounded-full overflow-hidden bg-secondary"
              >
                {["processed", "failed", "skipped", "awaiting"].map((k) =>
                  counts[k] > 0 ? <div key={k} className={segmentCls[k]} style={{ width: `${(counts[k] / counts.total) * 100}%` }} /> : null
                )}
              </div>
              <ul className="mt-5 grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                {[["processed", "Processed"], ["failed", "Failed"], ["skipped", "Skipped"], ["awaiting", "Awaiting"]].map(([k, name]) => (
                  <li key={k} className="flex items-center gap-2">
                    <span className={`h-2.5 w-2.5 rounded-full ${segmentCls[k]}`} />
                    <span className="text-muted-foreground">{name}</span>
                    <span className="ml-auto font-mono">{counts[k]}</span>
                  </li>
                ))}
              </ul>
              <p className="mt-5 text-[11px] font-mono text-muted-foreground leading-relaxed">
                Documents are processed while they upload and no in-progress state is stored, so a document without a
                processing record is shown as awaiting.
              </p>
            </>
          )}
        </div>

        <div className="rounded-2xl border border-border bg-card p-6">
          <h2 className="text-lg font-semibold tracking-tight">Recent Activity</h2>
          {loading && !documents.data ? (
            <p role="status" className="mt-4 text-center text-muted-foreground font-mono text-xs py-6">Loading activity…</p>
          ) : documents.error ? (
            <p className="mt-4 text-xs text-muted-foreground font-mono">Activity is unavailable because the documents could not be loaded.</p>
          ) : activity.length === 0 ? (
            <p className="mt-4 text-sm text-muted-foreground">No activity yet. Uploads and processing results will appear here.</p>
          ) : (
            <ul className="mt-4 space-y-4">
              {activity.map((a) => {
                const { Icon, cls } = activityStyle[a.kind];
                return (
                  <li key={a.id} data-activity={a.kind} className="flex items-start gap-3">
                    <span className={`h-8 w-8 rounded-lg border flex items-center justify-center shrink-0 ${cls}`}>
                      <Icon className="h-4 w-4" strokeWidth={1.75} />
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm truncate" title={a.title}>{a.title}</p>
                      <p className="text-xs text-muted-foreground font-mono mt-0.5">{a.detail} · {formatRelative(a.at)}</p>
                    </div>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      </div>

      {/* Recently added */}
      <div className="rounded-2xl border border-border bg-card p-6">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold tracking-tight">Recently Added Knowledge</h2>
          <Button variant="ghost" size="sm" onClick={() => navigate("/app/documents")}>
            View all <ArrowRight className="h-3.5 w-3.5 ml-1" />
          </Button>
        </div>
        {loading && !documents.data ? (
          <p role="status" className="mt-4 text-center text-muted-foreground font-mono text-xs py-6">Loading documents…</p>
        ) : documents.error ? (
          <div className="mt-4"><ErrorBox message={documents.error} onRetry={reload} /></div>
        ) : recentDocs.length === 0 ? (
          <div className="mt-4 rounded-xl border border-dashed border-border p-8 text-center">
            <FileText className="h-5 w-5 mx-auto text-muted-foreground" strokeWidth={1.75} />
            <p className="mt-3 text-sm font-medium">No documents yet</p>
            <p className="mt-1 text-xs text-muted-foreground">Upload your first PDF, DOCX or TXT file to see it here.</p>
            <Button variant="outline" size="sm" className="mt-4" onClick={() => navigate("/app/documents")}>
              Go to Documents
            </Button>
          </div>
        ) : (
          <div className="mt-4 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {recentDocs.map((d) => (
              <div key={d.id} className="rounded-xl border border-border bg-background/50 p-4 hover:border-primary/40 transition-colors">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{d.fileType}</p>
                <h3 className="mt-2 text-sm font-medium tracking-tight line-clamp-1" title={d.originalName}>{d.originalName}</h3>
                <p className="mt-1 text-xs text-muted-foreground">Uploaded {formatDate(d.createdAt)}</p>
                <div className="mt-3 flex items-center justify-between text-[11px] font-mono text-muted-foreground">
                  <span className="truncate">By {d.uploader?.name || "—"}</span>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
