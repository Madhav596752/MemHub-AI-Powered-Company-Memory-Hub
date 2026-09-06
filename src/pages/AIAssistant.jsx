import { useState, useRef, useEffect } from "react";
import { Sparkles, Send, Paperclip, Mic, Plus, Trash2, Calendar, ShieldCheck, Network, History, Copy, ThumbsUp, ThumbsDown } from "lucide-react";
import SourceCard from "@/components/SourceCard";
import { Button } from "@/components/ui/button";
import { promptCards, sampleChat } from "@/data/mockData";
import { toast } from "sonner";

const iconMap = { Calendar, ShieldCheck, Network, History };

function renderMarkdown(text) {
  // very light markdown: **bold**, single-line breaks, - bullets
  const lines = text.split("\n");
  const out = [];
  let list = [];
  const flushList = (key) => {
    if (list.length) {
      out.push(
        <ul key={`ul-${key}`} className="my-3 space-y-1.5 list-disc pl-5 marker:text-muted-foreground">
          {list.map((li, i) => (<li key={i} className="text-[15px]">{li}</li>))}
        </ul>
      );
      list = [];
    }
  };
  lines.forEach((line, idx) => {
    if (line.trim().startsWith("- ")) {
      list.push(inline(line.trim().slice(2)));
      return;
    }
    flushList(idx);
    if (!line.trim()) return;
    out.push(<p key={idx} className="text-[15px] leading-relaxed my-2">{inline(line)}</p>);
  });
  flushList("end");
  return out;
}

function inline(text) {
  const parts = text.split(/(\*\*[^*]+\*\*)/g);
  return parts.map((p, i) => p.startsWith("**") && p.endsWith("**") ? (<strong key={i} className="font-semibold text-foreground">{p.slice(2, -2)}</strong>) : (<span key={i}>{p}</span>));
}

