# Table cursors

Source: [Kenney Cursor Pack 1.1](https://kenney.nl/assets/cursor-pack), by Kenney.
License: CC0; the original notice is retained in `LICENSE.txt`.

Two unmodified Kenney PNG files are included, both 32 × 32:

| Local file | Original file | Hotspot | State |
| --- | --- | --- | --- |
| `pointer.png` | `PNG/Outline/Default/hand_point.png` | `(8, 4)` | Default throughout the game area, including hover and ordinary clicks |
| `pressed.png` | `PNG/Outline/Default/hand_closed.png` | `(16, 16)` | While actively dragging a card or panning a public desktop |

The pointing hand uses its fingertip as the click hotspot; the closed hand uses
the palm center. Shared `src/shared/styles/game-cursor.css`, loaded by `game-card`,
applies the same cursor throughout public areas, the player deck area and
its pile browser. A surrounding game table can also use the `game-cursor` class.
The area's selectors use the existing card `data-dragging` and viewport
`data-panning` markers. They switch to the closed hand only after a drag gesture
crosses its movement threshold. Hovering, pressing a mouse button and automatic sorting
keep the pointing hand. Release or cancellation clears the drag marker and
restores the pointing hand immediately, including during the settling animation.

Both images are preloaded. The browser renders the native cursor; there is no
separate button-state listener, DOM element following the mouse or per-frame
position calculation.
