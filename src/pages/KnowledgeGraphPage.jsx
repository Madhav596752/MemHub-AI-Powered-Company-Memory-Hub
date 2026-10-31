import { useCallback, useEffect, useMemo, useState } from "react";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import { api } from "@/api";
import { layoutGraph } from "@/utils/graphLayout";
import { AlertCircle, Loader2, Network, Search, X } from "lucide-react";

const GRAPH_LIMIT = 80;
const NO_EXTRA = { nodes: [], edges: [] };

// Why is the graph empty? Uses /api/graph/status so the message is true, not a guess.
function emptyMessage(enabled, status, filtered) {
  if (!enabled) return { title: "The knowledge graph is not enabled", body: "An administrator must configure Neo4j and the NLP service on the server. Until then, documents are still searchable and can be asked about." };
  if (filtered) return { title: "No entities in this document", body: "This document has not been processed yet, or no people, projects, technologies or other entities were recognised in it." };
  const d = status?.documents;
  if (d && d.total === 0) return { title: "No documents yet", body: "Upload a document and its entities and relationships will appear here." };
  if (d && d.processed === 0 && d.failed + d.skipped > 0) return { title: "No document has been processed yet", body: `${d.failed} failed and ${d.skipped} were skipped. Check that the NLP service is running, then reprocess them.` };
  if (d && d.processed === 0) return { title: "Your documents have not been processed yet", body: "Documents uploaded before the knowledge graph was enabled need to be reprocessed once." };
  return { title: "No entities found", body: "Your documents were processed, but no people, projects, technologies or other entities were recognised in them." };
}

const edgeId = (source, type, target) => `${source}|${type}|${target}`;

