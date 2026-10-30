import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Eye, RefreshCw, Loader2, AlertCircle, ExternalLink, Network, X, FileText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/EmptyState";
import { api } from "@/api";
import { useAuth } from "@/contexts/AuthContext";

const sortOptions = ["Recently Added", "Oldest", "Name (A–Z)", "Most Entities"];

const statusCls = {
  processed: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  failed: "bg-red-500/10 text-red-400 border-red-500/20",
  processing: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  skipped: "bg-amber-500/10 text-amber-400 border-amber-500/20",
  uploaded: "bg-secondary/60 text-muted-foreground border-border",
  unknown: "bg-secondary/60 text-muted-foreground border-border",
};

// Messages the backend itself uses for these codes (server/src/utils/graphIngest.js).
// A code that is not listed here is shown as the raw code instead of guessing a meaning.
const ERROR_TEXT = {
  GRAPH_NOT_CONFIGURED: "The knowledge graph is not configured on the server.",
  NLP_NOT_CONFIGURED: "The NLP service is not configured on the server.",
  NO_TEXT: "This document has no text to analyse.",
  NLP_CHUNK_FAILED: "Some parts of the document could not be analysed.",
  GRAPH_PROCESSING_FAILED: "The document could not be added to the knowledge graph.",
};
const errorText = (code) => (code ? ERROR_TEXT[code] || `Error code: ${code}` : "");

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

// Maps the REAL backend data to a display state. There is no Document.status column: a document row exists
// once the file was stored and its text read. Its knowledge-graph outcome is the GraphIngestion record
// (processed | failed | skipped), or no record at all. "Processing" is only shown while a request THIS page
// started (retry) is still running, because the backend does not store an in-progress state.
export function documentStatus(doc, retrying = false) {
  if (retrying) return { key: "processing", label: "Processing", detail: "Analysing this document for the knowledge graph…" };
  const g = doc.graphIngestion;
  if (!g) return { key: "uploaded", label: "Uploaded", detail: "No knowledge-graph processing has been recorded for this document." };
  if (g.status === "processed") {
    let detail = "";
    if (g.entityCount === 0) detail = "No entities were recognised in this document.";
    else if (g.relationshipCount === 0) detail = "Entities were found, but the text states no relationships between them.";
    return { key: "processed", label: "Processed", detail };
  }
  if (g.status === "failed") {
    const kept = g.processedAt ? ` Results from the last successful run (${formatDate(g.processedAt)}) are still in the graph.` : "";
    return { key: "failed", label: "Failed", detail: `${errorText(g.errorCode) || "Processing failed."}${kept}` };
  }
  if (g.status === "skipped") return { key: "skipped", label: "Skipped", detail: errorText(g.errorCode) || "Processing was skipped." };
  return { key: "unknown", label: String(g.status), detail: "" };
}

// Retry only where the backend's reprocess endpoint can change the outcome, and only for administrators
// (the endpoint is admin-only on the server, so members are not shown a button that would be refused).
function retryAction(doc, isAdmin) {
  if (!isAdmin) return null;
  const s = documentStatus(doc);
  if (s.key === "failed") return "Retry";
  if (s.key === "skipped") return doc.graphIngestion?.errorCode === "NO_TEXT" ? null : "Retry";
  if (s.key === "uploaded") return "Process";
  return null;
}

