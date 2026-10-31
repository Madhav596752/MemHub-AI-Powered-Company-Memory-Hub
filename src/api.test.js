// api.js token handling (jsdom). The backend is faked at the fetch level; the real api.js runs.
// Covers: access-token refresh + retry, refresh-token ROTATION (the new refresh token replaces the stored one),
// parallel 401s sharing ONE refresh request (refresh tokens are single-use), another tab having refreshed
// already, failed refresh, and compatibility with a server that does not rotate.
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { api, ACCESS_KEY, REFRESH_KEY } from "@/api";

const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

let calls;
function backend(handler) {
  calls = [];
  globalThis.fetch = vi.fn(async (url, options = {}) => {
    const entry = { url: String(url), method: options.method || "GET", headers: options.headers || {}, body: options.body ? JSON.parse(options.body) : undefined };
    calls.push(entry);
    return handler(entry);
  });
}

beforeEach(() => {
  localStorage.clear();
  localStorage.setItem(ACCESS_KEY, "access-old");
  localStorage.setItem(REFRESH_KEY, "refresh-1");
});
afterEach(() => vi.restoreAllMocks());

describe("api(): refresh-token rotation", () => {
  it("on 401 refreshes once, stores BOTH new tokens, and retries the request with the new access token", async () => {
    backend((c) => {
      if (c.url === "/api/auth/refresh") return json(200, { accessToken: "access-new", refreshToken: "refresh-2" });
      return c.headers.Authorization === "Bearer access-new" ? json(200, { data: "secret stuff" }) : json(401, { message: "Invalid or expired token" });
    });
    const result = await api("/api/documents");
    expect(result).toEqual({ data: "secret stuff" });
    expect(localStorage.getItem(ACCESS_KEY)).toBe("access-new");
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-2"); // rotated token replaces the used one
    expect(calls.find((c) => c.url === "/api/auth/refresh").body).toEqual({ refreshToken: "refresh-1" });
  });

  it("parallel requests that all get 401 share ONE refresh call (a second call would replay the used token)", async () => {
    backend((c) => {
      if (c.url === "/api/auth/refresh") return json(200, { accessToken: "access-new", refreshToken: "refresh-2" });
      return c.headers.Authorization === "Bearer access-new" ? json(200, { ok: c.url }) : json(401, {});
    });
    const results = await Promise.all([api("/api/documents"), api("/api/users"), api("/api/auth/me")]);
    expect(results.map((r) => r.ok)).toEqual(["/api/documents", "/api/users", "/api/auth/me"]);
    expect(calls.filter((c) => c.url === "/api/auth/refresh")).toHaveLength(1);
  });

  it("if another tab already refreshed (stored access token changed) it uses that token and does NOT send the refresh token", async () => {
    backend((c) => {
      if (c.url === "/api/auth/refresh") return json(500, {});
      if (c.headers.Authorization === "Bearer access-old") {
        // meanwhile another tab stored fresh tokens
        localStorage.setItem(ACCESS_KEY, "access-from-other-tab");
        localStorage.setItem(REFRESH_KEY, "refresh-from-other-tab");
        return json(401, {});
      }
      return c.headers.Authorization === "Bearer access-from-other-tab" ? json(200, { ok: true }) : json(401, {});
    });
    expect(await api("/api/documents")).toEqual({ ok: true });
    expect(calls.some((c) => c.url === "/api/auth/refresh")).toBe(false);
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-from-other-tab");
  });

  it("uses the Web Locks API when the browser has it (so tabs cannot refresh at the same time)", async () => {
    const request = vi.fn(async (name, cb) => cb());
    Object.defineProperty(globalThis.navigator, "locks", { value: { request }, configurable: true });
    try {
      backend((c) => {
        if (c.url === "/api/auth/refresh") return json(200, { accessToken: "access-new", refreshToken: "refresh-2" });
        return c.headers.Authorization === "Bearer access-new" ? json(200, { ok: true }) : json(401, {});
      });
      await api("/api/documents");
      expect(request).toHaveBeenCalledTimes(1);
      expect(request.mock.calls[0][0]).toBe("memhub-token-refresh");
    } finally {
      delete globalThis.navigator.locks;
    }
  });

  it("when the refresh is rejected the user gets the existing 'session expired' error", async () => {
    backend((c) => (c.url === "/api/auth/refresh" ? json(401, { message: "Invalid or expired refresh token" }) : json(401, {})));
    await expect(api("/api/documents")).rejects.toThrow("Your session has expired. Please log in again.");
  });

  it("still works with a server that returns only an access token (no rotation)", async () => {
    backend((c) => {
      if (c.url === "/api/auth/refresh") return json(200, { accessToken: "access-new" });
      return c.headers.Authorization === "Bearer access-new" ? json(200, { ok: true }) : json(401, {});
    });
    expect(await api("/api/documents")).toEqual({ ok: true });
    expect(localStorage.getItem(REFRESH_KEY)).toBe("refresh-1"); // unchanged
  });

  it("login / register 401s are credential errors: no refresh attempt", async () => {
    backend(() => json(401, { message: "Invalid email or password" }));
    await expect(api("/api/auth/login", { method: "POST", body: JSON.stringify({ email: "a", password: "b" }) })).rejects.toThrow("Invalid email or password");
    expect(calls).toHaveLength(1);
  });

  it("a rate-limit response (429) shows the server's message", async () => {
    backend(() => json(429, { success: false, message: "Too many requests. Please wait a moment and try again." }));
    await expect(api("/api/ask", { method: "POST", body: "{}" })).rejects.toThrow("Too many requests. Please wait a moment and try again.");
  });
});
