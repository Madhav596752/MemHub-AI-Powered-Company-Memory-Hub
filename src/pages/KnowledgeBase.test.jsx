import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast: { success: (...a) => toast.success(...a), error: (...a) => toast.error(...a) } }));

// Who is logged in. Reprocessing is administrator-only on the server, so the page only shows it to admins.
const auth = { isAdmin: true };
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));

import KnowledgeBase, { documentStatus } from "./KnowledgeBase";

const D1 = "11111111-1111-4111-8111-111111111111";
const D2 = "22222222-2222-4222-8222-222222222222";
const D3 = "33333333-3333-4333-8333-333333333333";
const D4 = "44444444-4444-4444-8444-444444444444";
const D5 = "55555555-5555-4555-8555-555555555555";

const doc = (id, name, extra = {}) => ({
  id, originalName: name, fileType: "PDF", mimeType: "application/pdf", fileSize: 2048, cloudinaryUrl: `https://files.example/${id}.pdf`,
  uploader: { id: "u1", name: "Priya Rao" }, createdAt: "2026-09-01T10:00:00.000Z", ...extra,
});
const ingestion = (status, extra = {}) => ({ status, entityCount: 0, relationshipCount: 0, errorCode: null, processedAt: null, updatedAt: "2026-09-01T10:01:00.000Z", ...extra });

const PROCESSED = doc(D1, "incident-review.pdf", { graphIngestion: ingestion("processed", { entityCount: 12, relationshipCount: 7, processedAt: "2026-09-01T10:01:00.000Z" }) });
const FAILED = doc(D2, "roadmap.docx", { fileType: "DOCX", createdAt: "2026-09-02T10:00:00.000Z", graphIngestion: ingestion("failed", { errorCode: "NLP_CHUNK_FAILED", entityCount: 3, processedAt: "2026-08-30T10:00:00.000Z" }) });
const SKIPPED = doc(D3, "notes.txt", { fileType: "TXT", createdAt: "2026-09-03T10:00:00.000Z", graphIngestion: ingestion("skipped", { errorCode: "GRAPH_NOT_CONFIGURED" }) });
const SKIPPED_NO_TEXT = doc(D4, "blank.txt", { fileType: "TXT", createdAt: "2026-09-04T10:00:00.000Z", graphIngestion: ingestion("skipped", { errorCode: "NO_TEXT" }) });
const UPLOADED = doc(D5, "legacy-upload.pdf", { createdAt: "2026-09-05T10:00:00.000Z", graphIngestion: null });

const node = (id, label, type, degree = 1) => ({ id, label, type, degree, documentCount: 1, mentionCount: 1 });
const GRAPH = {
  success: true, enabled: true, truncated: false, stats: { entities: 3, relationships: 2 },
  nodes: [node("n1", "Priya Rao", "PERSON", 2), node("n2", "login issue", "ISSUE"), node("n3", "Project Phoenix", "PROJECT")],
  edges: [{ id: "e1", source: "n1", target: "n2", type: "RESOLVED", confidence: 0.96, supportCount: 1 }, { id: "e2", source: "n2", target: "n3", type: "BELONGS_TO", confidence: 0.9, supportCount: 1 }],
  documents: [],
};

// Routes the mocked API like the backend does. `docs` is what GET /api/documents returns.
function serve({ docs = [PROCESSED], graph = GRAPH, detail = {}, reprocess } = {}) {
  api.mockImplementation(async (path, options = {}) => {
    if (path === "/api/documents") return { success: true, documents: typeof docs === "function" ? docs() : docs };
    if (path.startsWith("/api/documents/")) {
      const id = path.split("/")[3];
      const base = (typeof docs === "function" ? docs() : docs).find((d) => d.id === id);
      if (!base) throw new Error("Document not found");
      return { success: true, document: { ...base, textLength: 1500, textPreview: "Priya Rao resolved the login issue.", ...detail } };
    }
    if (path.startsWith("/api/graph?")) return typeof graph === "function" ? graph(path) : graph;
    if (path.startsWith("/api/graph/documents/") && options.method === "POST") return reprocess(path);
    throw new Error(`unexpected request ${path}`);
  });
}

