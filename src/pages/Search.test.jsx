import React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route, useLocation, useNavigate } from "react-router-dom";
import pageSource from "./Search.jsx?raw";

const api = vi.fn();
vi.mock("@/api", () => ({ api: (...args) => api(...args) }));

// Who is logged in. Only logout() matters to this page (the "Log in again" button after an expired session).
const auth = { logout: vi.fn() };
vi.mock("@/contexts/AuthContext", () => ({ useAuth: () => auth }));

import SearchPage from "./Search";

const DOC_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const DOC_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

// Exactly the shape POST /api/search returns (server/src/routes/search.js).
const hit = (documentId, documentName, text, chunkIndex, score, extra = {}) => ({
  documentId, documentName, text, chunkIndex, startChar: chunkIndex * 800, endChar: chunkIndex * 800 + text.length, distance: 1 - score, score, ...extra,
});
const REFUND = hit(DOC_A, "refund-policy.pdf", "Customers can request a refund within 14 days of purchase.", 2, 0.82);
const KITCHEN = hit(DOC_B, "office-rules.docx", "Please label your food in the shared fridge.", 0, 0.31);
const RESULTS = { success: true, query: "refund", results: [REFUND, KITCHEN] };

const SESSION_EXPIRED = "Your session has expired. Please log in again.";

