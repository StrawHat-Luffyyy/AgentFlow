import * as DropdownMenu from "@radix-ui/react-dropdown-menu";
import {
  Activity, BarChart3, ChevronRight, ListChecks, LogOut, Moon, PanelLeftClose, PanelLeftOpen,
  Search, Settings, ShieldCheck, Sun, Workflow,
} from "lucide-react";
import { useCallback, useEffect, useState, type ReactNode } from "react";
import { Link, NavLink, Outlet, useLocation } from "react-router";
import { api } from "../api.js";
import { Badge, BrandMark, IconButton, Kbd, Tooltip, useTheme } from "../design/index.js";
import { usePolling, useSession } from "../lib/session.js";
import { CommandPalette } from "./CommandPalette.js";

const SIDEBAR_KEY = "agentflow.sidebar";

function readCollapsed(): boolean {
  try { return window.localStorage.getItem(SIDEBAR_KEY) === "collapsed"; } catch { return false; }
}

export interface Crumb { label: ReactNode; to?: string }

/** Pages publish their breadcrumbs through this event so the top bar stays in the shell. */
export function useBreadcrumbs(crumbs: Crumb[]) {
  const key = JSON.stringify(crumbs.map((crumb) => [String(crumb.label), crumb.to ?? ""]));
  useEffect(() => {
    window.dispatchEvent(new CustomEvent("agentflow:breadcrumbs", { detail: crumbs }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);
}

const nav = [
  { to: "/runs", label: "Runs", icon: ListChecks },
  { to: "/approvals", label: "Approvals", icon: ShieldCheck },
  { to: "/workflows", label: "Workflows", icon: Workflow },
  { to: "/usage", label: "Usage", icon: BarChart3 },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

function HealthIndicator() {
  // Readiness is public (no auth) and cheap; poll slowly.
  const ready = usePolling(() => api.ready(), [], 10_000);
  const ok = ready.data?.status === "ready" && !ready.error;
  const label = ready.loading ? "Checking services" : ok ? "All systems operational" : "Degraded";
  const detail = ready.loading
    ? "Checking API, database and queue…"
    : ok
      ? `API ok · database ${ready.data?.database ?? "ok"} · queue ${ready.data?.queue ?? "ok"}`
      : `API, database or queue is not responding${ready.error ? `: ${ready.error}` : ""}`;
  return (
    <Tooltip content={detail} side="bottom">
      <span className={`health ${ready.loading ? "" : ok ? "health--ok" : "health--down"}`} role="status" aria-label={`${label}. ${detail}`} tabIndex={0}>
        <Activity size={16} aria-hidden="true" />
        <span className="health-label">{label}</span>
      </span>
    </Tooltip>
  );
}

function UserMenu() {
  const { principal, signOut } = useSession();
  if (!principal) return null;
  const name = principal.username ?? principal.id;
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger className="user-trigger" aria-label={`Account menu for ${name}`}>
        <span className="avatar" aria-hidden="true">{name.charAt(0).toUpperCase()}</span>
        <span className="user-name">{name}</span>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="menu user-menu" align="end" sideOffset={6}>
          <div className="menu-label">
            Signed in as <strong>{name}</strong>
            <div className="user-roles">
              {principal.roles.length === 0
                ? <span className="muted">No roles</span>
                : principal.roles.map((role) => <Badge key={role} tone="neutral">{role}</Badge>)}
            </div>
          </div>
          <DropdownMenu.Separator className="menu-separator" />
          <DropdownMenu.Item className="menu-item" asChild>
            <Link to="/settings"><Settings size={16} aria-hidden="true" />Settings</Link>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="menu-item menu-item--danger" onSelect={signOut}>
            <LogOut size={16} aria-hidden="true" />Sign out
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function AppShell() {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [crumbs, setCrumbs] = useState<Crumb[]>([]);
  const { resolved, toggle } = useTheme();
  const location = useLocation();
  const approvals = usePolling(() => api.listApprovals(), [], 5_000);
  const pending = approvals.data?.approvals.length ?? 0;

  const toggleSidebar = useCallback(() => {
    setCollapsed((value) => {
      try { window.localStorage.setItem(SIDEBAR_KEY, value ? "expanded" : "collapsed"); } catch { /* optional */ }
      return !value;
    });
  }, []);

  useEffect(() => {
    const onCrumbs = (event: Event) => setCrumbs((event as CustomEvent<Crumb[]>).detail);
    window.addEventListener("agentflow:breadcrumbs", onCrumbs);
    return () => window.removeEventListener("agentflow:breadcrumbs", onCrumbs);
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((open) => !open);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => { setPaletteOpen(false); }, [location.pathname]);

  return (
    <div className={`shell ${collapsed ? "shell--collapsed" : ""}`}>
      <a className="skip-link" href="#main">Skip to content</a>
      <aside className="sidebar" aria-label="Primary">
        <div className="sidebar-brand">
          <Link to="/runs" className="brand" aria-label="AgentFlow home">
            <BrandMark size={24} />
            <span className="brand-name">AgentFlow</span>
          </Link>
        </div>
        <nav className="sidebar-nav">
          {nav.map(({ to, label, icon: Icon }) => (
            <NavLink key={to} to={to} className={({ isActive }) => `nav-item ${isActive ? "is-active" : ""}`} title={collapsed ? label : undefined}>
              <Icon size={16} aria-hidden="true" />
              <span className="nav-label">{label}</span>
              {to === "/approvals" && pending > 0 && <span className="nav-count" aria-label={`${pending} pending`}>{pending}</span>}
            </NavLink>
          ))}
        </nav>
        <div className="sidebar-footer">
          <IconButton label={collapsed ? "Expand sidebar" : "Collapse sidebar"} onClick={toggleSidebar}>
            {collapsed ? <PanelLeftOpen size={16} /> : <PanelLeftClose size={16} />}
          </IconButton>
        </div>
      </aside>

      <header className="topbar">
        <nav className="breadcrumbs" aria-label="Breadcrumb">
          <ol>
            {crumbs.map((crumb, index) => (
              <li key={index}>
                {index > 0 && <ChevronRight size={16} aria-hidden="true" className="crumb-sep" />}
                {crumb.to && index < crumbs.length - 1
                  ? <Link to={crumb.to}>{crumb.label}</Link>
                  : <span aria-current={index === crumbs.length - 1 ? "page" : undefined}>{crumb.label}</span>}
              </li>
            ))}
          </ol>
        </nav>
        <div className="topbar-actions">
          <button type="button" className="palette-trigger" onClick={() => setPaletteOpen(true)} aria-label="Open command palette (Ctrl+K)">
            <Search size={16} aria-hidden="true" />
            <span>Search or jump to…</span>
            <Kbd>Ctrl K</Kbd>
          </button>
          <HealthIndicator />
          <IconButton label={resolved === "dark" ? "Switch to light theme" : "Switch to dark theme"} onClick={toggle}>
            {resolved === "dark" ? <Sun size={16} /> : <Moon size={16} />}
          </IconButton>
          <UserMenu />
        </div>
      </header>

      <main id="main" className="main" tabIndex={-1}>
        <Outlet />
      </main>

      <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
    </div>
  );
}
