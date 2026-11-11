# Popup Settings Implementation Plan

## Goal

Move every settings surface into `popup.html`, grouped into four collapsible sections, with model management in a second-level view. Remove `options.html` and the separate settings implementation. Preserve settings data, key masking, prompt versioning, cache, and provider behavior.

Design: `docs/superpowers/specs/2026-11-11-popup-settings-design.md`.

## Constraints

- No new framework, no router.
- Keep existing `Settings` / `ProviderConfig` schema.
- Keep existing provider form class names (`provider-*`, `pf-*`, `global-*`) where possible so tests migrate with minimal churn.
- No network on popup open; only “拉取模型” / “测试连接”.
- API keys never render unmasked.
- Use inline two-step confirmations, not `window.confirm`.
- Keep `minimum_chrome_version` at 120.

## Target Files

```text
src/settings/
  components.ts
  provider-form.ts        # moved from src/options/providers.ts
  settings-view.ts
  provider-manager.ts
  sections/
    types.ts
    model.ts
    translation.ts
    advanced.ts
    maintenance.ts
src/popup/main.ts         # shell + createSettingsView
src/styles/settings.css   # migrated/restyled options.css
src/styles/popup.css      # shell/scroll layout only
```

Delete: `src/options/index.html`, `src/options/main.ts`, `src/styles/options.css`, `src/options/providers.ts` (moved), `tests/unit/options-dom.test.ts` (coverage moves to settings-dom). Remove `options` entry from `vite.config.ts`, `options_page` from `public/manifest.json`, and options tests from `tests/unit/build.test.ts`.

## Interfaces

```ts
// src/settings/sections/types.ts
export type SectionId = "model" | "translation" | "advanced" | "maintenance";

export interface SectionHandle {
  id: SectionId;
  element: HTMLElement;
  summary(): string;
  update(settings: Settings): void;
}

export interface SettingsContext {
  getSettings(): Settings;
  savePatch(patch: Partial<Settings>): Promise<void>;
  openModels(startNew?: boolean): void;
  refresh(): void;
}
```

```ts
// src/settings/settings-view.ts
export interface SettingsViewOptions {
  mode: "popup" | "page";
}
export interface SettingsViewHandle {
  settings: Settings | null;
}
export async function createSettingsView(
  host: HTMLElement,
  options: SettingsViewOptions,
): Promise<SettingsViewHandle>;
```

`createSettingsView` reads settings once, renders the home view, and exposes the loaded settings for the popup test handle. It catches read failures and renders a retry/error state without throwing.

## Task 1 — Move provider form helpers

1. `git mv src/options/providers.ts src/settings/provider-form.ts`.
2. Update imports in `src/options/main.ts`, `src/popup/main.ts`, `tests/unit/options-dom.test.ts`, `tests/unit/options-providers.test.ts`, and any other references.
3. Add `src/settings/components.ts` with the shared DOM helpers from `src/options/main.ts`:
   - `el`, `makeButton`, `field`, `makeNumberControl`, `makeOverrideNumber`, `clampInt`, `readNumberOr`, `numericOrBlank`, `errorCodeOf`.
4. Run `npx vitest run tests/unit/options-providers.test.ts tests/unit/options-dom.test.ts tests/unit/popup-dom.test.ts`.

Expected: pure move, all existing tests still pass.

## Task 2 — Home view + global sections

1. Create `src/settings/sections/types.ts`.
2. Create `src/settings/sections/translation.ts`:
   - Target language select (`global-targetLang`).
   - Min paragraph length (`global-minParagraphLength`).
   - Content-only (`global-contentOnly`).
   - Trigger radios (`name="trigger-mode"`).
   - Glossary checkbox (`global-glossary`).
   - Save button `global-save translation-save`, status `global-saved`.
   - Clamp min length 4..100.
3. Create `src/settings/sections/advanced.ts`:
   - `global-concurrency`, `global-maxRPS`, `global-temperature`, `global-systemPrompt`.
   - Save button `global-save advanced-save`, status.
   - Clamp concurrency 1..10, maxRPS 1..20, temperature 0..2.
4. Create `src/settings/sections/maintenance.ts`:
   - `global-clear-cache` two-step inline confirm.
   - `global-cache-message` status.
   - `TranslationCache("ilmt").clear()`.
5. Create `src/settings/sections/model.ts` stub for now: summary + `settings-manage-models` button, no manager yet.
6. Create `src/settings/settings-view.ts`:
   - Accordion with four `<details class="settings-section">`; one open at a time.
   - All section bodies stay mounted.
   - `<summary>` title + summary text.
   - `savePatch()` merges patch, recomputes `promptVersion` when `systemPrompt` or `glossaryEnabled` changes (or when empty), calls `saveSettings`, refreshes memory and summaries.
   - Default open section: model.
