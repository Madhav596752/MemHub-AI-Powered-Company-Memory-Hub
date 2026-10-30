import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => ({ user: { name: "Priya Rao" } }) }));

import Dashboard from "./Dashboard";

const ing = (status, extra = {}) => ({ status, entityCount: 0, relationshipCount: 0, errorCode: null, processedAt: null, updatedAt: "2026-09-01T10:01:00.000Z", ...extra });
const doc = (n, extra = {}) => ({
  id: `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`, originalName: `report-${n}.pdf`, fileType: "PDF", mimeType: "application/pdf", fileSize: 1024 * n,
  cloudinaryUrl: "https://files.example/x.pdf", uploader: { id: "u1", name: "Priya Rao" }, createdAt: `2026-09-0${n}T10:00:00.000Z`, graphIngestion: null, ...extra,
});
// processing finishes a minute after the upload, like the real (synchronous) pipeline
const processed = (n, g) => ({ ...doc(n), graphIngestion: ing(g.status, { ...g, updatedAt: `2026-09-0${n}T10:01:00.000Z` }) });

// 7 documents: 4 processed, 1 failed, 1 skipped, 1 without a processing record. Deliberately not round numbers.
const DOCS = [
  doc(7), // no record
  processed(6, { status: "skipped", errorCode: "NO_TEXT" }),
  processed(5, { status: "failed", errorCode: "NLP_CHUNK_FAILED" }),
  processed(4, { status: "processed", entityCount: 9, relationshipCount: 4 }),
  processed(3, { status: "processed", entityCount: 6, relationshipCount: 3 }),
  processed(2, { status: "processed", entityCount: 5, relationshipCount: 0 }),
  processed(1, { status: "processed", entityCount: 2, relationshipCount: 1 }),
];
const STATUS = { success: true, enabled: true, connected: true, documents: { total: 7, processed: 4, failed: 1, skipped: 1, notProcessed: 1, processedWithoutRelationships: 1 } };
const GRAPH = { success: true, enabled: true, nodes: [], edges: [], stats: { entities: 31, relationships: 17 }, truncated: true, documents: [] };

function serve({ docs = DOCS, status = STATUS, graph = GRAPH } = {}) {
  api.mockImplementation(async (path) => {
    const pick = (v) => (typeof v === "function" ? v() : v);
    if (path === "/api/documents") return { success: true, documents: pick(docs) };
    if (path === "/api/graph/status") return pick(status);
    if (path === "/api/graph?limit=1") return pick(graph);
    throw new Error(`unexpected request ${path}`);
  });
}
const fail = (message) => () => { throw new Error(message); };

function Probe() {
  const loc = useLocation();
  return <div data-testid="assistant-page">{loc.state?.question ?? "(no question)"}</div>;
}
const renderPage = () =>
  render(
    <MemoryRouter initialEntries={["/app"]}>
      <Routes>
        <Route path="/app" element={<Dashboard />} />
        <Route path="/app/assistant" element={<Probe />} />
        <Route path="/app/search" element={<div>search page</div>} />
        <Route path="/app/knowledge" element={<div>kb page</div>} />
        <Route path="/app/documents" element={<div>docs page</div>} />
      </Routes>
    </MemoryRouter>
  );
const stat = (label) => document.querySelector(`[data-stat="${label}"]`);
const value = (label) => stat(label).querySelector("[data-stat-value]").textContent;

beforeEach(() => { cleanup(); api.mockReset(); });

