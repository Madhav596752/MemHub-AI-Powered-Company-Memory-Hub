import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));
// recharts needs real layout sizes (ResizeObserver), which jsdom does not have. The numbers under test are
// also rendered as plain text next to each chart, so the charts themselves are stubbed.
vi.mock("recharts", async () => {
  const React = await import("react");
  const Box = ({ children }) => React.createElement("div", { "data-chart": true }, children);
  const Nothing = () => null;
  return { ResponsiveContainer: Box, BarChart: Box, PieChart: Box, Pie: Box, Bar: Nothing, Cell: Nothing, XAxis: Nothing, YAxis: Nothing, CartesianGrid: Nothing, Tooltip: Nothing };
});

import Analytics from "./Analytics";

const now = new Date();
const thisMonth = (day) => new Date(now.getFullYear(), now.getMonth(), day, 12).toISOString();
const ing = (status, extra = {}) => ({ status, entityCount: 0, relationshipCount: 0, errorCode: null, processedAt: null, updatedAt: thisMonth(2), ...extra });
const doc = (n, extra = {}) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, originalName: `file-${n}.pdf`, fileType: "PDF", fileSize: 2048, createdAt: thisMonth(1), uploader: { id: "u", name: "Priya" }, graphIngestion: null, ...extra });

const DOCS = [
  doc(1, { graphIngestion: ing("processed", { entityCount: 14, relationshipCount: 8 }) }),
  doc(2, { fileType: "DOCX", graphIngestion: ing("processed", { entityCount: 22, relationshipCount: 5 }) }),
  doc(3, { fileType: "TXT", graphIngestion: ing("failed", { errorCode: "NLP_CHUNK_FAILED", entityCount: 99 }) }),
  doc(4, { graphIngestion: ing("skipped", { errorCode: "NO_TEXT" }) }),
  doc(5),
];
const STATUS = { success: true, enabled: true, connected: true, documents: { total: 5, processed: 2, failed: 1, skipped: 1, notProcessed: 1, processedWithoutRelationships: 0 } };
const GRAPH = { success: true, enabled: true, nodes: [], edges: [], stats: { entities: 33, relationships: 13 }, truncated: false, documents: [] };

function serve({ docs = DOCS, status = STATUS, graph = GRAPH } = {}) {
  api.mockImplementation(async (path) => {
    const pick = (v) => (typeof v === "function" ? v() : v);
    if (path === "/api/documents") return { success: true, documents: pick(docs) };
    if (path === "/api/graph/status") return pick(status);
    if (path === "/api/graph?limit=1") return pick(graph);
    throw new Error(`unexpected request ${path}`);
  });
}
const fail = (m) => () => { throw new Error(m); };
const renderPage = () => render(<MemoryRouter initialEntries={["/app/analytics"]}><Routes><Route path="/app/analytics" element={<Analytics />} /><Route path="/app/documents" element={<div>documents page</div>} /></Routes></MemoryRouter>);
const value = (label) => document.querySelector(`[data-stat="${label}"] [data-stat-value]`).textContent;

beforeEach(() => { cleanup(); api.mockReset(); });

describe("Analytics: real metrics", () => {
  it("shows loading, then totals, types, outcomes and top documents derived from the API", async () => {
    serve();
    renderPage();
    expect(value("Total Documents")).toBe("…");
    await screen.findByTestId("top-docs");

    expect(value("Total Documents")).toBe("5");
    expect(value("Storage Used")).toBe("10.0 KB");
    expect(value("Entities")).toBe("33");
    expect(value("Relationships")).toBe("13");

    const types = within(screen.getByTestId("type-list")).getAllByRole("listitem").map((li) => li.textContent);
    expect(types).toEqual(["PDF3", "DOCX1", "TXT1"]);
    const outcomes = within(screen.getByTestId("outcome-list")).getAllByRole("listitem").map((li) => li.textContent);
    expect(outcomes).toEqual(["Processed2", "Failed1", "Skipped1", "Awaiting1"]);

    // failed documents are not ranked even though they hold a count; largest first
    const top = within(screen.getByTestId("top-docs")).getAllByRole("listitem");
    expect(top).toHaveLength(2);
    expect(top[0].textContent).toContain("file-2.pdf");
    expect(top[0].textContent).toContain("22 entities · 5 relationships");
    expect(screen.getByText(/Deleted documents are not counted/)).toBeTruthy();
  });

  it("contains none of the old invented metrics", async () => {
    serve();
    renderPage();
    await screen.findByTestId("top-docs");
    for (const mock of ["94.2%", "Auth Guide", "38.6K", "2,140", "AI Queries Over Time", "Most Searched Topics", "Search Success", "Queries This Month", "Knowledge Growth"]) {
      expect(screen.queryByText(mock)).toBeNull();
    }
  });

  it("states clearly which analytics the backend cannot provide", async () => {
    serve();
    renderPage();
    const box = await screen.findByTestId("not-tracked");
    expect(within(box).getByText("Not tracked yet")).toBeTruthy();
    expect(box.textContent).toMatch(/question history, query counts and usage over time/);
    expect(box.textContent).toMatch(/Search volume, popular topics/);
    expect(box.textContent).toMatch(/Documents that were uploaded and later deleted/);
  });

  it("empty company: real zeros, an empty state instead of empty charts", async () => {
    serve({ docs: [], status: { ...STATUS, documents: { total: 0, processed: 0, failed: 0, skipped: 0, notProcessed: 0, processedWithoutRelationships: 0 } }, graph: { ...GRAPH, stats: { entities: 0, relationships: 0 } } });
    renderPage();
    expect(await screen.findByText("No documents to analyse yet")).toBeTruthy();
    expect(value("Total Documents")).toBe("0");
    expect(value("Storage Used")).toBe("0 B");
    expect(screen.queryByTestId("type-list")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Go to Documents" }));
    expect(await screen.findByText("documents page")).toBeTruthy();
  });

  it("API error: shows the message and Retry recovers", async () => {
    serve({ docs: fail("Something went wrong on our side. Please try again."), status: fail("Something went wrong on our side. Please try again."), graph: fail("Something went wrong on our side. Please try again.") });
    renderPage();
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong on our side");
    expect(value("Total Documents")).toBe("—");
    expect(value("Entities")).toBe("—");
    expect(screen.queryByText("No documents to analyse yet")).toBeNull(); // an error is not "empty"

    serve();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await screen.findByTestId("top-docs");
    expect(value("Total Documents")).toBe("5");
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("graph unavailable or off: entity totals are unknown, document analytics still work", async () => {
    serve({ graph: { success: true, enabled: false, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false } });
    renderPage();
    await screen.findByTestId("top-docs");
    expect(value("Entities")).toBe("—");
    expect(screen.getAllByText("The knowledge graph is not configured on this server.").length).toBe(2);
    expect(value("Total Documents")).toBe("5");
  });

  it("only sends the three existing GET requests, without any companyId", async () => {
    serve();
    renderPage();
    await screen.findByTestId("top-docs");
    expect(api.mock.calls.map((c) => c[0]).sort()).toEqual(["/api/documents", "/api/graph/status", "/api/graph?limit=1"]);
    for (const c of api.mock.calls) {
      expect(c[1]).toBeUndefined();
      expect(c[0]).not.toMatch(/company/i);
    }
  });
});
