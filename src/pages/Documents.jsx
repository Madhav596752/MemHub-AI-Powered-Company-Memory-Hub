import { useEffect, useRef, useState } from "react";
import { Upload, Search, FileText, ExternalLink, Trash2, Loader2, X, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import EmptyState from "@/components/EmptyState";
import { api } from "@/api";

const typeCls = {
  PDF: "bg-red-500/10 text-red-400 border-red-500/20",
  DOCX: "bg-blue-500/10 text-blue-400 border-blue-500/20",
  TXT: "bg-amber-500/10 text-amber-400 border-amber-500/20",
};

const MAX_SIZE = 10 * 1024 * 1024; // keep in sync with the server limit

function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(iso) {
  return new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

export default function Documents() {
  const [documents, setDocuments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [uploading, setUploading] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(null); // document shown in the details panel
  const [deletingId, setDeletingId] = useState(null);
  const fileInput = useRef(null);

  async function loadDocuments() {
    try {
      const data = await api("/api/documents");
      setDocuments(data.documents);
      setLoadError("");
    } catch (err) {
      setLoadError(err.message);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadDocuments();
  }, []);

  async function uploadFile(file) {
    if (!file || uploading) return;

    // Quick checks so the user gets instant feedback (the server checks again)
    if (!/\.(pdf|docx|txt)$/i.test(file.name)) {
      toast.error("Only PDF, DOCX and TXT files are allowed");
      return;
    }
    if (file.size === 0) {
      toast.error("That file is empty");
      return;
    }
    if (file.size > MAX_SIZE) {
      toast.error("File is too large (maximum 10 MB)");
      return;
    }

    setUploading(true);
    try {
      const form = new FormData();
      form.append("file", file);
      const data = await api("/api/documents", { method: "POST", body: form });
      // The file is saved even when indexing fails, so check the indexing result before claiming success
      if (data.indexing?.status === "indexed") {
        toast.success(`"${data.document.originalName}" uploaded and indexed`);
      } else {
        toast.error(
          `"${data.document.originalName}" was saved but is NOT searchable yet. ${data.indexing?.message || "Indexing failed."}`,
          { duration: 15000, action: { label: "Retry", onClick: () => reindexDocument(data.document) } }
        );
      }
      await loadDocuments();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setUploading(false);
      if (fileInput.current) fileInput.current.value = ""; // allow picking the same file again
    }
  }

  async function reindexDocument(doc) {
    try {
      const data = await api(`/api/documents/${doc.id}/reindex`, { method: "POST" });
      toast.success(`"${doc.originalName}" indexed (${data.indexing.chunks} chunks)`);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function openDetails(id) {
    try {
      const data = await api(`/api/documents/${id}`);
      setSelected(data.document);
    } catch (err) {
      toast.error(err.message);
    }
  }

  async function deleteDocument(doc) {
    if (!window.confirm(`Delete "${doc.originalName}"? This cannot be undone.`)) return;
    setDeletingId(doc.id);
    try {
      await api(`/api/documents/${doc.id}`, { method: "DELETE" });
      toast.success("Document deleted");
      if (selected?.id === doc.id) setSelected(null);
      await loadDocuments();
    } catch (err) {
      toast.error(err.message);
    } finally {
      setDeletingId(null);
    }
  }

  const filtered = documents.filter((d) => d.originalName.toLowerCase().includes(q.toLowerCase()));

  return (
    <div className="p-6 md:p-8 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-col md:flex-row md:items-end md:justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tighter">Documents</h1>
          <p className="mt-1 text-sm text-muted-foreground">Upload and manage your organization's documents.</p>
        </div>
        <Button onClick={() => fileInput.current?.click()} disabled={uploading} className="rounded-lg h-10">
          {uploading ? <Loader2 className="h-4 w-4 mr-2 animate-spin" /> : <Upload className="h-4 w-4 mr-2" />}
          {uploading ? "Uploading…" : "Upload Document"}
        </Button>
        <input
          ref={fileInput}
          type="file"
          accept=".pdf,.docx,.txt"
          className="hidden"
          onChange={(e) => uploadFile(e.target.files?.[0])}
        />
      </div>

      {/* Upload area: click or drop a file */}
      <div
        onClick={() => !uploading && fileInput.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          uploadFile(e.dataTransfer.files?.[0]);
        }}
        className={`rounded-2xl border-2 border-dashed p-10 text-center cursor-pointer transition-colors ${
          dragging ? "border-primary bg-primary/5" : "border-border bg-card/40 hover:border-primary/40"
        }`}
      >
        <div className="mx-auto h-12 w-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
          {uploading ? <Loader2 className="h-5 w-5 animate-spin" /> : <Upload className="h-5 w-5" strokeWidth={1.75} />}
        </div>
        <p className="mt-4 text-sm font-medium">
          {uploading ? "Uploading and reading your document…" : "Click to choose a file, or drag it here"}
        </p>
        <p className="mt-1 text-xs text-muted-foreground font-mono">PDF, DOCX or TXT · up to 10 MB</p>
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

      {loadError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 text-destructive text-sm px-4 py-3 flex items-center justify-between gap-4">
          <span>{loadError}</span>
          <Button variant="outline" size="sm" onClick={loadDocuments}>Retry</Button>
        </div>
      )}

      {loading ? (
        <p className="text-center text-muted-foreground font-mono text-xs py-10">Loading documents…</p>
      ) : documents.length === 0 && !loadError ? (
        <EmptyState
          icon={FileText}
          title="No documents yet"
          description="Upload your first PDF, DOCX or TXT file to get started."
        />
      ) : (
        <div className="rounded-2xl border border-border bg-card overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="text-left text-[11px] uppercase tracking-[0.14em] text-muted-foreground border-b border-border">
                <tr>
                  <th className="px-5 py-3 font-medium">Document</th>
                  <th className="px-5 py-3 font-medium">Type</th>
                  <th className="px-5 py-3 font-medium">Uploaded By</th>
                  <th className="px-5 py-3 font-medium">Date</th>
                  <th className="px-5 py-3 font-medium text-right">Actions</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((d) => (
                  <tr key={d.id} className="border-b border-border last:border-0 hover:bg-secondary/40 transition-colors">
                    <td className="px-5 py-3">
                      <button type="button" onClick={() => openDetails(d.id)} className="flex items-center gap-3 min-w-0 text-left">
                        <span className="h-8 w-8 rounded-md border border-border bg-secondary/60 flex items-center justify-center text-muted-foreground shrink-0">
                          <FileText className="h-4 w-4" strokeWidth={1.75} />
                        </span>
                        <span className="min-w-0">
                          <span className="block truncate font-medium hover:underline">{d.originalName}</span>
                          <span className="block text-[11px] font-mono text-muted-foreground">{formatSize(d.fileSize)}</span>
                        </span>
                      </button>
                    </td>
                    <td className="px-5 py-3">
                      <span className={`inline-flex items-center rounded-md border px-1.5 py-0.5 font-mono text-[10px] ${typeCls[d.fileType] || typeCls.TXT}`}>
                        {d.fileType}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-muted-foreground">{d.uploader?.name || "—"}</td>
                    <td className="px-5 py-3 text-muted-foreground font-mono text-xs">{formatDate(d.createdAt)}</td>
                    <td className="px-5 py-3">
                      <div className="flex items-center justify-end gap-1">
                        <a
                          href={d.cloudinaryUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          title="Open / download"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-foreground hover:bg-secondary/60"
                        >
                          <ExternalLink className="h-4 w-4" />
                        </a>
                        <button
                          type="button"
                          onClick={() => deleteDocument(d)}
                          disabled={deletingId === d.id}
                          title="Delete"
                          className="p-1.5 rounded-md text-muted-foreground hover:text-destructive hover:bg-destructive/10 disabled:opacity-50"
                        >
                          {deletingId === d.id ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
                {filtered.length === 0 && (
                  <tr><td colSpan={5} className="text-center text-muted-foreground font-mono text-xs py-10">No documents match your search.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Details panel */}
      {selected && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4" onClick={() => setSelected(null)}>
          <div
            className="w-full max-w-xl max-h-[85vh] overflow-y-auto rounded-2xl border border-border bg-card p-6 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <h2 className="text-lg font-semibold tracking-tight break-all">{selected.originalName}</h2>
              <button type="button" onClick={() => setSelected(null)} className="p-1 rounded-md text-muted-foreground hover:text-foreground" title="Close">
                <X className="h-4 w-4" />
              </button>
            </div>

            <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
              <div><dt className="text-xs text-muted-foreground font-mono">Type</dt><dd>{selected.fileType}</dd></div>
              <div><dt className="text-xs text-muted-foreground font-mono">Size</dt><dd>{formatSize(selected.fileSize)}</dd></div>
              <div><dt className="text-xs text-muted-foreground font-mono">Uploaded by</dt><dd>{selected.uploader?.name || "—"}</dd></div>
              <div><dt className="text-xs text-muted-foreground font-mono">Date</dt><dd>{formatDate(selected.createdAt)}</dd></div>
              <div><dt className="text-xs text-muted-foreground font-mono">Extracted text</dt><dd>{selected.textLength.toLocaleString()} characters</dd></div>
            </dl>

            <div>
              <p className="text-xs text-muted-foreground font-mono mb-1">Text preview</p>
              <pre className="whitespace-pre-wrap break-words rounded-lg border border-border bg-secondary/40 p-3 text-xs max-h-60 overflow-y-auto">
                {selected.textPreview}
                {selected.textLength > selected.textPreview.length ? "\n…" : ""}
              </pre>
            </div>

            <div className="flex justify-end gap-2">
              <Button variant="outline" className="rounded-lg" onClick={() => reindexDocument(selected)} title="Rebuild the searchable index for this document">
                <RefreshCw className="h-4 w-4 mr-2" /> Re-index
              </Button>
              <a href={selected.cloudinaryUrl} target="_blank" rel="noopener noreferrer">
                <Button variant="outline" className="rounded-lg"><ExternalLink className="h-4 w-4 mr-2" /> Open</Button>
              </a>
              <Button variant="destructive" className="rounded-lg" onClick={() => deleteDocument(selected)} disabled={deletingId === selected.id}>
                <Trash2 className="h-4 w-4 mr-2" /> Delete
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
