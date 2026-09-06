import { Link } from "react-router-dom";
import {
  ArrowRight,
  Sparkles,
  Search,
  Share2,
  FileText,
  Layers,
  Cpu,
  Check,
  Github,
  Twitter,
  Linkedin,
} from "lucide-react";
import Logo from "@/components/Logo";
import { Button } from "@/components/ui/button";
import ThemeToggle from "@/components/ThemeToggle";

const navLinks = [
  { label: "Product", href: "#product" },
  { label: "Features", href: "#features" },
  { label: "How It Works", href: "#how" },
  { label: "Technology", href: "#tech" },
];

const features = [
  {
    icon: Search,
    title: "AI-Powered Search",
    desc: "Semantic + keyword search across every document, meeting, and note — with relevance scoring.",
  },
  {
    icon: Sparkles,
    title: "RAG Question Answering",
    desc: "Trusted answers grounded in your organization's real knowledge, with inline source citations.",
  },
  {
    icon: Share2,
    title: "Knowledge Graph",
    desc: "See how people, projects and technologies connect — and follow the trail of decisions.",
  },
  {
    icon: FileText,
    title: "Document Intelligence",
    desc: "Automatic chunking, embedding, and indexing for PDFs, Markdown, DOCX, TXT, and CSV.",
  },
  {
    icon: Layers,
    title: "Semantic Search",
    desc: "Vector similarity over your entire memory. Ask by meaning, not just keywords.",
  },
  {
    icon: Cpu,
    title: "Company Memory",
    desc: "Everything your team has ever written, decided, or shipped — remembered and retrievable.",
  },
];

const steps = [
  { n: "01", title: "Upload Knowledge", desc: "Drop in documents, notes, meeting transcripts, or connect a source." },
  { n: "02", title: "Process with NLP", desc: "Entities, topics, and intents extracted with modern language models." },
  { n: "03", title: "Store Semantic Embeddings", desc: "Chunks indexed into a high-recall vector database." },
  { n: "04", title: "Build Knowledge Graph", desc: "Relationships between people, docs and concepts are materialized." },
  { n: "05", title: "Ask AI", desc: "Query in natural language — the assistant retrieves what matters." },
  { n: "06", title: "Retrieve Trusted Answers", desc: "Every answer is cited to the exact source chunk." },
];

const tech = [
  { name: "NLP", desc: "Entity, intent, topic extraction" },
  { name: "Deep Learning", desc: "Transformer-based embeddings" },
  { name: "RAG", desc: "Retrieval-augmented generation" },
  { name: "Vector Database", desc: "Sub-linear semantic recall" },
  { name: "Knowledge Graph", desc: "Materialized entity relations" },
];