function StatusBadge({ status }) {
  return (
    <span data-status={status.key} className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${statusCls[status.key] || statusCls.unknown}`}>
      {status.key === "processing" && <Loader2 className="h-2.5 w-2.5 animate-spin" />}
      {status.label}
    </span>
  );
}

export default function KnowledgeBase() {
  const isAdmin = Boolean(useAuth()?.isAdmin);
  const [list, setList] = useState({ phase: "loading", docs: [], error: "" });
  const [refreshing, setRefreshing] = useState(false);
  const [q, setQ] = useState("");
  const [type, setType] = useState("All");
  const [sort, setSort] = useState(sortOptions[0]);
  const [selectedId, setSelectedId] = useState(null);
  const [retrying, setRetrying] = useState({}); // documentId -> true while a reprocess request is running
  const [detailKey, setDetailKey] = useState(0); // bumped after a reprocess so the open details reload

  const load = useCallback(async ({ silent = false } = {}) => {
    if (silent) setRefreshing(true);
    else setList((l) => ({ ...l, phase: "loading", error: "" }));
    try {
      const data = await api("/api/documents");
      setList({ phase: "ready", docs: data.documents || [], error: "" });
    } catch (err) {
      setList((l) => ({ ...l, phase: "error", error: err.message || "Could not load documents." }));
    } finally {
      setRefreshing(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  async function reprocess(doc) {
    if (retrying[doc.id]) return;
    setRetrying((r) => ({ ...r, [doc.id]: true }));
    try {
      const data = await api(`/api/graph/documents/${doc.id}/reprocess`, { method: "POST" });
      const g = data.graph || {};
      if (g.status === "processed") {
        toast.success(`"${doc.originalName}" processed: ${g.entities} entities, ${g.relationships} relationships`);
      } else {
        toast.error(`"${doc.originalName}" ${g.status === "skipped" ? "was skipped" : "failed"}. ${g.message || errorText(g.code)}`.trim());
      }
    } catch (err) {
      toast.error(err.message);
    } finally {
      setRetrying((r) => {
        const next = { ...r };
        delete next[doc.id];
        return next;
      });
      await load({ silent: true }); // show what the database now says, not what we expect
      setDetailKey((k) => k + 1);
    }
  }

  const docs = list.docs;
  const types = useMemo(() => ["All", ...new Set(docs.map((d) => d.fileType))], [docs]);
  const activeType = types.includes(type) ? type : "All";

  const items = useMemo(() => {
    let arr = docs;
    if (activeType !== "All") arr = arr.filter((d) => d.fileType === activeType);
    if (q) {
      const needle = q.toLowerCase();
      arr = arr.filter((d) => `${d.originalName} ${d.uploader?.name || ""} ${d.fileType}`.toLowerCase().includes(needle));
    }
    arr = [...arr];
    if (sort === "Oldest") arr.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    else if (sort === "Name (A–Z)") arr.sort((a, b) => a.originalName.localeCompare(b.originalName));
    else if (sort === "Most Entities") {
      const n = (d) => (d.graphIngestion?.status === "processed" ? d.graphIngestion.entityCount : -1);
      arr.sort((a, b) => n(b) - n(a));
    } else arr.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    return arr;
  }, [docs, activeType, q, sort]);

  const tally = useMemo(() => {
    const t = { processed: 0, failed: 0, skipped: 0, uploaded: 0 };
    for (const d of docs) {
      const k = documentStatus(d).key;
      if (k in t) t[k] += 1;
    }
    return t;
  }, [docs]);

  const summary = [
    `${docs.length} ${docs.length === 1 ? "document" : "documents"}`,
    tally.processed && `${tally.processed} processed`,
    tally.failed && `${tally.failed} failed`,
    tally.skipped && `${tally.skipped} skipped`,
    tally.uploaded && `${tally.uploaded} not yet processed`,
  ].filter(Boolean).join(" · ");

  const selected = docs.find((d) => d.id === selectedId) || null;

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tighter">Knowledge Base</h1>
          <p className="mt-1 text-sm text-muted-foreground">All of your organization's memory, organized and searchable.</p>
        </div>
        <Button variant="outline" onClick={() => load({ silent: true })} disabled={refreshing || list.phase === "loading"} className="rounded-lg h-10" aria-label="Refresh">
          <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? "animate-spin" : ""}`} /> Refresh
        </Button>
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search documents by name or uploader…"
            aria-label="Search documents"
            className="w-full h-11 pl-9 pr-3 text-sm rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-sm h-11 overflow-x-auto no-scrollbar">
            {types.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${
                  activeType === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            aria-label="Sort documents"
            className="h-11 px-3 rounded-lg border border-border bg-card text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {sortOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      {list.phase === "loading" && (
        <div role="status" className="rounded-2xl border border-border bg-card p-10 flex items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading knowledge base…
        </div>
      )}

      {list.phase === "error" && (
        <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium">The knowledge base could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">{list.error}</p>
            <button onClick={() => load()} className="mt-3 h-8 px-3 rounded-md border border-border text-xs hover:bg-secondary">Try again</button>
          </div>
        </div>
      )}

      {list.phase === "ready" && docs.length === 0 && (
        <EmptyState
          icon={FileText}
          title="Your knowledge base is empty"
          description="Upload a document and it will appear here with its processing status, entities and relationships."
          action={<Link to="/app/documents"><Button className="rounded-lg">Go to Documents</Button></Link>}
        />
      )}

      {list.phase === "ready" && docs.length > 0 && (
        <>
          <p className="text-xs font-mono text-muted-foreground">
            {summary}
            {items.length !== docs.length ? ` · ${items.length} shown` : ""}
          </p>
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {items.map((d) => {
              const status = documentStatus(d, Boolean(retrying[d.id]));
              const action = retryAction(d, isAdmin);
              const g = d.graphIngestion;
              return (
                <article key={d.id} data-document-id={d.id} className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 transition-colors flex flex-col">
                  <div className="flex items-center justify-between">
                    <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{d.fileType}</span>
                    <span className="font-mono text-[10px] text-muted-foreground" title={new Date(d.createdAt).toLocaleString()}>{formatDate(d.createdAt)}</span>
                  </div>
                  <h3 className="mt-3 text-base font-semibold tracking-tight line-clamp-1" title={d.originalName}>{d.originalName}</h3>
                  <div className="mt-3 flex items-center gap-2">
                    <StatusBadge status={status} />
                    {status.key === "processed" && g && (
                      <span className="font-mono text-[10px] text-muted-foreground">
                        {g.entityCount} {g.entityCount === 1 ? "entity" : "entities"} · {g.relationshipCount} {g.relationshipCount === 1 ? "relationship" : "relationships"}
                      </span>
                    )}
                  </div>
                  {status.detail && <p className="mt-2 text-sm text-muted-foreground line-clamp-3 leading-relaxed">{status.detail}</p>}
                  <div className="flex-1" />
                  <div className="mt-5 pt-4 border-t border-border flex items-center justify-between gap-2">
                    <p className="text-xs text-muted-foreground font-mono truncate">{d.uploader?.name || "—"} · {formatSize(d.fileSize)}</p>
                    <div className="flex items-center gap-1 shrink-0">
                      {action && (
                        <Button variant="outline" size="sm" className="h-8" onClick={() => reprocess(d)} disabled={Boolean(retrying[d.id])} title="Run knowledge-graph processing for this document again">
                          <RefreshCw className="h-3.5 w-3.5 mr-1" /> {action}
                        </Button>
                      )}
                      <Button variant="ghost" size="sm" className="h-8" onClick={() => setSelectedId(d.id)}>
                        <Eye className="h-3.5 w-3.5 mr-1" /> View
                      </Button>
                    </div>
                  </div>
                </article>
              );
            })}
            {items.length === 0 && (
              <div className="col-span-full">
                <EmptyState icon={Search} title="No documents match your filters" description="Try a different type or search term." />
              </div>
            )}
          </div>
        </>
      )}

      {selected && (
        <DocumentDetails
          key={selected.id}
          summary={selected}
          reloadKey={detailKey}
          retrying={Boolean(retrying[selected.id])}
          isAdmin={isAdmin}
          onReprocess={() => reprocess(selected)}
          onClose={() => setSelectedId(null)}
        />
      )}
    </div>
  );
}