7. Add `tests/unit/settings-dom.test.ts` importing `createSettingsView` directly with a chrome mock:
   - four sections, summaries, default open, accordion one-open, bodies stay mounted.
   - translation save persists target/lang/min/contentOnly/trigger/glossary and recomputes promptVersion when glossary changes.
   - advanced save persists controls and promptVersion.
   - maintenance first click arms, second click clears.
   - read error renders error text.
8. Run new tests plus existing tests.

## Task 3 — Model manager

1. Create `src/settings/provider-manager.ts` from the provider list/form code in `src/options/main.ts`. Preserve:
   - list rendering, active badge, edit/copy/test/delete, set-as-current.
   - full form: kind, name, baseURL, appendV1, key, model + fetch, headers, overrides, system prompt, save/cancel/test.
   - key masking and “leave blank to keep”.
   - new provider defaults to DeepSeek.
2. Replace the model section stub:
   - active provider select (`settings-active-provider`), placeholder when `activeProviderId` empty.
   - summary (`.settings-model-summary`), test button, manage/add buttons.
   - no providers: add entry.
3. Add second-level view in `settings-view.ts`:
   - hide home, render provider manager with `.settings-back`.
   - back restores home and refreshes summaries.
   - provider dirty form uses inline “放弃 / 继续编辑”, not `confirm`.
   - delete uses two-step inline confirm.
4. Extend `tests/unit/settings-dom.test.ts` with provider tests migrated from `tests/unit/options-dom.test.ts`:
   - open manager, add/edit/copy/delete/test, headers, overrides, DeepSeek preset, key retention.
   - empty active provider shows “未选择当前模型” and disables test.
   - back navigation.
   - manager does not fetch on open.
5. Run tests.

## Task 4 — Wire popup, remove options page

1. Rewrite `src/popup/main.ts`:
   - detect `?mode=page`, add `body.page-mode`.
   - build header without “高级设置”, scroll host `.popup-scroll`, footer.
   - call `createSettingsView`.
   - expose `__ilmtPopup` with `settings` from the handle.
   - in page mode, opening the side panel does not call `window.close()`.
2. Update `src/styles/popup.css`:
   - `#root` flex column, max-height 600, `.popup-scroll` scrolls, header/footer fixed.
   - page mode: width 560, max-height none, page scrolls.
3. Create `src/styles/settings.css` from `src/styles/options.css`, restyled to quantum variables. Import in popup.
4. Delete `src/options/index.html`, `src/options/main.ts`, `src/styles/options.css`.
5. Remove `options` from `vite.config.ts` inputs and `options_page` from `public/manifest.json`.
6. Update background `open-options` handler:
   - prefer `chrome.action.openPopup()`.
   - catch/undefined -> `chrome.tabs.create({ url: chrome.runtime.getURL("popup.html?mode=page") })`.
7. Move relevant `tests/unit/options-dom.test.ts` coverage to `settings-dom.test.ts`; delete `options-dom.test.ts`.
8. Rewrite `tests/unit/popup-dom.test.ts` for shell, no advanced button, page mode, side panel behavior.
9. Update `tests/unit/background-index.test.ts`:
   - success -> `openPopup`.
   - rejection/undefined -> tab fallback URL.
   - trusted sender rules unchanged.
10. Update `tests/unit/build.test.ts`: no `options.html`, popup present, manifest has no `options_page`.
11. Run `npx vitest run` and `npx tsc --noEmit`.

## Task 5 — E2E, docs, final verification

1. Update `tests/e2e/translate.spec.ts` popup/options test:
   - open `popup.html`.
   - assert four sections, defaults, active provider.
   - open model manager, assert provider card, back.
   - remove `options.html` navigation.
2. Update `README.md`:
   - all settings in popup; four sections; model management second level.
   - project structure no options page.
3. Run `npm run verify:delivery`.
4. Run headless E2E.
5. Build main repo `dist/`, reload extension in Chrome if foreground verification is possible.
6. Merge to `main`, push, report verification results with the AGENTS.md template.

## Verification Commands

```bash
npx vitest run
npx tsc --noEmit
npm run build
npm run check-build
npm run verify:delivery
npm run test:e2e   # or the repo’s headless E2E command
```

## Known Limitations

- Closing the popup while editing a provider form loses unsaved input; no draft persistence.
- Old `options.html` bookmarks 404.
- `chrome.action.openPopup()` may fall back to the same UI in a tab.
