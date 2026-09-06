import { NavLink, useNavigate } from "react-router-dom";
import {
  LayoutDashboard,
  Sparkles,
  Library,
  FileText,
  Share2,
  Search,
  BarChart3,
  Settings,
  HelpCircle,
  ChevronsLeft,
  ChevronsRight,
  FolderOpen,
  Users,
  LogOut,
} from "lucide-react";
import Logo from "@/components/Logo";
import { currentUser } from "@/data/mockData";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

const primaryNav = [
  { to: "/app", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/app/assistant", label: "AI Assistant", icon: Sparkles },
  { to: "/app/knowledge", label: "Knowledge Base", icon: Library },
  { to: "/app/documents", label: "Documents", icon: FileText },
  { to: "/app/graph", label: "Knowledge Graph", icon: Share2 },
  { to: "/app/search", label: "Search", icon: Search },
  { to: "/app/analytics", label: "Analytics", icon: BarChart3 },
];

const workspaceNav = [
  { to: "/app", label: "My Workspace", icon: FolderOpen },
  { to: "/app", label: "Team Knowledge", icon: Users },
];

function NavItem({ item, collapsed }) {
  return (
    <NavLink
      to={item.to}
      end={item.end}
      title={collapsed ? item.label : undefined}
      className={({ isActive }) =>
        `group relative flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors duration-150 text-muted-foreground hover:text-foreground hover:bg-secondary/60 ${
          isActive ? "text-foreground bg-secondary" : ""
        } ${collapsed ? "justify-center px-0" : ""}`
      }
    >
      {({ isActive }) => (
        <>
          {isActive && (
            <span className="absolute left-0 top-1/2 h-5 -translate-y-1/2 w-[2px] rounded-r bg-primary" />
          )}
          <item.icon className="h-[18px] w-[18px] shrink-0" strokeWidth={1.75} />
          {!collapsed && <span className="truncate">{item.label}</span>}
        </>
      )}
    </NavLink>
  );
}

export default function Sidebar({ collapsed, onToggle }) {
  const navigate = useNavigate();

  return (
      <aside
        className={`hidden md:flex flex-col border-r border-border bg-card/40 h-screen sticky top-0 transition-[width] duration-200 ${
          collapsed ? "w-[68px]" : "w-[248px]"
        }`}
      >
        <div className={`h-16 flex items-center border-b border-border ${collapsed ? "justify-center px-2" : "px-5 justify-between"}`}>
          <Logo iconOnly={collapsed} to="/app" />
          {!collapsed && (
            <button
              onClick={onToggle}
              className="p-1.5 rounded-md hover:bg-secondary text-muted-foreground hover:text-foreground transition-colors"
              aria-label="Collapse sidebar"
            >
              <ChevronsLeft className="h-4 w-4" strokeWidth={1.75} />
            </button>
          )}
        </div>

        <nav className="flex-1 overflow-y-auto no-scrollbar px-3 py-4 space-y-6">
          <div className="space-y-1">
            {!collapsed && (
              <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                Navigation
              </p>
            )}
            {primaryNav.map((item) => (
              <NavItem key={item.label} item={item} collapsed={collapsed} />
            ))}
          </div>

          <div className="space-y-1">
            {!collapsed && (
              <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground/70">
                Workspace
              </p>
            )}
            {workspaceNav.map((item) => (
              <NavItem key={item.label} item={item} collapsed={collapsed} />
            ))}
          </div>
        </nav>

        <div className="border-t border-border p-3 space-y-1">
          <NavItem
            item={{ to: "/app/settings", label: "Settings", icon: Settings }}
            collapsed={collapsed}
          />
          <NavItem
            item={{ to: "/app", label: "Help", icon: HelpCircle }}
            collapsed={collapsed}
          />
          {collapsed ? (
            <button
              onClick={onToggle}
              className="w-full flex items-center justify-center p-2 rounded-lg text-muted-foreground hover:bg-secondary hover:text-foreground"
              aria-label="Expand sidebar"
            >
              <ChevronsRight className="h-4 w-4" strokeWidth={1.75} />
            </button>
          ) : (
            <DropdownMenu>
              <DropdownMenuTrigger>
                <button
                  className="w-full mt-2 flex items-center gap-3 rounded-lg p-2 hover:bg-secondary text-left transition-colors"
                >
                  <div className="h-8 w-8 rounded-full bg-primary/15 border border-primary/30 flex items-center justify-center text-primary text-xs font-semibold">
                    {currentUser.avatarInitials}
                  </div>
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-medium truncate">{currentUser.name}</p>
                    <p className="text-xs text-muted-foreground truncate">{currentUser.company}</p>
                  </div>
                </button>
              </DropdownMenuTrigger>
              <DropdownMenuContent side="top" align="end" className="w-56">
                <DropdownMenuItem onClick={() => navigate("/app/settings")}>
                  <Settings className="h-4 w-4 mr-2" /> Settings
                </DropdownMenuItem>
                <DropdownMenuItem>
                  <HelpCircle className="h-4 w-4 mr-2" /> Help & docs
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => navigate("/")} className="text-destructive focus:text-destructive">
                  <LogOut className="h-4 w-4 mr-2" /> Sign out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
        </div>
      </aside>
  );
}
