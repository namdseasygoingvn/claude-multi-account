# Design Language

Dark, dense, glass-morphic UI. Inspired by macOS/iOS system UI — near-black backgrounds, frosted-glass panels, white-on-dark hierarchy, warm yellow-orange accent.

---

## Color Palette

### Background Layers
| Role | Value | Usage |
|---|---|---|
| Page background | `#000000` | `bg-black` — outermost shell |
| Surface 1 | `#1C1C1E` | `system-gray6` — cards, modals, panels |
| Surface 2 | `#2C2C2E` | `system-gray5` — secondary panels, segmented control track |
| Surface 3 | `#3A3A3C` | `system-gray4` — active pill in segmented controls, inline inputs |
| Surface 4 | `#48484A` | `system-gray3` — active segment highlight |
| Surface 5 | `#636366` | `system-gray2` — rarely used border |
| Surface 6 | `#8E8E93` | `system-gray` — disabled icons |

### Borders & Overlays (all white-alpha, no grey hex values)
| Role | Class | When |
|---|---|---|
| Default border | `border-white/10` | panels, cards, inputs, header |
| Subtle border | `border-white/5` | inner rows, minimal separators |
| Hover highlight | `hover:bg-white/10` | icon buttons, nav items |
| Subtle fill | `bg-white/5` | ghost input bg, badge bg |
| Lighter fill | `bg-white/8` | dropdown option hover |

### Accent — Warm Yellow-Orange Gradient
| Role | Value |
|---|---|
| From | `#F3EB35` (yellow) |
| To | `#F99C24` (orange) |
| Single token | `system-blue: #F99C24` in Tailwind config |

Applied as:
- **Gradient** on CTA buttons and decorative icons: `bg-gradient-to-r from-[#F3EB35] to-[#F99C24]`
- **Gradient, diagonal** on icon containers: `bg-gradient-to-br from-[#F3EB35] to-[#F99C24]`
- **Solid** for borders, rings, text links, spinner borders: `border-system-blue`, `text-system-blue`, `ring-system-blue`
- **Transparent** for selections and halos: `bg-system-blue/20`, `shadow-system-blue/30`

> **Text on gradient background must be `text-black`** — yellow/orange fails contrast with white.
> Icon-only buttons (`text-black` on orange circle) are fine.

### Semantic Colors
| Role | Value | Class |
|---|---|---|
| Destructive | `#FF3B30` | `system-red` |
| Success | `#34C759` | `system-green` |
| Error text | — | `text-red-400` |
| Error bg | — | `bg-red-500/10 border-red-500/20` |
| Discord brand | `#5865F2 → #7289DA` | gradient only |

---

## Typography

