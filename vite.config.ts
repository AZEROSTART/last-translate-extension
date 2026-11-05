import { defineConfig } from "vitest/config";
import type { Plugin } from "vite";
import { renameSync, rmdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/**
 * Vite emits HTML entries under their source path (`src/panel/index.html`),
 * but MV3 requires them at the extension root (`panel.html`). Asset URLs are
 * absolute (`/assets/...`), so relocating the document does not break them.
 */
function flattenHtmlEntries(): Plugin {
  return {
    name: "ilmt-flatten-html-entries",
    enforce: "post",
    writeBundle(options, bundle) {
      const outDir = options.dir;
      if (!outDir) return;

      for (const [fileName, output] of Object.entries(bundle)) {
        if (output.type !== "asset" || !fileName.endsWith(".html")) continue;
        const segments = fileName.split("/");
        const flatName =
          segments.at(-1) === "index.html" && segments.length > 1
            ? `${segments.at(-2)}.html`
            : segments.at(-1)!;
        if (flatName === fileName) continue;

        const from = join(outDir, fileName);
        renameSync(from, join(outDir, flatName));

        let dir = dirname(from);
        while (dir !== outDir) {
          try {
            rmdirSync(dir);
          } catch {
            break;
          }
          dir = dirname(dir);
        }
      }
    },
  };
}

export default defineConfig({
  publicDir: "public",
  plugins: [flattenHtmlEntries()],
  build: {
    target: "chrome120",
    rolldownOptions: {
      preserveEntrySignatures: "strict",
      input: {
        background: resolve(import.meta.dirname, "src/background/index.ts"),
        content_guard: resolve(import.meta.dirname, "src/content/guard.ts"),
        content_main: resolve(import.meta.dirname, "src/content/main.ts"),
        panel: resolve(import.meta.dirname, "src/panel/index.html"),
        options: resolve(import.meta.dirname, "src/options/index.html"),
      },
      output: {
        entryFileNames: "[name].js",
        chunkFileNames: "chunks/[name]-[hash].js",
      },
    },
  },
  test: {
    environment: "jsdom",
    include: ["tests/unit/**/*.test.ts"],
    setupFiles: ["./tests/setup/chrome-mock.ts"],
  },
});
