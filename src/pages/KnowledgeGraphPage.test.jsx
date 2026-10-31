import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));

import KnowledgeGraphPage from "./KnowledgeGraphPage";
import { layoutGraph } from "@/utils/graphLayout";
import { chooseLabels } from "@/components/KnowledgeGraph";

const node = (id, label, type, degree = 1) => ({ id, label, type, degree, documentCount: 1, mentionCount: 1 });
const GRAPH = {
  success: true, enabled: true, truncated: false, stats: { entities: 3, relationships: 2 },
  nodes: [node("n1", "Priya Rao", "PERSON", 2), node("n2", "login issue", "ISSUE"), node("n3", "Project Phoenix", "PROJECT")],
  edges: [{ id: "e1", source: "n1", target: "n2", type: "RESOLVED", confidence: 0.96, supportCount: 1 }, { id: "e2", source: "n2", target: "n3", type: "BELONGS_TO", confidence: 0.9, supportCount: 1 }],
};
const DETAIL = {
  success: true,
  node: node("n1", "Priya Rao", "PERSON", 2),
  relationships: [{ type: "RESOLVED", direction: "out", other: { id: "n2", label: "login issue", type: "ISSUE" }, evidence: "Priya Rao resolved the login issue", documentId: "d1", documentName: "incident-review.txt", chunkIndex: 0, confidence: 0.96 }],
  mentions: [],
};

beforeEach(() => { cleanup(); api.mockReset(); });

describe("KnowledgeGraphPage", () => {
  it("shows a loading state, then real nodes and the evidence of the selected node", async () => {
    api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? DETAIL : GRAPH));
    render(<KnowledgeGraphPage />);
    expect(screen.getByRole("status")).toBeTruthy();
    expect(await screen.findByText("Priya Rao resolved the login issue", { exact: false })).toBeTruthy();
    expect(screen.getAllByText("Priya Rao").length).toBeGreaterThan(0);
    expect(screen.getByText("incident-review.txt · chunk 1")).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/api/graph?limit=80");
    expect(api).toHaveBeenCalledWith("/api/graph/nodes/n1");
    // no fake data from the old mock
    expect(screen.queryByText("Knowledge Graph GA", { exact: false })).toBeNull();
  });

  it("opens filtered to the document in ?documentId= (deep link from the Knowledge Base)", async () => {
    window.history.pushState({}, "", "/app/graph?documentId=d2");
    try {
      api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? DETAIL : GRAPH));
      render(<KnowledgeGraphPage />);
      await waitFor(() => expect(api).toHaveBeenCalledWith("/api/graph?limit=80&documentId=d2"));
      expect(api).not.toHaveBeenCalledWith("/api/graph?limit=80");
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("a deep link to a document that cannot be loaded offers a way back to all documents", async () => {
    window.history.pushState({}, "", "/app/graph?documentId=gone");
    try {
      api.mockImplementation(async (path) => {
        if (path === "/api/graph?limit=80&documentId=gone") throw new Error("Document not found");
        return path.startsWith("/api/graph/nodes/") ? DETAIL : GRAPH;
      });
      render(<KnowledgeGraphPage />);
      expect(await screen.findByText("Document not found")).toBeTruthy();
      fireEvent.click(screen.getByText("Show all documents"));
      await waitFor(() => expect(screen.getAllByText("Priya Rao").length).toBeGreaterThan(0));
    } finally {
      window.history.pushState({}, "", "/");
    }
  });

  it("shows an error with a retry", async () => {
    api.mockRejectedValueOnce(new Error("The knowledge graph database is currently unavailable."));
    api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? DETAIL : GRAPH));
    render(<KnowledgeGraphPage />);
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("The knowledge graph database is currently unavailable.")).toBeTruthy();
    fireEvent.click(screen.getByText("Try again"));
    await waitFor(() => expect(screen.getAllByText("Priya Rao").length).toBeGreaterThan(0));
  });

  it("explains an empty graph truthfully: no documents", async () => {
    api.mockImplementation(async (path) => (path === "/api/graph/status" ? { enabled: true, connected: true, documents: { total: 0, processed: 0, failed: 0, skipped: 0, notProcessed: 0 } } : { success: true, enabled: true, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false }));
    render(<KnowledgeGraphPage />);
    expect(await screen.findByText("No documents yet")).toBeTruthy();
  });

  it("explains an empty graph truthfully: documents exist but none was processed", async () => {
    api.mockImplementation(async (path) => (path === "/api/graph/status" ? { enabled: true, connected: true, documents: { total: 3, processed: 0, failed: 1, skipped: 0, notProcessed: 2 } } : { success: true, enabled: true, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false }));
    render(<KnowledgeGraphPage />);
    expect(await screen.findByText("No document has been processed yet")).toBeTruthy();
  });

  it("says so when the graph is not enabled on the server", async () => {
    api.mockImplementation(async (path) => (path === "/api/graph/status" ? { enabled: false, connected: false, documents: { total: 2, processed: 0, failed: 0, skipped: 2, notProcessed: 0 } } : { success: true, enabled: false, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false }));
    render(<KnowledgeGraphPage />);
    expect(await screen.findByText("The knowledge graph is not enabled")).toBeTruthy();
  });

  it("filters by document: the request carries documentId, the list comes from the API", async () => {
    const withDocs = { ...GRAPH, documents: [{ id: "d1", name: "incident-review.txt" }, { id: "d2", name: "roadmap.txt" }] };
    api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? DETAIL : withDocs));
    render(<KnowledgeGraphPage />);
    const select = await screen.findByLabelText("Filter by document");
    fireEvent.change(select, { target: { value: "d2" } });
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/graph?limit=80&documentId=d2"));
  });

  it("says honestly when entities exist but no relationship was extracted, and never draws an edge", async () => {
    const lonely = { ...GRAPH, edges: [], nodes: GRAPH.nodes.map((n) => ({ ...n, degree: 0 })) };
    api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? { success: true, node: lonely.nodes[0], relationships: [], mentions: [{ documentId: "d1", documentName: "incident-review.txt", chunkIndex: 0, surfaces: ["Priya Rao"] }] } : lonely));
    const { container } = render(<KnowledgeGraphPage />);
    expect(await screen.findByText("No relationships extracted.", { exact: false })).toBeTruthy();
    expect(screen.getByRole("note").textContent).toContain("no relationships between them have been extracted");
    expect(container.querySelectorAll("[data-edge]").length).toBe(0);
  });

  it("lists the real connected entities with the relationship type, and draws only API edges", async () => {
    api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? DETAIL : GRAPH));
    const { container } = render(<KnowledgeGraphPage />);
    expect(await screen.findByText("→ login issue")).toBeTruthy();
    expect(screen.getAllByText("RESOLVED").length).toBeGreaterThan(0);
    expect(container.querySelectorAll("[data-edge]").length).toBe(GRAPH.edges.length);
  });

  it("clicking a connected entity that is not drawn yet adds it (from the API) and selects it", async () => {
    const detail = { ...DETAIL, relationships: [{ ...DETAIL.relationships[0], other: { id: "n9", label: "Kafka", type: "TECHNOLOGY" }, type: "USED" }] };
    api.mockImplementation(async (path) => (path.startsWith("/api/graph/nodes/") ? detail : GRAPH));
    const { container } = render(<KnowledgeGraphPage />);
    fireEvent.click(await screen.findByText("→ Kafka"));
    await waitFor(() => expect(api).toHaveBeenCalledWith("/api/graph/nodes/n9"));
    expect(container.querySelectorAll("[data-edge]").length).toBe(GRAPH.edges.length + 1);
  });
});

