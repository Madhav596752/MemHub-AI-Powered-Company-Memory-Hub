import { useState, useRef, useEffect } from "react";
import { Sparkles, Send, Paperclip, Mic, Plus, Trash2, Calendar, ShieldCheck, Network, History, Copy, ThumbsUp, ThumbsDown, AlertCircle, SearchX } from "lucide-react";
import SourceCard from "@/components/SourceCard";
import { Button } from "@/components/ui/button";
import { promptCards } from "@/data/mockData";
import { toast } from "sonner";
import { api } from "@/api";

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

// Backend citation -> the shape SourceCard shows. Everything comes from the API response.
function toCard(src) {
  const ext = (src.documentName.split(".").pop() || "").toUpperCase().slice(0, 4);
  const range = src.startChar != null && src.endChar != null ? ` · chars ${src.startChar}–${src.endChar}` : "";
  return {
    id: `${src.documentId}:${src.chunkIndex}`,
    ref: src.ref,
    type: ext || "DOC",
    title: src.documentName,
    meta: `chunk ${src.chunkIndex + 1}${range}`,
    excerpt: src.text,
  };
}

// Hint under a "no answer" message, depending on WHY the backend found no answer
function hintFor(reason) {
  if (reason === "not_indexed") return "Nothing is searchable yet. Check the Documents page: upload a file, or use Re-index on one that failed.";
  if (reason === "not_enough_info") return "Related passages were found, but they do not answer this question. No sources are shown.";
  return "No sources. Try rephrasing, or check that the relevant document is uploaded and indexed.";
}

const MAX_QUESTION_LENGTH = 1000; // same limit as the backend

