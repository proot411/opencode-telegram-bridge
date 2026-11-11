// OpenCode local-plugin entrypoint shim.
//
// OpenCode resolves a *local directory* plugin by probing `<dir>/server.*` and
// then `<dir>/index.*` (Bun module resolution). It does NOT read this package's
// `package.json` "main"/"exports", so the real implementation in `src/index.ts`
// is never discovered on its own. This file exposes it at the expected path.
export { default } from "./src/index.ts";