// Details of one document: metadata + text preview from GET /api/documents/:id, and the entities and
// relationships extracted from THIS document from GET /api/graph?documentId=:id (both company-scoped by the backend).
function DocumentDetails({ summary, reloadKey, retrying, isAdmin, onReprocess, onClose }) {
  const [doc, setDoc] = useState({ phase: "loading", data: null, error: "" });
  const [graph, setGraph] = useState({ phase: "loading", data: null, error: "" });

  useEffect(() => {
    let cancelled = false;
    setDoc((d) => ({ ...d, phase: d.data ? "ready" : "loading", error: "" }));
    setGraph((g) => ({ ...g, phase: g.data ? "ready" : "loading", error: "" }));
    api(`/api/documents/${encodeURIComponent(summary.id)}`)
      .then((r) => { if (!cancelled) setDoc({ phase: "ready", data: r.document, error: "" }); })
      .catch((err) => { if (!cancelled) setDoc({ phase: "error", data: null, error: err.message }); });
    api(`/api/graph?limit=200&documentId=${encodeURIComponent(summary.id)}`)
      .then((r) => { if (!cancelled) setGraph({ phase: "ready", data: r, error: "" }); })
      .catch((err) => { if (!cancelled) setGraph({ phase: "error", data: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [summary.id, reloadKey]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const d = doc.data || summary; // the list row already has everything except the text preview
  const status = documentStatus(d, retrying);
  const action = retryAction(d, isAdmin);
  const g = d.graphIngestion;

  const graphReady = graph.phase === "ready" && graph.data.enabled;
  const nodes = useMemo(() => (graphReady ? graph.data.nodes : []), [graphReady, graph.data]);
  const edges = graphReady ? graph.data.edges : [];
  const labelOf = useMemo(() => new Map(nodes.map((n) => [n.id, n.label])), [nodes]);
  const byType = useMemo(() => {
    const groups = new Map();
    for (const n of [...nodes].sort((a, b) => (b.degree ?? 0) - (a.degree ?? 0) || a.label.localeCompare(b.label))) {
      if (!groups.has(n.type)) groups.set(n.type, []);
      groups.get(n.type).push(n);
    }
    return [...groups.entries()];
  }, [nodes]);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label={`Details of ${d.originalName}`}
        className="w-full max-w-2xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 space-y-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <h2 className="text-lg font-semibold tracking-tight break-all">{d.originalName}</h2>
          <button type="button" onClick={onClose} className="p-1 rounded-md text-muted-foreground hover:text-foreground" title="Close" aria-label="Close">
            <X className="h-4 w-4" />
          </button>
        </div>

        <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
          <div><dt className="text-xs text-muted-foreground font-mono">Type</dt><dd>{d.fileType}</dd></div>
          <div><dt className="text-xs text-muted-foreground font-mono">Size</dt><dd>{formatSize(d.fileSize)}</dd></div>
          <div><dt className="text-xs text-muted-foreground font-mono">Uploaded by</dt><dd>{d.uploader?.name || "—"}</dd></div>
          <div><dt className="text-xs text-muted-foreground font-mono">Uploaded</dt><dd>{new Date(d.createdAt).toLocaleString()}</dd></div>
          {doc.data && <div><dt className="text-xs text-muted-foreground font-mono">Extracted text</dt><dd>{doc.data.textLength.toLocaleString()} characters</dd></div>}
          {g?.processedAt && <div><dt className="text-xs text-muted-foreground font-mono">Last processed</dt><dd>{new Date(g.processedAt).toLocaleString()}</dd></div>}
        </dl>

        <div>
          <p className="text-xs text-muted-foreground font-mono mb-1">Knowledge-graph processing</p>
          <div className="flex items-center gap-2 flex-wrap">
            <StatusBadge status={status} />
            {action && (
              <Button variant="outline" size="sm" className="h-8" onClick={onReprocess} disabled={retrying}>
                <RefreshCw className="h-3.5 w-3.5 mr-1" /> {action === "Process" ? "Process now" : "Retry processing"}
              </Button>
            )}
          </div>
          {status.detail && <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{status.detail}</p>}
        </div>

        <div>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-muted-foreground font-mono">Extracted information</p>
            {graphReady && nodes.length > 0 && (
              <Link to={`/app/graph?documentId=${encodeURIComponent(d.id)}`} className="inline-flex items-center gap-1 text-[11px] font-mono text-primary hover:underline">
                <Network className="h-3 w-3" /> Open in Knowledge Graph
              </Link>
            )}
          </div>

          {graph.phase === "loading" && <p role="status" className="mt-2 text-xs text-muted-foreground font-mono flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading entities…</p>}
          {graph.phase === "error" && <p role="alert" className="mt-2 text-xs text-destructive">{graph.error}</p>}
          {graph.phase === "ready" && !graph.data.enabled && (
            <p className="mt-2 text-sm text-muted-foreground">The knowledge graph is not enabled on the server, so entities and relationships are not available.</p>
          )}
          {graphReady && nodes.length === 0 && (
            <p className="mt-2 text-sm text-muted-foreground">No entities are stored in the knowledge graph for this document.</p>
          )}

          {nodes.length > 0 && (
            <div className="mt-2 space-y-4">
              <p className="text-xs font-mono text-muted-foreground">
                {graph.data.truncated
                  ? `Showing the ${nodes.length} most connected of ${graph.data.stats.entities} entities · ${graph.data.stats.relationships} relationships`
                  : `${graph.data.stats.entities} entities · ${graph.data.stats.relationships} relationships`}
              </p>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Entities</p>
                <div className="mt-2 space-y-3 max-h-56 overflow-y-auto pr-1">
                  {byType.map(([entityType, group]) => (
                    <div key={entityType}>
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{entityType} ({group.length})</p>
                      <ul className="mt-1.5 flex flex-wrap gap-1.5">
                        {group.map((n) => (
                          <li key={n.id} data-entity className="text-[11px] font-mono px-2 py-0.5 rounded-md bg-secondary/60 border border-border text-muted-foreground">{n.label}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>

              <div>
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Relationships</p>
                {edges.length === 0 ? (
                  <p className="mt-2 text-xs text-muted-foreground leading-relaxed">No relationships were extracted from this document. Relationships only appear when a sentence states them.</p>
                ) : (
                  <ul className="mt-2 space-y-1.5 max-h-56 overflow-y-auto pr-1">
                    {edges.map((e) => (
                      <li key={e.id || `${e.source}|${e.type}|${e.target}`} data-relationship className="rounded-lg bg-background/60 border border-border px-3 py-2 text-xs flex items-center justify-between gap-3">
                        <span className="truncate">{labelOf.get(e.source) || "Unknown"} → {labelOf.get(e.target) || "Unknown"}</span>
                        <span className="font-mono text-[10px] text-muted-foreground shrink-0">
                          {e.type}{typeof e.confidence === "number" ? ` · ${Math.round(e.confidence * 100)}%` : ""}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>

        <div>
          <p className="text-xs text-muted-foreground font-mono mb-1">Text preview</p>
          {doc.phase === "loading" && !doc.data && <p className="text-xs text-muted-foreground font-mono flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading preview…</p>}
          {doc.phase === "error" && <p role="alert" className="text-xs text-destructive">{doc.error}</p>}
          {doc.data && (
            <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary/40 p-3 text-xs max-h-60 overflow-y-auto">
              {doc.data.textPreview}
              {doc.data.textLength > doc.data.textPreview.length ? "\n…" : ""}
            </pre>
          )}
        </div>

        <div className="flex justify-end gap-2">
          <a href={d.cloudinaryUrl} target="_blank" rel="noopener noreferrer">
            <Button variant="outline" className="rounded-lg"><ExternalLink className="h-4 w-4 mr-2" /> Open file</Button>
          </a>
        </div>
      </div>
    </div>
  );
}
