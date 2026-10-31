import { createContext, useContext, useEffect, useState } from "react";
import { api, ACCESS_KEY, REFRESH_KEY } from "@/api";

const AuthContext = createContext(null);

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [loading, setLoading] = useState(true); // true while we check stored login

  // On app start: if a token is stored, ask the backend who we are
  useEffect(() => {
    async function restoreLogin() {
      if (!localStorage.getItem(ACCESS_KEY)) {
        setLoading(false);
        return;
      }
      try {
        const me = await api("/api/auth/me");
        setUser(me);
      } catch {
        // token invalid and refresh failed -> clear everything
        localStorage.removeItem(ACCESS_KEY);
        localStorage.removeItem(REFRESH_KEY);
        setUser(null);
      } finally {
        setLoading(false);
      }
    }
    restoreLogin();
  }, []);

  function saveAuth(data) {
    localStorage.setItem(ACCESS_KEY, data.accessToken);
    localStorage.setItem(REFRESH_KEY, data.refreshToken);
    setUser(data.user);
  }

  async function login(email, password) {
    const data = await api("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    });
    saveAuth(data);
  }

  async function register({ name, email, password, companyName, inviteCode }) {
    const data = await api("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ name, email, password, companyName, inviteCode }),
    });
    saveAuth(data);
  }

  function logout() {
    // Revoke the session on the server too (best effort: the local logout never waits for it or fails because of it).
    const refreshToken = localStorage.getItem(REFRESH_KEY);
    if (refreshToken) {
      api("/api/auth/logout", { method: "POST", body: JSON.stringify({ refreshToken }) }).catch(() => {});
    }
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setUser(null);
  }

  return (
    // isAdmin only decides which controls to SHOW. The backend re-checks every privileged request.
    <AuthContext.Provider value={{ user, loading, isAdmin: user?.role === "ADMIN", login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}