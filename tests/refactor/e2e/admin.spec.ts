import { expect, test, type Page } from "@playwright/test";
import { installAdminFixture, sse, status } from "./fixtures/admin_fixture.js";

async function openAdmin(page: Page) {
  const fixture = await installAdminFixture(page);
  await page.goto("/admin/#bootstrap_token=one-time-secret");
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  return fixture;
}

test("bootstrap-and-session-expiry", async ({ page }) => {
  const fixture = await openAdmin(page);
  await expect(page).toHaveURL(/\/admin\/$/);
  expect(await page.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length, body: document.body.textContent }))).toEqual(expect.objectContaining({ local: 0, session: 0 }));
  await page.getByRole("button", { name: "End session" }).click();
  await expect(page.getByRole("heading", { name: "Control room locked" })).toBeFocused();
  expect(fixture.requests.find((request) => request.url().endsWith("/auth/bootstrap"))?.postData()).toBe("{\"token\":\"one-time-secret\"}");
});

test("github-and-ghes-account-lifecycle", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Accounts" })).toBeVisible();
  await page.getByLabel("GitHub host").fill("github.example.test");
  await page.getByRole("button", { name: "Start login" }).click();
  await expect(page.getByText("ABCD-1234")).toBeVisible();
  await page.getByRole("button", { name: "I've authorized" }).click();
  await expect(page.getByText("Enterprise Admin")).toBeVisible();
  await page.getByRole("button", { name: "Make default" }).click();
  expect(fixture.requests.find((request) => request.url().endsWith("/accounts/default"))?.headers()["x-ghcg-csrf"]).toBe("csrf-memory-only");
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("article").filter({ hasText: "Enterprise Admin" }).getByRole("button", { name: "Remove" }).click();
  await expect(page.getByRole("article").filter({ hasText: "Enterprise Admin" }).getByText("removed")).toBeVisible();
});

test("model-refresh-invalidates-preference", async ({ page }) => {
  await openAdmin(page);
  await page.getByRole("button", { name: "Models" }).click();
  await expect(page.getByText("gpt-alpha", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "Refresh catalog" }).click();
  await expect(page.getByRole("heading", { name: "Preferred model unavailable" })).toBeVisible();
  await page.getByRole("button", { name: "Set preferred" }).click();
  await expect(page.getByText("claude-beta is now preferred.")).toBeVisible();
});

test("config-revision-and-security-rejection", async ({ page }) => {
  const fixture = await openAdmin(page);
  await page.getByRole("button", { name: "Configuration" }).click();
  await expect(page.getByText("REVISION 7")).toBeVisible();
  fixture.state.conflictConfig = true;
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("changed elsewhere");
  fixture.state.rejectSecurity = true;
  await page.getByRole("button", { name: "Apply configuration" }).click();
  await expect(page.getByRole("alert")).toContainText("security check rejected");
});

test("responses-history-inspect-and-clear", async ({ page }) => {
  await openAdmin(page);
  await page.getByRole("button", { name: "Responses History" }).click();
  await expect(page.getByText("12", { exact: true })).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept());
  await page.getByRole("button", { name: "Clear history" }).click();
  await expect(page.getByRole("heading", { name: "History is empty" })).toBeVisible();
  await expect(page.getByText("Responses history cleared.")).toBeVisible();
});

test("events-and-degraded-recovery", async ({ page }) => {
  const fixture = await installAdminFixture(page);
  fixture.state.streamBody = [
    sse("performance", { kind: "performance", status: status("degraded") }),
    "id: 41\n" + sse("operational", { kind: "operational", event: { eventId: "41", occurredAt: "2026-09-03T12:01:00.000Z", kind: "performance_degraded", severity: "warning", metadata: { metric: "buffered_p95_ms", actual: 8, threshold: 5 } } }),
  ].join("");
  await page.goto("/admin/#bootstrap_token=event-secret");
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toBeVisible();
  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.getByRole("heading", { name: "performance degraded" })).toBeVisible();
  const many = Array.from({ length: 520 }, (_, index) => ({ eventId: String(index + 100), occurredAt: "2026-09-03T12:02:00.000Z", kind: "gateway_started", severity: "info", metadata: {} }));
  fixture.state.streamBody = many.map((event) => `id: ${event.eventId}\n${sse("operational", { kind: "operational", event })}`).join("") + sse("performance", { kind: "performance", status: status("healthy") });
  await page.reload();
  await expect(page.getByRole("heading", { name: "Overview" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Gateway is degraded" })).toHaveCount(0);
  await page.getByRole("button", { name: "Events" }).click();
  await expect(page.locator(".timeline > li")).toHaveCount(512);
});

test("daemon-restart-invalidates-session", async ({ page }) => {
  const fixture = await openAdmin(page);
  fixture.state.authenticated = false;
  await page.getByRole("button", { name: "Accounts" }).click();
  await expect(page.getByRole("heading", { name: "Control room locked" })).toBeFocused();
  await expect(page.getByText("admin session ended")).toBeVisible();
  expect(await page.evaluate(() => localStorage.length + sessionStorage.length)).toBe(0);
});