export default function AIAssistant() {
  const [messages, setMessages] = useState([]);
  const [question, setQuestion] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const bottomRef = useRef(null);

  const ask = async (e) => {
    e?.preventDefault();
    const q = question.trim();
    if (!q || loading) return;
    setError("");
    setLoading(true);
    setMessages((m) => [...m, { role: "user", content: q }]);
    setQuestion("");
    try {
      // Only the question is sent. The server decides which company's documents are searched.
      const data = await api("/api/ask", { method: "POST", body: JSON.stringify({ question: q }) });
      setMessages((m) => [
        ...m,
        { role: "assistant", content: data.answer, grounded: data.grounded, reason: data.reason, sources: (data.sources || []).map(toCard) },
      ]);
    } catch (err) {
      setError(err.message || "Something went wrong");
      setQuestion(q); // give the question back so it can be retried
      setMessages((m) => m.slice(0, -1));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, loading]);

  const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant");

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
            <Button variant="ghost" size="sm" disabled={messages.length === 0} onClick={() => { setMessages([]); setError(""); }}>
              <Plus className="h-3.5 w-3.5 mr-1" /> New
            </Button>
            <Button variant="ghost" size="sm" disabled={messages.length === 0} onClick={clear}>
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
              <h2 className="mt-6 text-3xl font-semibold tracking-tighter">Ask your company's documents</h2>
              <p className="mt-2 text-sm text-muted-foreground">
                Answers are generated only from your organization's indexed documents, with the sources they came from.
              </p>
              <div className="mt-8 grid grid-cols-1 sm:grid-cols-2 gap-3 text-left">
                {promptCards.map((p) => {
                  const Icon = iconMap[p.icon] || Sparkles;
                  return (
                    <button
                      key={p.title}
                      type="button"
                      onClick={() => setQuestion(p.title)}
                      className="group rounded-xl border border-border bg-card p-4 text-sm flex items-start gap-3 hover:border-primary/40 transition-colors"
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
                      {m.grounded === false ? (
                        <div className="rounded-xl border border-dashed border-border bg-card/40 p-4 flex items-start gap-3">
                          <SearchX className="h-4 w-4 mt-0.5 shrink-0 text-muted-foreground" strokeWidth={1.75} />
                          <div>
                            <p className="text-sm">{m.content}</p>
                            <p className="mt-1 text-xs text-muted-foreground font-mono">{hintFor(m.reason)}</p>
                          </div>
                        </div>
                      ) : (
                        <div className="prose-invert max-w-none">{renderMarkdown(m.content)}</div>
                      )}

                      {m.sources?.length > 0 && (
                        <>
                          <div className="mt-4 flex flex-wrap gap-2">
                            {m.sources.map((s) => (
                              <span key={s.id} className="inline-flex items-center gap-1.5 rounded-md border border-primary/20 bg-primary/5 px-2 py-1 text-[11px] font-mono text-primary">
                                <span>[{s.ref}]</span> {s.title}
                              </span>
                            ))}
                          </div>
                          {/* The side panel is hidden on smaller screens, so show the cards here instead */}
                          <div className="mt-3 space-y-2 xl:hidden">
                            {m.sources.map((s) => <SourceCard key={s.id} source={s} index={s.ref - 1} />)}
                          </div>
                        </>
                      )}

                      <div className="mt-3 flex items-center gap-1 text-muted-foreground">
                        <button className="p-1.5 rounded-md hover:bg-secondary hover:text-foreground transition-colors" onClick={() => { navigator.clipboard.writeText(m.content); toast.success("Copied"); }}>
                          <Copy className="h-3.5 w-3.5" />
                        </button>
                        <button type="button" disabled title="Feedback is coming in a later phase" className="p-1.5 rounded-md opacity-40 cursor-not-allowed"><ThumbsUp className="h-3.5 w-3.5" /></button>
                        <button type="button" disabled title="Feedback is coming in a later phase" className="p-1.5 rounded-md opacity-40 cursor-not-allowed"><ThumbsDown className="h-3.5 w-3.5" /></button>
                      </div>
                    </div>
                  )}
                </div>
              ))}
              {loading && (
                <div className="flex items-center gap-2 text-xs font-mono text-muted-foreground" role="status">
                  <Sparkles className="h-3.5 w-3.5 animate-pulse text-primary" /> Searching your documents and writing an answer…
                </div>
              )}
              <div ref={bottomRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-border bg-background/60 glass px-6 md:px-8 py-4">
          <form onSubmit={ask} className="max-w-3xl mx-auto">
            {error && (
              <div role="alert" className="mb-3 flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-400">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                <span>{error}</span>
              </div>
            )}
            <div className="rounded-2xl border border-border bg-card">
              <textarea
                value={question}
                onChange={(e) => setQuestion(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) ask(e);
                }}
                maxLength={MAX_QUESTION_LENGTH}
                disabled={loading}
                placeholder="Ask a question about your company's documents…"
                rows={2}
                className="w-full resize-none bg-transparent px-4 pt-3 pb-1 text-sm focus:outline-none placeholder:text-muted-foreground disabled:opacity-60"
              />
              <div className="flex items-center justify-between px-2 py-2 border-t border-border/60">
                <div className="flex items-center gap-0.5 text-muted-foreground">
                  <button type="button" disabled title="Attachments are coming in a later phase" className="p-2 rounded-md opacity-50 cursor-not-allowed"><Paperclip className="h-4 w-4" strokeWidth={1.75} /></button>
                  <button type="button" disabled title="Voice input is coming in a later phase" className="p-2 rounded-md opacity-50 cursor-not-allowed"><Mic className="h-4 w-4" strokeWidth={1.75} /></button>
                </div>
                <div className="flex items-center gap-3">
                  <Button type="submit" size="sm" className="rounded-lg h-8 px-3" disabled={loading || !question.trim()}>
                    <Send className="h-3.5 w-3.5 mr-1" /> {loading ? "Asking…" : "Ask"}
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
          {lastAssistant?.sources?.length > 0 ? (
            lastAssistant.sources.map((s) => <SourceCard key={s.id} source={s} index={s.ref - 1} />)
          ) : (
            <div className="text-center text-muted-foreground text-xs font-mono py-16 px-4">
              {lastAssistant ? "This answer has no sources." : "Sources appear here after you ask a question."}
            </div>
          )}
        </div>
      </aside>
    </div>
  );
}