// Shows the current URL so the tests can check the ?q= synchronisation.
function Probe() {
  const loc = useLocation();
  const navigate = useNavigate();
  return (
    <>
      <div data-testid="url">{loc.pathname + loc.search}</div>
      <button onClick={() => navigate("/app/search?q=from-topbar")}>topbar-search</button>
    </>
  );
}
const renderAt = (url, { strict = false } = {}) => {
  const tree = (
    <MemoryRouter initialEntries={[url]}>
      <Routes>
        <Route path="/app/search" element={<><SearchPage /><Probe /></>} />
        <Route path="/login" element={<div>login page</div>} />
      </Routes>
    </MemoryRouter>
  );
  return render(strict ? <React.StrictMode>{tree}</React.StrictMode> : tree);
};
const searchCalls = () => api.mock.calls.filter((c) => c[0] === "/api/search");
const bodyOf = (call) => JSON.parse(call[1].body);
const box = () => screen.getByPlaceholderText(/Search your company's memory/);
const type = (value) => fireEvent.change(box(), { target: { value } });
const submit = () => fireEvent.submit(box().closest("form"));
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

beforeEach(() => {
  cleanup();
  api.mockReset();
  auth.logout.mockReset();
});

describe("Search page: no mock data", () => {
  it("does not import mockData and shows none of the old sample results", async () => {
    expect(pageSource).not.toMatch(/mockData/);
    api.mockResolvedValue({ success: true, query: "authentication", results: [] });
    renderAt("/app/search?q=authentication");
    await screen.findByText(/No results for/);
    for (const sample of ["Authentication Architecture", "Session Invalidation Strategy", "Q1 Product Priorities", "sample results"]) {
      expect(screen.queryByText(new RegExp(sample))).toBeNull();
    }
  });

  it("starts empty: nothing is searched until a query exists, and no default query is filled in", () => {
    renderAt("/app/search");
    expect(box().value).toBe("");
    expect(searchCalls()).toHaveLength(0);
    expect(screen.getByText(/press Enter to search your uploaded documents/)).toBeTruthy();
  });
});

describe("Search page: successful search", () => {
  it("calls POST /api/search with only { query, limit: 5 } and renders the backend results", async () => {
    api.mockResolvedValue(RESULTS);
    renderAt("/app/search?q=refund");

    expect(await screen.findByText("refund-policy.pdf")).toBeTruthy();
    expect(searchCalls()).toHaveLength(1);
    const [path, options] = searchCalls()[0];
    expect(path).toBe("/api/search");
    expect(options.method).toBe("POST");
    expect(bodyOf(searchCalls()[0])).toEqual({ query: "refund", limit: 5 });

    // document name, chunk text, relevance score and document ID of every result
    expect(screen.getByText("Customers can request a refund within 14 days of purchase.")).toBeTruthy();
    expect(screen.getByText("82%")).toBeTruthy();
    expect(screen.getByText(`ID ${DOC_A}`)).toBeTruthy();
    expect(screen.getByText("office-rules.docx")).toBeTruthy();
    expect(screen.getByText("31%")).toBeTruthy();
    expect(screen.getByText(`ID ${DOC_B}`)).toBeTruthy();
    expect(screen.getByText(/2 results for “refund”/)).toBeTruthy();
    expect(screen.getByText("PDF")).toBeTruthy(); // file type comes from the real document name
    expect(screen.getByText(/chunk 3 · chars 1600–/)).toBeTruthy(); // chunkIndex 2 -> "chunk 3"
    expect(document.querySelectorAll("article[data-document-id]").length).toBe(2);
  });

  it("submitting the form searches, puts the query in the URL and sends the trimmed text", async () => {
    api.mockResolvedValue(RESULTS);
    renderAt("/app/search");
    type("  refund policy  ");
    submit();

    await screen.findByText("refund-policy.pdf");
    expect(screen.getByTestId("url").textContent).toBe("/app/search?q=refund+policy");
    expect(searchCalls()).toHaveLength(1);
    expect(bodyOf(searchCalls()[0]).query).toBe("refund policy");
  });

  it("a search started from elsewhere (the top-bar box navigates to ?q=) runs while the page is already open", async () => {
    api.mockResolvedValue(RESULTS);
    renderAt("/app/search?q=refund");
    await screen.findByText("refund-policy.pdf");

    fireEvent.click(screen.getByText("topbar-search"));
    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    expect(bodyOf(searchCalls()[1]).query).toBe("from-topbar");
    expect(box().value).toBe("from-topbar"); // the input follows the URL
  });

  it("a blank submit sends nothing", () => {
    renderAt("/app/search");
    type("   ");
    submit();
    expect(searchCalls()).toHaveLength(0);
  });

  it("an over-long query in the URL is cut to the backend's 1000-character limit", async () => {
    api.mockResolvedValue({ success: true, results: [] });
    renderAt(`/app/search?q=${"x".repeat(1500)}`);
    await screen.findByText(/No results for/);
    expect(bodyOf(searchCalls()[0]).query).toHaveLength(1000);
  });
});

describe("Search page: loading, duplicates and stale answers", () => {
  it("shows a loading state while the request is running, then the results", async () => {
    const d = deferred();
    api.mockReturnValue(d.promise);
    renderAt("/app/search?q=refund");
    expect(screen.getByRole("status").textContent).toMatch(/Searching your documents/);
    expect(screen.queryByText("refund-policy.pdf")).toBeNull();

    d.resolve(RESULTS);
    expect(await screen.findByText("refund-policy.pdf")).toBeTruthy();
    expect(screen.queryByText(/Searching your documents/)).toBeNull();
  });

  it("pressing Enter again on the same query while it is running does not send a second request", async () => {
    const d = deferred();
    api.mockReturnValue(d.promise);
    renderAt("/app/search");
    type("refund");
    submit();
    submit();
    submit();
    await waitFor(() => expect(searchCalls()).toHaveLength(1));
    d.resolve(RESULTS);
    await screen.findByText("refund-policy.pdf");
    expect(searchCalls()).toHaveLength(1);
  });

  it("is sent only once on load even under React StrictMode (double effects)", async () => {
    api.mockResolvedValue(RESULTS);
    renderAt("/app/search?q=refund", { strict: true });
    await screen.findByText("refund-policy.pdf");
    expect(searchCalls()).toHaveLength(1);
  });

  it("searching the same query again after it finished does search again (e.g. after uploading a document)", async () => {
    api.mockResolvedValue(RESULTS);
    renderAt("/app/search?q=refund");
    await screen.findByText("refund-policy.pdf");
    submit();
    await waitFor(() => expect(searchCalls()).toHaveLength(2));
    await screen.findByText("refund-policy.pdf");
  });

  it("a late answer to an OLD search never replaces the results of the newer one", async () => {
    const first = deferred();
    const second = deferred();
    api.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise);
    renderAt("/app/search?q=old");
    await waitFor(() => expect(searchCalls()).toHaveLength(1));

    type("new");
    submit();
    await waitFor(() => expect(searchCalls()).toHaveLength(2));

    second.resolve({ success: true, results: [KITCHEN] });
    await screen.findByText("office-rules.docx");
    first.resolve({ success: true, results: [REFUND] }); // arrives late
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.queryByText("refund-policy.pdf")).toBeNull();
    expect(screen.getByText("office-rules.docx")).toBeTruthy();
    expect(screen.getByText(/1 result for “new”/)).toBeTruthy();
  });
});

describe("Search page: empty results", () => {
  it("shows an empty state (and no cards) when the backend finds nothing", async () => {
    api.mockResolvedValue({ success: true, query: "nothing", results: [] });
    renderAt("/app/search?q=nothing");
    expect(await screen.findByText(/No results for “nothing”/)).toBeTruthy();
    expect(screen.getByText(/uploaded and indexed/)).toBeTruthy();
    expect(document.querySelectorAll("article").length).toBe(0);
    expect(screen.queryByRole("alert")).toBeNull();
  });
});

