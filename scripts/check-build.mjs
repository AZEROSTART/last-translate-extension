#!/usr/bin/env node
// Verifies that dist/ is a chrome://extensions loadable MV3 bundle.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const distDir = resolve(import.meta.dirname, "../dist");
const problems = [];

function readJson(relativePath) {
  const filePath = resolve(distDir, relativePath);
  if (!existsSync(filePath)) {
    problems.push(`missing ${relativePath}`);
    return null;
  }
  try {
    return JSON.parse(readFileSync(filePath, "utf8"));
  } catch (error) {
    problems.push(`invalid JSON in ${relativePath}: ${error.message}`);
    return null;
  }
}

function requireFile(relativePath, referencedBy) {
  if (!existsSync(resolve(distDir, relativePath))) {
    problems.push(`missing ${relativePath} (referenced by ${referencedBy})`);
  }
}

const manifest = readJson("manifest.json");

if (manifest) {
  if (manifest.manifest_version !== 3) {
    problems.push("manifest_version must be 3");
  }

  const contentScripts = manifest.content_scripts ?? [];
  for (const entry of contentScripts) {
    for (const script of entry.js ?? []) {
      requireFile(script, "content_scripts");
    }
    for (const stylesheet of entry.css ?? []) {
      requireFile(stylesheet, "content_scripts");
    }
  }

  const serviceWorker = manifest.background?.service_worker;
  if (serviceWorker) {
    requireFile(serviceWorker, "background.service_worker");
  } else {
    problems.push("missing background.service_worker");
  }

  for (const entry of manifest.web_accessible_resources ?? []) {
    for (const resource of entry.resources ?? []) {
      if (!resource.includes("*")) requireFile(resource, "web_accessible_resources");
    }
  }

  for (const htmlPath of [manifest.side_panel?.default_path, manifest.options_page]) {
    if (htmlPath) requireFile(htmlPath, "manifest page");
  }

  if (!manifest.action?.default_popup) {
    problems.push("missing action.default_popup");
  } else {
    requireFile(manifest.action.default_popup, "action.default_popup");
  }

  for (const [size, path] of Object.entries(manifest.icons ?? {})) {
    requireFile(path, `icons.${size}`);
  }
  for (const [size, path] of Object.entries(manifest.action?.default_icon ?? {})) {
    requireFile(path, `action.default_icon.${size}`);
  }

  for (const rule of manifest.declarative_net_request?.rule_resources ?? []) {
    const rules = readJson(rule.path);
    if (rules && !Array.isArray(rules)) {
      problems.push(`${rule.path} must contain a JSON array`);
    }
  }
}

if (problems.length > 0) {
  console.error("dist check failed:");
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log("dist check passed: manifest and every referenced entry are present.");