System font stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif`

| Role | Size | Weight | Color | Class |
|---|---|---|---|---|
| Page title / modal heading | `text-2xl` / `text-3xl` | `font-bold` | white | — |
| Widget / section heading | `text-lg` | `font-semibold` | white | — |
| Body / card text | `text-sm` | regular | `text-gray-300` | — |
| Secondary / helper | `text-sm` | regular | `text-gray-400` | — |
| Muted / placeholder | `text-sm` | regular | `text-gray-500` / `text-gray-600` | — |
| Input text | `text-sm` | regular | white | — |
| Section label | `text-[10px]` | `font-bold` | `text-gray-500` | `uppercase tracking-wider` |
| Badge / pill | `text-[10px]` | `font-bold` | white or black | — |
| Monospace data | `text-xs` / `text-sm` | regular | `text-gray-300` | `font-mono` |

---

## Spacing & Layout

- **Page padding**: `px-6 py-6` inside the main content area
- **Section gap**: `gap-6` between major columns/sections
- **Card internal padding**: `p-4` standard, `p-3` compact, `px-3 py-2` for list items
- **Label-to-control gap**: `gap-1.5`
- **Inline icon-to-text gap**: `gap-2` standard, `gap-1.5` compact

---

## Border Radius

| Scale | Value | Usage |
|---|---|---|
| `rounded-[6px]` | 6px | Segment pill, inner quantity buttons |
| `rounded-lg` | 8px | Dropdowns, small inputs, badges |
| `rounded-xl` | 12px | Input fields, action buttons, modal inner rows |
| `rounded-2xl` | 16px | Cards, modals, icon containers |
| `rounded-3xl` | 24px | Login card |
| `rounded-full` | 50% | Avatar, circular icon buttons |

---

## Elevation & Glass

### `.glass` (defined in `index.html`)
```css
background: rgba(28, 28, 30, 0.65);   /* system-gray6 at 65% */
backdrop-filter: blur(20px);
border: 1px solid rgba(255, 255, 255, 0.1);
```
Used on: header bar, sidebar, modal containers.

### `.glass-panel` (defined in `index.html`)
```css
background: rgba(44, 44, 46, 0.4);    /* system-gray5 at 40% */
backdrop-filter: blur(12px);
border: 1px solid rgba(255, 255, 255, 0.08);
```
Used on: lighter inner panels.

### Shadows
| Role | Class |
|---|---|
| Modal / card | `shadow-2xl shadow-black/50` |
| Accent glow | `shadow-lg shadow-[#F99C24]/20` |
| Accent glow strong | `shadow-lg shadow-[#F99C24]/30` |
| Button | `shadow-lg` (on primary buttons) |

---

## Buttons

### Primary (CTA)
```
bg-gradient-to-r from-[#F3EB35] to-[#F99C24]
hover:opacity-90
text-black font-bold
rounded-xl
shadow-lg shadow-[#F99C24]/20
active:scale-[0.98]
transition-all
```

### Ghost / Toolbar
```
bg-white/5 hover:bg-white/10
border border-white/10
text-gray-400 hover:text-white
rounded-lg
transition-colors
```

### Destructive
```
bg-red-500 hover:bg-red-600
text-white font-medium
rounded-xl
shadow-lg shadow-red-500/20
```

### Disabled state (all buttons)
```
opacity-50 cursor-not-allowed
```
Or for primary: `disabled:from-system-gray4 disabled:to-system-gray4`

---

## Inputs & Form Controls

### Text Input
```
bg-white/5
border border-white/10
rounded-xl
text-sm text-white placeholder-gray-600
px-4 py-3
focus:ring-2 focus:ring-[#F99C24] focus:border-transparent
transition-all
```

### Textarea
```
bg-system-gray6/50
border border-white/5
rounded-xl
text-sm text-gray-300 placeholder-gray-600
focus:ring-1 focus:ring-system-blue focus:border-system-blue/50
focus:bg-system-gray6
```

### Select / Dropdown
```
Track: bg-system-gray6/50 border-white/5 rounded-lg
Option hover: hover:bg-white/8 hover:text-white
Active option: bg-system-blue/20 text-white
Checkmark: text-system-blue
```

### Segmented Control
```
Track: bg-system-gray5/50 p-1 rounded-lg
Active pill: bg-system-gray3 text-white shadow-sm ring-1 ring-white/5 rounded-[6px]
Inactive: text-gray-400 hover:text-white
```

### Stepper (Number Spinner)
```
Container: flex items-center bg-white/5 border border-white/10 rounded-lg overflow-hidden
Buttons (− / +): px-1.5 py-1 text-gray-500 hover:text-white hover:bg-white/10 transition-colors leading-none text-sm
Value display: px-1.5 text-xs text-white min-w-[1.25rem] text-center tabular-nums
Disabled button: opacity-30 cursor-not-allowed
Disabled container: opacity-40 pointer-events-none
```
- Use `rounded-lg` in dense contexts (header), `rounded-xl` to match surrounding inputs
- Never use native `<input type="number">` — always this custom pattern
- Keyboard arrow up/down via `onKeyDown` on the container div
- ARIA role on container: `role="spinbutton"`

### Range Slider
```
accent-system-blue
```

---

## Labels (section headers above controls)
Always the same pattern:
```
text-[10px] font-bold text-gray-500 uppercase tracking-wider
```

---

## Icons
- Library: **lucide-react** (`^0.554.0`)
- Default toolbar icon size: `w-4 h-4`
- Section icon size: `w-5 h-5`
- Decorative (inside icon containers): `w-8 h-8` or `w-10 h-10`
- Muted icon color: `text-gray-400` or `text-gray-500`
- Accent icon color: `text-system-blue` (orange)

### Icon Container (decorative)
```
w-16 h-16 (or w-20 h-20)
bg-gradient-to-br from-[#F3EB35] to-[#F99C24]
rounded-2xl
shadow-lg shadow-[#F99C24]/20
```
Icon inside: `text-black`

---

## Overlays & Modals

### Backdrop
```
fixed inset-0 z-50
bg-black/60 backdrop-blur-md
```

### Modal container
```
glass border border-white/10 rounded-2xl
shadow-2xl
p-8
```
Close button: top-right, `p-2 hover:bg-white/10 rounded-full text-gray-400 hover:text-white`

---

## Scrollbars (global)
```css
::-webkit-scrollbar { width: 10px; background: transparent; }
::-webkit-scrollbar-track { background: transparent; }
::-webkit-scrollbar-thumb {
  background: #48484a;           /* system-gray3 */
  border-radius: 10px;
  border: 2px solid transparent;
  background-clip: content-box;
}
::-webkit-scrollbar-thumb:hover { background: #636366; } /* system-gray2 */
```
Custom scrollbar class: `custom-scrollbar` (same values, scoped).

---

## Tooltips

Use the shared `<Tooltip>` component (`src/shared/ui/tooltip/Tooltip.tsx`). It renders via a React portal at `document.body` with `position: fixed` and `z-index: 9999`, so it is **never clipped** by `overflow: hidden` parents and always renders above the header.

### Usage
```tsx
import { Tooltip } from '@/src/shared/ui';

<Tooltip
  content={
    <>
      Tooltip text. Highlight key terms with{' '}
      <span className="text-system-blue font-semibold">Keyword</span>.
    </>
  }
/>
```

The default trigger is a `HelpCircle` icon (`w-3 h-3 text-gray-600 cursor-help`). Pass `children` to use a custom trigger.

### Rules
- **Always use `<Tooltip>`** — never hand-roll `group/tip` absolute divs
- **Tooltip panel style**: `w-64 px-3 py-2.5 bg-system-gray4 border border-white/10 rounded-xl text-[11px] text-gray-300 shadow-xl leading-snug`
- **Placement**: right — appears to the right of the trigger icon, vertically centered. Handled automatically by the component (no manual positioning needed)
- **Highlights**: `<span className="text-system-blue font-semibold">`

---

## Notification / Alert Strips

### Error
```
bg-red-500/10 border border-red-500/20 rounded-2xl
text-red-400 (heading: font-bold, body: text-xs text-red-400/80)
```

### Inline warning badge
```
fixed top-20 right-6 z-50
bg-red-500/20 border border-red-500/40 rounded-lg
text-red-300 text-sm
```

---

## App Shell Layout

```
┌─────────────────── Header (fixed, h-14, z-50) ───────────────────┐
│ sidebar │                                                          │
│  w-14   │            Main content area                            │
│ (fixed) │            pl-14  pt-14  h-screen overflow-hidden       │
│  z-40   │                                                          │
└─────────┴──────────────────────────────────────────────────────────┘
```

- **Header**: `fixed top-0 left-0 right-0 h-14 glass border-b border-white/10 z-50`
- **Sidebar**: `fixed left-0 top-14 bottom-0 w-14 glass border-r border-white/10 z-40`
- **Sidebar active icon**: `bg-gradient-to-br from-[#F3EB35] to-[#F99C24] text-black rounded-xl shadow-lg shadow-[#F99C24]/30`
- **Sidebar inactive icon**: `text-gray-500 hover:text-white hover:bg-white/10 rounded-xl`
- **Main**: `pl-14 pt-14 h-screen overflow-hidden`

---

## UX Motion

All motion in this app uses **pure Tailwind CSS transitions** — no Framer Motion or custom CSS animations.

### Sidebar expand/collapse (canonical pattern)

The sidebar expands on hover from collapsed (`w-14`) to expanded (`w-44`), with labels fading in with a stagger. This is the reference implementation for any panel that slides open/closed.

| Element | Classes | Notes |
|---|---|---|
| Container width | `transition-[width] duration-200 ease-in-out` | Width-only transition — avoids animating unrelated props |
| Collapsed state | `w-14` | Icon-only, 56px |
| Expanded state | `hover:w-44` | With labels, 176px |
| Label opacity | `opacity-0 group-hover/sidebar:opacity-100 transition-opacity duration-150 delay-75` | Fades in after width starts expanding (75ms stagger) |
| Nav item | `transition-all duration-200` | Covers bg color + any layout shifts |

**Rules when reusing this pattern:**
- Width transition: always `transition-[width] duration-200 ease-in-out` (not `transition-all`, to avoid animating shadows etc.)
- Revealed content: fade in with `transition-opacity duration-150 delay-75` so it doesn't appear before the container has opened
- Use `overflow-hidden` on the container so content is clipped during animation
- Use `group/` + `group-hover/` scoped variants to avoid conflicts when nesting hover groups

---

## Selection Highlight
```
selection:bg-system-blue/30 selection:text-white
```
