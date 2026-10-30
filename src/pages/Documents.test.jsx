// Delete and re-index are administrator-only on the server (DELETE /api/documents/:id, POST /api/documents/:id/reindex).
// This checks that the page only OFFERS them to administrators. Hiding a button is a convenience, never the security:
// the server refuses the request from a member anyway (see server/src/routes/rbac.test.js).
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup, within } from "@testing-library/react";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));
const toast = { success: vi.fn(), error: vi.fn() };
vi.mock("sonner", () => ({ toast: { success: (...a) => toast.success(...a), error: (...a) => toast.error(...a) } }));
const auth = { isAdmin: false };
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));

import Documents from "./Documents";

const D1 = "11111111-1111-4111-8111-111111111111";
const DOC = {
  id: D1, originalName: "handbook.pdf", fileType: "PDF", mimeType: "application/pdf", fileSize: 2048,
  cloudinaryUrl: "https://files.example/handbook.pdf", uploader: { id: "u1", name: "Priya Rao" }, createdAt: "2026-09-01T10:00:00.000Z",
};

function serve() {
  api.mockImplementation(async (path) => {
    if (path === "/api/documents") return { success: true, documents: [DOC] };
    if (path === `/api/documents/${D1}`) return { success: true, document: { ...DOC, textLength: 5, textPreview: "hello" } };
    throw new Error(`unexpected request ${path}`);
  });
}

beforeEach(() => { cleanup(); api.mockReset(); toast.success.mockReset(); toast.error.mockReset(); auth.isAdmin = false; });

describe("Documents: role-based controls", () => {
  it("a member can browse and open documents but sees no Delete or Re-index control (row or details)", async () => {
    serve();
    render(<Documents />);
    fireEvent.click(await screen.findByText("handbook.pdf"));
    await screen.findByText("hello"); // the details panel is open
    expect(screen.queryByTitle("Delete")).toBeNull();
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Re-index")).toBeNull();
    expect(screen.getByTitle("Open / download")).toBeTruthy(); // reading is still allowed
    expect(api.mock.calls.some(([, options]) => options?.method === "DELETE" || options?.method === "POST")).toBe(false);
  });

  it("an administrator sees Delete in the row and both Delete and Re-index in the details", async () => {
    auth.isAdmin = true;
    serve();
    render(<Documents />);
    await screen.findByText("handbook.pdf");
    expect(screen.getByTitle("Delete")).toBeTruthy();
    fireEvent.click(screen.getByText("handbook.pdf"));
    await screen.findByText("hello");
    expect(screen.getByText("Re-index")).toBeTruthy();
    expect(screen.getAllByText("Delete").length).toBe(1); // the details button (the row one is an icon with a title)
  });

  it("an administrator's Re-index calls the admin endpoint", async () => {
    auth.isAdmin = true;
    serve();
    api.mockImplementation(async (path, options) => {
      if (path === "/api/documents") return { success: true, documents: [DOC] };
      if (path === `/api/documents/${D1}` && !options) return { success: true, document: { ...DOC, textLength: 5, textPreview: "hello" } };
      if (path === `/api/documents/${D1}/reindex` && options?.method === "POST") return { success: true, indexing: { status: "indexed", chunks: 3 } };
      throw new Error(`unexpected request ${path}`);
    });
    render(<Documents />);
    fireEvent.click(await screen.findByText("handbook.pdf"));
    await screen.findByText("hello");
    fireEvent.click(screen.getByText("Re-index"));
    await waitFor(() => expect(toast.success).toHaveBeenCalled());
    expect(within(document.body).queryByText(/permission/i)).toBeNull();
  });
});
