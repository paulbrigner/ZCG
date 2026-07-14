# Design QA

## Comparison target

- Source visual truth:
  - Attached Dashboard worklist screenshot, originally `/Users/paulbrigner/Desktop/Screenshot 2026-07-14 at 9.06.45 AM.png`.
  - Attached Dashboard tools screenshot, originally `/var/folders/y7/001_hzx12fv3fnlcdr121ggh0000gn/T/TemporaryItems/NSIRD_screencaptureui_xmmjWj/Screenshot 2026-07-14 at 9.08.52 AM.png`.
  - Attached Current corpus screenshot, originally `/Users/paulbrigner/Desktop/Screenshot 2026-07-14 at 9.11.25 AM.png`.
  - Attached committee-briefing freshness screenshot, originally `/var/folders/y7/001_hzx12fv3fnlcdr121ggh0000gn/T/TemporaryItems/NSIRD_screencaptureui_r7age1/Screenshot 2026-07-14 at 9.51.56 AM.png`.
- Browser-rendered implementation:
  - `/tmp/zcg-dashboard-viewport-final.png`
  - `/tmp/zcg-dashboard-after-mobile.png`
  - `/tmp/zcg-home-viewport-final.png`
  - `/tmp/zcg-report-freshness-local.png`
- Viewports: 1280 x 720 desktop and 390 x 844 mobile.
- State: public read-only Dashboard; home page with the Historical grant payments information popup open; public changed-evidence and current-evidence briefing pages.

## Full-view comparison evidence

- The worklist preserves the source hierarchy and row density while showing only the numeric age in each row. The single `Days outstanding` heading continues to define the column.
- The Current corpus card keeps the existing two-column metric grid and adds the historical-payment amount as a clean full-width final row.
- The information popup remains inside the desktop viewport, uses the existing information-control styling, and does not obscure the metric that opened it.
- The Dashboard tools card has been removed from the implementation rather than restyled or relocated.
- The committee-briefing badge now says `Evidence changed` rather than the ambiguous `Stale evidence`, and the warning names the exact changed-record count from that briefing's saved evidence snapshot.

## Focused region comparison evidence

- Worklist age column: `/tmp/zcg-dashboard-viewport-final.png` visibly shows `3`, `4`, and `7` without repeating `days outstanding`; `/tmp/zcg-dashboard-after-mobile.png` confirms the same treatment at the narrow breakpoint.
- Current corpus metric and explanation: `/tmp/zcg-home-viewport-final.png` shows `$19.3M`, the `historical grant payments` label, a circular information control, and the reconciled FPF/OpenZcash scope explanation.
- Committee briefing freshness: `/tmp/zcg-report-freshness-local.png` shows the updated badge and the report-specific `3 of 11 evidence records` explanation without changing the established card layout.
- No additional crop was needed because both focused regions are readable at original screenshot resolution.

## Required fidelity surfaces

- Fonts and typography: existing application font family, weights, sizes, line heights, and hierarchy are preserved. The new metric follows the existing KPI type scale.
- Spacing and layout rhythm: existing card padding, grid borders, section gaps, row spacing, and control alignment are preserved. The full-width metric row aligns with the grid edges.
- Colors and visual tokens: the implementation reuses the existing background, border, blue, muted-text, badge, button, and dark-popover tokens.
- Image quality and asset fidelity: no new raster, logo, illustration, or substitute icon asset was introduced.
- Copy and content: the repeated visual label and Dashboard tools copy are removed. The new metric is labeled in plain language, with detailed evidence scope available on demand.

## Primary interactions tested

- Opened and closed the Historical grant payments information control.
- Loaded the public Dashboard and verified worklist grant-detail and briefing links remain present.
- Checked the desktop and mobile worklist layouts.
- Verified the explanatory popup exposes its content and expanded state to assistive technology.
- Opened the Web3Lagos committee briefing panel and verified the report-specific freshness count on both the grant page and its public briefing page.

## Findings

- No actionable P0, P1, or P2 visual or interaction findings remain.

## Comparison history

1. The source worklist repeated `days outstanding` on every row. The visible row suffix was removed while a visually hidden singular/plural phrase was retained for assistive technology. Post-fix evidence: `/tmp/zcg-dashboard-viewport-final.png` and `/tmp/zcg-dashboard-after-mobile.png`.
2. The source Dashboard contained a Dashboard tools card. The card and its now-unused authorization lookup were removed. Post-fix evidence: source inspection and the final Dashboard render.
3. The source Current corpus card had no evidence-backed historical amount. A full-width `$19.3M` metric and reconciled information popup were added. Post-fix evidence: `/tmp/zcg-home-viewport-final.png`.
4. The source briefing used a broad `Stale evidence` indicator. The badge now distinguishes changed evidence from a template/model update, and the notice reports how many saved evidence records changed. Post-fix evidence: `/tmp/zcg-report-freshness-local.png`.

## Console check

- Final browser pass reported no console errors.

## Follow-up polish

- None required for this change set.

final result: passed
