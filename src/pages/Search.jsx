import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { Search, Sparkles, KeyRound, AlertCircle, SearchX } from "lucide-react";
import { api } from "@/api";
import { useAuth } from "@/contexts/AuthContext";

// Category filters are NOT functional: POST /api/search only accepts { query, limit } and documents have no
// category/tag/type column. They stay visible but disabled (like the other "later phase" controls in the app)
// instead of pretending to filter. "All" is the only real scope.
const filters = ["All", "Technical Docs", "Meetings", "Projects"];

const MAX_QUERY_LENGTH = 1000; // same limit as the backend
const RESULT_LIMIT = 5; // sent as "limit" (the backend accepts 1-20)
// The message api.js throws once a 401 could not be fixed by refreshing the token (pinned by api.test.js).
const SESSION_EXPIRED = "Your session has expired. Please log in again.";

const IDLE = { status: "idle", query: "", results: [], error: "", expired: false };

// File type label shown above the title, derived from the real document name (e.g. "report.pdf" -> "PDF").
function fileType(name) {
  const ext = String(name || "").includes(".") ? String(name).split(".").pop() : "";
  return (ext || "DOC").toUpperCase().slice(0, 4);
}

// score = 1 - cosine distance, so 1 is a perfect match. Shown as a whole percentage (never below 0).
function relevance(score) {
  if (typeof score !== "number" || !Number.isFinite(score)) return null;
  return Math.max(0, Math.min(100, Math.round(score * 100)));
}

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const auth = useAuth();

  // The URL (?q=) is the single source of truth for WHICH search is shown.
  const urlQuery = (params.get("q") || "").slice(0, MAX_QUERY_LENGTH);
  const query = urlQuery.trim();

  const [input, setInput] = useState(urlQuery);
  const [view, setView] = useState(IDLE);

  const requestId = useRef(0); // lets a late answer to an OLD search be ignored
  const inFlight = useRef(null); // the query currently being sent, so the same search is never sent twice

  const run = useCallback(async (q) => {
    if (inFlight.current === q) return; // identical search already running (double Enter, StrictMode, ...)
    const id = ++requestId.current;
    inFlight.current = q;
    setView({ status: "loading", query: q, results: [], error: "", expired: false });
    try {
      // Only the query and limit are sent. The server takes the company from the login token.
      const data = await api("/api/search", { method: "POST", body: JSON.stringify({ query: q, limit: RESULT_LIMIT }) });
      if (id !== requestId.current) return; // a newer search replaced this one
      if (!Array.isArray(data?.results)) throw new Error("The search service returned an unexpected response.");
      setView({ status: "success", query: q, results: data.results, error: "", expired: false });
    } catch (err) {
      if (id !== requestId.current) return;
      const message = err?.message || "Something went wrong";
      setView({ status: "error", query: q, results: [], error: message, expired: message === SESSION_EXPIRED });
    } finally {
      if (id === requestId.current) inFlight.current = null;
    }
  }, []);

  // Runs on first load (/app/search?q=...), when the URL changes (submit, back/forward, the top-bar search box).
  useEffect(() => {
    setInput(urlQuery);
    if (!query) {
      requestId.current++; // drop any search still running
      inFlight.current = null;
      setView(IDLE);
      return;
    }
    run(query);
  }, [urlQuery, query, run]);

  const submit = (e) => {
    e.preventDefault();
    const next = input.trim();
    if (!next) return;
    // Same query as the URL: the URL will not change, so search directly (e.g. to see a newly uploaded document).
    // A different query goes through the URL so back/forward and shared links work.
    if (next === query) run(next);
    else setParams({ q: next });
  };

  // The session cannot be recovered here (refresh failed): drop the stored login and go to the login page.
  const logInAgain = () => {
    auth?.logout?.();
    navigate("/login", { replace: true });
  };

  const { status, results } = view;

  return (
    <div className="p-6 md:p-8 max-w-[1200px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">Search your company's documents by meaning.</p>
      </div>

      <form onSubmit={submit} className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          maxLength={MAX_QUERY_LENGTH}
          aria-label="Search"
          placeholder="Search your company's memory…"
          className="w-full h-14 pl-11 pr-44 text-base rounded-2xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-lg border border-border bg-secondary/50 p-1">
          <button
            type="button"
            disabled
            title="Keyword search is not available yet: MemHub currently searches by meaning only"
            className="px-3 py-1.5 text-xs font-mono rounded-md flex items-center gap-1 text-muted-foreground opacity-50 cursor-not-allowed"
          >
            <KeyRound className="h-3 w-3" /> Keyword
          </button>
          <button
            type="button"
            aria-pressed="true"
            title="Searching by meaning (vector search over your indexed documents)"
            className="px-3 py-1.5 text-xs font-mono rounded-md flex items-center gap-1 bg-primary/10 text-primary cursor-default"
          >
            <Sparkles className="h-3 w-3" /> Semantic
          </button>
        </div>
      </form>

      <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-sm w-fit overflow-x-auto no-scrollbar">
        {filters.map((f) =>
          f === "All" ? (
            <button
              key={f}
              type="button"
              aria-pressed="true"
              className="px-3 py-1.5 rounded-md text-xs whitespace-nowrap bg-secondary text-foreground cursor-default"
            >
              {f}
            </button>
          ) : (
            <button
              key={f}
              type="button"
              disabled
              title="Category filters are coming in a later phase: the search API cannot filter yet"
              className="px-3 py-1.5 rounded-md text-xs whitespace-nowrap text-muted-foreground opacity-50 cursor-not-allowed"
            >
              {f}
            </button>
          )
        )}
      </div>

      <div className="space-y-3" aria-busy={status === "loading"}>
        {status === "idle" && (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground font-mono">
            Type a question or topic and press Enter to search your uploaded documents.
          </div>
        )}

        {status === "loading" && (
          <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground" role="status">
            <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" /> Searching your documents…
          </div>
        )}

        {status === "error" && (
          <div role="alert" className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
            <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
            <div>
              <span>{view.error}</span>
              <div className="mt-3 flex items-center gap-2">
                <button type="button" onClick={() => run(view.query)} className="h-8 px-3 rounded-md border border-border text-xs text-foreground hover:bg-secondary">
                  Try again
                </button>
                {view.expired && (
                  <button type="button" onClick={logInAgain} className="h-8 px-3 rounded-md bg-primary text-primary-foreground text-xs hover:bg-primary/90">
                    Log in again
                  </button>
                )}
              </div>
            </div>
          </div>
        )}

        {status === "success" && results.length > 0 && (
          <>
            <p className="text-xs font-mono text-muted-foreground" role="status">
              {results.length} {results.length === 1 ? "result" : "results"} for “{view.query}” · semantic search
            </p>
            {results.map((r) => {
              const pct = relevance(r.score);
              const range = r.startChar != null && r.endChar != null ? ` · chars ${r.startChar}–${r.endChar}` : "";
              return (
                <article key={`${r.documentId}:${r.chunkIndex}`} data-document-id={r.documentId} className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 transition-colors">
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{fileType(r.documentName)}</p>
                      <h3 className="mt-1 text-lg font-semibold tracking-tight break-words">{r.documentName}</h3>
                    </div>
                    <div className="shrink-0 flex flex-col items-end">
                      <span className="font-mono text-[10px] text-muted-foreground">RELEVANCE</span>
                      <span
                        title={typeof r.score === "number" ? `Cosine similarity ${r.score.toFixed(3)}` : undefined}
                        className="mt-1 rounded-md bg-primary/10 border border-primary/20 text-primary font-mono text-xs px-2 py-0.5"
                      >
                        {pct === null ? "—" : `${pct}%`}
                      </span>
                    </div>
                  </div>
                  <p className="mt-2 text-sm text-muted-foreground leading-relaxed whitespace-pre-line break-words">{r.text}</p>
                  <div className="mt-4 flex items-center justify-between gap-4">
                    <span className="inline-flex shrink-0 items-center text-[10px] font-mono px-2 py-0.5 rounded-md bg-secondary/60 border border-border text-muted-foreground">
                      chunk {Number(r.chunkIndex) + 1}{range}
                    </span>
                    <p className="text-[11px] font-mono text-muted-foreground truncate" title={r.documentId}>
                      ID {r.documentId}
                    </p>
                  </div>
                </article>
              );
            })}
          </>
        )}

        {status === "success" && results.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground font-mono">
            <SearchX className="mx-auto mb-3 h-5 w-5" strokeWidth={1.75} />
            No results for “{view.query}”. Search only covers documents that are uploaded and indexed: check the Documents page.
          </div>
        )}
      </div>
    </div>
  );
}