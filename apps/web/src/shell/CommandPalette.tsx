import * as RadixDialog from "@radix-ui/react-dialog";
import { ArrowRight, BarChart3, CornerDownLeft, ListChecks, Moon, Plus, Search, Settings, ShieldCheck, Workflow } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useNavigate } from "react-router";
import { api, type RunSummary } from "../api.js";
import { StatusPill, useTheme } from "../design/index.js";
import { formatRelative, shortId } from "../lib/format.js";

interface Command {
  id: string;
  group: "Runs" | "Navigate" | "Actions";
  label: ReactNode;
  keywords: string;
  icon: ReactNode;
  hint?: ReactNode;
  run: () => void;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Ctrl/Cmd+K: jump to a run by ID prefix or workflow name, go to a page, or run a quick action. */
export function CommandPalette({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const navigate = useNavigate();
  const { toggle, resolved } = useTheme();
  const [query, setQuery] = useState("");
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [active, setActive] = useState(0);
  const listId = useId();
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setActive(0);
    api.listRuns().then((body) => setRuns(body.runs)).catch(() => setRuns([]));
  }, [open]);

  const go = (path: string) => () => { onOpenChange(false); navigate(path); };

  const commands = useMemo<Command[]>(() => {
    const needle = query.trim().toLowerCase();
    const runCommands: Command[] = runs
      .filter((run) => !needle || run.id.startsWith(needle) || run.workflowName.toLowerCase().includes(needle))
      .slice(0, needle ? 8 : 5)
      .map((run) => ({
        id: `run:${run.id}`,
        group: "Runs",
        label: <><code>{shortId(run.id)}</code><span className="palette-run-name">{run.workflowName}</span></>,
        keywords: `${run.id} ${run.workflowName}`,
        icon: <ListChecks size={16} />,
        hint: <><StatusPill value={run.publicStatus} size="sm" /><span className="palette-hint">{formatRelative(run.createdAt, Date.now())}</span></>,
        run: go(`/runs/${run.id}`),
      }));
    if (UUID.test(needle) && !runs.some((run) => run.id === needle)) {
      runCommands.unshift({
        id: `run:${needle}`, group: "Runs", label: <>Open run <code>{shortId(needle)}</code></>, keywords: needle,
        icon: <ArrowRight size={16} />, run: go(`/runs/${needle}`),
      });
    }
    const pages: Command[] = [
      { id: "nav:runs", group: "Navigate", label: "Runs", keywords: "runs list", icon: <ListChecks size={16} />, run: go("/runs") },
      { id: "nav:approvals", group: "Navigate", label: "Approvals", keywords: "approvals review pending", icon: <ShieldCheck size={16} />, run: go("/approvals") },
      { id: "nav:workflows", group: "Navigate", label: "Workflows", keywords: "workflows versions", icon: <Workflow size={16} />, run: go("/workflows") },
      { id: "nav:usage", group: "Navigate", label: "Usage", keywords: "usage tokens cost", icon: <BarChart3 size={16} />, run: go("/usage") },
      { id: "nav:settings", group: "Navigate", label: "Settings", keywords: "settings preferences", icon: <Settings size={16} />, run: go("/settings") },
    ];
    const actions: Command[] = [
      { id: "act:new", group: "Actions", label: "Start a new run", keywords: "new run start create", icon: <Plus size={16} />, run: go("/runs?new=1") },
      { id: "act:theme", group: "Actions", label: `Switch to ${resolved === "dark" ? "light" : "dark"} theme`, keywords: "theme dark light toggle appearance", icon: <Moon size={16} />, run: () => { toggle(); onOpenChange(false); } },
    ];
    const matches = (command: Command) => !needle || command.keywords.includes(needle) || String(command.label).toLowerCase().includes(needle);
    return [...runCommands, ...pages.filter(matches), ...actions.filter(matches)];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, runs, resolved]);

  useEffect(() => { setActive(0); }, [query]);
  useEffect(() => {
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  const groups = ["Runs", "Navigate", "Actions"] as const;
  let index = -1;

  return (
    <RadixDialog.Root open={open} onOpenChange={onOpenChange}>
      <RadixDialog.Portal>
        <RadixDialog.Overlay className="dialog-overlay" />
        <RadixDialog.Content className="palette" aria-describedby={undefined}>
          <RadixDialog.Title className="visually-hidden">Command palette</RadixDialog.Title>
          <div className="palette-input">
            <Search size={16} aria-hidden="true" />
            <input
              autoFocus
              role="combobox"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={commands[active] ? `${listId}-${active}` : undefined}
              aria-label="Search runs, pages and actions"
              placeholder="Run ID prefix, workflow name, page or action…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "ArrowDown") { event.preventDefault(); setActive((value) => Math.min(value + 1, commands.length - 1)); }
                if (event.key === "ArrowUp") { event.preventDefault(); setActive((value) => Math.max(value - 1, 0)); }
                if (event.key === "Enter") { event.preventDefault(); commands[active]?.run(); }
              }}
            />
          </div>
          <ul className="palette-list" id={listId} role="listbox" ref={listRef} aria-label="Results">
            {commands.length === 0 && <li className="palette-empty">No matches. Paste a full run ID to open it directly.</li>}
            {groups.map((group) => {
              const items = commands.filter((command) => command.group === group);
              if (items.length === 0) return null;
              return (
                <li key={group} role="presentation">
                  <div className="palette-group" aria-hidden="true">{group}</div>
                  <ul role="group" aria-label={group}>
                    {items.map((command) => {
                      index += 1;
                      const current = index;
                      return (
                        <li
                          key={command.id}
                          id={`${listId}-${current}`}
                          data-index={current}
                          role="option"
                          aria-selected={current === active}
                          className={`palette-item ${current === active ? "is-active" : ""}`}
                          onMouseMove={() => setActive(current)}
                          onClick={command.run}
                        >
                          <span className="palette-icon" aria-hidden="true">{command.icon}</span>
                          <span className="palette-label">{command.label}</span>
                          {command.hint && <span className="palette-meta">{command.hint}</span>}
                          {current === active && <CornerDownLeft size={16} className="palette-enter" aria-hidden="true" />}
                        </li>
                      );
                    })}
                  </ul>
                </li>
              );
            })}
          </ul>
        </RadixDialog.Content>
      </RadixDialog.Portal>
    </RadixDialog.Root>
  );
}
