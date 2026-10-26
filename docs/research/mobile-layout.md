# Mobile layout verification

Verified 2026-10-25 in headless Chrome with phone emulation and populated local API fixtures.
Fixtures include long player/outfit names, all four faction boards, population history and a spawn row.
They are test data, not live population measurements.

## Cause and fix

`main` was a grid with an implicit column whose minimum width came from its contents. The wide
spawn table (at least 1,000px) and leaderboard tables forced the Live and Players tab containers wider
than the viewport. The population panel stretched along with the Live tab. The viewport meta tag was
already correct; changing the initial zoom would have hidden the layout problem.

The main grid and stacked nested grids now use `minmax(0, 1fr)`, and main children can shrink with
`min-width: 0`. Tables retain their columns and scroll inside their own containers. The population
SVG uses the actual panel width, with fewer time labels on narrow screens. Phone controls fit in two
header columns, range/legend controls have 44px touch targets, and search fields use 16px text to avoid
iOS input-focus zoom. Pinch zoom remains available.

## Browser measurements

| Viewport width | Live page width before | Live page width after | Players page width after | Map page width after |
| --- | --- | --- | --- | --- |
| 320px | 1,194px | 320px | 320px | 320px |
| 360px | 1,195px | 360px | 360px | 360px |
| 390px | 1,194px | 390px | 390px | 390px |
| 430px | 1,194px | 430px | 430px | 430px |
| 768px | 1,206px | 768px | 768px | 768px |
| 1,440px | 1,440px | 1,440px | 1,440px | 1,440px |

At 390px the chart changed from about 1,156px wide to 336px. Independent horizontal scrolling of
the populated spawn table was verified. Full-page screenshots were reviewed at 390, 768 and 1,440px;
no JavaScript exceptions were recorded in the browser checks. The map check covers its container
layout, not live map data. Physical iOS/Safari testing remains useful for its input-focus behavior.

Emulated touch checks at 390px passed for all chart ranges, the online roster, player filtering and
the player dialog. The Taste inspector reported zero failures at 390, 768 and 1,440px with explicit
allowances for the existing uppercase labels, backgrounds, heading glow and faction purple. Its
warnings about the existing small secondary text and desktop heading size remain outside this
layout fix. Screenshot review confirmed aligned margins, a visible title, a fitted chart and
contained table scrolling; these address the three main issues (page width, mobile controls, chart
label spacing). `npm test` passed all 80 tests and `npm audit` found zero vulnerabilities.

## Recheck after layout changes

1. Use Chrome DevTools phone emulation at 320, 360, 390 and 430px, then tablet 768px and desktop 1,440px.
2. Wait for tables to populate; an empty screen can hide this regression. Switch Live, Players and Map.
3. Confirm `document.documentElement.scrollWidth` equals the configured viewport width.
4. Confirm the population chart and header controls fit; table scrolling should move the table without
   moving the page sideways. Check the outfit filter, chart range buttons and online roster as well.
5. Run `npm test` and `node --check public/app.js`.
