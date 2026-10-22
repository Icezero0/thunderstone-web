# Frontend conventions

- Use the rules configuration page's visual style for every frontend page: warm paper background, cream panels, dark blue grey header, copper gold primary actions, and serif headings.
- Load `/global.css` before page-specific CSS. It is the source of shared palette, font stacks, controls, buttons, panels, headers and focus states.
- Reuse its CSS custom properties and components (`.masthead`, `.brand`, `.hero-copy`, `.panel` / `.card`, `.button.primary`, `.button.secondary`, `.text-button`). Keep layout and feature-specific styling in the page stylesheet.
- Add any new shared token or component to `global.css`. Do not establish another page theme or redeclare the global palette in page CSS.
- Reserve green and red for semantic statuses; ordinary actions use the shared gold buttons. Retain readable contrast in headers and code blocks.
- Preserve existing DOM IDs and browser-local audit data when changing presentation. Services are started by the user; do not start a listening server for previews.
- See `README.md` in this directory for examples and the token reference.