const renderPage = () => render(<MemoryRouter><KnowledgeBase /></MemoryRouter>);
const card = (id) => document.querySelector(`[data-document-id="${id}"]`);

beforeEach(() => { cleanup(); api.mockReset(); toast.success.mockReset(); toast.error.mockReset(); auth.isAdmin = true; });

describe("KnowledgeBase: loading real documents", () => {
  it("shows a loading state, then the documents from the API with their real metadata", async () => {
    serve({ docs: [PROCESSED, FAILED] });
    renderPage();
    expect(screen.getByRole("status").textContent).toContain("Loading knowledge base");
    expect(await screen.findByText("incident-review.pdf")).toBeTruthy();
    expect(screen.getByText("roadmap.docx")).toBeTruthy();
    expect(api).toHaveBeenCalledWith("/api/documents");

    const c = card(D1);
    expect(within(c).getByText("PDF")).toBeTruthy();
    expect(within(c).getByText(/Priya Rao · 2\.0 KB/)).toBeTruthy();
    expect(within(c).getByText(new Date("2026-09-01T10:00:00.000Z").toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" }))).toBeTruthy();
    expect(within(c).getByText("12 entities · 7 relationships")).toBeTruthy();
    expect(document.querySelectorAll("[data-document-id]").length).toBe(2); // exactly what the API returned

    // nothing from the old mock data
    expect(screen.queryByText("System Architecture Documentation")).toBeNull();
    expect(screen.queryByText(/chunks/)).toBeNull();
  });

  it("builds the type filter from the types that really exist and filters by it", async () => {
    serve({ docs: [PROCESSED, FAILED, SKIPPED] });
    renderPage();
    await screen.findByText("incident-review.pdf");
    expect(screen.queryByText("Meetings")).toBeNull(); // mock-only category
    fireEvent.click(screen.getByRole("button", { name: "TXT" }));
    expect(document.querySelectorAll("[data-document-id]").length).toBe(1);
    expect(card(D3)).toBeTruthy();
  });

  it("searches by name and sorts by the real entity count", async () => {
    serve({ docs: [PROCESSED, FAILED, doc(D3, "small.pdf", { graphIngestion: ingestion("processed", { entityCount: 40, relationshipCount: 1 }) })] });
    renderPage();
    await screen.findByText("incident-review.pdf");
    fireEvent.change(screen.getByLabelText("Sort documents"), { target: { value: "Most Entities" } });
    const order = [...document.querySelectorAll("[data-document-id]")].map((el) => el.getAttribute("data-document-id"));
    expect(order).toEqual([D3, D1, D2]); // 40, 12, then the one without a processed result
    fireEvent.change(screen.getByLabelText("Search documents"), { target: { value: "roadmap" } });
    expect(document.querySelectorAll("[data-document-id]").length).toBe(1);
    expect(card(D2)).toBeTruthy();
  });

  it("refresh reloads the list from the API", async () => {
    let current = [PROCESSED];
    serve({ docs: () => current });
    renderPage();
    await screen.findByText("incident-review.pdf");
    current = [PROCESSED, FAILED];
    fireEvent.click(screen.getByLabelText("Refresh"));
    expect(await screen.findByText("roadmap.docx")).toBeTruthy();
    expect(api.mock.calls.filter(([p]) => p === "/api/documents").length).toBe(2);
  });
});

describe("KnowledgeBase: empty and failing", () => {
  it("shows an honest empty state for a company without documents", async () => {
    serve({ docs: [] });
    renderPage();
    expect(await screen.findByText("Your knowledge base is empty")).toBeTruthy();
    expect(document.querySelectorAll("[data-document-id]").length).toBe(0);
    expect(screen.getByText("Go to Documents").closest("a").getAttribute("href")).toBe("/app/documents");
    expect(screen.queryByText(/0 documents/)).toBeNull();
  });

  it("shows the API error with a working retry", async () => {
    serve({ docs: [PROCESSED] });
    api.mockRejectedValueOnce(new Error("Something went wrong on our side. Please try again.")); // first request fails, the retry works
    renderPage();
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Something went wrong on our side. Please try again.")).toBeTruthy();
    expect(document.querySelectorAll("[data-document-id]").length).toBe(0); // no stale or fake cards next to an error
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("incident-review.pdf")).toBeTruthy();
  });

  it("an unauthorized response (expired session) is shown as an error and no documents are rendered", async () => {
    api.mockRejectedValue(new Error("Your session has expired. Please log in again."));
    renderPage();
    expect(await screen.findByText("Your session has expired. Please log in again.")).toBeTruthy();
    expect(screen.getByRole("alert")).toBeTruthy();
    expect(document.querySelectorAll("[data-document-id]").length).toBe(0);
  });
});

describe("KnowledgeBase: processing status", () => {
  it("renders every backend state truthfully and offers retry only where it can help", async () => {
    serve({ docs: [PROCESSED, FAILED, SKIPPED, SKIPPED_NO_TEXT, UPLOADED] });
    renderPage();
    await screen.findByText("incident-review.pdf");

    const status = (id) => card(id).querySelector("[data-status]").getAttribute("data-status");
    expect(status(D1)).toBe("processed");
    expect(status(D2)).toBe("failed");
    expect(status(D3)).toBe("skipped");
    expect(status(D4)).toBe("skipped");
    expect(status(D5)).toBe("uploaded");

    expect(within(card(D2)).getByText(/Some parts of the document could not be analysed\./)).toBeTruthy();
    expect(within(card(D2)).getByText(/last successful run/)).toBeTruthy();
    expect(within(card(D3)).getByText("The knowledge graph is not configured on the server.")).toBeTruthy();
    expect(within(card(D5)).getByText("No knowledge-graph processing has been recorded for this document.")).toBeTruthy();

    expect(within(card(D1)).queryByText("Retry")).toBeNull(); // processed: nothing to retry
    expect(within(card(D2)).getByText("Retry")).toBeTruthy();
    expect(within(card(D3)).getByText("Retry")).toBeTruthy();
    expect(within(card(D4)).queryByText("Retry")).toBeNull(); // no text: retrying cannot help
    expect(within(card(D5)).getByText("Process")).toBeTruthy();

    expect(screen.getByText("5 documents · 1 processed · 1 failed · 2 skipped · 1 not yet processed")).toBeTruthy();
  });

  it("does not claim 'processed' with data it does not have, and shows unknown codes raw", () => {
    expect(documentStatus(doc(D1, "a", { graphIngestion: ingestion("processed", { entityCount: 0 }) })).detail).toBe("No entities were recognised in this document.");
    expect(documentStatus(doc(D1, "a", { graphIngestion: ingestion("processed", { entityCount: 4, relationshipCount: 0 }) })).detail).toContain("no relationships");
    expect(documentStatus(doc(D1, "a", { graphIngestion: ingestion("failed", { errorCode: "SOMETHING_NEW" }) })).detail).toBe("Error code: SOMETHING_NEW");
    expect(documentStatus(doc(D1, "a", { graphIngestion: ingestion("queued") })).label).toBe("queued"); // future status: shown as is
    expect(documentStatus(doc(D1, "a"), true).key).toBe("processing");
  });

  it("retry: shows Processing only while the request runs, then the status the database now reports", async () => {
    let release;
    const gate = new Promise((r) => { release = r; });
    let current = [FAILED];
    serve({
      docs: () => current,
      reprocess: async () => { await gate; current = [{ ...FAILED, graphIngestion: ingestion("processed", { entityCount: 5, relationshipCount: 2, processedAt: "2026-10-01T10:00:00.000Z" }) }]; return { success: true, graph: { status: "processed", entities: 5, relationships: 2, relationshipStatus: "extracted" } }; },
    });
    renderPage();
    await screen.findByText("roadmap.docx");

    fireEvent.click(within(card(D2)).getByText("Retry"));
    await waitFor(() => expect(card(D2).querySelector("[data-status]").getAttribute("data-status")).toBe("processing"));
    expect(api).toHaveBeenCalledWith(`/api/graph/documents/${D2}/reprocess`, { method: "POST" });
    expect(within(card(D2)).getByText("Retry").closest("button").disabled).toBe(true);

    release();
    await waitFor(() => expect(card(D2).querySelector("[data-status]").getAttribute("data-status")).toBe("processed"));
    expect(within(card(D2)).getByText("5 entities · 2 relationships")).toBeTruthy();
    expect(toast.success).toHaveBeenCalledWith('"roadmap.docx" processed: 5 entities, 2 relationships');
  });

  it("retry that fails again reports the backend message and keeps the failed status", async () => {
    serve({
      docs: [FAILED],
      reprocess: async () => ({ success: true, graph: { status: "failed", entities: 0, relationships: 0, code: "NLP_CHUNK_FAILED", message: "Some parts of the document could not be analysed. Reprocess it to try again." } }),
    });
    renderPage();
    await screen.findByText("roadmap.docx");
    fireEvent.click(within(card(D2)).getByText("Retry"));
    await waitFor(() => expect(toast.error).toHaveBeenCalled());
    expect(toast.error.mock.calls[0][0]).toContain("failed");
    await waitFor(() => expect(card(D2).querySelector("[data-status]").getAttribute("data-status")).toBe("failed"));
  });

  it("retry request error (e.g. 404, network) is shown and the card leaves the Processing state", async () => {
    serve({ docs: [FAILED], reprocess: async () => { throw new Error("Document not found"); } });
    renderPage();
    await screen.findByText("roadmap.docx");
    fireEvent.click(within(card(D2)).getByText("Retry"));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith("Document not found"));
    await waitFor(() => expect(card(D2).querySelector("[data-status]").getAttribute("data-status")).toBe("failed"));
  });
});

