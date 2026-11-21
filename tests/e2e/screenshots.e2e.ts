import { mkdirSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_USERNAME, adminPassword } from "./env.ts";

// README screenshots (`pnpm screenshots`). All runs use the deterministic scripted provider, so
// every token figure shown is an estimate; the README captions say so.
const out = "docs/screenshots";
test.describe.configure({ mode: "serial" });
test.use({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });

let page: Page;

async function shot(name: string) {
  // Let polling settle and any toast fade so captures are stable.
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: `${out}/${name}.png` });
}

async function setTheme(theme: "light" | "dark") {
  await page.evaluate((value) => window.localStorage.setItem("agentflow.theme", value), theme);
  await page.reload();
}

async function startScriptedRun(): Promise<string> {
  await page.goto("/runs?new=1");
  const drawer = page.getByRole("dialog", { name: "New run" });
  await expect(drawer.getByText(/worker online/i)).toBeVisible();
  await drawer.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  return new URL(page.url()).pathname;
}

const runStatus = (status: string) => page.locator(`.run-title .pill[title="${status}"]`);

test.beforeAll(async ({ browser }) => {
  mkdirSync(out, { recursive: true });
  page = await browser.newPage();
  await page.goto("/login");
  await page.getByLabel("Username").fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(adminPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/runs/);
  await setTheme("light");
});

test.afterAll(async () => {
  await page.close();
});

test("captures the console", async () => {
  test.setTimeout(240_000);

  // 1. The first worker is killed after analyze-features' response is journalled; the
  //    replacement re-dispatches the step once the lease expires and replays the response.
  const recovered = await startScriptedRun();
  await expect(runStatus("WAITING_APPROVAL")).toBeVisible({ timeout: 120_000 });
  await expect(page.getByText(/Replayed from journal/i).first()).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).first().click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(runStatus("SUCCEEDED")).toBeVisible({ timeout: 60_000 });
  await page.getByText("analyze-features", { exact: true }).first().click();
  await page.reload(); // drops the approval toast; the selected step stays in the URL
  await expect(page.getByRole("heading", { name: "analyze-features" })).toBeVisible();
  await shot("run-detail-recovered");
  await setTheme("dark");
  await shot("run-detail-recovered-dark");
  await setTheme("light");

  // 2. A second run, left waiting so the Approvals page has something to show.
  const waiting = await startScriptedRun();
  await expect(runStatus("WAITING_APPROVAL")).toBeVisible({ timeout: 60_000 });
  await page.goto("/approvals");
  await expect(page.getByRole("heading", { name: "Publication approval" })).toBeVisible();
  await shot("approvals");

  await page.goto("/runs");
  await expect(page.locator(`a[href="${recovered}"], tr`).first()).toBeVisible();
  await shot("runs");

  await page.goto("/usage?range=7d");
  await expect(page.getByRole("img", { name: /Tokens per day/ })).toBeVisible();
  await shot("usage");

  await page.goto("/workflows");
  await page.getByRole("link", { name: "cloud-comparison-scripted" }).click();
  await expect(page.locator(".wf-step")).toHaveCount(9);
  await shot("workflow");

  expect(waiting).not.toBe(recovered);
});
