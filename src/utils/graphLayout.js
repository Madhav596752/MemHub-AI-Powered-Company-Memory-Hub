// Turns the API graph (nodes + edges, no coordinates) into what KnowledgeGraph.jsx draws.
// A small deterministic force layout (no extra dependency): the same data always gives the same picture.
//
// Entities that have NO relationship in the data are not pulled into the middle of the picture (that
// made a dense, unreadable blob of dots). They are placed on an outer ring and drawn as isolated.
// No edge is ever created here: edges come from the API, nothing else.

// Backend entity types -> the colour groups the existing KnowledgeGraph legend already has.
const VISUAL_TYPE = {
  TECHNOLOGY: "technology", SERVICE: "technology", PRODUCT: "technology",
  DOCUMENT: "document", DECISION: "document",
  PERSON: "people", TEAM: "people",
  PROJECT: "project", ISSUE: "project", ORGANIZATION: "project",
  MEETING: "meeting", DATE: "meeting", LOCATION: "meeting",
};
export const visualType = (entityType) => VISUAL_TYPE[entityType] || "concept";

export const GRAPH_WIDTH = 1000;
export const GRAPH_HEIGHT = 600;
const W = GRAPH_WIDTH;
const H = GRAPH_HEIGHT;

function hash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i += 1) h = Math.imul(h ^ text.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

// nodes: [{ id, label, type, degree?, ... }]   edges: [{ id, source, target, type, supportCount?, confidence? }]
// -> { nodes: [{ ...node, entityType, type: <visual type>, x, y, r, primary, isolated, degree }],
//      edges: [{ id, source, target, type, supportCount, confidence }] }
// `degree` is the number of DISTINCT connected neighbours that are visible in this picture.
export function layoutGraph(nodes, edges) {
  const known = new Set(nodes.map((n) => n.id));
  const seen = new Set();
  const cleanEdges = [];
  for (const e of edges || []) {
    if (!known.has(e.source) || !known.has(e.target) || e.source === e.target) continue;
    const id = e.id || `${e.source}|${e.type}|${e.target}`;
    if (seen.has(id)) continue;
    seen.add(id);
    cleanEdges.push({ id, source: e.source, target: e.target, type: e.type, supportCount: e.supportCount ?? 1, confidence: e.confidence ?? null });
  }

  const neighbours = new Map(nodes.map((n) => [n.id, new Set()]));
  for (const e of cleanEdges) { neighbours.get(e.source).add(e.target); neighbours.get(e.target).add(e.source); }
  const maxDegree = Math.max(1, ...nodes.map((n) => neighbours.get(n.id).size));

  const placed = nodes.map((n) => {
    const degree = neighbours.get(n.id).size;
    return {
      ...n,
      degree,
      entityType: n.type,
      type: visualType(n.type),
      x: W / 2, y: H / 2,
      r: 7 + Math.round((degree / maxDegree) * 11),
      primary: false,
      isolated: degree === 0,
    };
  });

  // ---- connected entities: force layout in the middle of the canvas
  const core = placed.filter((n) => !n.isolated);
  core.forEach((n, i) => {
    const angle = (i / Math.max(1, core.length)) * Math.PI * 2 + hash(n.id) * 0.5;
    const ring = 60 + hash(`${n.id}:r`) * 150;
    n.x = W / 2 + Math.cos(angle) * ring;
    n.y = H / 2 + Math.sin(angle) * ring * 0.7;
  });
  const index = new Map(core.map((n, i) => [n.id, i]));
  const links = cleanEdges.map((e) => [index.get(e.source), index.get(e.target)]);
  const STEPS = 260;
  for (let step = 0; step < STEPS; step += 1) {
    const cool = 1 - step / STEPS;
    const dx = core.map(() => 0);
    const dy = core.map(() => 0);
    for (let i = 0; i < core.length; i += 1) {
      for (let j = i + 1; j < core.length; j += 1) {
        const vx = core[i].x - core[j].x;
        const vy = core[i].y - core[j].y;
        const d2 = Math.max(vx * vx + vy * vy, 100);
        const d = Math.sqrt(d2);
        const f = 7000 / d2; // repulsion
        dx[i] += (vx / d) * f; dy[i] += (vy / d) * f;
        dx[j] -= (vx / d) * f; dy[j] -= (vy / d) * f;
      }
    }
    for (const [a, b] of links) {
      const vx = core[b].x - core[a].x;
      const vy = core[b].y - core[a].y;
      const d = Math.max(Math.sqrt(vx * vx + vy * vy), 1);
      const f = (d - 95) * 0.18; // spring
      dx[a] += (vx / d) * f; dy[a] += (vy / d) * f;
      dx[b] -= (vx / d) * f; dy[b] -= (vy / d) * f;
    }
    core.forEach((n, i) => {
      dx[i] += (W / 2 - n.x) * 0.012;
      dy[i] += (H / 2 - n.y) * 0.012;
      n.x += Math.max(-30, Math.min(30, dx[i])) * cool;
      n.y += Math.max(-30, Math.min(30, dy[i])) * cool;
    });
  }
  // keep the connected cluster inside an inner ellipse so the outer ring stays free
  const inner = core.length > 0 && placed.some((n) => n.isolated) ? { rx: W * 0.36, ry: H * 0.34 } : { rx: W / 2 - 60, ry: H / 2 - 50 };
  core.forEach((n) => {
    const ex = (n.x - W / 2) / inner.rx;
    const ey = (n.y - H / 2) / inner.ry;
    const len = Math.sqrt(ex * ex + ey * ey);
    if (len > 1) { n.x = W / 2 + ex / len * inner.rx; n.y = H / 2 + ey / len * inner.ry; }
  });

  // ---- isolated entities: evenly spaced on the outer ring(s)
  const loose = placed.filter((n) => n.isolated).sort((a, b) => hash(a.id) - hash(b.id));
  const hasCore = core.length > 0;
  const rings = hasCore
    ? [{ rx: W / 2 - 55, ry: H / 2 - 45 }, { rx: W / 2 - 105, ry: H / 2 - 85 }]
    : [{ rx: W / 2 - 80, ry: H / 2 - 70 }, { rx: W / 2 - 200, ry: H / 2 - 160 }, { rx: W / 2 - 320, ry: H / 2 - 240 }];
  let cursor = 0;
  rings.forEach((ring, ri) => {
    const perimeter = Math.PI * (3 * (ring.rx + ring.ry) - Math.sqrt((3 * ring.rx + ring.ry) * (ring.rx + 3 * ring.ry)));
    const capacity = ri === rings.length - 1 ? loose.length - cursor : Math.min(loose.length - cursor, Math.max(1, Math.floor(perimeter / 34)));
    for (let i = 0; i < capacity; i += 1) {
      const angle = (i / capacity) * Math.PI * 2 + ri * 0.35 - Math.PI / 2;
      const n = loose[cursor + i];
      n.x = W / 2 + Math.cos(angle) * ring.rx;
      n.y = H / 2 + Math.sin(angle) * ring.ry;
    }
    cursor += capacity;
  });

  placed.forEach((n) => { n.x = Math.round(Math.min(W - 30, Math.max(30, n.x))); n.y = Math.round(Math.min(H - 30, Math.max(30, n.y))); });
  if (core.length) core.reduce((best, n) => (n.degree > best.degree ? n : best), core[0]).primary = true;
  return { nodes: placed, edges: cleanEdges };
}
