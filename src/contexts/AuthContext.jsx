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
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
    setUser(null);
  }

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  return useContext(AuthContext);
}