import { LogOut } from "lucide-react";
import { Badge, Button, Card, KeyValue, SegmentedControl, useTheme, type ThemePreference } from "../design/index.js";
import { useSession } from "../lib/session.js";
import { useBreadcrumbs } from "../shell/AppShell.js";
import { PageHeader } from "./common.js";

const roleHelp: Record<string, string> = {
  "research-reviewer": "Decides research-report publication approvals",
  "release-manager": "Decides release approvals",
  operator: "Resolves side effects whose outcome is unknown (reconcile)",
};

/** Appearance (stored in this browser only) and the signed-in session. */
export function SettingsPage() {
  useBreadcrumbs([{ label: "Settings" }]);
  const { preference, setPreference } = useTheme();
  const { principal, signOut } = useSession();
  const roles = principal?.roles ?? [];

  return (
    <div className="page page--narrow">
      <PageHeader title="Settings" description="Appearance for this browser, and the session you are signed in with." />
      <Card title="Appearance" meta="Saved in this browser">
        <SegmentedControl<ThemePreference>
          label="Theme"
          value={preference}
          onChange={setPreference}
          options={[
            { value: "system", label: "System", help: "Follow the operating system" },
            { value: "light", label: "Light" },
            { value: "dark", label: "Dark" },
          ]}
        />
      </Card>
      <Card title="Session" actions={<Button variant="secondary" size="sm" icon={<LogOut size={16} />} onClick={signOut}>Sign out</Button>}>
        <KeyValue items={[
          { label: "Signed in as", value: principal?.username ?? principal?.id ?? "—" },
          { label: "Principal id", value: <code>{principal?.id ?? "—"}</code> },
          {
            label: "Roles",
            value: roles.length === 0 ? <span className="muted">None — you can start and watch runs, but not decide approvals or reconcile</span> : (
              <ul className="role-list">
                {roles.map((role) => (
                  <li key={role}><Badge tone="neutral">{role}</Badge><span className="muted">{roleHelp[role] ?? ""}</span></li>
                ))}
              </ul>
            ),
          },
        ]} />
        <p className="metric-note">Roles come from the API's credential configuration and cannot be changed here.</p>
      </Card>
    </div>
  );
}
