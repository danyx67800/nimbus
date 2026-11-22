# Nimbus 2000 — Magical Artifact Redesign

This document is the migration map for the visual redesign. It is deliberately
additive: every API, route, store, WebSocket event, encryption path and business
rule remains untouched. Only the presentation layer and local display
preferences change.

## 1. Audit

| Area | Detected implementation | Redesign treatment |
| --- | --- | --- |
| Runtime | Fastify + SQLite server, vanilla TypeScript web client bundled by esbuild | No change |
| Entry | `web/src/main.ts`, `web/public/index.html` | Early atmosphere/house paint, artifact link in the shell |
| Shell | `web/src/views/shell.ts` | Mahogany side rail, brass utility stirrups, Marauder trail, shadow-veil control |
| Navigation | `NAV` / `BOTTOM_NAV` in `shell.ts` | Folded map navigation: cartouche labels, brass active seam, house seal |
| Theme | `web/src/theme.ts`, `light/dark/black/system` | Kept, plus `day/dusk/night` atmospheres and four elemental houses |
| UI primitives | `web/src/ui.ts` (`h`, icons, modals, menus, toasts, avatars) | Same DOM API; materials, letterpress and wax/seal styling |
| Auth | `web/src/views/auth.ts` | Diagon Alley shopfront: stone, arched leaded window, parchment panel |
| Files | `web/src/views/files.ts` | Paper cabinet: deckled cards, brass labels, willow progress |
| Board | `web/src/views/board.ts` | Ledger columns, pinned parchment cards, brass rings and seals |
| Chat | `web/src/views/chat.ts` | Correspondence: parchment bubbles, ink annotations, wax send control |
| Calls | `web/src/views/calls.ts`, `calls-manager.ts` | Floo/Department stage, brass controls, candlelit backdrop |
| Settings | `web/src/views/settings.ts` | Artifact calibration card: atmosphere and house selectors |
| Admin | `web/src/views/admin.ts` | Pensieve-like register surfaces, engraved tabular numbers |
| Modals / menus | `web/src/ui.ts` | Leaded-glass frames with brass corner rule |
| Toasts | `web/src/ui.ts` | Wax-sealed notices; blocking errors become Howlers |
| Progress | Shell storage, settings meter, board checklist | Willow taper with brass ferrule |
| Badges | Navigation unread counter | Golden Snitch with fluttering silver wings |
| Service worker | `web/public/sw.js` | Cache version bumped; artifact sheet pre-cached |

## 2. Design tokens

`web/public/artifacts.css` is the single token + component layer.

### Material palette

- Parchment: `#F4EBD9`, `#E6D5B8`, `#D8C39E`
- Ink: `#2A1C11`, `#4B3723`, `#6D573D`
- Stone: `#3E4244`, `#2A2D2E`
- Mahogany: `#5C2314`, `#3D150B`, `#8F4229`
- Brass: `#C59B27`, `#E0BC6A`, `#7A5717`
- Pewter, copper, sealing wax, verdigris, moonlight
- Warm candle occlusion replaces every cold drop shadow:
  `rgba(28, 16, 8, 0.45)` family

Procedural, local-only textures are generated with inline SVG turbulence and
repeating gradients; the app still ships no external fonts, images or CDNs.

### Atmosphere

- `data-atmosphere="day"` — Great Hall / Burrow: amber parchment, candle warmth
- `data-atmosphere="dusk"` — Highlands / Clock Tower: slate, wet wood, brass
- `data-atmosphere="night"` — Department of Mysteries / Black Lake: near
  monochrome slate-green, deep focus

`auto` derives the atmosphere from the existing light/dark/black preference.
Selection is local to the device (`nimbus-atmosphere`).

### Houses

`data-house="gryffindor|slytherin|ravenclaw|hufflepuff"` remaps
`--house`, `--house-deep`, `--house-metal`, `--house-glow`. No layout changes:
active navigation, seals, focus and switch states inherit the element.

### Typography

- `--font-display`: Cochin / Baskerville / Iowan / Palatino / Georgia
- `--font-body`: Iowan / Palatino / Book Antiqua / Georgia
- `--font-script`: Snell Roundhand / Apple Chancery / Segoe Script fallback
- `--font-tabular`: Courier Prime / Courier New, tabular numerals

All combinations used for body and controls meet WCAG AA contrast on their
declared parchment or stone surface.

### Motion

- Gyroscopic stabilization: no layout vibration in top bar/side rail
- Horton-Keitch braking: `cubic-bezier(0.3, 0.9, 0.22, 1)` for progress
- Dynamic Cushioning: damped panel and card transitions
- Daisy Pennifold grip: drag cards settle with a controlled tilt
- `prefers-reduced-motion` disables candle, wing, footprint and Howler motion

## 3. Components

`web/src/artifacts.ts` contains the reusable, logic-free artifact primitives:

- `nimbusBrandPlate()` — mahogany nameplate with brass crest and gold script
- `marauderTrail()` — animated footprints and “You are here” cartouche
- `brassStirrups()` — retractable brass action rail in the top bar
- `createPrivacySwitch()` — “Mischief managed” shadow veil, preserving page state

CSS-level components used by every view:

- `NimbusMahoganyShell` → `.sidebar`, `.nimbus-plate`
- `MarauderMapNav` → `.nav`, `.nav-label`, `.nav-link.active`, `.nav-badge`
- `BrassStirrupActions` → `.brass-stirrups`, `.icon-btn`
- `WillowProgressBar` → `.willow-track`, `.willow-fill`
- `PensieveHistoryView` → audit/admin panels and `.messages` grain
- `TimeTurnerScrubber` → tabular timestamps and relative time
- `HowlerAlertToast` → `.toast.error`
- `GoldenSnitchBadge` → `.nav-badge`

## 4. Accessibility and responsive behaviour

- Semantics, focus order, labels and keyboard handlers are unchanged.
- New controls are real buttons with `aria-pressed` or `aria-label`.
- The shadow veil is dismissible with Escape and restores focus.
- House and atmosphere choices are local display preferences; no server data
  is written.
- Knight Bus compression: the side rail narrows below 980px, utility rail and
  search compress below 820/640px, house tiles reflow to two columns.
- Print removes navigation and the veil, leaving readable paper.

## 5. Verification

- `npm run typecheck`
- `npm run lint`
- `npm test`
- `npm run build`

No business logic or API contract changed.