export default function KnowledgeGraphPage() {
  const [state, setState] = useState({ phase: "loading", error: "", enabled: true, graph: null, status: null });
  // /app/graph?documentId=<id> (linked from the Knowledge Base) opens the graph filtered to that document.
  // The backend validates the id against the user's own company, so nothing here is trusted.
  const [docFilter, setDocFilter] = useState(() => new URLSearchParams(window.location.search).get("documentId") || "");
  const [selectedId, setSelectedId] = useState(null);
  const [detail, setDetail] = useState({ phase: "idle", data: null, error: "" });
  const [nodeSearch, setNodeSearch] = useState("");
  // Real entities/edges the user pulled in with "Show neighbours" (taken from the API, never invented).
  const [extra, setExtra] = useState(NO_EXTRA);

  const load = useCallback(async (documentId = "") => {
    setState((s) => ({ ...s, phase: "loading", error: "" }));
    setExtra(NO_EXTRA);
    try {
      const data = await api(`/api/graph?limit=${GRAPH_LIMIT}${documentId ? `&documentId=${encodeURIComponent(documentId)}` : ""}`);
      let status = null;
      if (!data.enabled || data.nodes.length === 0) {
        status = await api("/api/graph/status").catch(() => null); // only to explain an empty graph
      }
      setState({ phase: data.nodes.length ? "ready" : "empty", error: "", enabled: data.enabled, graph: data, status });
      setSelectedId((cur) => (data.nodes.some((n) => n.id === cur) ? cur : data.nodes[0]?.id ?? null));
    } catch (err) {
      setState((s) => ({ ...s, phase: "error", error: err.message || "Could not load the knowledge graph." }));
    }
  }, []);

  useEffect(() => { load(docFilter); }, [load, docFilter]);

  // API graph + the neighbours the user expanded. Duplicates are dropped; the API's own entries win.
  const merged = useMemo(() => {
    if (!state.graph) return { nodes: [], edges: [] };
    const nodes = new Map(state.graph.nodes.map((n) => [n.id, n]));
    for (const n of extra.nodes) if (!nodes.has(n.id)) nodes.set(n.id, n);
    const edges = new Map(state.graph.edges.map((e) => [e.id || edgeId(e.source, e.type, e.target), e]));
    for (const e of extra.edges) if (!edges.has(e.id)) edges.set(e.id, e);
    return { nodes: [...nodes.values()], edges: [...edges.values()] };
  }, [state.graph, extra]);

  const laidOut = useMemo(() => layoutGraph(merged.nodes, merged.edges), [merged]);
  const nodeById = useMemo(() => new Map(laidOut.nodes.map((n) => [n.id, n])), [laidOut]);
  const selected = nodeById.get(selectedId) || null;

  // Evidence and relationships of the selected node come from the backend (real text + real documents).
  useEffect(() => {
    if (!selectedId) { setDetail({ phase: "idle", data: null, error: "" }); return undefined; }
    let cancelled = false;
    setDetail({ phase: "loading", data: null, error: "" });
    api(`/api/graph/nodes/${encodeURIComponent(selectedId)}`)
      .then((data) => { if (!cancelled) setDetail({ phase: "ready", data, error: "" }); })
      .catch((err) => { if (!cancelled) setDetail({ phase: "error", data: null, error: err.message }); });
    return () => { cancelled = true; };
  }, [selectedId]);

  const filtered = nodeSearch ? laidOut.nodes.filter((n) => n.label.toLowerCase().includes(nodeSearch.toLowerCase())).slice(0, 30) : [];
  const select = (n) => setSelectedId(n.id);

  // Adds the selected entity's related entities (and the edges to them) to the picture.
  // Everything added comes from /api/graph/nodes/:id; `only` limits it to one neighbour.
  const showNeighbours = (only) => {
    if (detail.phase !== "ready") return;
    const me = detail.data.node;
    const nodes = [];
    const edges = [];
    for (const r of detail.data.relationships) {
      if (only && r.other.id !== only) continue;
      nodes.push({ id: r.other.id, label: r.other.label, type: r.other.type, documentCount: 1, mentionCount: 1 });
      const [source, target] = r.direction === "out" ? [me.id, r.other.id] : [r.other.id, me.id];
      edges.push({ id: edgeId(source, r.type, target), source, target, type: r.type, confidence: r.confidence, supportCount: 1 });
    }
    setExtra((cur) => ({ nodes: [...cur.nodes, ...nodes], edges: [...cur.edges, ...edges] }));
  };
  const openNeighbour = (r) => {
    if (!nodeById.has(r.other.id)) showNeighbours(r.other.id);
    setSelectedId(r.other.id);
  };

  const rels = detail.phase === "ready" ? detail.data.relationships : [];
  const hiddenNeighbours = rels.filter((r) => !nodeById.has(r.other.id)).length;
  const connectedShown = laidOut.nodes.filter((n) => !n.isolated).length;
  const docs = state.graph?.documents || [];

  return (
    <div className="p-6 md:p-8 max-w-[1600px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Knowledge Graph</h1>
        <p className="mt-1 text-sm text-muted-foreground">Explore relationships between your organization's knowledge.</p>
      </div>

      {state.phase === "loading" && (
        <div role="status" className="rounded-2xl border border-border bg-card p-10 flex items-center justify-center gap-3 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin" /> Loading knowledge graph…
        </div>
      )}

      {state.phase === "error" && (
        <div role="alert" className="rounded-2xl border border-destructive/30 bg-destructive/5 p-6 flex items-start gap-3">
          <AlertCircle className="h-5 w-5 text-destructive shrink-0 mt-0.5" />
          <div className="flex-1">
            <p className="text-sm font-medium">The knowledge graph could not be loaded</p>
            <p className="mt-1 text-sm text-muted-foreground">{state.error}</p>
            <button onClick={() => load(docFilter)} className="mt-3 h-8 px-3 rounded-md border border-border text-xs hover:bg-secondary">Try again</button>
            {docFilter && <button onClick={() => setDocFilter("")} className="mt-3 ml-2 h-8 px-3 rounded-md border border-border text-xs hover:bg-secondary">Show all documents</button>}
          </div>
        </div>
      )}

      {state.phase === "empty" && (() => {
        const m = emptyMessage(state.enabled, state.status, Boolean(docFilter));
        return (
          <div className="rounded-2xl border border-border bg-card p-10 text-center">
            <Network className="mx-auto h-8 w-8 text-muted-foreground" strokeWidth={1.5} />
            <p className="mt-3 text-base font-medium">{m.title}</p>
            <p className="mt-1 text-sm text-muted-foreground max-w-md mx-auto">{m.body}</p>
            {docFilter && <button onClick={() => setDocFilter("")} className="mt-4 h-8 px-3 rounded-md border border-border text-xs hover:bg-secondary">Show all documents</button>}
          </div>
        );
      })()}

      {state.phase === "ready" && (
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
          <div className="lg:col-span-3">
            <div className="mb-3 flex flex-wrap items-center gap-3">
              <div className="relative max-w-sm flex-1 min-w-[220px]">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                <input
                  value={nodeSearch}
                  onChange={(e) => setNodeSearch(e.target.value)}
                  placeholder="Search nodes…"
                  aria-label="Search nodes"
                  className="w-full h-10 pl-9 pr-9 text-sm rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40"
                />
                {nodeSearch && (
                  <button onClick={() => setNodeSearch("")} aria-label="Clear search" className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground">
                    <X className="h-3.5 w-3.5" />
                  </button>
                )}
                {nodeSearch && filtered.length > 0 && (
                  <div className="absolute z-20 top-full mt-1 w-full rounded-lg border border-border bg-card shadow-lg max-h-56 overflow-y-auto">
                    {filtered.map((n) => (
                      <button key={n.id} onClick={() => { select(n); setNodeSearch(""); }} className="w-full text-left px-3 py-2 text-sm hover:bg-secondary flex items-center justify-between">
                        <span>{n.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{n.entityType}</span>
                      </button>
                    ))}
                  </div>
                )}
              </div>
              {docs.length > 0 && (
                <select
                  value={docFilter}
                  onChange={(e) => { setDocFilter(e.target.value); setSelectedId(null); }}
                  aria-label="Filter by document"
                  className="h-10 max-w-[240px] rounded-lg bg-card border border-border px-3 text-sm focus:outline-none focus:ring-2 focus:ring-primary/40"
                >
                  <option value="">All documents</option>
                  {docs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                </select>
              )}
              <p className="text-xs font-mono text-muted-foreground">
                {state.graph.truncated
                  ? `Showing the ${state.graph.nodes.length} most connected of ${state.graph.stats.entities} entities · ${state.graph.stats.relationships} relationships`
                  : `${state.graph.stats.entities} entities · ${state.graph.stats.relationships} relationships`}
              </p>
            </div>

            {laidOut.edges.length === 0 && (
              <div role="note" className="mb-3 rounded-lg border border-border bg-card px-4 py-3 text-xs text-muted-foreground flex items-start gap-2">
                <AlertCircle className="h-4 w-4 shrink-0 mt-px" />
                <span>
                  Entities were found, but no relationships between them have been extracted{docFilter ? " from this document" : " yet"}. Relationships only appear when a sentence states them
                  (for example “Priya works on Project Apollo”). Documents processed before this was improved can be reprocessed to pick up more.
                </span>
              </div>
            )}

            <KnowledgeGraph data={laidOut} selectedId={selectedId} onSelect={select} onClear={() => setSelectedId(null)} />
            {laidOut.edges.length > 0 && (
              <p className="mt-2 text-xs font-mono text-muted-foreground">
                {connectedShown} of {laidOut.nodes.length} shown have relationships; the dashed dots on the outer ring have none.
              </p>
            )}
          </div>

          <aside className="rounded-2xl border border-border bg-card p-5 h-fit lg:sticky lg:top-20 max-h-[calc(100vh-6rem)] overflow-y-auto">
            <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Selected Knowledge</p>
            {selected ? (
              <>
                <h3 className="mt-2 text-lg font-semibold tracking-tight break-words">{selected.label}</h3>
                <div className="mt-3 flex flex-wrap gap-2">
                  <span className="inline-flex items-center rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 font-mono text-[10px] text-primary uppercase tracking-[0.14em]">{selected.entityType}</span>
                  {(() => {
                    const count = detail.phase === "ready" ? detail.data.node.documentCount : selected.documentCount;
                    return count ? (
                      <span className="inline-flex items-center rounded-md border border-border px-2 py-0.5 font-mono text-[10px] text-muted-foreground">
                        {count} {count === 1 ? "document" : "documents"}
                      </span>
                    ) : null;
                  })()}
                </div>

                {detail.phase === "loading" && <p className="mt-6 text-xs text-muted-foreground font-mono flex items-center gap-2"><Loader2 className="h-3 w-3 animate-spin" /> Loading details…</p>}
                {detail.phase === "error" && <p role="alert" className="mt-6 text-xs text-destructive">{detail.error}</p>}

                {detail.phase === "ready" && (
                  <div className="mt-6">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
                        Connected entities{rels.length > 0 ? ` (${new Set(rels.map((r) => r.other.id)).size})` : ""}
                      </p>
                      {hiddenNeighbours > 0 && (
                        <button onClick={() => showNeighbours()} className="text-[11px] font-mono text-primary hover:underline">Show in graph</button>
                      )}
                    </div>
                    <ul className="mt-2 space-y-2">
                      {rels.map((r, i) => (
                        <li key={`${r.other.id}-${r.type}-${r.documentId}-${r.chunkIndex}-${i}`} className="rounded-lg bg-background/60 border border-border p-3">
                          <button onClick={() => openNeighbour(r)} className="w-full text-left text-sm flex items-center justify-between gap-2">
                            <span className="truncate">{r.direction === "out" ? "→" : "←"} {r.other.label}</span>
                            <span className="font-mono text-[10px] text-muted-foreground shrink-0">{r.type}</span>
                          </button>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground">
                            {r.direction === "out" ? `${selected.label} ${r.type.toLowerCase().replaceAll("_", " ")} ${r.other.label}` : `${r.other.label} ${r.type.toLowerCase().replaceAll("_", " ")} ${selected.label}`}
                          </p>
                          <p className="mt-1.5 text-xs text-muted-foreground leading-relaxed">“{r.evidence}”</p>
                          <p className="mt-1 font-mono text-[10px] text-muted-foreground truncate">{r.documentName} · chunk {r.chunkIndex + 1}</p>
                        </li>
                      ))}
                      {rels.length === 0 && (
                        <li className="text-xs text-muted-foreground leading-relaxed">
                          <span className="font-mono">No relationships extracted.</span>{" "}
                          This entity is mentioned
                          {detail.data.mentions.length > 0 ? ` in ${new Set(detail.data.mentions.map((m) => m.documentId)).size} document(s)` : ""}
                          {" "}but no sentence connected it to another entity, so nothing is drawn for it.
                        </li>
                      )}
                    </ul>
                    {detail.data.mentions.length > 0 && (
                      <>
                        <p className="mt-5 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Mentioned in</p>
                        <ul className="mt-2 space-y-1">
                          {[...new Map(detail.data.mentions.map((m) => [m.documentId, m])).values()].map((m) => (
                            <li key={m.documentId} className="font-mono text-[10px] text-muted-foreground truncate">{m.documentName}</li>
                          ))}
                        </ul>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <p className="mt-3 text-sm text-muted-foreground">Click a node to see details.</p>
            )}
          </aside>
        </div>
      )}
    </div>
  );
}
