---
name: forge-responsive
description: Responsive design audit and implementation. Core Web Vitals, fluid/intrinsic layout, container queries, mobile-first, WCAG 2.2 touch targets. Use when building or reviewing UI components, pages, or layouts.
---

<objective>
Audit and guide responsive design using modern CSS capabilities and measurable web standards. Analysis is grounded in Core Web Vitals thresholds, WCAG 2.2 criteria, and intrinsic design principles — not opinion. Every finding includes the standard violated, the file/line, and a concrete fix.
</objective>

<essential_principles>
- Detect the project's CSS strategy first (Tailwind, CSS modules, styled-components, vanilla). Rules change by context.
- Intrinsic design over breakpoint sprawl. Components should adapt to their container, not the viewport. Prefer `clamp()`, `auto-fit`, container queries over media query cascades.
- Measure by Core Web Vitals impact. CLS, LCP, and INP are the metrics that matter — flag patterns that degrade them.
- Mobile-first is the default recommendation, but desktop-first is valid if the project already committed to it.
- Every finding must cite the standard (WCAG criterion, CWV metric) and include file, line, and a concrete fix.
</essential_principles>

<process>

## Step 1 — Detect CSS strategy

Read project config to identify the stack:

| Signal | Strategy |
|--------|----------|
| `tailwind.config.*` exists | Tailwind CSS |
| `*.module.css` or `*.module.scss` in components | CSS Modules |
| `styled-components` or `@emotion` in package.json | CSS-in-JS |
| `*.css` or `*.scss` alongside components | Vanilla / SCSS |
| `globals.css` or `app.css` only | Global styles |

Read the config file (tailwind.config, theme file, or main CSS) to extract:
- Custom breakpoints (if any)
- Theme spacing scale
- Container max-width

## Step 2 — Identify breakpoint strategy

### For Tailwind projects
Check `tailwind.config.*` for custom `screens`. Tailwind v3/v4 defaults:
```
sm: 640px, md: 768px, lg: 1024px, xl: 1280px, 2xl: 1536px
```
Tailwind is mobile-first by design (min-width). Note custom breakpoints if present.

### For vanilla/SCSS/CSS Modules
Search for media queries and classify:
- `min-width` → mobile-first (correct default)
- `max-width` → desktop-first (valid if consistent)
- Mixed `min-width` AND `max-width` in same codebase → `⚠` inconsistency

Extract unique breakpoint values. Flag if >5 distinct values exist (fragmentation).

### Reference: real-world viewport distribution (2024-2025)
| Category | Common widths | Share |
|----------|---------------|-------|
| Mobile | 360-430px | ~80% of phones |
| Tablet | 768-810px | iPad variants |
| Desktop | 1440-1920px | Most common |

## Step 3 — Audit layout patterns

### Intrinsic design patterns (prefer over media queries)

Check if the project uses modern CSS for self-adapting layouts:

| Pattern | CSS | Replaces |
|---------|-----|----------|
| Fluid grids | `repeat(auto-fit, minmax(min(250px, 100%), 1fr))` | Breakpoint-based column switching |
| Fluid spacing | `gap: clamp(1rem, 2vw, 3rem)` | Multiple spacing overrides per breakpoint |
| Fluid typography | `clamp(1rem, 0.909rem + 0.45vw, 1.25rem)` | font-size at every breakpoint |
| Container queries | `@container (inline-size > 400px) { ... }` | Component-level media queries |
| Logical properties | `margin-inline`, `padding-block` | Physical margin-left/padding-top |

> Container queries (CSS Containment L3) have 90%+ browser support. Use for reusable components. Keep media queries for page-level layout and user preference queries (prefers-color-scheme, prefers-reduced-motion).

**When to flag absence:** If the project has >5 media queries doing column switching on the same component used in multiple contexts, suggest container queries. If typography uses 3+ breakpoint overrides, suggest `clamp()`.

### Fluid containers
- `width: Npx` on containers → `⚠` CLS risk — should be `max-width` + `width: 100%`
- Exception: icons, avatars, fixed-size elements are fine with px

### Flexible grids
- `grid-template-columns: Npx Npx Npx` → `⚠` use `repeat(auto-fit, minmax(Npx, 1fr))`
- Flexbox without `flex-wrap` on multi-item containers → `⚠` will overflow on mobile

