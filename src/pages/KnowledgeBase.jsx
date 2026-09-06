import { useMemo, useState } from "react";
import { Search, Eye, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/EmptyState";
import { knowledgeItems, knowledgeTypes } from "@/data/mockData";

const sortOptions = ["Recently Added", "Most Viewed"];

export default function KnowledgeBase() {
  const [q, setQ] = useState("");
  const [type, setType] = useState("All");
  const [sort, setSort] = useState(sortOptions[0]);

  const items = useMemo(() => {
    let arr = knowledgeItems;
    if (type !== "All") arr = arr.filter((i) => i.type === type);
    if (q) arr = arr.filter((i) => (i.title + i.description + i.tags.join(" ")).toLowerCase().includes(q.toLowerCase()));
    arr = [...arr];
    if (sort === "Most Viewed") arr.sort((a, b) => b.chunks - a.chunks);
    else arr.sort((a, b) => new Date(b.date) - new Date(a.date));
    return arr;
  }, [q, type, sort]);

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tighter">Knowledge Base</h1>
          <p className="mt-1 text-sm text-muted-foreground">All of your organization's memory, organized and searchable.</p>
        </div>
      </div>

      <div className="flex flex-col md:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
          <input
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search your organization's knowledge…"
            className="w-full h-11 pl-9 pr-3 text-sm rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40 transition-colors"
          />
        </div>
        <div className="flex items-center gap-2">
          <div className="flex items-center gap-1 rounded-lg border border-border bg-card p-1 text-sm h-11 overflow-x-auto no-scrollbar">
            {knowledgeTypes.map((t) => (
              <button
                key={t}
                onClick={() => setType(t)}
                className={`px-3 py-1.5 rounded-md text-xs whitespace-nowrap transition-colors ${
                  type === t ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"
                }`}
              >
                {t}
              </button>
            ))}
          </div>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value)}
            className="h-11 px-3 rounded-lg border border-border bg-card text-xs text-muted-foreground focus:outline-none focus:ring-2 focus:ring-primary/40"
          >
            {sortOptions.map((s) => <option key={s}>{s}</option>)}
          </select>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
        {items.map((k) => (
          <article key={k.id} className="rounded-2xl border border-border bg-card p-5 hover:border-primary/40 transition-colors flex flex-col">
            <div className="flex items-center justify-between">
              <span className="font-mono text-[10px] uppercase tracking-[0.14em] text-primary">{k.type}</span>
              <span className="font-mono text-[10px] text-muted-foreground">{k.date}</span>
            </div>
            <h3 className="mt-3 text-base font-semibold tracking-tight line-clamp-1">{k.title}</h3>
            <p className="mt-2 text-sm text-muted-foreground line-clamp-3 leading-relaxed">{k.description}</p>
            <div className="mt-4 flex flex-wrap gap-1.5">
              {k.tags.map((t) => (
                <span key={t} className="inline-flex items-center gap-1 text-[10px] font-mono px-2 py-0.5 rounded-md bg-secondary/60 border border-border text-muted-foreground">
                  <Tag className="h-2.5 w-2.5" /> {t}
                </span>
              ))}
            </div>
            <div className="mt-5 pt-4 border-t border-border flex items-center justify-between">
              <p className="text-xs text-muted-foreground font-mono">{k.author} · <span className="text-primary">{k.chunks} chunks</span></p>
              <Button variant="ghost" size="sm" className="h-8">
                <Eye className="h-3.5 w-3.5 mr-1" /> View
              </Button>
            </div>
          </article>
        ))}
        {items.length === 0 && (
          <div className="col-span-full">
            <EmptyState icon={Search} title="No knowledge matches your filters" description="Try a different type or search term." />
          </div>
        )}
      </div>
    </div>
  );
}