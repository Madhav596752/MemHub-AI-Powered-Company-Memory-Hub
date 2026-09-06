import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useTheme } from "@/contexts/ThemeContext";
import { currentUser } from "@/data/mockData";
import { toast } from "sonner";
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
  const [profile, setProfile] = useState({ name: currentUser.name, email: currentUser.email, company: currentUser.company });
  const [ai, setAi] = useState({ model: "MemHub-1", style: "Concise", citations: true });

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
                  <Input className="mt-2 h-10" value={profile.name} onChange={(e) => setProfile({ ...profile, name: e.target.value })} />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Email</label>
                  <Input className="mt-2 h-10" type="email" value={profile.email} onChange={(e) => setProfile({ ...profile, email: e.target.value })} />
                </div>
                <div className="sm:col-span-2">
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Company</label>
                  <Input className="mt-2 h-10" value={profile.company} onChange={(e) => setProfile({ ...profile, company: e.target.value })} />
                </div>
              </div>
              <Button onClick={() => toast.success("Profile saved")}>Save changes</Button>
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
                <Input className="mt-2 h-10" defaultValue={`${profile.company} Memory`} />
              </div>
              <div>
                <p className="text-sm font-medium">Members</p>
                <ul className="mt-3 space-y-2">
                  {["Madhav Sharma", "Priya N.", "Aarav K.", "Nia R."].map((m, i) => (
                    <li key={m} className="flex items-center justify-between rounded-lg border border-border bg-background/50 px-3 py-2 text-sm">
                      <div className="flex items-center gap-3">
                        <span className="h-7 w-7 rounded-full bg-primary/10 border border-primary/20 flex items-center justify-center text-primary text-[11px] font-semibold">
                          {m.split(" ").map((x) => x[0]).join("")}
                        </span>
                        <span>{m}</span>
                      </div>
                      <span className="font-mono text-[10px] text-muted-foreground">{i === 0 ? "Owner" : "Member"}</span>
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
                <p className="text-xs text-muted-foreground font-mono mt-1">Customize how MemHub answers</p>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">AI Model</label>
                <select value={ai.model} onChange={(e) => setAi({ ...ai, model: e.target.value })} className="mt-2 w-full h-10 rounded-lg border border-border bg-background text-sm px-3 focus:outline-none focus:ring-2 focus:ring-primary/40">
                  <option>MemHub-1</option>
                  <option>MemHub-1 Pro</option>
                  <option>MemHub-Legacy</option>
                </select>
              </div>
              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Response style</label>
                <div className="mt-2 flex items-center gap-1 rounded-lg border border-border bg-background p-1 w-fit">
                  {["Concise", "Balanced", "Detailed"].map((s) => (
                    <button key={s} onClick={() => setAi({ ...ai, style: s })} className={`px-3 py-1.5 text-xs rounded-md ${ai.style === s ? "bg-secondary text-foreground" : "text-muted-foreground hover:text-foreground"}`}>
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
                  onClick={() => setAi({ ...ai, citations: !ai.citations })}
                  className={`inline-flex h-5 w-9 shrink-0 items-center rounded-full border border-transparent transition-colors ${ai.citations ? "bg-primary" : "bg-secondary"}`}
                >
                  <span
                    className={`block h-4 w-4 rounded-full bg-white shadow-lg transition-transform ${ai.citations ? "translate-x-4" : "translate-x-0.5"}`}
                  />
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
                  <Input className="mt-2 h-10" type="password" />
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">New password</label>
                  <Input className="mt-2 h-10" type="password" />
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background/50 p-4">
                <p className="text-sm font-medium">Active sessions</p>
                <p className="text-xs text-muted-foreground font-mono mt-1">3 devices · sign out any device you don't recognize</p>
                <Button variant="outline" size="sm" className="mt-3">Sign out other sessions</Button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
