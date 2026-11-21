import { expect, test, type Page } from "@playwright/test";
import { E2E_ADMIN_USERNAME, adminPassword } from "./env.ts";

// One journey, in order, against the isolated stack: each step builds on the run the earlier ones made.
test.describe.configure({ mode: "serial" });

let page: Page;
let runPath = "";
const consoleErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage();
  page.on("console", (message) => {
    // The session check before sign-in is expected to 401.
    if (message.type() === "error" && !message.text().includes("401")) consoleErrors.push(message.text());
  });
  page.on("pageerror", (error) => consoleErrors.push(error.message));
});

test.afterAll(async () => {
  await page.close();
});

const runStatus = (status: string) => page.locator(`.run-title .pill[title="${status}"]`);

test("rejects a wrong password, then signs in", async () => {
  await page.goto("/runs");
  await expect(page).toHaveURL(/\/login/);
  await page.getByLabel("Username").fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("Password", { exact: true }).fill("definitely-not-the-password");
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page.getByRole("alert")).toBeVisible();
  await page.getByLabel("Password", { exact: true }).fill(adminPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  await expect(page).toHaveURL(/\/runs$/);
  await expect(page.getByRole("heading", { name: "Runs", level: 1 })).toBeVisible();
});

test("starts a scripted reference run that parks on its approval", async () => {
  await page.getByRole("button", { name: "New run" }).first().click();
  const drawer = page.getByRole("dialog", { name: "New run" });
  await expect(drawer.getByText(/worker online/i)).toBeVisible();
  await drawer.getByRole("button", { name: "Start run" }).click();
  await expect(page).toHaveURL(/\/runs\/[0-9a-f-]{36}$/);
  runPath = new URL(page.url()).pathname;
  await expect(page.getByRole("heading", { name: "cloud-comparison-scripted", level: 1 })).toBeVisible();
  await expect(runStatus("WAITING_APPROVAL")).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText("Scripted").first()).toBeVisible();
});

test("approves it from the Approvals page and the run succeeds", async () => {
  await page.getByRole("link", { name: "Approvals" }).first().click();
  await expect(page.getByRole("heading", { name: "Approvals", level: 1 })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Publication approval" })).toBeVisible();
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByRole("dialog").getByRole("button", { name: "Approve" }).click();
  await expect(page.getByText("Nothing waiting for you")).toBeVisible();
  await page.goto(runPath);
  await expect(runStatus("SUCCEEDED")).toBeVisible({ timeout: 60_000 });
});

test("shows billed, estimated usage on the Usage page", async () => {
  await page.goto("/usage");
  const billed = page.locator(".metric", { hasText: "Billed tokens" }).locator(".metric-value");
  await expect(billed).not.toHaveText("0");
  await expect(page.getByText(/[1-9]\d* estimated/)).toBeVisible();
  await expect(page.getByRole("img", { name: /Tokens per day/ })).toBeVisible();
  await expect(page.getByRole("cell", { name: "scripted-research" })).toBeVisible();
});

test("lists the workflow, shows its immutable version, and starts a run from it", async () => {
  await page.goto("/workflows");
  await page.getByRole("link", { name: "cloud-comparison-scripted" }).click();
  await expect(page.getByText("Immutable")).toBeVisible();
  await expect(page.locator(".wf-step")).toHaveCount(9);
  await page.getByRole("link", { name: "Start run" }).click();
  await expect(page.getByRole("dialog", { name: "New run" })).toBeVisible();
  await page.getByRole("dialog", { name: "New run" }).getByRole("button", { name: "Cancel" }).click();
});

test("switches theme and signs out from Settings", async () => {
  await page.goto("/settings");
  await page.getByText("Dark", { exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
  await page.getByText("System", { exact: true }).click();
  await expect(page.locator("html")).not.toHaveAttribute("data-theme", /.+/);
  await page.getByRole("button", { name: "Sign out" }).click();
  await expect(page).toHaveURL(/\/login/);
});

test("shows not-found states for unknown runs and workflows, with no console errors", async () => {
  await page.getByLabel("Username").fill(E2E_ADMIN_USERNAME);
  await page.getByLabel("Password", { exact: true }).fill(adminPassword());
  await page.getByRole("button", { name: "Sign in" }).click();
  // Signing back in returns to the page the session ended on.
  await expect(page).toHaveURL(/\/settings$/);
  await page.goto("/workflows/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText("Workflow not found")).toBeVisible();
  await page.goto("/runs/00000000-0000-4000-8000-000000000000");
  await expect(page.getByText(/not found|could not be loaded/i).first()).toBeVisible();
  // 404s from the not-found pages above are expected resource errors.
  expect(consoleErrors.filter((text) => !text.includes("404"))).toEqual([]);
});
