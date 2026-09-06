import { cloneElement, createContext, useContext, useEffect, useRef, useState } from "react";

const DropdownContext = createContext(null);

export function DropdownMenu({ children }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    if (!open) return;
    const onClickOutside = (e) => {
      if (rootRef.current && !rootRef.current.contains(e.target)) setOpen(false);
    };
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, [open]);

  return (
    <DropdownContext.Provider value={{ open, setOpen }}>
      <div ref={rootRef} className="relative inline-block">
        {children}
      </div>
    </DropdownContext.Provider>
  );
}

export function DropdownMenuTrigger({ children }) {
  const { open, setOpen } = useContext(DropdownContext);
  return cloneElement(children, {
    onClick: (e) => {
      children.props.onClick?.(e);
      setOpen(!open);
    },
  });
}

export function DropdownMenuContent({ align = "start", side = "bottom", className = "", children }) {
  const { open, setOpen } = useContext(DropdownContext);
  if (!open) return null;

  const alignCls = align === "end" ? "right-0" : align === "center" ? "left-1/2 -translate-x-1/2" : "left-0";
  const sideCls = side === "top" ? "bottom-full mb-2" : "top-full mt-2";

  return (
    <div
      onClick={() => setOpen(false)}
      className={`absolute ${sideCls} ${alignCls} z-50 min-w-[8rem] overflow-hidden rounded-lg border border-border bg-card p-1 text-sm shadow-xl ${className}`}
    >
      {children}
    </div>
  );
}

export function DropdownMenuItem({ className = "", ...props }) {
  return (
    <div
      className={`relative flex cursor-pointer select-none items-center gap-2 rounded-md px-2 py-1.5 text-sm outline-none transition-colors hover:bg-secondary/60 ${className}`}
      {...props}
    />
  );
}

export function DropdownMenuSeparator() {
  return <div className="-mx-1 my-1 h-px bg-border" />;
}
