import { useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Search, Sparkles, KeyRound } from "lucide-react";
import { searchResults } from "@/data/mockData";

const filters = ["All", "Technical Docs", "Meetings", "Projects"];

export default function SearchPage() {
  const [params, setParams] = useSearchParams();
  const [q, setQ] = useState(params.get("q") || "authentication");
  const [filter, setFilter] = useState("All");
  const [mode, setMode] = useState("semantic");

  const results = useMemo(() => {
    let arr = searchResults;
    if (filter !== "All") arr = arr.filter((r) => r.type === filter);
    if (q) arr = arr.filter((r) => (r.title + r.snippet + r.tags.join(" ")).toLowerCase().includes(q.toLowerCase()));
    return arr;
  }, [q, filter]);

  return (
    <div className="p-6 md:p-8 max-w-[1200px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Search</h1>
        <p className="mt-1 text-sm text-muted-foreground">Search your company's memory — by meaning or by keyword.</p>
      </div>

      <form onSubmit={(e) => { e.preventDefault(); setParams({ q }); }} className="relative">
        <Search className="absolute left-4 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search your company's memory…"
          className="w-full h-14 pl-11 pr-32 text-base rounded-2xl bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
        />
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1 rounded-lg border border-border bg-secondary/50 p-1">
          <button
            type="button"
            onClick={() => setMode("keyword")}
            className={`px-3 py-1.5 text-xs font-mono rounded-md flex items-center gap-1 ${mode === "keyword" ? "bg-card text-foreground" : "text-muted-foreground"}`}
          >
            <KeyRound className="h-3 w-3" /> Keyword
          </button>
          <button
            type="button"
            onClick={() => setMode("semantic")}
            className={`px-3 py-1.5 text-xs font-mono rounded-md flex items-center gap-1 ${mode === "semantic" ? "bg-card text-primary" : "text-muted-foreground"}`}
          >
            <Sparkles className="h-3 w-3" /> Semantic
          </button>
        </div>
      </form>

      <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-sm w-fit overflow-x-auto no-scrollbar">
        {filters.map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${
              filter === f ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
            }`}
          >
            {f}
          </button>
        ))}
      </div>

      <div className="space-y-3">
        <p className="text-xs font-mono text-muted-foreground">{results.length} results · {mode === "semantic" ? "Semantic" : "Keyword"} search</p>
        {results.map((r) => (
          <article key={r.id} className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 transition-colors">
            <div className="flex items-start justify-between gap-4">
              <div className="min-w-0">
                <p className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{r.type}</p>
                <h3 className="mt-1 text-lg font-semibold tracking-tight">{r.title}</h3>
              </div>
              <div className="shrink-0 flex flex-col items-end">
                <span className="font-mono text-[10px] text-muted-foreground">RELEVANCE</span>
                <span className="mt-1 rounded-md bg-primary/10 border border-primary/20 text-primary font-mono text-xs px-2 py-0.5">
                  {r.relevance}%
                </span>
              </div>
            </div>
            <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{r.snippet}</p>
            <div className="mt-4 flex items-center justify-between">
              <div className="flex flex-wrap gap-1.5">
                {r.tags.map((t) => (
                  <span key={t} className="inline-flex items-center text-[10px] font-mono px-2 py-0.5 rounded-md bg-secondary/60 border border-border text-muted-foreground">
                    {t}
                  </span>
                ))}
              </div>
              <p className="text-[11px] font-mono text-muted-foreground truncate">{r.source}</p>
            </div>
          </article>
        ))}
        {results.length === 0 && (
          <div className="rounded-2xl border border-dashed border-border p-12 text-center text-sm text-muted-foreground font-mono">
            No results. Try a broader query.
          </div>
        )}
      </div>
    </div>
  );
}
