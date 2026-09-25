# Design — SQL Server Query AI

A locked design system for this app. Every page reads this file before its styles change. Do not
restyle one page on its own: amend this file when the system needs to grow.

## Genre
modern-minimal · theme **Cobalt** (the cool dev-tool register), adapted for a working app rather than a
landing page. It reads like an instrument panel for a DBA: calm ground, ruled hairlines, one blue signal,
and SQL shown as code.

## Macrostructure family
- App pages (`/app`, `/settings`, `/setup`): **Workbench**. A fixed left rail (brand, new analysis,
  history, account) and one left-aligned working column. The tool itself leads: the plan drop zone on an
  empty workspace, Jev's decision on a report. No marketing hero, no feature grid.
- Auth pages (`/login`, `/signup`): **Single form**. Wordmark, a left-aligned title, one bordered form.
- There are no marketing or content pages.

## Theme
Tokens live in `app/tokens.css` under the existing `--qai-*` names. OKLCH throughout.

| token | light | dark | use |
| --- | --- | --- | --- |
| `--qai-paper` | `oklch(98.5% 0.004 250)` | `oklch(19% 0.014 258)` | page ground |
| `--qai-paper-2` | `oklch(96.5% 0.005 252)` | `oklch(22% 0.015 258)` | rail, bands |
| `--qai-paper-3` | `oklch(94% 0.006 254)` | `oklch(27% 0.016 258)` | tracks, wells |
| `--qai-rule` | `oklch(90% 0.008 255)` | `oklch(32% 0.016 258)` | hairlines |
| `--qai-ink` | `oklch(24% 0.02 258)` | `oklch(95% 0.008 255)` | headings, values |
| `--qai-ink-muted` | `oklch(50% 0.015 256)` | `oklch(72% 0.014 255)` | captions, meta |
| `--qai-accent` | `oklch(55% 0.2 256)` | `oklch(72% 0.15 255)` | the one signal |
| `--qai-on-accent` | `oklch(99% 0.004 256)` | `oklch(18% 0.03 258)` | text on accent |
| `--qai-teal` | `oklch(52% 0.1 190)` | `oklch(78% 0.1 185)` | "done", healthy |
| `--qai-warn` | `oklch(52% 0.11 75)` | `oklch(82% 0.12 80)` | warnings, declined |
| `--qai-danger` | `oklch(52% 0.19 22)` | `oklch(74% 0.14 20)` | critical, errors |
| `--qai-graphite` | `oklch(23% 0.018 260)` | `oklch(15% 0.014 260)` | SQL code wells |

Accent covers under 5 % of any viewport: the primary button, focus rings, the selected option's border,
the pick marker, bar fills for the pick, and links.

## Typography
- Display: **Space Grotesk** 500, tracking `-0.02em` (headings, the decision title, KPI values).
- Body: **Inter** 400/500/600.
- Mono: **JetBrains Mono** 400/500. SQL, operator names, node ids, object names, numbers in tables and
  bars, and small UPPERCASE labels (`0.06em` tracking).
- All self-hosted through `@fontsource`: the image makes no request to a font CDN.
- Scale: `--qai-text-xs` 12 · `sm` 14 · `base` 16 · `lg` 18 · `xl` 22 · `2xl` 30 · display 40 px.

## Surfaces and radius
- Depth comes from 1 px hairlines, never from drop shadows, glows, blur or gradients.
- Radius: 6 px on buttons, inputs and chips; 10 px on cards and panels.
- SQL is shown on a dark graphite well in mono, the one dark element on a page.

## Spacing
The 4-point scale in `tokens.css` (`--qai-space-xs` 4 … `3xl` 48). Sections are separated by
`--qai-space-3xl`; items inside a card by `--qai-space-md`.

## Motion
- Easing `--qai-ease-out: cubic-bezier(0.2, 0.7, 0.2, 1)`, 150/220 ms.
- Only the live pipeline moves: the progress bar grows and the active step is marked. Reports appear
  composed and static: no rise, count-up, bar-grow, ring-draw or pulse.
- Hover changes colour or border only; nothing lifts. Reduced motion removes all transitions.

## Microinteractions stance
- Success is silent (a status line, never a toast or celebration).
- Focus rings are instant, 2 px accent, 2 px offset.
- Non-interactive surfaces never react to hover.

## CTA voice
- Primary: solid accent, 6 px radius, verb + object ("Analyse plan", "Save and continue").
- Secondary: 1 px hairline border on paper, same radius and padding.
- Destructive: secondary shape with danger text.

## What pages MUST share
The rail and wordmark, the tokens above, the three faces, the CTA voice, and the section heading
rhythm (Space Grotesk heading, optional mono meta on the right).

## What pages MAY differ on
Only content density: settings uses stacked forms, the report uses a two-column decision panel.

## Banned here
Gradient buttons or borders, glass blur, radial glows, side-stripe cards, pulsing dots, hover lift,
icon-tile feature grids, centred heroes, pill-shaped CTAs, pure `#fff`/`#000`.

## Exports

### tokens.css (summary)
```css
:root {
  --qai-paper: oklch(98.5% 0.004 250);
  --qai-ink: oklch(24% 0.02 258);
  --qai-accent: oklch(55% 0.2 256);
  --qai-rule: oklch(90% 0.008 255);
  --qai-font-display: "Space Grotesk", ui-sans-serif, system-ui, sans-serif;
  --qai-font-body: "Inter", ui-sans-serif, system-ui, sans-serif;
  --qai-font-mono: "JetBrains Mono", ui-monospace, Menlo, monospace;
  --qai-radius: 10px;
  --qai-radius-control: 6px;
}
```
