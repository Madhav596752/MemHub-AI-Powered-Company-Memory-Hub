import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Mail, Lock, Sparkles, ShieldCheck, Zap } from "lucide-react";
import Logo from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

export default function Login() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ email: "madhav@acme.co", password: "demopass", remember: true });

  const submit = (e) => {
    e.preventDefault();
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      toast.success("Welcome back to MemHub");
      navigate("/app");
    }, 700);
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-background">
      {/* Left / form */}
      <div className="flex flex-col p-6 md:p-10">
        <Logo />
        <div className="flex-1 flex items-center justify-center py-10">
          <div className="w-full max-w-md">
            <h1 className="text-3xl font-semibold tracking-tighter">Welcome back</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Sign in to continue exploring your company's memory.
            </p>

            <button
              className="mt-8 w-full h-11 rounded-lg border border-border bg-card hover:bg-secondary transition-colors flex items-center justify-center gap-3 text-sm font-medium"
            >
              <svg width="18" height="18" viewBox="0 0 24 24"><path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/><path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/><path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"/><path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/></svg>
              Continue with Google
            </button>

            <div className="my-6 flex items-center gap-3 text-xs text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              <span className="font-mono">OR</span>
              <span className="h-px flex-1 bg-border" />
            </div>

            <form onSubmit={submit} className="space-y-4">
              <div>
                <label htmlFor="email" className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Email</label>
                <div className="mt-2 relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                  <Input
                    id="email"
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm({ ...form, email: e.target.value })}
                    className="pl-9 h-11"
                    required
                  />
                </div>
              </div>
              <div>
                <div className="flex items-center justify-between">
                  <label htmlFor="password" className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Password</label>
                  <button type="button" className="text-xs text-primary hover:underline">Forgot?</button>
                </div>
                <div className="mt-2 relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                  <Input
                    id="password"
                    type="password"
                    value={form.password}
                    onChange={(e) => setForm({ ...form, password: e.target.value })}
                    className="pl-9 h-11"
                    required
                  />
                </div>
              </div>

              <label className="flex items-center gap-2 text-sm text-muted-foreground cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.remember}
                  onChange={(e) => setForm({ ...form, remember: e.target.checked })}
                  className="h-4 w-4 rounded-sm border border-border accent-primary"
                />
                Remember me for 30 days
              </label>

              <Button
                type="submit"
                disabled={loading}
                className="w-full h-11 rounded-lg"
              >
                {loading ? "Signing in…" : "Sign in"}
                {!loading && <ArrowRight className="h-4 w-4 ml-1.5" />}
              </Button>
            </form>

            <p className="mt-6 text-sm text-muted-foreground">
              New to MemHub?{" "}
              <Link to="/register" className="text-primary hover:underline">
                Create an account
              </Link>
            </p>
          </div>
        </div>
      </div>

      {/* Right / visual */}
      <div className="hidden lg:flex relative overflow-hidden border-l border-border bg-secondary/30">
        <div className="absolute inset-0 grid-dots opacity-40" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[500px] rounded-full bg-primary/25 blur-[130px]" />

        <div className="relative m-auto max-w-md p-10">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary">MemHub</p>
          <h2 className="mt-3 text-4xl font-semibold tracking-tighter leading-tight">
            Turn scattered information into organizational intelligence.
          </h2>
          <ul className="mt-8 space-y-4">
            {[
              { icon: Sparkles, t: "Ask anything — answers with citations." },
              { icon: ShieldCheck, t: "SOC 2 ready, private by default." },
              { icon: Zap, t: "Semantic search over your entire memory." },
            ].map((x) => (
              <li key={x.t} className="flex items-start gap-3 text-sm">
                <span className="h-8 w-8 rounded-lg bg-primary/10 border border-primary/20 flex items-center justify-center text-primary shrink-0">
                  <x.icon className="h-4 w-4" strokeWidth={1.75} />
                </span>
                <span className="text-muted-foreground pt-1.5">{x.t}</span>
              </li>
            ))}
          </ul>
        </div>
      </div>
    </div>
  );
}