### Fluid typography
Formula: `font-size: clamp(min, preferred, max)` where preferred = `rem + vw`:
```css
/* 16px at 320px viewport → 20px at 1200px viewport */
font-size: clamp(1rem, 0.909rem + 0.455vw, 1.25rem);
```
- Always use `rem + vw` (not pure `vw`) so text scales with user browser font size
- Body text at 16px base is fine — don't flag
- Headings and hero text without fluid scaling → `info` suggest clamp()

### Responsive images (LCP + CLS impact)
- `<img>` without `max-width: 100%` or responsive class → `⚠` will overflow
- Large images without `srcset` + `sizes` or `<picture>` → `⚠ LCP` wastes bandwidth on mobile
- Missing `width`/`height` attributes or `aspect-ratio` → `⚠ CLS` causes layout shift
- Hero/LCP image not preloaded → `info` consider `<link rel="preload">`
- Not using modern formats (AVIF/WebP) → `info` suggest with `<picture>` fallback
- Next.js project using `<img>` instead of `next/image` → `⚠` loses optimization pipeline

### Touch targets (WCAG 2.2)
- **SC 2.5.8 Target Size (Minimum) — Level AA**: targets must be at least **24x24 CSS px**, or have sufficient spacing (24px offset) to adjacent targets
- **SC 2.5.5 Target Size (Enhanced) — Level AAA**: targets must be at least **44x44 CSS px**
- Recommend 44x44 for primary actions (buttons, CTAs), 24x24 minimum for all interactive elements
- Exceptions: inline text links in paragraphs, targets where specific presentation is essential (e.g., map pins)

### Viewport meta
- Missing `<meta name="viewport" content="width=device-width, initial-scale=1">` → `✗` critical

## Step 4 — Core Web Vitals impact assessment

Cross-reference findings with CWV metrics:

| Metric | Good | Needs Improvement | Poor | Responsive impact |
|--------|------|--------------------|------|-------------------|
| **CLS** | ≤0.1 | 0.1-0.25 | >0.25 | Unsized images, font swaps, dynamic content injection |
| **LCP** | ≤2.5s | 2.5s-4.0s | >4.0s | Oversized images on mobile, unpreloaded hero images |
| **INP** | ≤200ms | 200ms-500ms | >500ms | Heavy JS hydration on mobile, layout thrashing on resize |

Flag findings that directly impact CWV with the metric name: `⚠ CLS`, `⚠ LCP`, `⚠ INP`.

## Step 5 — Context-aware severity

| Severity | Criteria | Example |
|----------|----------|---------|
| `✗` Critical | Breaks layout or fails WCAG AA | Missing viewport meta, fixed 1200px container |
| `⚠` Warning | Degrades CWV or usability | No flex-wrap, unsized images (CLS), small touch targets |
| `info` | Modern CSS improvement | Could use clamp(), could add container queries, srcset |

**Exclude from analysis:**
- Admin panels / back-office UIs (unless user asks)
- Print stylesheets
- Email templates (different rules entirely)
- SVG internals

## Step 6 — Output

```markdown
# Responsive Audit

**Strategy:** [Tailwind / CSS Modules / CSS-in-JS / Vanilla]
**Breakpoint approach:** [mobile-first / desktop-first / mixed ⚠]
**Breakpoints detected:** [list with px values]
**Modern CSS usage:** [container queries: yes/no] [clamp(): yes/no] [logical properties: yes/no]

## Critical
- `✗` [file:line] — [issue] — [standard] → [fix]

## Warnings
- `⚠` [file:line] — [issue] — [CWV metric or WCAG SC] → [fix]

## Improvements
- `info` [file:line] — [suggestion]

## Core Web Vitals risk
| Metric | Risk level | Root causes |
|--------|-----------|-------------|
| CLS | low/medium/high | [specific findings] |
| LCP | low/medium/high | [specific findings] |
| INP | low/medium/high | [specific findings] |

## Summary
- Critical: N | Warnings: N | Info: N
```

</process>

<fast_mode>
When invoked with `-fast` flag: audit only files changed in the current branch (use `git diff --name-only main`). Skip breakpoint consistency and CWV risk table. Focus on critical + warning only.
</fast_mode>

<success_criteria>
- Every critical/warning finding cites the standard (WCAG SC number or CWV metric name)
- No style opinions reported as problems (spacing preferences, color choices)
- Modern CSS patterns suggested only when they solve a concrete problem (not "you should use container queries everywhere")
- Breakpoint strategy identified before flagging inconsistencies
- Core Web Vitals risk assessment based on actual findings, not theoretical
- Findings are reproducible — another developer can find and fix each issue
</success_criteria>