describe("Dashboard: real statistics", () => {
  it("shows a loading state first, then counts calculated from the API", async () => {
    let release;
    api.mockImplementation((path) => {
      if (path === "/api/documents") return new Promise((r) => { release = () => r({ documents: DOCS }); });
      if (path === "/api/graph/status") return Promise.resolve(STATUS);
      return Promise.resolve(GRAPH);
    });
    renderPage();
    expect(screen.getAllByRole("status").length).toBeGreaterThan(0);
    expect(value("Total Documents")).toBe("…");
    await waitFor(() => expect(value("Total Documents")).toBe("7"));
    release();
    await screen.findAllByText("report-7.pdf");

    expect(value("Processed")).toBe("4");
    expect(value("Awaiting Processing")).toBe("1");
    expect(value("Failed")).toBe("1");
    expect(value("Skipped")).toBe("1");
    expect(value("Entities")).toBe("31");
    expect(value("Relationships")).toBe("17");
    expect(value("Stored Files")).toBe("28.0 KB"); // (1+2+…+7) KB, summed from the documents
    expect(screen.getByRole("img", { name: /4 processed, 1 failed, 1 skipped, 1 awaiting processing, of 7 documents/ })).toBeTruthy();
  });

  it("contains none of the old mock numbers or names", async () => {
    serve();
    renderPage();
    await screen.findAllByText("report-7.pdf");
    for (const mock of ["1,284", "38.6K", "9,421", "5,847", "+12.4%", "Q3 Product Roadmap.pdf", "Priya N.", "Knowledge Overview"]) {
      expect(screen.queryByText(mock)).toBeNull();
    }
    expect(screen.queryByText(/queries/i)).toBeNull(); // no query statistic exists in the backend
  });

  it("recent activity lists real uploads and processing results, newest first", async () => {
    serve();
    renderPage();
    await screen.findAllByText("report-7.pdf");
    const items = [...document.querySelectorAll("[data-activity]")];
    expect(items).toHaveLength(6);
    expect(items[0].textContent).toContain("report-7.pdf"); // newest document
    expect(items.some((li) => li.dataset.activity === "failed" && li.textContent.includes("report-5.pdf"))).toBe(true);
    expect(items.some((li) => li.dataset.activity === "processed" && li.textContent.includes("9 entities · 4 relationships"))).toBe(true);
    expect(within(items[0]).getByText(/Uploaded by Priya Rao/)).toBeTruthy();
  });

  it("empty company: real zeros and empty states, no fake activity", async () => {
    serve({ docs: [], status: { ...STATUS, documents: { total: 0, processed: 0, failed: 0, skipped: 0, notProcessed: 0, processedWithoutRelationships: 0 } }, graph: { ...GRAPH, stats: { entities: 0, relationships: 0 } } });
    renderPage();
    expect(await screen.findByText("No documents yet")).toBeTruthy();
    expect(value("Total Documents")).toBe("0");
    expect(value("Entities")).toBe("0");
    expect(screen.getByText(/No activity yet/)).toBeTruthy();
    expect(screen.getByText(/No documents yet\. Upload one/)).toBeTruthy();
  });

  it("documents API error: error message with Retry, which reloads", async () => {
    let ok = false;
    serve({ docs: () => { if (!ok) throw new Error("Something went wrong on our side. Please try again."); return DOCS; }, status: fail("Something went wrong on our side. Please try again.") });
    renderPage();
    const alerts = await screen.findAllByRole("alert");
    expect(alerts.some((a) => a.textContent.includes("Something went wrong on our side"))).toBe(true);
    expect(value("Total Documents")).toBe("—"); // unknown, not 0

    ok = true;
    serve({});
    fireEvent.click(screen.getAllByRole("button", { name: "Retry" })[0]);
    await screen.findAllByText("report-7.pdf");
    expect(value("Total Documents")).toBe("7");
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });

  it("status endpoint failing falls back to a tally of the loaded documents and says so", async () => {
    serve({ status: fail("Cannot reach the server. Please try again.") });
    renderPage();
    await screen.findAllByText("report-7.pdf");
    expect(value("Total Documents")).toBe("7");
    expect(value("Processed")).toBe("4");
    expect(value("Failed")).toBe("1");
    expect(screen.getByRole("alert").textContent).toContain("Showing a tally of the loaded documents instead");
  });

  it("graph failing: entity and relationship totals show an em dash and the reason, other numbers stay", async () => {
    serve({ graph: fail("The knowledge graph is currently unavailable.") });
    renderPage();
    await screen.findAllByText("report-7.pdf");
    expect(value("Entities")).toBe("—");
    expect(value("Relationships")).toBe("—");
    expect(stat("Entities").textContent).toContain("The knowledge graph is currently unavailable.");
    expect(value("Total Documents")).toBe("7");
  });

  it("graph not configured: totals are unknown (—), not 0, and the page explains why", async () => {
    serve({
      status: { ...STATUS, enabled: false, connected: false, documents: { total: 7, processed: 0, failed: 0, skipped: 6, notProcessed: 1, processedWithoutRelationships: 0 } },
      graph: { success: true, enabled: false, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false },
    });
    renderPage();
    await screen.findAllByText("report-7.pdf");
    expect(value("Entities")).toBe("—");
    expect(value("Skipped")).toBe("6");
    expect(screen.getByText(/knowledge graph is not configured on this server, so documents are skipped/i)).toBeTruthy();
  });

  it("only issues the three existing GET requests and never sends a companyId", async () => {
    serve();
    renderPage();
    await screen.findAllByText("report-7.pdf");
    expect(api.mock.calls.map((c) => c[0]).sort()).toEqual(["/api/documents", "/api/graph/status", "/api/graph?limit=1"]);
    for (const call of api.mock.calls) {
      expect(call[1]).toBeUndefined(); // no method, no body
      expect(call[0]).not.toMatch(/company/i);
    }
  });
});

describe("Dashboard: Ask MemHub", () => {
  it("is enabled, and Ask stays disabled for empty or whitespace-only input", async () => {
    serve();
    renderPage();
    const input = screen.getByLabelText("Ask MemHub a question");
    const button = screen.getByRole("button", { name: /Ask/ });
    expect(input.disabled).toBe(false);
    expect(button.disabled).toBe(true);
    fireEvent.change(input, { target: { value: "   " } });
    expect(button.disabled).toBe(true);
    fireEvent.submit(input.closest("form"));
    expect(screen.queryByTestId("assistant-page")).toBeNull();
    await screen.findAllByText("report-7.pdf");
  });

  it("submitting hands the trimmed question to the AI Assistant page", async () => {
    serve();
    renderPage();
    fireEvent.change(screen.getByLabelText("Ask MemHub a question"), { target: { value: "  What is our refund policy?  " } });
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    expect((await screen.findByTestId("assistant-page")).textContent).toBe("What is our refund policy?");
    // The dashboard itself never calls /api/ask; the assistant page does.
    expect(api.mock.calls.some((c) => c[0] === "/api/ask")).toBe(false);
  });

  it("an example prompt fills the input without submitting", async () => {
    serve();
    renderPage();
    const chip = screen.getByRole("button", { name: /authentication architecture/i });
    fireEvent.click(chip);
    expect(screen.getByLabelText("Ask MemHub a question").value).toBe("Show me our authentication architecture.");
    expect(screen.queryByTestId("assistant-page")).toBeNull();
    await screen.findAllByText("report-7.pdf");
  });

  it("links to Search, Knowledge Base, Documents and AI Assistant", async () => {
    serve();
    renderPage();
    const href = (name) => screen.getByRole("link", { name: new RegExp(name) }).getAttribute("href");
    expect(href("Search")).toBe("/app/search");
    expect(href("Knowledge Base")).toBe("/app/knowledge");
    expect(href("^Documents")).toBe("/app/documents");
    expect(href("AI Assistant")).toBe("/app/assistant");
    await screen.findAllByText("report-7.pdf");
  });
});
