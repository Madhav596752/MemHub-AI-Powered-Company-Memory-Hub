import { useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { ArrowRight, Mail, Lock, User, Building2, Sparkles, ShieldCheck } from "lucide-react";
import Logo from "@/components/Logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";

function scorePassword(pw) {
  let s = 0;
  if (pw.length >= 8) s++;
  if (/[A-Z]/.test(pw)) s++;
  if (/[0-9]/.test(pw)) s++;
  if (/[^A-Za-z0-9]/.test(pw)) s++;
  if (pw.length >= 12) s++;
  return Math.min(4, s);
}

const strengthMeta = [
  { label: "Too short", color: "bg-destructive" },
  { label: "Weak", color: "bg-destructive" },
  { label: "Okay", color: "bg-amber-500" },
  { label: "Strong", color: "bg-emerald-500" },
  { label: "Excellent", color: "bg-emerald-500" },
];

export default function Register() {
  const navigate = useNavigate();
  const [loading, setLoading] = useState(false);
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "", company: "" });
  const strength = useMemo(() => scorePassword(form.password), [form.password]);
  const match = form.password && form.password === form.confirm;

  const submit = (e) => {
    e.preventDefault();
    if (!match) return toast.error("Passwords don't match");
    setLoading(true);
    setTimeout(() => {
      setLoading(false);
      toast.success("Welcome to MemHub");
      navigate("/app");
    }, 700);
  };

  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-2 bg-background">
      <div className="flex flex-col p-6 md:p-10">
        <Logo />
        <div className="flex-1 flex items-center justify-center py-10">
          <div className="w-full max-w-md">
            <h1 className="text-3xl font-semibold tracking-tighter">Create your workspace</h1>
            <p className="mt-2 text-sm text-muted-foreground">
              Set up MemHub in under a minute. Bring your knowledge in next.
            </p>

            <form onSubmit={submit} className="mt-8 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Full name</label>
                  <div className="mt-2 relative">
                    <User className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                    <Input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} className="pl-9 h-11" placeholder="Madhav Sharma" />
                  </div>
                </div>
                <div>
                  <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Company</label>
                  <div className="mt-2 relative">
                    <Building2 className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                    <Input required value={form.company} onChange={(e) => setForm({ ...form, company: e.target.value })} className="pl-9 h-11" placeholder="Acme Labs" />
                  </div>
                </div>
              </div>

              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Work email</label>
                <div className="mt-2 relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                  <Input required type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} className="pl-9 h-11" placeholder="you@company.com" />
                </div>
              </div>

              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Password</label>
                <div className="mt-2 relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                  <Input required type="password" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} className="pl-9 h-11" placeholder="At least 8 characters" />
                </div>
                {form.password && (
                  <div className="mt-2">
                    <div className="grid grid-cols-4 gap-1">
                      {[0, 1, 2, 3].map((i) => (
                        <span key={i} className={`h-1 rounded-full transition-colors ${i < strength ? strengthMeta[strength].color : "bg-secondary"}`} />
                      ))}
                    </div>
                    <p className="mt-1.5 text-[11px] font-mono text-muted-foreground">
                      {strengthMeta[strength].label}
                    </p>
                  </div>
                )}
              </div>

              <div>
                <label className="text-xs uppercase tracking-[0.14em] text-muted-foreground">Confirm password</label>
                <div className="mt-2 relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
                  <Input required type="password" value={form.confirm} onChange={(e) => setForm({ ...form, confirm: e.target.value })} className="pl-9 h-11" placeholder="Repeat password" />
                </div>
                {form.confirm && !match && (
                  <p className="mt-1.5 text-[11px] text-destructive">Passwords don't match</p>
                )}
              </div>

              <Button type="submit" disabled={loading} className="w-full h-11 rounded-lg">
                {loading ? "Creating…" : "Create MemHub Account"}
                {!loading && <ArrowRight className="h-4 w-4 ml-1.5" />}
              </Button>
            </form>

            <p className="mt-6 text-sm text-muted-foreground">
              Already have an account?{" "}
              <Link to="/login" className="text-primary hover:underline">
                Sign in
              </Link>
            </p>
          </div>
        </div>
      </div>

      <div className="hidden lg:flex relative overflow-hidden border-l border-border bg-secondary/30">
        <div className="absolute inset-0 grid-dots opacity-40" />
        <div className="absolute top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 h-[500px] w-[500px] rounded-full bg-primary/25 blur-[130px]" />
        <div className="relative m-auto max-w-md p-10">
          <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary">Join MemHub</p>
          <h2 className="mt-3 text-4xl font-semibold tracking-tighter leading-tight">
            One workspace for everything your team has ever known.
          </h2>
          <ul className="mt-8 space-y-4">
            {[
              { icon: Sparkles, t: "Free for the first 50 documents." },
              { icon: ShieldCheck, t: "Your data stays private. Always." },
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
