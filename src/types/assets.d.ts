/**
 * Ambient module declarations for Vite-only asset imports. The `?inline` suffix
 * asks Vite to return the file contents as a string (used by the panel and
 * options pages), which TypeScript would otherwise not know how to resolve.
 */
declare module "*.css?inline" {
  const css: string;
  export default css;
}
