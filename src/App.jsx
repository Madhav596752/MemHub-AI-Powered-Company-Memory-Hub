import { Routes, Route, Navigate } from "react-router-dom";
import { Toaster } from "sonner";
import Landing from "@/pages/Landing";
import Login from "@/pages/Login";
import Register from "@/pages/Register";
import DashboardLayout from "@/components/DashboardLayout";
import Dashboard from "@/pages/Dashboard";
import AIAssistant from "@/pages/AIAssistant";
import KnowledgeBase from "@/pages/KnowledgeBase";
import Documents from "@/pages/Documents";
import KnowledgeGraphPage from "@/pages/KnowledgeGraphPage";
import SearchPage from "@/pages/Search";
import Analytics from "@/pages/Analytics";
import Settings from "@/pages/Settings";

export default function App() {
  return (
    <>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<Login />} />
        <Route path="/register" element={<Register />} />
        <Route element={<DashboardLayout />}>
          <Route path="/app" element={<Dashboard />} />
          <Route path="/app/assistant" element={<AIAssistant />} />
          <Route path="/app/knowledge" element={<KnowledgeBase />} />
          <Route path="/app/documents" element={<Documents />} />
          <Route path="/app/graph" element={<KnowledgeGraphPage />} />
          <Route path="/app/search" element={<SearchPage />} />
          <Route path="/app/analytics" element={<Analytics />} />
          <Route path="/app/settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
      <Toaster
        position="bottom-right"
        theme="system"
        toastOptions={{
          className:
            "!bg-card !text-card-foreground !border !border-border !rounded-xl",
        }}
      />
    </>
  );
}
