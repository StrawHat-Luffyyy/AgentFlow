import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { BrandMark, ThemeProvider, ToastProvider, TooltipProvider } from "./design/index.js";
import { SessionProvider, useSession } from "./lib/session.js";
import { LoginPage } from "./pages/LoginPage.js";
import { RunDetailPage } from "./pages/RunDetailPage.js";
import { RunsPage } from "./pages/RunsPage.js";
import { UpcomingPage } from "./pages/UpcomingPage.js";
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
                  <Route path="/runs/new" element={<Navigate to="/runs?new=1" replace />} />
                  <Route path="/runs/:id" element={<RunDetailPage />} />
                  <Route path="/approvals/*" element={<UpcomingPage title="Approvals" description="Pending human checkpoints across your runs." interim="Until then, pending approvals can be decided from each run's page." />} />
                  <Route path="/workflows" element={<UpcomingPage title="Workflows" description="Workflow definitions and their immutable versions." />} />
                  <Route path="/usage" element={<UpcomingPage title="Usage" description="Billed, cached and saved tokens over time." interim="Per-run token figures are already on each run's page." />} />
                  <Route path="/settings" element={<UpcomingPage title="Settings" description="Appearance and session." interim="The theme toggle is in the top bar." />} />
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
