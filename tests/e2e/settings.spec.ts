/**
 * The settings page can preview a claim effect without touching the learning
 * store: "试一试" mounts a throwaway effect whose claim is a local stub, so the
 * word is never captured. Mirrors the flow a user takes in
 * `popup.html?mode=page`.
 */

import { expect, test } from "@playwright/test";
import { rm } from "node:fs/promises";
import { startMockServer, type MockServer } from "../mock-server";
import { launchExtension, seedSettings, type Extension } from "./harness";

test("previews a claim effect without claiming a word", async () => {
  let extension: Extension | undefined;
  let server: MockServer | undefined;
  try {
    extension = await launchExtension();
    server = await startMockServer();
    await seedSettings(extension.worker, server.origin);
    const extensionId = new URL(extension.worker.url()).host;

    const page = await extension.context.newPage();
    await page.goto(`chrome-extension://${extensionId}/popup.html?mode=page`);

    // Only the model section starts open, so the learning section's preview
    // button is not reachable until its accordion is expanded.
    await page.locator('details[data-section="learning"] summary').click();
    // Nothing is mounted until "试一试" opens exactly one preview slot.
    await expect(page.locator(".effect-preview:not([hidden])")).toHaveCount(0);
    await page.locator('.effect-try[data-effect="gopher-hole"]').click();

    const preview = page.locator(".effect-preview:not([hidden])");
    await expect(preview.locator('[data-ilmt-effect="gopher-hole"]')).toBeVisible();
    await preview.locator('[data-ilmt-effect="gopher-hole"] button').click();
    await expect(preview.locator('[data-ilmt-effect="gopher-hole"]')).toHaveAttribute(
      "data-ilmt-state",
      "settled",
    );

    const stored = await extension.worker.evaluate(async () => chrome.storage.local.get("learning"));
    expect(stored.learning).toBeUndefined();
  } finally {
    await extension?.context.close().catch(() => {});
    if (extension) await rm(extension.userDataDir, { recursive: true, force: true }).catch(() => {});
    await server?.close().catch(() => {});
  }
});
