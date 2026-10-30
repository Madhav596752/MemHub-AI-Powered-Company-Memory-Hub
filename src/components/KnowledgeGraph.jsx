import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { GRAPH_HEIGHT as height, GRAPH_WIDTH as width } from "@/utils/graphLayout";

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

const MIN_ZOOM = 0.6;
const MAX_ZOOM = 6;
const FONT = 11; // label size on screen, in px; divided by the zoom inside the scaled group
const CHAR_W = 6.6; // average width of one monospace character at FONT
const MAX_LABEL_CHARS = 26;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const short = (text) => (text.length > MAX_LABEL_CHARS ? `${text.slice(0, MAX_LABEL_CHARS - 1)}…` : text);
const RELATION = (type) => String(type || "").replaceAll("_", " ").toLowerCase();

// Which node labels are drawn. A label is never drawn on top of another one.
//   1. the selected / hovered node and its neighbours (what the user is looking at)
//   2. then the most connected nodes, more of them the further the user zooms in
// Everything else stays a plain dot (its name is in the tooltip, the search box and the side panel).
export function chooseLabels(nodes, { selectedId, hoverId, neighbours, zoom }) {
  const focus = selectedId || hoverId;
  const rank = (n) => {
    if (n.id === selectedId) return 0;
    if (n.id === hoverId) return 1;
    if (focus && neighbours.has(n.id)) return 2;
    return 3;
  };
  const ordered = [...nodes].sort((a, b) => rank(a) - rank(b) || b.degree - a.degree || a.label.localeCompare(b.label));
  const budget = Math.round(10 + (zoom - 1) * 45); // labels allowed beyond the focus group
  const boxes = [];
  const shown = new Set();
  let extra = 0;
  for (const n of ordered) {
    const r = rank(n);
    if (r === 3) {
      if (extra >= budget) break;
      if (n.isolated && zoom < 2.2) continue; // loose dots only get labels once the user has zoomed in
    }
    const w = (short(n.label).length * CHAR_W) / zoom;
    const h = (FONT + 3) / zoom;
    const top = n.y + n.r + 4 / zoom;
    const box = { x1: n.x - w / 2, x2: n.x + w / 2, y1: top, y2: top + h };
    const clash = boxes.some((b) => box.x1 < b.x2 && b.x1 < box.x2 && box.y1 < b.y2 && b.y1 < box.y2);
    if (clash && r > 1) continue; // selected / hovered are shown even when crowded
    boxes.push(box);
    shown.add(n.id);
    if (r === 3) extra += 1;
  }
  return shown;
}