describe("KnowledgeBase: document details, entities and relationships", () => {
  it("loads the document and ITS graph, and renders real entities and relationships", async () => {
    serve({ docs: [PROCESSED] });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    const dialog = await screen.findByRole("dialog");

    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/documents/${D1}`));
    expect(api).toHaveBeenCalledWith(`/api/graph?limit=200&documentId=${D1}`);

    expect(await within(dialog).findByText(/Priya Rao resolved the login issue\./)).toBeTruthy(); // text preview
    expect(within(dialog).getByText("1,500 characters")).toBeTruthy();
    expect(await within(dialog).findByText("login issue")).toBeTruthy();
    expect(within(dialog).getByText("PERSON (1)")).toBeTruthy();
    expect(within(dialog).getByText("ISSUE (1)")).toBeTruthy();
    expect(within(dialog).getByText("3 entities · 2 relationships")).toBeTruthy();
    expect(dialog.querySelectorAll("[data-entity]").length).toBe(3);

    const rels = [...dialog.querySelectorAll("[data-relationship]")].map((el) => el.textContent);
    expect(rels).toEqual(["Priya Rao → login issueRESOLVED · 96%", "login issue → Project PhoenixBELONGS_TO · 90%"]);

    // navigation to the related graph information
    expect(within(dialog).getByText("Open in Knowledge Graph").closest("a").getAttribute("href")).toBe(`/app/graph?documentId=${D1}`);
  });

  it("entities without relationships: says so and draws no relationship", async () => {
    serve({ docs: [PROCESSED], graph: { ...GRAPH, edges: [], stats: { entities: 3, relationships: 0 } } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText(/No relationships were extracted from this document/)).toBeTruthy();
    expect(dialog.querySelectorAll("[data-relationship]").length).toBe(0);
    expect(dialog.querySelectorAll("[data-entity]").length).toBe(3);
  });

  it("says when the list is truncated instead of implying it is complete", async () => {
    serve({ docs: [PROCESSED], graph: { ...GRAPH, truncated: true, stats: { entities: 450, relationships: 300 } } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    expect(await screen.findByText("Showing the 3 most connected of 450 entities · 300 relationships")).toBeTruthy();
  });

  it("no entities stored: says so; graph not enabled: says so", async () => {
    serve({ docs: [UPLOADED], graph: { ...GRAPH, nodes: [], edges: [], stats: { entities: 0, relationships: 0 } } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    expect(await screen.findByText("No entities are stored in the knowledge graph for this document.")).toBeTruthy();
    expect(screen.queryByText("Open in Knowledge Graph")).toBeNull();

    cleanup();
    serve({ docs: [UPLOADED], graph: { success: true, enabled: false, nodes: [], edges: [], stats: { entities: 0, relationships: 0 }, truncated: false } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    expect(await screen.findByText(/The knowledge graph is not enabled on the server/)).toBeTruthy();
  });

  it("a graph error does not hide the document details", async () => {
    serve({ docs: [PROCESSED], graph: () => { throw new Error("The knowledge graph database is currently unavailable."); } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    const dialog = await screen.findByRole("dialog");
    expect(await within(dialog).findByText("The knowledge graph database is currently unavailable.")).toBeTruthy();
    expect(await within(dialog).findByText(/Priya Rao resolved the login issue\./)).toBeTruthy();
    expect(within(dialog).getByText("incident-review.pdf")).toBeTruthy();
  });

  it("a failed document shows its error and a retry inside the details; closing works", async () => {
    serve({ docs: [FAILED], graph: { ...GRAPH, nodes: [], edges: [], stats: { entities: 0, relationships: 0 } } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Some parts of the document could not be analysed\./)).toBeTruthy();
    expect(within(dialog).getByText("Retry processing")).toBeTruthy();
    fireEvent.click(within(dialog).getByLabelText("Close"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("KnowledgeBase: tenant safety on the client", () => {
  it("never sends a company id: every request path and body is free of it, and ids come only from the API", async () => {
    serve({ docs: [FAILED], reprocess: async () => ({ success: true, graph: { status: "processed", entities: 1, relationships: 0 } }) });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    await screen.findByRole("dialog");
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/graph?limit=200&documentId=${D2}`));
    fireEvent.click(within(screen.getByRole("dialog")).getByText("Retry processing"));
    await waitFor(() => expect(api).toHaveBeenCalledWith(`/api/graph/documents/${D2}/reprocess`, { method: "POST" }));

    for (const [path, options] of api.mock.calls) {
      expect(String(path)).not.toMatch(/company/i);
      expect(JSON.stringify(options ?? {})).not.toMatch(/company/i);
    }
  });

  it("a document that the API no longer returns (e.g. foreign or deleted) shows an error in the details, not data", async () => {
    serve({ docs: [PROCESSED] });
    api.mockImplementation(async (path) => {
      if (path === "/api/documents") return { success: true, documents: [PROCESSED] };
      if (path.startsWith("/api/documents/")) throw new Error("Document not found");
      if (path.startsWith("/api/graph?")) throw new Error("Document not found");
      throw new Error("unexpected");
    });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    const dialog = await screen.findByRole("dialog");
    await waitFor(() => expect(within(dialog).getAllByText("Document not found").length).toBe(2));
    expect(dialog.querySelectorAll("[data-entity]").length).toBe(0);
  });
});