describe("Search page: errors", () => {
  it("embedding service unavailable: shows the server's message as an error (not as 'no results') and can retry", async () => {
    api.mockRejectedValueOnce(new Error("The embedding service is currently unavailable. Please try again later."));
    renderAt("/app/search?q=refund");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("The embedding service is currently unavailable. Please try again later.");
    expect(screen.queryByText(/No results for/)).toBeNull();
    expect(document.querySelectorAll("article").length).toBe(0);
    expect(screen.queryByText("Log in again")).toBeNull(); // not an auth problem

    api.mockResolvedValue(RESULTS);
    fireEvent.click(screen.getByText("Try again"));
    expect(await screen.findByText("refund-policy.pdf")).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
    expect(searchCalls()).toHaveLength(2);
  });

  it("an unexpected server error and a network failure are shown as errors too", async () => {
    api.mockRejectedValueOnce(new Error("Something went wrong on our side. Please try again."));
    renderAt("/app/search?q=a");
    expect((await screen.findByRole("alert")).textContent).toContain("Something went wrong on our side");
    cleanup();
    api.mockRejectedValueOnce(new Error("Cannot reach the server. Please try again."));
    renderAt("/app/search?q=b");
    expect((await screen.findByRole("alert")).textContent).toContain("Cannot reach the server");
  });

  it("a malformed response is an error, never an empty result list", async () => {
    api.mockResolvedValue({ success: true });
    renderAt("/app/search?q=refund");
    expect((await screen.findByRole("alert")).textContent).toContain("unexpected response");
    expect(screen.queryByText(/No results for/)).toBeNull();
  });

  it("authentication failure: shows the expired-session error and 'Log in again' clears the session and opens /login", async () => {
    api.mockRejectedValue(new Error(SESSION_EXPIRED));
    renderAt("/app/search?q=refund");

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain(SESSION_EXPIRED);
    expect(document.querySelectorAll("article").length).toBe(0); // no results leak next to the error
    expect(auth.logout).not.toHaveBeenCalled(); // not logged out behind the user's back (a refresh may only have failed on the network)

    fireEvent.click(screen.getByText("Log in again"));
    expect(auth.logout).toHaveBeenCalledTimes(1);
    expect(await screen.findByText("login page")).toBeTruthy();
  });
});

describe("Search page: company isolation (what the page itself is responsible for)", () => {
  // The vector-level filter and the PostgreSQL re-check live in the backend and are proven by
  // server/src/pipeline.test.js ("two companies ...") and rag.integration.test.js. The page must never help a
  // client choose a company, and must show exactly what the server returned for the signed-in company.
  it("never sends a companyId, even when the URL carries one", async () => {
    api.mockResolvedValue(RESULTS);
    renderAt("/app/search?q=salary&companyId=other-company&limit=20");
    await screen.findByText("refund-policy.pdf");
    expect(bodyOf(searchCalls()[0])).toEqual({ query: "salary", limit: 5 });
    expect(JSON.stringify(searchCalls()[0])).not.toMatch(/other-company/);
  });

  it("renders only the documents the server returned (nothing is added from local data)", async () => {
    api.mockResolvedValue({ success: true, results: [KITCHEN] });
    renderAt("/app/search?q=fridge");
    await screen.findByText("office-rules.docx");
    expect(document.querySelectorAll("article").length).toBe(1);
    expect(screen.queryByText("refund-policy.pdf")).toBeNull();
  });
});

describe("Search page: controls that the backend cannot support are not faked", () => {
  it("Semantic is the active mode; Keyword and the category filters are disabled with an explanation", () => {
    renderAt("/app/search");
    expect(screen.getByRole("button", { name: /Semantic/ }).getAttribute("aria-pressed")).toBe("true");
    const keyword = screen.getByRole("button", { name: /Keyword/ });
    expect(keyword.disabled).toBe(true);
    expect(keyword.title).toMatch(/not available/i);
    for (const name of ["Technical Docs", "Meetings", "Projects"]) {
      const f = screen.getByRole("button", { name });
      expect(f.disabled).toBe(true);
      expect(f.title).toMatch(/cannot filter/i);
    }
  });

  it("clicking a disabled filter does not search", () => {
    renderAt("/app/search");
    fireEvent.click(screen.getByRole("button", { name: "Meetings" }));
    fireEvent.click(screen.getByRole("button", { name: /Keyword/ }));
    expect(searchCalls()).toHaveLength(0);
  });
});