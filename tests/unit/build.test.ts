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
    expect(m.content_scripts[0].run_at).toBe("document_start");
    expect(m.web_accessible_resources[0].resources).toContain("content_main.js");
  });

  it("emits every entry file", () => {
    for (const f of ["background.js", "content_guard.js", "content_main.js", "panel.html", "options.html", "rules/dnr.json"]) {
      expect(existsSync(`dist/${f}`), f).toBe(true);
    }
  });
});
