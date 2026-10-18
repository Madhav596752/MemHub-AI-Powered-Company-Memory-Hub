import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/contexts/ThemeContext";
import { useAuth } from "@/contexts/AuthContext";
import { User, Building, Sparkles, Palette, ShieldCheck } from "lucide-react";

const sections = [
  { id: "profile", label: "Profile", icon: User },
  { id: "workspace", label: "Workspace", icon: Building },
  { id: "ai", label: "AI Settings", icon: Sparkles },
  { id: "appearance", label: "Appearance", icon: Palette },
  { id: "security", label: "Security", icon: ShieldCheck },
];

export default function Settings() {
  const [active, setActive] = useState("profile");
  const { theme, setTheme } = useTheme();
  const { user } = useAuth();

  return (
    <div className="p-6 md:p-8 max-w-[1200px] mx-auto space-y-6">
      <div>
        <h1 className="text-3xl font-semibold tracking-tighter">Settings</h1>
        <p className="mt-1 text-sm text-muted-foreground">Manage your account, workspace, and MemHub preferences.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[220px_1fr] gap-6">
        <aside className="rounded-2xl border border-border bg-card p-2 h-fit">
          {sections.map((s) => (
            <button
              key={s.id}
              onClick={() => setActive(s.id)}
              className={`w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors ${
                active === s.id ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground hover:bg-secondary/60"
              }`}
            >
              <s.icon className="h-4 w-4" strokeWidth={1.75} />
              {s.label}
            </button>
          ))}
        </aside>

        <div className="rounded-2xl border border-border bg-card p-6">
          {active === "profile" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Profile</h2>
                <p className="text-xs text-muted-foreground font-mono mt-1">Your personal information</p>
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Full name</label>
                  <Input className="mt-2 h-10" value={user.name} readOnly />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Email</label>
                  <Input className="mt-2 h-10" type="email" value={user.email} readOnly />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Company</label>
                  <Input className="mt-2 h-10" value={user.companyName || ""} readOnly />
                </div>
              </div>
              <p className="text-xs text-muted-foreground font-mono">Editing your profile is coming in a later phase.</p>
            </div>
          )}

          {active === "workspace" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Workspace</h2>
                <p className="text-xs text-muted-foreground font-mono mt-1">Manage the shared space</p>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Workspace name</label>
                <Input className="mt-2 h-10" value={user.companyName || ""} readOnly />
              </div>
              {user.role === "ADMIN" && (
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Invite code</label>
                  <Input className="mt-2 h-10 font-mono text-xs" value={user.companyId || ""} readOnly onFocus={(e) => e.target.select()} />
                  <p className="mt-1.5 text-xs text-muted-foreground font-mono">
                    Share this code with teammates. They paste it on the Create Account page to join this company. Only share it with people you trust.
                  </p>
                </div>
              )}
              <div>
                <p className="text-sm font-medium">Members</p>
                <ul className="mt-3 space-y-2">
                  {[user].map((m) => (
                    <li key={m.id} className="flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-2 text-sm">
                      <div className="flex items-center gap-3">
                        <span className="h-7 w-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-[11px] font-semibold">
                          {m.name.split(" ").map((x) => x[0]).slice(0, 2).join("").toUpperCase()}
                        </span>
                        <span>{m.name}</span>
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground">{m.role === "ADMIN" ? "Admin" : "Member"}</span>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          {active === "ai" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">AI Settings</h2>
                <p className="text-xs text-muted-foreground font-mono mt-1">Coming in a later phase, together with the AI Assistant</p>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">AI Model</label>
                <select disabled className="mt-2 w-full h-10 rounded-lg border border-border bg-background text-sm px-3 opacity-60 cursor-not-allowed">
                  <option>MemHub-1</option>
                  <option>MemHub-1 Pro</option>
                  <option>MemHub-Legacy</option>
                </select>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Response style</label>
                <div className="mt-2 flex items-center gap-1 rounded-lg border border-border bg-background p-1 w-fit">
                  {["Concise", "Balanced", "Detailed"].map((s) => (
                    <button key={s} type="button" disabled className={`px-3 py-1.5 text-xs rounded-md opacity-60 cursor-not-allowed ${s === "Concise" ? "bg-secondary text-foreground" : "text-muted-foreground"}`}>
                      {s}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex items-center justify-between rounded-lg border border-border bg-background/50 p-4">
                <div>
                  <p className="text-sm font-medium">Inline citations</p>
                  <p className="text-xs text-muted-foreground font-mono mt-0.5">Show source cards next to every answer</p>
                </div>
                <button
                  type="button"
                  disabled
                  className="inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent bg-primary opacity-60 cursor-not-allowed"
                >
                  <span className="block h-4 w-4 rounded-full bg-white shadow-lg translate-x-4" />
                </button>
              </div>
            </div>
          )}

          {active === "appearance" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Appearance</h2>
                <p className="text-xs text-muted-foreground font-mono mt-1">Theme preference</p>
              </div>
              <div className="grid grid-cols-3 gap-3">
                {[
                  { id: "light", label: "Light" },
                  { id: "dark", label: "Dark" },
                  { id: "system", label: "System" },
                ].map((t) => (
                  <button
                    key={t.id}
                    onClick={() => setTheme(t.id)}
                    className={`rounded-xl border p-4 text-left transition-colors ${
                      theme === t.id ? "border-primary ring-2 ring-primary/30" : "border-border hover:border-primary/40"
                    }`}
                  >
                    <div className={`h-16 rounded-md mb-3 ${t.id === "light" ? "bg-gradient-to-br from-white to-slate-200" : t.id === "dark" ? "bg-gradient-to-br from-slate-900 to-slate-950" : "bg-gradient-to-br from-slate-200 to-slate-800"}`} />
                    <p className="text-sm font-medium">{t.label}</p>
                  </button>
                ))}
              </div>
            </div>
          )}

          {active === "security" && (
            <div className="space-y-6">
              <div>
                <h2 className="text-lg font-semibold tracking-tight">Security</h2>
                <p className="text-xs text-muted-foreground font-mono mt-1">Password & session management</p>
              </div>
              <div className="space-y-3">
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Current password</label>
                  <Input className="mt-2 h-10" type="password" disabled />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">New password</label>
                  <Input className="mt-2 h-10" type="password" disabled />
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background/50 p-4">
                <p className="text-sm font-medium">Active sessions</p>
                <p className="text-xs text-muted-foreground font-mono mt-1">Password change and session management are coming in a later phase.</p>
                <Button variant="outline" size="sm" className="mt-3" disabled>Sign out other sessions</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
