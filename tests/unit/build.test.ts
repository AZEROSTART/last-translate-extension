import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { readFileSync, existsSync } from "node:fs";

describe("build output", () => {
  beforeAll(() => { execSync("npm run build", { stdio: "ignore" }); }, 120_000);

  it("emits a valid MV3 manifest", () => {
    const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    expect(m.manifest_version).toBe(3);
    expect(m.background.service_worker).toBe("background.js");
    expect(m.permissions).toContain("storage");
    expect(m.permissions).toContain("sidePanel");
    expect(m.content_scripts[0].js).toEqual(["content_guard.js"]);
    expect(m.content_scripts[0].css).toEqual(["inject.css"]);
    expect(m.content_scripts[0].run_at).toBe("document_start");
    expect(m.web_accessible_resources[0].resources).toContain("content_main.js");
  });

  it("declares a toolbar action but never a fixed manifest key", () => {
    const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    expect(m.action).toBeDefined();
    expect(m.key).toBeUndefined();
  });

  it("gives every command a description so Chrome can load the extension", () => {
    const m = JSON.parse(readFileSync("dist/manifest.json", "utf8"));
    for (const command of Object.values<{ description?: string }>(m.commands ?? {})) {
      expect(command.description?.trim().length ?? 0).toBeGreaterThan(0);
    }
  });

  it("emits every entry file", () => {
    for (const f of ["background.js", "content_guard.js", "content_main.js", "inject.css", "panel.html", "options.html", "rules/dnr.json"]) {
      expect(existsSync(`dist/${f}`), f).toBe(true);
    }
  });

  it("ships the injected stylesheet with translation and bubble classes", () => {
    const css = readFileSync("dist/inject.css", "utf8");
    expect(css).toContain(".ilmt-tr");
    expect(css).toContain(".ilmt-bubble");
  });

  it("ships style A, heading, and flex/grid break classes", () => {
    const css = readFileSync("dist/inject.css", "utf8");
    expect(css).toContain(".ilmt-block");
    expect(css).toContain('[data-ilmt-heading="1"]');
    expect(css).toContain(".ilmt-flex-break");
    expect(css).toContain(".ilmt-grid-break");
    expect(css).not.toContain(".ilmt-inline");
  });

  it("ships the loading skeleton styles", () => {
    const css = readFileSync("dist/inject.css", "utf8");
    expect(css).toContain('[data-loading="1"]');
    expect(css).toContain("@keyframes ilmt-loading-pulse");
    expect(css).toContain("prefers-reduced-motion");
  });

  it("hardens the skeleton bar against page CSS", () => {
    const css = readFileSync("dist/inject.css", "utf8");
    const rule = css.match(/\.ilmt-tr\[data-loading="1"\]::?before\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).not.toBe("");
    expect(rule.split(";").filter(Boolean).every((decl) => decl.includes("!important"))).toBe(true);
  });

  it("does not inject a data-ilmt stylesheet from content_main.js", () => {
    const code = readFileSync("dist/content_main.js", "utf8");
    expect(code).not.toContain('"data-ilmt"');
    expect(code).not.toContain("style[data-ilmt]");
  });
});
