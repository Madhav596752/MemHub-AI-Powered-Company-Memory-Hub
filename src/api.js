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

// Ask the backend for a new access token using the refresh token
async function refreshAccessToken() {
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
  return data.accessToken;
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
    const newToken = await refreshAccessToken();
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
