/** Shared vanilla-DOM helpers for the popup settings UI. */

import type { ErrorCode } from "../shared/types";

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

export function makeButton(label: string, className: string): HTMLButtonElement {
  const button = el("button", className, label);
  button.type = "button";
  return button;
}

export function field(labelText: string, input: HTMLElement, hint?: string): HTMLElement {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "field-label", labelText));
  wrap.appendChild(input);
  if (hint) wrap.appendChild(el("span", "field-hint", hint));
  return wrap;
}

export function metaItem(label: string, value: string): HTMLElement {
  const item = el("div", "meta-item");
  item.append(el("span", "meta-label", label), el("span", "meta-value", value));
  return item;
}

export function makeNumberControl(
  labelText: string,
  className: string,
  value: number,
  min: number | undefined,
  max: number | undefined,
  step: number,
  hint: string,
): { wrap: HTMLElement; input: HTMLInputElement } {
  const wrap = el("label", "field");
  wrap.appendChild(el("span", "field-label", labelText));
  const input = el("input", className);
  input.type = "number";
  input.step = String(step);
  if (min !== undefined) input.min = String(min);
  if (max !== undefined) input.max = String(max);
  input.value = String(value);
  wrap.appendChild(input);
  wrap.appendChild(el("span", "field-hint", hint));
  return { wrap, input };
}

export function makeOverrideNumber(
  className: string,
  value: number | undefined,
  opts: { min?: number; max?: number; step?: number } = {},
): HTMLInputElement {
  const input = el("input", className);
  input.type = "number";
  if (opts.min !== undefined) input.min = String(opts.min);
  if (opts.max !== undefined) input.max = String(opts.max);
  input.step = String(opts.step ?? 1);
  input.value = value === undefined ? "" : String(value);
  input.placeholder = "继承全局";
  return input;
}

export function clampInt(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function readNumber(value: string, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function readNumberOr(value: string, fallback: number): number {
  return value.trim() === "" ? fallback : readNumber(value, fallback);
}

export function numericOrBlank(value: string): number | "" {
  const parsed = Number(value);
  return value.trim() !== "" && Number.isFinite(parsed) ? parsed : "";
}

export function newProviderId(): string {
  const cryptoApi = globalThis.crypto as Crypto & { randomUUID?: () => string };
  if (typeof cryptoApi.randomUUID === "function") return cryptoApi.randomUUID();
  return `p_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export function now(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function errorCodeOf(error: unknown): ErrorCode | undefined {
  if (typeof error === "object" && error !== null) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string") return code as ErrorCode;
  }
  return undefined;
}
