export default function EmptyState({ icon: Icon, title, description, action }) {
  return (
    <div className="rounded-2xl border border-dashed border-border bg-card/40 p-10 flex flex-col items-center justify-center text-center">
      {Icon && (
        <div className="mb-5 h-12 w-12 rounded-xl bg-primary/10 border border-primary/20 flex items-center justify-center text-primary">
          <Icon className="h-5 w-5" strokeWidth={1.75} />
        </div>
      )}
      <h3 className="text-lg font-semibold tracking-tight">{title}</h3>
      {description && (
        <p className="mt-2 text-sm text-muted-foreground max-w-md font-mono">{description}</p>
      )}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
}