export default function KnowledgeGraph({ data, selectedId, onSelect, onClear }) {
  const [view, setView] = useState({ k: 1, x: 0, y: 0 });
  const [hover, setHover] = useState(null);
  const [hoverEdge, setHoverEdge] = useState(null);
  const svgRef = useRef(null);
  const drag = useRef({ active: false, moved: false, sx: 0, sy: 0, vx: 0, vy: 0 });
  const viewRef = useRef(view);
  viewRef.current = view;

  const nodes = data.nodes;
  const edges = data.edges;
  const nodeMap = useMemo(() => new Map(nodes.map((n) => [n.id, n])), [nodes]);

  // neighbour sets per node, built only from the real edges
  const adjacency = useMemo(() => {
    const map = new Map(nodes.map((n) => [n.id, new Set()]));
    for (const e of edges) { map.get(e.source)?.add(e.target); map.get(e.target)?.add(e.source); }
    return map;
  }, [nodes, edges]);

  const focusId = selectedId || hover;
  const neighbours = useMemo(() => (focusId ? adjacency.get(focusId) || new Set() : new Set()), [adjacency, focusId]);
  const isInFocus = (id) => !focusId || id === focusId || neighbours.has(id);
  const touchesFocus = (e) => Boolean(focusId) && (e.source === focusId || e.target === focusId);

  const labels = useMemo(
    () => chooseLabels(nodes, { selectedId, hoverId: hover, neighbours, zoom: view.k }),
    [nodes, selectedId, hover, neighbours, view.k],
  );

  const presentGroups = useMemo(() => new Set(nodes.map((n) => n.type)), [nodes]);
  const hasIsolated = nodes.some((n) => n.isolated);

  // ---- zoom / pan -------------------------------------------------------------------------------
  const toSvg = useCallback((clientX, clientY) => {
    const svg = svgRef.current;
    const ctm = svg?.getScreenCTM?.();
    if (!svg || !ctm) return { x: width / 2, y: height / 2 };
    const p = svg.createSVGPoint();
    p.x = clientX; p.y = clientY;
    const q = p.matrixTransform(ctm.inverse());
    return { x: q.x, y: q.y };
  }, []);

  const zoomAt = useCallback((factor, px = width / 2, py = height / 2) => {
    setView((v) => {
      const k = clamp(v.k * factor, MIN_ZOOM, MAX_ZOOM);
      if (k === v.k) return v;
      const ratio = k / v.k;
      return { k, x: px - (px - v.x) * ratio, y: py - (py - v.y) * ratio };
    });
  }, []);

  // The wheel listener is attached natively: React's onWheel is passive and cannot stop the page scrolling.
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return undefined;
    const onWheel = (e) => {
      e.preventDefault();
      const p = toSvg(e.clientX, e.clientY);
      zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, p.x, p.y);
    };
    svg.addEventListener("wheel", onWheel, { passive: false });
    return () => svg.removeEventListener("wheel", onWheel);
  }, [toSvg, zoomAt]);

  const onPointerDown = (e) => {
    if (e.button !== undefined && e.button !== 0) return;
    drag.current = { active: true, moved: false, sx: e.clientX, sy: e.clientY, vx: viewRef.current.x, vy: viewRef.current.y };
    const rect = svgRef.current?.getBoundingClientRect();
    const unit = rect && rect.width ? width / Math.max(rect.width, 1) : 1; // screen px -> svg units (approx.)
    const move = (ev) => {
      const d = drag.current;
      if (!d.active) return;
      const dx = ev.clientX - d.sx;
      const dy = ev.clientY - d.sy;
      if (!d.moved && Math.hypot(dx, dy) < 4) return;
      d.moved = true;
      setView((v) => ({ ...v, x: clamp(d.vx + dx * unit, -width * 3, width * 3), y: clamp(d.vy + dy * unit, -height * 3, height * 3) }));
    };
    const up = () => {
      drag.current.active = false;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      setTimeout(() => { drag.current.moved = false; }, 0); // lets the click that follows a drag be ignored
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  };

  const reset = () => setView({ k: 1, x: 0, y: 0 });

  // When the selection changes from outside (search box, side panel), bring the node into view.
  useEffect(() => {
    const n = selectedId ? nodeMap.get(selectedId) : null;
    if (!n) return;
    setView((v) => {
      const sx = n.x * v.k + v.x;
      const sy = n.y * v.k + v.y;
      if (sx > 40 && sx < width - 40 && sy > 40 && sy < height - 40) return v;
      return { ...v, x: width / 2 - n.x * v.k, y: height / 2 - n.y * v.k };
    });
  }, [selectedId, nodeMap]);

  const btn = "h-8 w-8 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary flex items-center justify-center";
  const selectNode = (n) => { if (!drag.current.moved && onSelect) onSelect(n); };
  const activeEdges = edges.filter(touchesFocus);
  const labelledEdges = new Set(activeEdges.slice(0, 14).map((e) => e.id));
  if (hoverEdge) labelledEdges.add(hoverEdge);

  return (
    <div className="relative rounded-2xl border border-border bg-card overflow-hidden">
      <div className="absolute inset-0 grid-dots opacity-30 pointer-events-none" />
      <div className="absolute top-4 right-4 z-10 flex items-center gap-1 rounded-lg border border-border bg-background/70 glass p-1">
        <button onClick={() => zoomAt(1.25)} className={btn} aria-label="Zoom in">+</button>
        <button onClick={() => zoomAt(1 / 1.25)} className={btn} aria-label="Zoom out">−</button>
        <button onClick={reset} className="h-8 px-2 text-xs font-mono rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary" aria-label="Reset view">Reset</button>
      </div>

      <div className="absolute bottom-4 left-4 z-10 max-w-[calc(100%-2rem)] rounded-lg border border-border bg-background/70 glass px-3 py-2 flex flex-wrap gap-x-4 gap-y-1 text-xs">
        {typeLegend.filter((t) => presentGroups.has(t.key)).map((t) => (
          <div key={t.key} className="flex items-center gap-1.5">
            <span
              className="h-2.5 w-2.5 rounded-full border-2"
              style={{ borderColor: typeStyles[t.key].stroke, background: typeStyles[t.key].fill === "transparent" ? "transparent" : typeStyles[t.key].fill }}
            />
            <span className="text-muted-foreground">{t.label}</span>
          </div>
        ))}
        {hasIsolated && (
          <div className="flex items-center gap-1.5">
            <span className="h-2.5 w-2.5 rounded-full border border-dashed border-muted-foreground" />
            <span className="text-muted-foreground">No relationships</span>
          </div>
        )}
      </div>

      <p className="absolute top-4 left-4 z-10 hidden md:block text-[10px] font-mono text-muted-foreground pointer-events-none">
        scroll to zoom · drag to pan · click a node
      </p>

      <svg
        ref={svgRef}
        viewBox={`0 0 ${width} ${height}`}
        className="relative w-full h-[500px] md:h-[600px] select-none"
        style={{ touchAction: "none", cursor: "grab" }}
        onPointerDown={onPointerDown}
        onClick={(e) => { if (e.target === e.currentTarget && !drag.current.moved && onClear) onClear(); }}
        role="img"
        aria-label={`Knowledge graph with ${nodes.length} entities and ${edges.length} relationships`}
      >
        <defs>
          <radialGradient id="node-glow" cx="50%" cy="50%" r="50%">
            <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity="0.35" />
            <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity="0" />
          </radialGradient>
          <marker id="kg-arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M0,0 L10,5 L0,10 z" fill="hsl(var(--primary))" />
          </marker>
        </defs>

        <rect x="-5000" y="-5000" width="10000" height="10000" fill="transparent" onClick={() => { if (!drag.current.moved && onClear) onClear(); }} />

        <g transform={`translate(${view.x} ${view.y}) scale(${view.k})`}>
          {edges.map((e, i) => {
            const na = nodeMap.get(e.source);
            const nb = nodeMap.get(e.target);
            if (!na || !nb) return null;
            const active = touchesFocus(e) || hoverEdge === e.id;
            const dim = focusId && !active;
            return (
              <g key={e.id} data-edge={e.type} onMouseEnter={() => setHoverEdge(e.id)} onMouseLeave={() => setHoverEdge(null)}>
                <title>{`${na.label} — ${e.type} → ${nb.label}${e.supportCount > 1 ? ` (${e.supportCount} mentions)` : ""}`}</title>
                <line
                  x1={na.x} y1={na.y} x2={nb.x} y2={nb.y}
                  stroke={active ? "hsl(var(--primary))" : "currentColor"}
                  className={`graph-edge ${active ? "text-primary" : "text-muted-foreground"}`}
                  strokeWidth={(active ? 1.8 : 1.1 + Math.min(1, (e.supportCount - 1) * 0.3)) / Math.sqrt(view.k)}
                  strokeOpacity={dim ? 0.1 : active ? 0.95 : 0.45}
                  markerEnd={active ? "url(#kg-arrow)" : undefined}
                  style={{ animationDelay: `${Math.min(i, 60) * 8}ms` }}
                />
                {/* wide invisible line: makes thin edges easy to hover */}
                <line x1={na.x} y1={na.y} x2={nb.x} y2={nb.y} stroke="transparent" strokeWidth={10 / view.k} />
              </g>
            );
          })}

          {/* relationship-type labels: only for the focused node's edges and the hovered edge */}
          {edges.filter((e) => labelledEdges.has(e.id)).map((e) => {
            const na = nodeMap.get(e.source);
            const nb = nodeMap.get(e.target);
            if (!na || !nb) return null;
            const text = RELATION(e.type);
            const w = (text.length * 6 + 10) / view.k;
            const mx = (na.x + nb.x) / 2;
            const my = (na.y + nb.y) / 2;
            return (
              <g key={`l-${e.id}`} pointerEvents="none">
                <rect x={mx - w / 2} y={my - 8 / view.k} width={w} height={14 / view.k} rx={3 / view.k} className="fill-background" fillOpacity="0.9" stroke="hsl(var(--primary))" strokeOpacity="0.5" strokeWidth={0.8 / view.k} />
                <text x={mx} y={my + 3 / view.k} textAnchor="middle" className="fill-primary" style={{ fontFamily: "JetBrains Mono, monospace", fontSize: `${10 / view.k}px` }}>{text}</text>
              </g>
            );
          })}

          {nodes.map((n, i) => {
            const style = typeStyles[n.type] || typeStyles.concept;
            const isSelected = selectedId === n.id;
            const dim = focusId && !isInFocus(n.id);
            const r = n.r;
            return (
              <g
                key={n.id}
                className="graph-node"
                role="button"
                tabIndex={0}
                aria-label={`${n.label}, ${n.entityType}${n.isolated ? ", no relationships" : `, ${n.degree} connected`}`}
                aria-pressed={isSelected}
                style={{ cursor: "pointer", opacity: dim ? 0.22 : n.isolated && !isInFocus(n.id) ? 0.6 : 1, animationDelay: `${Math.min(i, 60) * 8}ms`, outline: "none" }}
                onMouseEnter={() => setHover(n.id)}
                onMouseLeave={() => setHover(null)}
                onFocus={() => setHover(n.id)}
                onBlur={() => setHover(null)}
                onClick={(e) => { e.stopPropagation(); selectNode(n); }}
                onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (onSelect) onSelect(n); } }}
              >
                <title>{`${n.label} (${n.entityType})${n.isolated ? " — no relationships" : ` — ${n.degree} connected`}`}</title>
                {(n.primary || isSelected) && <circle cx={n.x} cy={n.y} r={r + 22} fill="url(#node-glow)" />}
                {isSelected && <circle cx={n.x} cy={n.y} r={r + 5} fill="none" stroke="hsl(var(--primary))" strokeWidth={1.5} strokeOpacity={0.8} />}
                <circle
                  cx={n.x} cy={n.y} r={r}
                  fill={style.fill}
                  stroke={style.stroke}
                  strokeWidth={isSelected ? 3 : n.primary ? 0 : 2}
                  strokeDasharray={n.isolated ? "3 3" : undefined}
                  opacity={n.primary ? 1 : 0.95}
                />
                {labels.has(n.id) && (
                  <text
                    x={n.x} y={n.y + r + (FONT + 2) / view.k}
                    textAnchor="middle"
                    className="fill-foreground"
                    pointerEvents="none"
                    style={{ fontFamily: "JetBrains Mono, monospace", fontSize: `${FONT / view.k}px`, fontWeight: isSelected ? 600 : 400, paintOrder: "stroke", stroke: "hsl(var(--card))", strokeWidth: `${3 / view.k}px` }}
                  >
                    {short(n.label)}
                  </text>
                )}
              </g>
            );
          })}
        </g>
      </svg>
    </div>
  );
}
