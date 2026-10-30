// Very small fetch helper for talking to the MemHub backend.
// In development, Vite proxies /api to http://localhost:5000 (see vite.config.js),
// so VITE_API_URL can stay empty. Set it only if the API is on another URL.
const API_URL = import.meta.env.VITE_API_URL || "";

export const ACCESS_KEY = "memhub_access_token";
export const REFRESH_KEY = "memhub_refresh_token";

async function send(path, options = {}, token) {
  const headers = {};
  // File uploads send FormData: the browser must set the multipart Content-Type itself
  if (!(options.body instanceof FormData)) headers["Content-Type"] = "application/json";
  if (token) headers.Authorization = `Bearer ${token}`;

  let res;
  try {
    res = await fetch(`${API_URL}${path}`, { ...options, headers });
  } catch {
    // Network failure / server down: show a simple message, not "Failed to fetch"
    throw new Error("Cannot reach the server. Please try again.");
  }
  const data = await res.json().catch(() => ({}));
  return { res, data };
}

// Ask the backend for a new access token using the refresh token.
// Refresh tokens are single-use: the server answers with a NEW refresh token that replaces the stored one.
// Because of that, only ONE refresh may run at a time:
//   - inside this tab, parallel 401s share one in-flight request;
//   - across tabs, a Web Lock serialises refreshes, and a caller that waited re-uses the access token the
//     other tab just stored instead of sending the (already used) refresh token again.
let refreshInFlight = null;

async function requestNewTokens() {
  const refreshToken = localStorage.getItem(REFRESH_KEY);
  if (!refreshToken) return null;

  let result;
  try {
    result = await send("/api/auth/refresh", {
      method: "POST",
      body: JSON.stringify({ refreshToken }),
    });
  } catch {
    return null;
  }
  const { res, data } = result;
  if (!res.ok) return null;

  localStorage.setItem(ACCESS_KEY, data.accessToken);
  // Rotation: keep the newest refresh token (older servers do not send one).
  if (data.refreshToken) localStorage.setItem(REFRESH_KEY, data.refreshToken);
  return data.accessToken;
}

function refreshAccessToken(staleAccessToken) {
  if (!refreshInFlight) {
    const run = async () => {
      // Another tab may have refreshed while we waited for the lock.
      const current = localStorage.getItem(ACCESS_KEY);
      if (current && current !== staleAccessToken) return current;
      return requestNewTokens();
    };
    const locked = typeof navigator !== "undefined" && navigator.locks?.request
      ? navigator.locks.request("memhub-token-refresh", run)
      : run();
    refreshInFlight = Promise.resolve(locked).finally(() => {
      refreshInFlight = null;
    });
  }
  return refreshInFlight;
}

// api("/api/auth/login", { method: "POST", body: JSON.stringify({...}) })
// Adds the access token automatically. If the server says 401 (token expired),
// it refreshes the token once and retries. Throws Error(message) on failure.
export async function api(path, options = {}) {
  let token = localStorage.getItem(ACCESS_KEY);
  let { res, data } = await send(path, options, token);

  // Login/register 401s mean "wrong credentials", not "expired token"
  const isAuthForm = path === "/api/auth/login" || path === "/api/auth/register";
  if (res.status === 401 && token && !isAuthForm) {
    const newToken = await refreshAccessToken(token);
    if (newToken) {
      ({ res, data } = await send(path, options, newToken));
    }
  }

  if (!res.ok) {
    if (res.status === 401 && !isAuthForm) {
      throw new Error("Your session has expired. Please log in again.");
    }
    // 502/503/504 = a service we depend on (search, AI provider) failed; the server sends a safe message
    if ([502, 503, 504].includes(res.status) && data.message) throw new Error(data.message);
    if (res.status >= 500) throw new Error("Something went wrong on our side. Please try again.");
    throw new Error(data.message || "Something went wrong");
  }
  return data;
}
