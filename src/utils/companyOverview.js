// Shared data layer for the Dashboard and Analytics pages.
//
// Everything here is read from EXISTING, authenticated, company-scoped endpoints:
//   GET /api/documents       -> the company's documents (+ uploader + last graph-processing record)
//   GET /api/graph/status    -> server-side document counts by processing status
//   GET /api/graph?limit=1   -> entity / relationship totals of the company's graph
// The company is decided by the server from the JWT. Nothing sent from here carries a companyId.
//
// Nothing is estimated: the helpers below only count / group what the API returned.
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/api";

const MONTHS_SHOWN = 12;

const EMPTY = { data: null, error: "" };
const toPart = (promise, map) =>
  promise.then(
    (v) => ({ data: map(v), error: "" }),
    (e) => ({ data: null, error: e?.message || "Something went wrong" })
  );

// The three requests are independent: each result is applied as soon as it arrives, and one failing
// never blanks the others (so the counts do not wait for the full document list).
export function useCompanyOverview() {
  const [state, setState] = useState({ loading: true, documents: EMPTY, status: EMPTY, graph: EMPTY });
  const latest = useRef(0);

  const load = useCallback(async () => {
    const id = ++latest.current;
    const apply = (key) => (part) => {
      if (id === latest.current) setState((s) => ({ ...s, [key]: part })); // ignore stale / unmounted results
    };
    // keep the previous data on screen while reloading, but drop old error messages
    setState((s) => ({
      loading: true,
      documents: { data: s.documents.data, error: "" },
      status: { data: s.status.data, error: "" },
      graph: { data: s.graph.data, error: "" },
    }));
    await Promise.all([
      toPart(api("/api/documents"), (v) => (Array.isArray(v.documents) ? v.documents : [])).then(apply("documents")),
      toPart(api("/api/graph/status"), (v) => v).then(apply("status")),
      toPart(api("/api/graph?limit=1"), (v) => v).then(apply("graph")),
    ]);
    if (id === latest.current) setState((s) => ({ ...s, loading: false }));
  }, []);

  useEffect(() => {
    load();
    return () => {
      latest.current += 1;
    };
  }, [load]);

  return { ...state, reload: load };
}

// ---------- counts ----------

// Prefer the server's own aggregation (/api/graph/status). If only the document list loaded,
// tally it with the same rules. Returns null when neither is available (never a made-up 0).
//   awaiting = documents with no processing record. MemHub processes a document during the upload
//   request and does not store an "in progress" state, so this is the closest honest signal.
export function documentCounts(statusResult, documentsResult) {
  const s = statusResult?.data?.documents;
  if (s && Number.isFinite(s.total)) {
    return {
      total: s.total,
      processed: s.processed || 0,
      failed: s.failed || 0,
      skipped: s.skipped || 0,
      awaiting: s.notProcessed || 0,
      source: "server",
    };
  }
  const docs = documentsResult?.data;
  if (!docs) return null;
  const t = { total: docs.length, processed: 0, failed: 0, skipped: 0, awaiting: 0, source: "documents" };
  for (const d of docs) {
    const k = d.graphIngestion?.status;
    if (k === "processed") t.processed += 1;
    else if (k === "failed") t.failed += 1;
    else if (k === "skipped") t.skipped += 1;
    else t.awaiting += 1;
  }
  return t;
}

// Entity / relationship totals. `available: false` means "unknown", which the UI shows as "—", not 0.
export function graphTotals(graphResult) {
  if (graphResult?.error) return { available: false, reason: graphResult.error };
  const g = graphResult?.data;
  if (!g) return { available: false, reason: "" };
  if (g.enabled === false) return { available: false, reason: "The knowledge graph is not configured on this server." };
  return { available: true, entities: g.stats?.entities ?? 0, relationships: g.stats?.relationships ?? 0 };
}

export function totalBytes(docs) {
  return docs.reduce((sum, d) => sum + (Number.isFinite(d.fileSize) ? d.fileSize : 0), 0);
}

