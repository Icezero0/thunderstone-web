# Frontend conventions

- Use the rules configuration page's visual style for every frontend page: warm paper background, cream panels, dark blue grey header, copper gold primary actions, and serif headings.
- Load `/src/shared/styles/global.css` before page-specific CSS. It is the source of shared palette, font stacks, controls, buttons, panels, headers and focus states.
- Reuse its CSS custom properties and components (`.masthead`, `.brand`, `.hero-copy`, `.panel` / `.card`, `.button.primary`, `.button.secondary`, `.text-button`). Keep layout and feature-specific styling in the page stylesheet.
- Add any new shared token or component to `src/shared/styles/global.css`. Do not establish another page theme or redeclare the global palette in page CSS.
- Reserve green and red for semantic statuses; ordinary actions use the shared gold buttons. Retain readable contrast in headers and code blocks.
- Keep page code and layout CSS together in `src/pages/<page>/`. Shared API transport, realtime and styles belong in `src/shared/`; session composition belongs in `src/app/`. Keep shared modules independent of page controllers.
- Preserve existing DOM IDs, storage keys and drafts when changing presentation. Services are started by the user; do not start a listening server for previews.
- Visual effects are normally reviewed manually by the user in the existing running services. Do not take screenshots or independently perform visual acceptance checks (including GUI automation, headless browsers and screenshot-based comparisons). If your own visual verification is necessary, first explain the reason and obtain explicit user consent. Normal builds, type checking and nonvisual tests do not require that consent.
- See `README.md` in this directory for examples and the token reference.
