# Game component test fixture

The former game-probe page is retained here only as a DOM fixture for component
regression tests. It is not a frontend page, build entry, or publicly served route.
Tests bundle `index.ts` in memory and use `page.html` with the simulated DOM.
Production uses the shared components from `src/shared/components/`.

Vite rejects requests for test fixtures, test bundles and retired development
pages. The backend serves only the explicit production page allowlist.