// ---------- groupings (Analytics) ----------

export function typeBreakdown(docs) {
  const map = new Map();
  for (const d of docs) {
    const k = d.fileType || "FILE";
    map.set(k, (map.get(k) || 0) + 1);
  }
  return [...map.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value || a.name.localeCompare(b.name));
}

// Documents that EXIST now, grouped by upload month (last 12 calendar months, empty months = 0).
// Deleted documents are gone from the database, so this is NOT a history of everything ever uploaded.
export function uploadsByMonth(docs, now = new Date()) {
  const months = [];
  for (let i = MONTHS_SHOWN - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
    months.push({ key: `${d.getFullYear()}-${d.getMonth()}`, label: d.toLocaleDateString(undefined, { month: "short", year: "2-digit" }), docs: 0 });
  }
  const index = new Map(months.map((m, i) => [m.key, i]));
  const firstStart = new Date(now.getFullYear(), now.getMonth() - (MONTHS_SHOWN - 1), 1);
  let earlier = 0;
  for (const d of docs) {
    const t = new Date(d.createdAt);
    if (Number.isNaN(t.getTime())) continue;
    const i = index.get(`${t.getFullYear()}-${t.getMonth()}`);
    if (i !== undefined) months[i].docs += 1;
    else if (t < firstStart) earlier += 1;
  }
  return { months, earlier };
}

export function processingOutcomes(counts) {
  if (!counts) return [];
  return [
    { key: "processed", name: "Processed", value: counts.processed },
    { key: "failed", name: "Failed", value: counts.failed },
    { key: "skipped", name: "Skipped", value: counts.skipped },
    { key: "awaiting", name: "Awaiting", value: counts.awaiting },
  ];
}

// Documents with the most entities extracted from them (per document, so an entity mentioned in
// two documents is counted in both; this is NOT the number of distinct entities in the graph).
export function topDocumentsByEntities(docs, limit = 5) {
  return docs
    .filter((d) => d.graphIngestion?.status === "processed" && d.graphIngestion.entityCount > 0)
    .map((d) => ({ id: d.id, name: d.originalName, entities: d.graphIngestion.entityCount, relationships: d.graphIngestion.relationshipCount }))
    .sort((a, b) => b.entities - a.entities || a.name.localeCompare(b.name))
    .slice(0, limit);
}

// ---------- activity (Dashboard) ----------

// Real events only: when a document was uploaded, and when its last graph processing finished or failed.
export function recentActivity(docs, limit = 8) {
  const events = [];
  for (const d of docs) {
    if (d.createdAt) {
      events.push({
        id: `${d.id}:upload`,
        kind: "upload",
        title: d.originalName,
        detail: d.uploader?.name ? `Uploaded by ${d.uploader.name}` : "Uploaded",
        at: d.createdAt,
      });
    }
    const g = d.graphIngestion;
    if (g?.updatedAt && g.status === "processed") {
      events.push({ id: `${d.id}:processed`, kind: "processed", title: d.originalName, detail: `Added to the knowledge graph · ${g.entityCount} entities · ${g.relationshipCount} relationships`, at: g.updatedAt });
    } else if (g?.updatedAt && g.status === "failed") {
      events.push({ id: `${d.id}:failed`, kind: "failed", title: d.originalName, detail: "Knowledge-graph processing failed", at: g.updatedAt });
    }
  }
  return events
    .filter((e) => !Number.isNaN(new Date(e.at).getTime()))
    .sort((a, b) => new Date(b.at) - new Date(a.at))
    .slice(0, limit);
}

// ---------- formatting ----------

export function formatBytes(n) {
  if (!Number.isFinite(n) || n < 0) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

export function formatRelative(iso, now = new Date()) {
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return "";
  const s = Math.max(0, Math.round((now - t) / 1000));
  if (s < 60) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return t.toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export const formatCount = (n) => (Number.isFinite(n) ? n.toLocaleString() : "—");
