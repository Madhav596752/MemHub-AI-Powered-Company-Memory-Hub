// Sidebar / auth tests (jsdom). The backend is faked at the fetch level, so the real
// AuthContext, api.js and Sidebar run together. jsdom has no layout engine, so these tests
// prove behaviour (name shown, menu opens, logout clears the session) but NOT pixel visibility.
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import { AuthProvider } from "@/contexts/AuthContext";
import Sidebar from "@/components/Sidebar";

const USER = { id: "u1", name: "Zoya Khan", email: "zoya@globex.test", role: "MEMBER", companyId: "c1", companyName: "Globex Ltd" };

function fakeBackend() {
  globalThis.fetch = vi.fn(async (url) => {
    if (String(url).endsWith("/api/auth/me")) return { ok: true, status: 200, json: async () => USER };
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

function renderApp() {
  return render(
    <MemoryRouter initialEntries={["/app"]}>
      <AuthProvider>
        <Routes>
          <Route path="/app" element={<Sidebar collapsed={false} onToggle={() => {}} />} />
          <Route path="/login" element={<p>LOGIN PAGE</p>} />
        </Routes>
      </AuthProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  cleanup();
  localStorage.clear();
  localStorage.setItem("memhub_access_token", "access-123");
  localStorage.setItem("memhub_refresh_token", "refresh-456");
  fakeBackend();
});

describe("Sidebar user display + logout", () => {
  it("shows the name and company returned by /api/auth/me (nothing hard-coded)", async () => {
    renderApp();
    expect(await screen.findByText("Zoya Khan")).toBeTruthy();
    expect(screen.getByText("Globex Ltd")).toBeTruthy();
    expect(screen.getByText("ZK")).toBeTruthy(); // initials derived from the real name
    for (const demo of ["Madhav", "Rahul", "Priya", "Acme"]) expect(screen.queryByText(new RegExp(demo))).toBeNull();
  });

  it("opens the profile menu with a Logout item", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Zoya Khan"));
    expect(screen.getByText("Logout")).toBeTruthy();
  });

  it("Logout clears both tokens and the user, then goes to /login", async () => {
    renderApp();
    fireEvent.click(await screen.findByText("Zoya Khan"));
    fireEvent.click(screen.getByText("Logout"));
    await waitFor(() => expect(screen.getByText("LOGIN PAGE")).toBeTruthy());
    expect(localStorage.getItem("memhub_access_token")).toBeNull();
    expect(localStorage.getItem("memhub_refresh_token")).toBeNull();
    expect(localStorage.getItem("memhub_password")).toBeNull();
  });

  it("the sidebar uses the dynamic viewport height so the profile/logout area is not pushed off mobile screens", async () => {
    const { container } = renderApp();
    await screen.findByText("Zoya Khan");
    expect(container.querySelector("aside").className).toContain("h-dvh");
  });
});
