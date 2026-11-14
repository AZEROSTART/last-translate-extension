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

    for (const effectId of ["gopher-hole", "magnet", "cat-hoard"]) {
      const tryButton = page.locator(`.effect-try[data-effect="${effectId}"]`);
      await tryButton.click();

      const preview = page.locator(".effect-preview:not([hidden])");
      const root = preview.locator(`[data-ilmt-effect="${effectId}"]`);
      await expect(root).toBeVisible();
      // Exactly one preview slot is open, whichever effect it holds.
      await expect(page.locator(".effect-preview:not([hidden])")).toHaveCount(1);
      await root.locator("button").click();
      await expect(root).toHaveAttribute("data-ilmt-state", "settled");

      // Close the slot again so the next effect starts from a clean state.
      await tryButton.click();
      await expect(page.locator(".effect-preview:not([hidden])")).toHaveCount(0);
    }

    const stored = await extension.worker.evaluate(async () => chrome.storage.local.get("learning"));
    expect(stored.learning).toBeUndefined();
  } finally {
    await extension?.context.close().catch(() => {});
    if (extension) await rm(extension.userDataDir, { recursive: true, force: true }).catch(() => {});
    await server?.close().catch(() => {});
  }
});