export default function AIAssistant() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [thinking, setThinking] = useState(false);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, thinking]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

  const submit = (e) => {
    e?.preventDefault();
    if (!input.trim()) return;
    const userMsg = { role: "user", content: input.trim() };
    setMessages((m) => [...m, userMsg]);
    setInput("");
    setThinking(true);
    setTimeout(() => {
      setMessages((m) => [...m, sampleChat[1]]);
      setThinking(false);
    }, 1100);
  };

  const fillPrompt = (t) => {
    setInput(t);
  };

  const clear = () => {
    setMessages([]);
    toast.success("Conversation cleared");
  };

  return (
    <div className="flex h-[calc(100vh-4rem)]">
      {/* Chat area */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Header */}
        <div className="border-b border-border px-6 md:px-8 py-4 flex items-center justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="h-6 w-6 rounded-md bg-primary text-primary-foreground flex items-center justify-center">
                <Sparkles className="h-3.5 w-3.5" />
              </span>
              <h1 className="text-lg font-semibold tracking-tight">MemHub AI</h1>
            </div>
            <p className="text-xs text-muted-foreground mt-1 font-mono">Ask questions about your organization's knowledge.</p>
          </div>
          <div className="flex items-center gap-2">
            <Button variant="ghost" size="sm" onClick={() => setMessages([])}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New
            </Button>
            <Button variant="ghost" size="sm" onClick={clear}>
              <Trash2 className="h-3.5 w-3.5 mr-1" /> Clear
            </Button>
          </div>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto px-6 md:px-8 py-6">
          {messages.length === 0 ? (
            <div className="max-w-2xl mx-auto text-center py-14">
              <div className="inline-flex h-14 w-14 rounded-2xl bg-primary/10 border border-primary/20 items-center justify-center text-primary">
                <Sparkles className="h-6 w-6" strokeWidth={1.75} />
              </div>
              <h2 className="mt-6 text-3xl font-semibold tracking-tighter">Ask MemHub anything</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Your assistant is grounded in your organization's real knowledge — every answer cites the source.
              </p>
              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
                {promptCards.map((p) => {
                  const Icon = iconMap[p.icon] || Sparkles;
                  return (
                    <button
                      key={p.title}
                      onClick={() => fillPrompt(p.title)}
                      className="group rounded-xl border border-border bg-card hover:border-primary/40 p-4 text-sm flex items-start gap-3 transition-colors"
                    >
                      <span className="h-8 w-8 rounded-lg bg-secondary border border-border flex items-center justify-center text-muted-foreground group-hover:text-primary group-hover:border-primary/30 transition-colors">
                        <Icon className="h-4 w-4" strokeWidth={1.75} />
                      </span>
                      <span className="pt-1">{p.title}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="max-w-3xl mx-auto space-y-8">
              {messages.map((m, i) => (
                <div key={i} className={`flex ${m.role === "user" ? "justify-end" : "justify-start"}`}>
                  {m.role === "user" ? (
                    <div className="max-w-[75%] rounded-2xl bg-secondary px-4 py-3 text-sm">{m.content}</div>
                  ) : (
                    <div className="w-full">
                      <div className="flex items-center gap-2 mb-2">
                        <span className="h-6 w-6 rounded-md bg-primary text-primary-foreground flex items-center justify-center">
                          <Sparkles className="h-3 w-3" />
                        </span>
                        <span className="text-xs font-mono text-muted-foreground">MemHub AI</span>
                        {typeof m.confidence === "number" && (
                          <span className="ml-auto text-[11px] font-mono px-2 py-0.5 rounded-full bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">
                            {Math.round(m.confidence * 100)}% confidence
                          </span>
                        )}
                      </div>
                      <div className="prose-invert max-w-none">{renderMarkdown(m.content)}</div>

                      {m.sources && (
                        <div className="mt-4 flex flex-wrap gap-2">
                          {m.sources.map((s, idx) => (
                            <span key={s.id} className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] font-mono text-primary">
                              <span>[{idx + 1}]</span> {s.title}
                            </span>
                          ))}
                        </div>
                      )}

                      <div className="mt-3 flex items-center gap-1 text-muted-foreground">
                        <button className="p-1.5 rounded-md hover:bg-secondary hover:text-foreground transition-colors" onClick={() => { navigator.clipboard.writeText(m.content); toast.success("Copied"); }}>
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button className="p-1.5 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><ThumbsUp className="h-3.5 w-3.5" /></button>
                        <button className="p-1.5 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><ThumbsDown className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {thinking && (
                <div className="flex items-center gap-3 text-sm text-muted-foreground font-mono">
                  <span className="flex gap-1">
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "0ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "150ms" }} />
                    <span className="h-1.5 w-1.5 rounded-full bg-primary animate-bounce" style={{ animationDelay: "300ms" }} />
                  </span>
                  Retrieving from your knowledge base…
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-background/60 glass px-6 md:px-8 py-4">
          <form onSubmit={submit} className="max-w-3xl mx-auto">
            <div className="rounded-2xl border border-border bg-card focus-within:border-primary/40 focus-within:ring-2 focus-within:ring-primary/20 transition-colors">
              <textarea
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    submit();
                  }
                }}
                placeholder="Ask a question about your company…"
                rows={2}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm focus:outline-none placeholder:text-muted-foreground"
              />
              <div className="flex items-center justify-between px-2 py-2 border-t border-border/60">
                <div className="flex items-center gap-0.5 text-muted-foreground">
                  <button type="button" className="p-2 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><Paperclip className="h-4 w-4" strokeWidth={1.75} /></button>
                  <button type="button" className="p-2 rounded-md hover:bg-secondary hover:text-foreground transition-colors"><Mic className="h-4 w-4" strokeWidth={1.75} /></button>
                </div>
                <div className="flex items-center gap-3">
                  <span className="hidden sm:block text-[11px] font-mono text-muted-foreground">Enter to send · Shift+Enter for newline</span>
                  <Button type="submit" size="sm" className="rounded-lg h-8 px-3" disabled={!input.trim()}>
                    <Send className="h-3.5 w-3.5 mr-1" /> Send
                  </Button>
                </div>
              </div>
            </div>
          </form>
        </div>
      </div>

      {/* Sources side panel */}
      <aside className="hidden xl:flex w-[340px] border-l border-border bg-card/40 flex-col">
        <div className="px-5 py-4 border-b border-border">
          <p className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Sources</p>
          <h3 className="mt-1 text-base font-semibold tracking-tight">Cited in this answer</h3>
        </div>
        <div className="flex-1 overflow-y-auto p-4 space-y-2">
          {lastAssistant?.sources ? (
            lastAssistant.sources.map((s, i) => <SourceCard key={s.id} source={s} index={i} />)
          ) : (
            <div className="text-center text-muted-foreground text-xs font-mono py-16 px-4">
              Sources cited by MemHub AI will appear here after you ask a question.
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
