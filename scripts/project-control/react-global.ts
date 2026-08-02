/**
 * Puts React in global scope for the contrast harness.
 *
 * The admin components are compiled by Vite with the automatic JSX runtime, but the standalone
 * `tsx` runner used by scripts/ applies the CLASSIC transform, which emits bare `React.createElement`
 * references. Importing this module FIRST satisfies those references without touching a single
 * product file — the components stay exactly as the application builds them, which is the whole
 * point of rendering them here rather than re-typing their markup.
 */
import * as React from "react";

(globalThis as unknown as { React: typeof React }).React = React;