describe("KnowledgeBase: role-based controls (the server enforces the same rule; the UI just does not offer what would be refused)", () => {
  it("a member sees the status of every document but no Retry / Process button on the cards", async () => {
    auth.isAdmin = false;
    serve({ docs: [PROCESSED, FAILED, SKIPPED, UPLOADED] });
    renderPage();
    await screen.findByText("roadmap.docx");
    expect(within(card(D2)).getByText(/failed/i)).toBeTruthy(); // the status itself is still visible
    for (const id of [D1, D2, D3, D5]) {
      expect(within(card(id)).queryByText("Retry")).toBeNull();
      expect(within(card(id)).queryByText("Process")).toBeNull();
    }
    expect(within(card(D2)).getByText("View")).toBeTruthy();
  });

  it("a member never triggers a reprocess request, and the details dialog has no retry either", async () => {
    auth.isAdmin = false;
    serve({ docs: [FAILED], graph: { ...GRAPH, nodes: [], edges: [], stats: { entities: 0, relationships: 0 } } });
    renderPage();
    fireEvent.click(await screen.findByText("View"));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByText(/Some parts of the document could not be analysed\./)).toBeTruthy();
    expect(within(dialog).queryByText("Retry processing")).toBeNull();
    expect(within(dialog).queryByText("Process now")).toBeNull();
    expect(api.mock.calls.some(([path, options]) => path.includes("/reprocess") && options?.method === "POST")).toBe(false);
  });

  it("an administrator still gets the buttons", async () => {
    auth.isAdmin = true;
    serve({ docs: [FAILED, UPLOADED] });
    renderPage();
    await screen.findByText("roadmap.docx");
    expect(within(card(D2)).getByText("Retry")).toBeTruthy();
    expect(within(card(D5)).getByText("Process")).toBeTruthy();
  });
});
