import { useState } from "react";

const typeStyles = {
  concept: { fill: "hsl(var(--primary))", stroke: "hsl(var(--primary))" },
  technology: { fill: "transparent", stroke: "#06B6D4" },
  document: { fill: "transparent", stroke: "#A855F7" },
  people: { fill: "transparent", stroke: "#F59E0B" },
  project: { fill: "transparent", stroke: "#10B981" },
  meeting: { fill: "transparent", stroke: "#EC4899" },
};

const typeLegend = [
  { key: "concept", label: "Concept" },
  { key: "technology", label: "Technology" },
  { key: "document", label: "Document" },
  { key: "people", label: "People" },
  { key: "project", label: "Project" },
  { key: "meeting", label: "Meeting" },
];

export default function KnowledgeGraph({ data, selectedId, onSelect }) {
  const [zoom, setZoom] = useState(1);
  const [hover, setHover] = useState(null);

  const width = 1000;
  const height = 600;

  const nodeMap = Object.fromEntries(data.nodes.map((n) => [n.id, n]));
  const neighbors = (id) =>
    new Set(
      data.edges
        .filter(([a, b]) => a === id || b === id)
        .flatMap(([a, b]) => [a, b])
    );
  const activeSet = selectedId ? neighbors(selectedId) : hover ? neighbors(hover) : null;

  return (
    <div className="relative rounded-2xl border border-border bg-card overflow-hidden">
      <div className="absolute inset-0 grid-dots opacity-30 pointer-events-none" />
      <div className="absolute top-4 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/70 glass p-1">
        <button
          onClick={() => setZoom((z) => Math.min(2, z + 0.15))}
          className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center justify-center"
          aria-label="Zoom in"
        >+</button>
        <button
          onClick={() => setZoom((z) => Math.max(0.5, z - 0.15))}
          className="h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center justify-center"
          aria-label="Zoom out"
        >−</button>
        <button
          onClick={() => setZoom(1)}
          className="h-8 px-2 text-xs font-mono rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary"
        >Reset</button>
      </div>

      <div className="absolute bottom-4 left-4 z-10 rounded-lg border border-border bg-background/70 glass px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {typeLegend.map((t) => (
          <div key={t.key} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full border-2"
              style={{
                borderColor: typeStyles[t.key].stroke,
                background: typeStyles[t.key].fill === "transparent" ? "transparent" : typeStyles[t.key].fill,
              }}
            />
            <span className="text-muted-foreground">{t.label}</span>
          </div>
        ))}
      </div>

      <svg
        viewBox={`0 0 ${width} ${height}`}
        className="w-full h-[500px] md:h-[600px]"
        style={{ transform: `scale(${zoom})`, transformOrigin: "center" }}
      >
        <defs>
          <radialGradient id="node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.35" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </radialGradient>
        </defs>

        {data.edges.map(([a, b], i) => {
          const na = nodeMap[a];
          const nb = nodeMap[b];
          if (!na || !nb) return null;
          const isActive = activeSet && activeSet.has(a) && activeSet.has(b);
          return (
            <line
              key={i}
              x1={na.x}
              y1={na.y}
              x2={nb.x}
              y2={nb.y}
              stroke={isActive ? "hsl(var(--primary))" : "currentColor"}
              className={`graph-edge ${isActive ? "text-primary" : "text-border"}`}
              strokeWidth={isActive ? 1.5 : 1}
              strokeOpacity={isActive ? 0.9 : 0.5}
              style={{ animationDelay: `${i * 20}ms` }}
            />
          );
        })}

        {data.nodes.map((n, i) => {
          const style = typeStyles[n.type] || typeStyles.concept;
          const isSelected = selectedId === n.id;
          const isDim = activeSet && !activeSet.has(n.id);
          return (
            <g
              key={n.id}
              className="graph-node"
              style={{ cursor: "pointer", opacity: isDim ? 0.3 : 1, animationDelay: `${200 + i * 30}ms` }}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onSelect && onSelect(n)}
            >
              {(n.primary || isSelected) && (
                <circle cx={n.x} cy={n.y} r={n.r + 22} fill="url(#node-glow)" />
              )}
              <circle
                cx={n.x}
                cy={n.y}
                r={n.r}
                fill={n.primary ? style.fill : style.fill}
                stroke={style.stroke}
                strokeWidth={isSelected ? 3 : n.primary ? 0 : 2}
                opacity={n.primary ? 1 : 0.95}
              />
              <text
                x={n.x}
                y={n.y + n.r + 16}
                textAnchor="middle"
                className="fill-foreground text-[11px]"
                style={{ fontFamily: "JetBrains Mono, monospace" }}
              >
                {n.label}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}