export default function Landing() {
  return (
    <div className="min-h-screen bg-background">
      {/* Nav */}
      <header className="sticky top-0 z-50 border-b border-border bg-background/70 glass">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-10">
            <Logo />
            <nav className="hidden md:flex items-center gap-1">
              {navLinks.map((l) => (
                <a
                  key={l.label}
                  href={l.href}
                  className="px-3 py-2 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary transition-colors"
                >
                  {l.label}
                </a>
              ))}
            </nav>
          </div>
          <div className="flex items-center gap-2">
            <ThemeToggle />
            <Link
              to="/login"
              className="hidden sm:inline-flex px-4 py-2 text-sm text-muted-foreground hover:text-foreground rounded-md hover:bg-secondary transition-colors"
            >
              Login
            </Link>
            <Link to="/register">
              <Button className="rounded-full h-9 px-5 shadow-sm">
                Get Started <ArrowRight className="h-3.5 w-3.5 ml-1.5" />
              </Button>
            </Link>
          </div>
        </div>
      </header>

      {/* Hero */}
      <section className="relative overflow-hidden">
        <div className="absolute inset-0 grid-dots opacity-40 pointer-events-none" />
        <div className="absolute left-1/2 top-24 -translate-x-1/2 h-[500px] w-[900px] max-w-[95vw] rounded-full bg-primary/20 blur-[120px] opacity-40 pointer-events-none" />

        <div className="relative max-w-7xl mx-auto px-6 lg:px-8 pt-20 pb-28 md:pt-28 md:pb-36 text-center">
          <div className="inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-mono text-muted-foreground">
            <span className="h-1.5 w-1.5 rounded-full bg-cyan-400" />
            v1.0 · AI Knowledge Platform
          </div>
          <h1 className="mt-6 text-5xl sm:text-6xl md:text-7xl font-bold tracking-tighter leading-[1.05] text-balance">
            Your Company's Memory,
            <br />
            <span className="text-primary">Powered by AI.</span>
          </h1>
          <p className="mt-6 max-w-2xl mx-auto text-base md:text-lg text-muted-foreground leading-relaxed">
            MemHub transforms scattered company knowledge into an intelligent, searchable memory that
            your team can understand, explore, and interact with.
          </p>
          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <Link to="/register">
              <Button size="lg" className="rounded-full h-11 px-6">
                Get Started <ArrowRight className="h-4 w-4 ml-1.5" />
              </Button>
            </Link>
            <Link to="/app">
              <Button size="lg" variant="outline" className="rounded-full h-11 px-6 border-border">
                Explore Demo
              </Button>
            </Link>
          </div>

          {/* AI Visualization */}
          <div className="mt-16 relative mx-auto max-w-4xl">
            <div className="rounded-2xl border border-border bg-card/60 backdrop-blur-sm p-6 md:p-10">
              <svg viewBox="0 0 800 260" className="w-full h-auto">
                {[
                  ["Documents", 100, 130, "hsl(var(--muted-foreground))"],
                  ["Knowledge", 300, 80, "#A855F7"],
                  ["AI", 500, 180, "hsl(var(--primary))"],
                  ["Answers", 700, 130, "#06B6D4"],
                ].map(([label, x, y, color], i, arr) => {
                  const next = arr[i + 1];
                  return (
                    <g key={label}>
                      {next && (
                        <line
                          x1={x}
                          y1={y}
                          x2={next[1]}
                          y2={next[2]}
                          stroke="hsl(var(--border))"
                          strokeWidth={1.5}
                          strokeDasharray="4 4"
                        />
                      )}
                      <circle cx={x} cy={y} r={26} fill={color} opacity={0.15} />
                      <circle cx={x} cy={y} r={12} fill={color} />
                      <text
                        x={x}
                        y={y + 44}
                        textAnchor="middle"
                        className="fill-muted-foreground text-[12px]"
                        style={{ fontFamily: "JetBrains Mono, monospace" }}
                      >
                        {label}
                      </text>
                    </g>
                  );
                })}
              </svg>
            </div>
          </div>
        </div>
      </section>

      {/* Features */}
      <section id="features" className="border-t border-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-24">
          <div className="max-w-2xl">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary">Features</p>
            <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tighter">
              Every capability of a modern AI knowledge platform.
            </h2>
            <p className="mt-4 text-muted-foreground">
              Purpose-built primitives for teams that ship. Semantic recall, cited answers, and a live graph of what
              your company knows.
            </p>
          </div>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {features.map((f) => (
              <div
                key={f.title}
                className="group rounded-2xl border border-border bg-card p-6 hover:border-primary/40 transition-colors duration-200"
              >
                <span className="h-10 w-10 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
                  <f.icon className="h-5 w-5" strokeWidth={1.75} />
                </span>
                <h3 className="mt-5 text-lg font-semibold tracking-tight">{f.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{f.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section id="how" className="border-t border-border bg-secondary/20">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-24">
          <div className="max-w-2xl">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary">How it works</p>
            <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tighter">
              From scattered files to answered questions.
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {steps.map((s, i) => (
              <div key={s.n} className="rounded-2xl border border-border bg-card p-6 relative">
                <span className="font-mono text-xs text-primary">{s.n}</span>
                <h3 className="mt-3 text-lg font-semibold tracking-tight">{s.title}</h3>
                <p className="mt-2 text-sm text-muted-foreground leading-relaxed">{s.desc}</p>
                {i < steps.length - 1 && (
                  <ArrowRight className="hidden lg:block absolute -right-3 top-1/2 -translate-y-1/2 h-4 w-4 text-border" />
                )}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Tech */}
      <section id="tech" className="border-t border-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-24">
          <div className="text-center max-w-2xl mx-auto">
            <p className="text-[11px] font-medium uppercase tracking-[0.16em] text-primary">Technology</p>
            <h2 className="mt-3 text-3xl md:text-4xl font-semibold tracking-tighter">
              A serious stack under a simple surface.
            </h2>
          </div>
          <div className="mt-12 grid grid-cols-2 md:grid-cols-5 gap-3">
            {tech.map((t) => (
              <div key={t.name} className="rounded-xl border border-border bg-card p-5 text-center hover:border-primary/40 transition-colors">
                <p className="font-mono text-xs text-primary">{t.name}</p>
                <p className="mt-2 text-xs text-muted-foreground leading-relaxed">{t.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="border-t border-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-24">
          <div className="rounded-3xl border border-border bg-gradient-to-b from-card to-secondary/40 p-10 md:p-16 relative overflow-hidden">
            <div className="absolute -top-24 -right-24 h-64 w-64 rounded-full bg-primary/25 blur-[100px]" />
            <div className="relative max-w-2xl">
              <h2 className="text-3xl md:text-5xl font-semibold tracking-tighter">
                Turn scattered information into organizational intelligence.
              </h2>
              <p className="mt-4 text-muted-foreground">
                Start free. Bring your first 50 documents. See MemHub answer your team's real questions in minutes.
              </p>
              <div className="mt-8 flex flex-col sm:flex-row items-start gap-3">
                <Link to="/register">
                  <Button size="lg" className="rounded-full h-11 px-6">
                    Get Started free <ArrowRight className="h-4 w-4 ml-1.5" />
                  </Button>
                </Link>
                <Link to="/app">
                  <Button size="lg" variant="outline" className="rounded-full h-11 px-6 border-border">
                    Explore Demo
                  </Button>
                </Link>
              </div>
              <ul className="mt-8 flex flex-wrap gap-x-6 gap-y-2 text-sm text-muted-foreground">
                {["No credit card", "SOC 2 ready", "Self-hosted option"].map((x) => (
                  <li key={x} className="flex items-center gap-2">
                    <Check className="h-4 w-4 text-primary" /> {x}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="border-t border-border">
        <div className="max-w-7xl mx-auto px-6 lg:px-8 py-10 flex flex-col md:flex-row items-center justify-between gap-4">
          <div className="flex items-center gap-4">
            <Logo />
            <span className="text-xs text-muted-foreground font-mono">© 2026 MemHub Labs</span>
          </div>
          <div className="flex items-center gap-1 text-muted-foreground">
            <a href="#" className="p-2 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><Github className="h-4 w-4" /></a>
            <a href="#" className="p-2 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><Twitter className="h-4 w-4" /></a>
            <a href="#" className="p-2 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><Linkedin className="h-4 w-4" /></a>
          </div>
        </div>
      </footer>
    </div>
  );
}
