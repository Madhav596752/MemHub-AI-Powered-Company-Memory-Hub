import { useState } from "react";
import KnowledgeGraph from "@/components/KnowledgeGraph";
import { graphData } from "@/data/mockData";
import { Search, X } from "lucide-react";

export default function KnowledgeGraphPage() {
  const [selected, setSelected] = useState(graphData.nodes[0]);
  const [nodeSearch, setNodeSearch] = useState("");

  const filtered = graphData.nodes.filter((n) => n.label.toLowerCase().includes(nodeSearch.toLowerCase()));
  const relatedIds = new Set(graphData.edges.filter(([a, b]) => a === selected?.id || b === selected?.id).flatMap(([a, b]) => [a, b]).filter((x) => x !== selected?.id));
  const related = graphData.nodes.filter((n) => relatedIds.has(n.id));

  return (
    <div className="p-6 md:p-8 max-w-[1600px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Knowledge Graph</h1>
        <p className="mt-1 text-sm text-muted-foreground">Explore relationships between your organization's knowledge.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-4">
        <div className="lg:col-span-3">
          <div className="mb-3 relative max-w-sm">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
            <input
              value={nodeSearch}
              onChange={(e) => setNodeSearch(e.target.value)}
              placeholder="Search nodes…"
              className="w-full h-10 pl-9 pr-9 text-sm rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40"
            />
            {nodeSearch && (
              <button onClick={() => setNodeSearch("")} className="absolute right-2 top-1/2 -translate-y-1/2 p-1 text-muted-foreground hover:text-foreground">
                <X className="h-3.5 w-3.5" />
              </button>
            )}
            {nodeSearch && filtered.length > 0 && (
              <div className="absolute z-10 top-full mt-1 w-full rounded-lg border border-border bg-card shadow-lg max-h-56 overflow-y-auto">
                {filtered.map((n) => (
                  <button key={n.id} onClick={() => { setSelected(n); setNodeSearch(""); }} className="w-full text-left px-3 py-2 text-sm hover:bg-secondary flex items-center justify-between">
                    <span>{n.label}</span>
                    <span className="font-mono text-[10px] text-muted-foreground">{n.type}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <KnowledgeGraph data={graphData} selectedId={selected?.id} onSelect={setSelected} />
        </div>

        <aside className="rounded-2xl border border-border bg-card p-5 h-fit sticky top-20">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Selected Knowledge</p>
          {selected ? (
            <>
              <h3 className="mt-2 text-lg font-semibold tracking-tight">{selected.label}</h3>
              <div className="mt-3 flex flex-wrap gap-2">
                <span className="inline-flex items-center rounded-md border border-primary/20 bg-primary/5 px-2 py-0.5 font-mono text-[10px] text-primary uppercase tracking-[0.14em]">
                  {selected.type}
                </span>
              </div>

              <div className="mt-6">
                <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Related</p>
                <ul className="mt-2 space-y-1.5">
                  {related.map((r) => (
                    <li key={r.id}>
                      <button onClick={() => setSelected(r)} className="w-full text-left rounded-lg px-3 py-2 text-sm bg-background/60 border border-border hover:border-primary/40 transition-colors flex items-center justify-between">
                        <span className="truncate">{r.label}</span>
                        <span className="font-mono text-[10px] text-muted-foreground">{r.type}</span>
                      </button>
                    </li>
                  ))}
                  {related.length === 0 && <li className="text-xs text-muted-foreground font-mono">No connections yet.</li>}
                </ul>
              </div>
            </>
          ) : (
            <p className="mt-3 text-sm text-muted-foreground">Click a node to see details.</p>
          )}
        </aside>
      </div>
    </div>
  );
}
