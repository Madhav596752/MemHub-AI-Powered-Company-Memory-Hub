import { Navigate, Outlet } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";

// Wrap routes with this. Logged-out visitors are sent to /login.
export default function ProtectedRoute() {
  const { user, loading } = useAuth();

  // Still checking the stored token — don't redirect yet
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center text-sm text-muted-foreground">
        Loading…
      </div>
    );
  }

  if (!user) return <Navigate to="/login" replace />;

  return <Outlet />;
}
