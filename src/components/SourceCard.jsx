import { FileText } from "lucide-react";

const typeColors = {
  PDF: "text-red-400 bg-red-500/10 border-red-500/20",
  MD: "text-cyan-400 bg-cyan-500/10 border-cyan-500/20",
  DOCX: "text-blue-400 bg-blue-500/10 border-blue-500/20",
  CSV: "text-emerald-400 bg-emerald-500/10 border-emerald-500/20",
  TXT: "text-amber-400 bg-amber-500/10 border-amber-500/20",
};

export default function SourceCard({ source, index }) {
  const cls = typeColors[source.type] || typeColors.PDF;
  return (
    <button
      className="w-full text-left group rounded-lg border border-border bg-card hover:border-primary/40 hover:bg-secondary/40 transition-colors p-3 flex items-start gap-3"
    >
      <span className={`shrink-0 h-8 w-8 rounded-md border flex items-center justify-center font-mono text-[10px] ${cls}`}>
        {source.type}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          {typeof index === "number" && (
            <span className="font-mono text-[10px] text-muted-foreground">[{index + 1}]</span>
          )}
          <p className="text-sm font-medium truncate group-hover:text-primary transition-colors">
            {source.title}
          </p>
        </div>
        <p className="mt-0.5 font-mono text-[11px] text-muted-foreground">
          {source.meta}
        </p>
      </div>
      <FileText className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity" strokeWidth={1.75} />
    </button>
  );
}