describe("chooseLabels", () => {
  const mk = (id, label, x, y, degree = 0) => ({ id, label, x, y, r: 8, degree, isolated: degree === 0 });
  const none = { selectedId: null, hoverId: null, neighbours: new Set() };
  it("never puts two labels on top of each other and always labels the selected node", () => {
    const nodes = [mk("a", "Alpha service", 100, 100, 3), mk("b", "Beta service", 104, 102, 2), mk("c", "Gamma", 400, 300, 1)];
    const shown = chooseLabels(nodes, { selectedId: "b", hoverId: null, neighbours: new Set(["a"]), zoom: 1 });
    expect(shown.has("b")).toBe(true);
    expect(shown.has("a")).toBe(false); // would overlap the selected label
    expect(shown.has("c")).toBe(true);
  });
  it("labels far fewer nodes than it has in a crowded graph, and more when zoomed in", () => {
    const nodes = Array.from({ length: 80 }, (_, i) => mk(`n${i}`, `Entity number ${i}`, 60 + (i % 10) * 85, 60 + Math.floor(i / 10) * 60, 1 + (i % 4)));
    const far = chooseLabels(nodes, { ...none, zoom: 1 }).size;
    const near = chooseLabels(nodes, { ...none, zoom: 3 }).size;
    expect(far).toBeLessThanOrEqual(10);
    expect(near).toBeGreaterThan(far);
  });
  it("keeps isolated dots unlabeled until the user zooms in", () => {
    const nodes = [mk("x", "Loose entity", 50, 50, 0)];
    expect(chooseLabels(nodes, { ...none, zoom: 1 }).size).toBe(0);
    expect(chooseLabels(nodes, { ...none, zoom: 3 }).size).toBe(1);
  });
});

describe("layoutGraph", () => {
  it("is deterministic, keeps nodes on the canvas, maps types and ignores edges to unknown nodes", () => {
    const edges = [...GRAPH.edges, { id: "x", source: "n1", target: "missing", type: "USED" }];
    const a = layoutGraph(GRAPH.nodes, edges);
    const b = layoutGraph(GRAPH.nodes, edges);
    expect(a).toEqual(b);
    expect(a.edges.map((e) => [e.source, e.type, e.target])).toEqual([["n1", "RESOLVED", "n2"], ["n2", "BELONGS_TO", "n3"]]);
    expect(a.nodes.map((n) => n.type)).toEqual(["people", "project", "project"]);
    expect(a.nodes.every((n) => n.x >= 30 && n.x <= 970 && n.y >= 30 && n.y <= 570)).toBe(true);
    expect(a.nodes.filter((n) => n.primary).map((n) => n.id)).toEqual(["n2"]); // the most connected visible node
  });
  it("never invents edges: entities without a relationship stay isolated", () => {
    const nodes = [...GRAPH.nodes, node("n4", "Loose", "DATE", 0), node("n5", "Other loose", "LOCATION", 0)];
    const out = layoutGraph(nodes, GRAPH.edges);
    expect(out.edges.length).toBe(GRAPH.edges.length);
    expect(out.nodes.filter((n) => n.isolated).map((n) => n.id).sort()).toEqual(["n4", "n5"]);
    expect(out.nodes.find((n) => n.id === "n1").isolated).toBe(false);
  });
  it("de-duplicates repeated edges and ignores self loops", () => {
    const out = layoutGraph(GRAPH.nodes, [...GRAPH.edges, { ...GRAPH.edges[0] }, { id: "s", source: "n1", target: "n1", type: "USED" }]);
    expect(out.edges.length).toBe(2);
  });
  it("handles an empty graph", () => {
    expect(layoutGraph([], [])).toEqual({ nodes: [], edges: [] });
  });
});
