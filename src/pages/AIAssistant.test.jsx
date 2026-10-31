import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation } from "react-router-dom";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

import AIAssistant from "./AIAssistant";

const ANSWER = {
  success: true, grounded: true, answer: "Refunds are issued within **14 days**.",
  sources: [{ ref: 1, kind: "chunk", documentId: "d1", documentName: "refund-policy.pdf", chunkIndex: 2, text: "Refunds are issued within 14 days of purchase.", startChar: 10, endChar: 60, score: 0.8 }],
  retrieval: { vector: { status: "ok", chunks: 1 }, graph: { status: "ok", facts: 0 } },
};

function Probe() {
  const loc = useLocation();
  return <div data-testid="nav-state">{loc.state ? JSON.stringify(loc.state) : "no-state"}</div>;
}
const renderAt = (state, { strict = false } = {}) => {
  const tree = (
    <MemoryRouter initialEntries={[{ pathname: "/app/assistant", state }]}>
      <Routes><Route path="/app/assistant" element={<><AIAssistant /><Probe /></>} /></Routes>
    </MemoryRouter>
  );
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
};
const askCalls = () => api.mock.calls.filter((c) => c[0] === "/api/ask");

beforeEach(() => {
  cleanup();
  api.mockReset();
  Element.prototype.scrollIntoView = vi.fn(); // not implemented by jsdom
});

describe("AI Assistant: question handed over from the Dashboard", () => {
  it("asks it once through POST /api/ask, shows the answer and its citation, and clears the navigation state", async () => {
    api.mockResolvedValue(ANSWER);
    renderAt({ question: "What is our refund policy?" });

    expect(await screen.findByText("14 days")).toBeTruthy(); // rendered answer (bold part)
    expect(screen.getByText("What is our refund policy?")).toBeTruthy(); // the user's message
    expect(screen.getAllByText("refund-policy.pdf").length).toBeGreaterThan(0); // citation
    expect(screen.getAllByText(/Refunds are issued within 14 days of purchase\./).length).toBeGreaterThan(0); // evidence excerpt

    expect(askCalls()).toHaveLength(1);
    const [path, options] = askCalls()[0];
    expect(path).toBe("/api/ask");
    expect(options.method).toBe("POST");
    expect(JSON.parse(options.body)).toEqual({ question: "What is our refund policy?" }); // question only: never a companyId
    await waitFor(() => expect(screen.getByTestId("nav-state").textContent).toBe("no-state"));
  });

  it("is sent only once even under React StrictMode (double effects)", async () => {
    api.mockResolvedValue(ANSWER);
    renderAt({ question: "Strict question" }, { strict: true });
    await screen.findByText("14 days");
    expect(askCalls()).toHaveLength(1);
  });

  it("an over-long question is cut to the backend's 1000-character limit", async () => {
    api.mockResolvedValue(ANSWER);
    renderAt({ question: "x".repeat(1500) });
    await screen.findByText("14 days");
    expect(JSON.parse(askCalls()[0][1].body).question).toHaveLength(1000);
  });

  it("a not-grounded answer shows the backend's reason hint and no sources", async () => {
    api.mockResolvedValue({ success: true, grounded: false, reason: "not_indexed", answer: "I couldn't search your documents because none of them are indexed yet.", sources: [], retrieval: {} });
    renderAt({ question: "Anything?" });
    expect(await screen.findByText(/none of them are indexed yet/)).toBeTruthy();
    expect(screen.getByText(/Nothing is searchable yet/)).toBeTruthy();
  });

  it("an API error is shown and the question is put back in the composer so it can be retried", async () => {
    api.mockRejectedValue(new Error("The AI service is not configured."));
    renderAt({ question: "Will this fail?" });
    expect((await screen.findByRole("alert")).textContent).toContain("The AI service is not configured.");
    expect(screen.getByPlaceholderText(/Ask a question about your company/).value).toBe("Will this fail?");
    expect(screen.queryByText("14 days")).toBeNull();
  });

  it("without a handed-over question nothing is sent; a typed question still works and sends only the question", async () => {
    api.mockResolvedValue(ANSWER);
    renderAt(undefined);
    expect(askCalls()).toHaveLength(0);
    const box = screen.getByPlaceholderText(/Ask a question about your company/);
    fireEvent.change(box, { target: { value: "Typed question" } });
    fireEvent.click(screen.getByRole("button", { name: /Ask/ }));
    await screen.findByText("14 days");
    expect(askCalls()).toHaveLength(1);
    expect(JSON.parse(askCalls()[0][1].body)).toEqual({ question: "Typed question" });
  });

  it("ignores a navigation state that is not a question string", async () => {
    api.mockResolvedValue(ANSWER);
    renderAt({ question: { evil: true } });
    expect(askCalls()).toHaveLength(0);
    renderAt({ question: "   " });
    await waitFor(() => expect(askCalls()).toHaveLength(0));
  });
});
