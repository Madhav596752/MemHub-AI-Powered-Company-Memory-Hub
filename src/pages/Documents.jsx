import { useState, useRef } from "react";
import { Upload, Search, FileText, MoreHorizontal, CheckCircle2, AlertCircle, Loader2, Trash2, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { documents as seedDocs } from "@/data/mockData";
import { toast } from "sonner";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const statusMeta = {
  indexed: { label: "Indexed", icon: CheckCircle2, cls: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" },
  processing: { label: "Processing", icon: Loader2, cls: "bg-amber-500/10 text-amber-400 border-amber-500/20" },
  failed: { label: "Failed", icon: AlertCircle, cls: "bg-destructive/10 text-destructive border-destructive/20" },
};

const typeCls = {
  PDF: "bg-red-500/10 text-red-400 border-red-500/20",
  MD: "bg-cyan-500/10 text-cyan-400 border-cyan-500/20",
  DOCX: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  CSV: "bg-emerald-500/10 text-emerald-400 border-emerald-500/20",
  TXT: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

export default function Documents() {
  const [docs, setDocs] = useState(seedDocs);
  const [q, setQ] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef(null);

  const filtered = docs.filter((d) => d.name.toLowerCase().includes(q.toLowerCase()));

  const handleFiles = (files) => {
    const list = Array.from(files);
    const newDocs = list.map((f, i) => ({
      id: `d${Date.now()}-${i}`,
      name: f.name,
      type: (f.name.split(".").pop() || "TXT").toUpperCase(),
      uploader: "You",
      date: new Date().toLocaleDateString("en-US", { month: "short", day: "2-digit", year: "numeric" }),
      status: "processing",
      chunks: 0,
      size: `${(f.size / 1024).toFixed(0)} KB`,
    }));
    setDocs((d) => [...newDocs, ...d]);
    toast.success(`${list.length} file(s) queued for processing`);
    // simulate processing
    newDocs.forEach((n) => {
      setTimeout(() => {
        setDocs((d) => d.map((x) => x.id === n.id ? { ...x, status: "indexed", chunks: Math.floor(Math.random() * 100) + 20 } : x));
      }, 2200);
    });
  };

  const onDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    if (e.dataTransfer.files?.length) handleFiles(e.dataTransfer.files);
  };

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tighter">Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">Upload, index and manage your organization's documents.</p>
        </div>
        <Button onClick={() => inputRef.current?.click()} className="rounded-lg h-10">
          <Upload className="h-4 w-4 mr-2" /> Upload Document
        </Button>
        <input ref={inputRef} type="file" multiple hidden onChange={(e) => e.target.files && handleFiles(e.target.files)} />
      </div>

      {/* Drop zone */}
      <div
        onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
        onDragLeave={() => setDragOver(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current?.click()}
        className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          dragOver ? "border-primary bg-primary/5" : "border-border bg-card/40 hover:border-primary/40"
        }`}
      >
        <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
          <Upload className="h-5 w-5" strokeWidth={1.75} />
        </div>
        <p className="mt-4 text-sm font-medium">Drag & drop to upload</p>
        <p className="mt-1 text-xs text-muted-foreground font-mono">Supports PDF, DOCX, TXT, CSV, MD · Max 25 MB per file</p>
      </div>

      {/* Search */}
      <div className="relative max-w-md">
        <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" strokeWidth={1.75} />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search documents…"
          className="w-full h-10 pl-9 pr-3 text-sm rounded-lg bg-card border border-border focus:outline-none focus:ring-2 focus:ring-primary/40 focus:border-primary/40"
        />
      </div>

      {/* Table */}
      <div className="rounded-2xl border border-border bg-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-left text-[11px] uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
              <tr>
                <th className="px-5 py-3 font-medium">Document</th>
                <th className="px-5 py-3 font-medium">Type</th>
                <th className="px-5 py-3 font-medium">Uploaded By</th>
                <th className="px-5 py-3 font-medium">Date</th>
                <th className="px-5 py-3 font-medium">Status</th>
                <th className="px-5 py-3 font-medium text-right">Chunks</th>
                <th className="px-5 py-3 font-medium w-10"></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((d) => {
                const st = statusMeta[d.status];
                const StIcon = st.icon;
                return (
                  <tr key={d.id} className="border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
                    <td className="px-5 py-3">
                      <div className="flex items-center gap-3 min-w-0">
                        <span className="h-8 w-8 rounded-md border border-border bg-secondary/60 flex items-center justify-center text-muted-foreground shrink-0">
                          <FileText className="h-4 w-4" strokeWidth={1.75} />
                        </span>
                        <div className="min-w-0">
                          <p className="truncate font-medium">{d.name}</p>
                          <p className="text-[11px] font-mono text-muted-foreground">{d.size}</p>
                        </div>
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${typeCls[d.type] || typeCls.TXT}`}>
                        {d.type}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{d.uploader}</td>
                    <td className="px-5 py-3 text-muted-foreground font-mono text-xs">{d.date}</td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] font-mono ${st.cls}`}>
                        <StIcon className={`h-3 w-3 ${d.status === "processing" ? "animate-spin" : ""}`} />
                        {st.label}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right font-mono text-xs">{d.chunks || "—"}</td>
                    <td className="px-5 py-3">
                      <DropdownMenu>
                        <DropdownMenuTrigger>
                          <button className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary transition-colors">
                            <MoreHorizontal className="h-4 w-4" />
                          </button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="w-44">
                          <DropdownMenuItem><Download className="h-4 w-4 mr-2" /> Download</DropdownMenuItem>
                          <DropdownMenuItem className="text-destructive focus:text-destructive" onClick={() => setDocs((x) => x.filter((y) => y.id !== d.id))}>
                            <Trash2 className="h-4 w-4 mr-2" /> Delete
                          </DropdownMenuItem>
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
              {filtered.length === 0 && (
                <tr><td colSpan={7} className="text-center text-muted-foreground font-mono text-xs py-10">No documents.</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}