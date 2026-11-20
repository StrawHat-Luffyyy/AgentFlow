import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { BrandMark, ThemeProvider, ToastProvider, TooltipProvider } from "./design/index.js";
import { SessionProvider, useSession } from "./lib/session.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RunDetailPage } from "./pages/RunDetailPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { ApprovalsPage } from "./pages/ApprovalsPage.js";
import { SettingsPage } from "./pages/SettingsPage.js";
import { UsagePage } from "./pages/UsagePage.js";
import { WorkflowDetailPage, WorkflowsPage } from "./pages/WorkflowsPage.js";
import { AppShell } from "./shell/AppShell.js";

function RequireSession({ children }: { children: ReactNode }) {
  const { principal, checking } = useSession();
  const location = useLocation();
  if (checking) {
    return (
      <main className="auth" aria-busy="true">
        <div className="auth-column auth-column--center"><BrandMark size={28} /><p className="muted">Checking session…</p></div>
      </main>
    );
  }
  if (!principal) return <Navigate to="/login" replace state={{ from: `${location.pathname}${location.search}` }} />;
  return <>{children}</>;
}

/** /runs/new opens the New run drawer over the runs list; ?workflow=<id> preselects a workflow. */
function NewRunRedirect() {
  const params = new URLSearchParams(useLocation().search);
  params.set("new", "1");
  return <Navigate to={`/runs?${params.toString()}`} replace />;
}

export function App() {
  return (
    <ThemeProvider>
      <TooltipProvider delayDuration={400}>
        <ToastProvider>
          <SessionProvider>
            <BrowserRouter>
              <Routes>
                <Route path="/login" element={<LoginPage />} />
                <Route element={<RequireSession><AppShell /></RequireSession>}>
                  <Route index element={<Navigate to="/runs" replace />} />
                  <Route path="/runs" element={<RunsPage />} />
                  <Route path="/runs/new" element={<NewRunRedirect />} />
                  <Route path="/runs/:id" element={<RunDetailPage />} />
                  <Route path="/approvals" element={<ApprovalsPage />} />
                  <Route path="/workflows" element={<WorkflowsPage />} />
                  <Route path="/workflows/:id" element={<WorkflowDetailPage />} />
                  <Route path="/usage" element={<UsagePage />} />
                  <Route path="/settings" element={<SettingsPage />} />
                  <Route path="*" element={<Navigate to="/runs" replace />} />
                </Route>
              </Routes>
            </BrowserRouter>
          </SessionProvider>
        </ToastProvider>
      </TooltipProvider>
    </ThemeProvider>
  );
}
