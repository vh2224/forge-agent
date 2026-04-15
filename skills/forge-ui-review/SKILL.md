---
name: forge-ui-review
description: "Review de UI — WCAG 2.2, CWV, WAI-ARIA, React 19/Next.js."
---

<objective>
Review UI components for quality across three dimensions: accessibility (WCAG 2.2 AA), performance (Core Web Vitals), and architecture (established patterns). Every finding is grounded in a published standard or measurable metric — not opinion. Framework-aware: React 19, Next.js App Router, Vue, Svelte.
</objective>

<essential_principles>
- Detect the framework first. React 19, Vue 3, Svelte 5, and vanilla have different correct patterns.
- Accessibility is WCAG 2.2 AA baseline — cite the exact Success Criterion number for every finding.
- Performance findings must map to a Core Web Vital (CLS, LCP, INP) with the published threshold.
- Architecture findings reference established patterns (Compound Components, Hooks, Container/Presentational).
- Never suggest extracting a component that's used once. Abstraction has a cost.
</essential_principles>

<process>

## Step 1 — Detect framework and patterns

Read project config to identify:

| Signal | Framework |
|--------|-----------|
| `react` + `react-dom` 19+ in package.json | React 19 |
| `react` 18.x in package.json | React 18 |
| `next` in package.json | Next.js (check App Router vs Pages) |
| `vue` 3.x in package.json | Vue 3 |
| `nuxt` in package.json | Nuxt (Vue) |
| `svelte` in package.json | Svelte |
| `.astro` files | Astro |
| None of the above | Vanilla / Web Components |

Also detect:
- State management: Redux, Zustand, Jotai, Pinia, TanStack Query, Context API
- Styling: Tailwind, CSS Modules, styled-components, Emotion
- Testing: Vitest, Jest, Testing Library, Playwright, Cypress
- App Router vs Pages Router (check for `app/` directory with `layout.tsx`)

## Step 2 — Accessibility audit (WCAG 2.2 AA)

### Images and media
- `<img>` without `alt` → `✗` SC 1.1.1 Non-text Content
- Decorative images without `alt=""` → `⚠` SC 1.1.1 (screen readers announce filename)
- `<video>`/`<audio>` without captions or transcript → `⚠` SC 1.2.2 Captions

### Interactive elements
- `<button>`/`<a>` without visible text or `aria-label` → `✗` SC 4.1.2 Name, Role, Value
- `<div onClick>` without `role="button"`, `tabIndex`, and `onKeyDown` → `✗` SC 2.1.1 Keyboard
- Custom widget missing required ARIA pattern (see APG section below) → `✗` SC 4.1.2

### Forms
- `<input>` without `<label>` or `aria-label` → `✗` SC 1.3.1 Info and Relationships
- Missing error messages on validation → `⚠` SC 3.3.1 Error Identification
- Missing `autocomplete` on common fields (name, email, tel) → `info` SC 1.3.5

### Structure
- Heading hierarchy skips levels (h1 → h3) → `⚠` SC 1.3.1
- Missing landmark elements (`<main>`, `<nav>`, `<header>`) → `⚠` SC 1.3.1
- Missing `lang` attribute on `<html>` → `✗` SC 3.1.1 Language of Page

### Color and contrast
- Insufficient text contrast → `⚠` SC 1.4.3 (4.5:1 normal text, 3:1 large text)
- Information conveyed by color alone → `⚠` SC 1.4.1 Use of Color

### Motion
- Animations without `prefers-reduced-motion` check → `⚠` SC 2.3.3

### WCAG 2.2 new criteria (not in 2.1)
- **SC 2.4.11 Focus Not Obscured (AA)**: focused element hidden behind sticky header/footer/modal → `✗`. Focused element must be at least partially visible.
- **SC 2.5.7 Dragging Movements (AA)**: drag-and-drop without single-pointer alternative (click/tap) → `✗`. Every drag action must have a non-dragging fallback.
- **SC 2.5.8 Target Size Minimum (AA)**: interactive targets < 24x24 CSS px without sufficient spacing → `⚠`. Minimum 24px; recommend 44px for primary actions.
- **SC 3.2.6 Consistent Help (A)**: help mechanisms (chat, FAQ, contact) in different positions across pages → `⚠`.
- **SC 3.3.7 Redundant Entry (A)**: form asks user to re-enter info already provided in same session → `⚠`.
- **SC 3.3.8 Accessible Authentication (AA)**: login requires cognitive test (CAPTCHA puzzle, transcription) without alternative → `✗`. Must allow paste, password managers, passkeys.

### WAI-ARIA Authoring Practices (APG) — required patterns

When reviewing custom widgets, verify they implement the correct APG pattern:

**Modal dialog:** `role="dialog"`, `aria-modal="true"`, `aria-labelledby` → visible title. Focus trap (Tab/Shift+Tab inside), Escape closes, focus returns to trigger.

**Tabs:** `role="tablist"` container, `role="tab"` with `aria-selected`, `role="tabpanel"` with `aria-labelledby`. Arrow keys between tabs, Tab into panel content, Home/End to first/last.

**Accordion:** Headers with `aria-expanded`, `aria-controls` pointing to panel. Enter/Space toggles. Optional arrow keys between headers.

**Combobox/autocomplete:** Input with `role="combobox"`, `aria-expanded`, `aria-autocomplete`, `aria-controls` → listbox. Options with `role="option"`, `aria-selected`. Down arrow opens, Escape closes, Enter selects.

**Toast/notification:** `role="status"` (polite) or `role="alert"` (assertive). Don't auto-dismiss critical messages. Actions in toasts must be keyboard-accessible.

### Context exclusions
- Icons inside buttons with visible text: `aria-hidden="true"` on icon is correct
- Hidden content (`display: none`, `hidden`): skip
- Third-party component internals: only check props passed, not library source

## Step 3 — Performance (Core Web Vitals)

### Thresholds (assessed at 75th percentile)

| Metric | Good | Needs Improvement | Poor |
|--------|------|--------------------|------|
| **LCP** | ≤2.5s | 2.5s-4.0s | >4.0s |
| **INP** | ≤200ms | 200ms-500ms | >500ms |
| **CLS** | ≤0.1 | 0.1-0.25 | >0.25 |

> INP replaced FID in March 2024. INP measures the latency of ALL interactions (not just first), making it more representative.

### React 19 / Next.js specific

**Server Components (default in App Router):**
- Component with no hooks, events, or browser APIs marked `'use client'` → `⚠` unnecessary client bundle. Remove directive.
- Entire page marked `'use client'` → `⚠` push directive down to interactive leaves only.
- Server Component trying to use `useState`/`useEffect` → `✗` will crash at runtime.
- `useEffect` + `fetch` when server-side fetch would suffice → `⚠` creates waterfall.
- Sequential `await` in Server Component instead of `Promise.all()` → `⚠` waterfall.

**React 19 hooks:**
- `use(promise)` without Suspense boundary above → `✗` will crash.
- `useFormStatus()` called outside `<form>` context → `✗` returns stale data.
- `useOptimistic()` without error rollback handling → `⚠` UI desyncs on failure.
- `useActionState()` (replaces `useFormState`) not adopted when using form actions → `info`.

**Next.js App Router:**
- Missing `loading.tsx` for routes with async data → `⚠` no loading state.
- Missing `error.tsx` for routes with fallible data → `⚠` no error boundary.
- API route that only proxies a database call → `info` use Server Action instead.
- `<img>` instead of `next/image` → `⚠ LCP` loses image optimization.

### General (all frameworks)

**Rendering:**
- Component inside `.map()` defined inline → `⚠ INP` creates new reference each render
- Missing `key` prop on list items → `✗` reconciliation breaks
- Large list (>50 items) without virtualization → `⚠ INP` suggest react-window/tanstack-virtual
- Context provider at root with frequently changing value → `⚠ INP` forces full re-render tree

**Bundle:**
- Full library import for one function (e.g., `import _ from 'lodash'` for `debounce`) → `⚠` bundle bloat. Use `lodash/debounce` or `lodash-es`.
- Synchronous import of heavy component only shown in modal/drawer → `info` lazy load with dynamic import

**UX states:**
- Async operation without loading state → `⚠` (UX)
- Async operation without error handling/boundary → `⚠` (UX)
- Empty list/table without empty state → `info` (UX)

### Severity by CWV impact
- `✗` Critical: causes crashes, visible jank, or data loss (missing keys, infinite rerenders, no Suspense boundary)
- `⚠` Warning: measurable CWV degradation (large lists, context re-renders, unsized images)
- `info`: improvement opportunity (lazy loading, memoization, modern patterns)

## Step 4 — Component architecture

### Design patterns (reference: patterns.dev, Kent C. Dodds)

| Pattern | When appropriate | Anti-signal |
|---------|-----------------|-------------|
| **Compound Components** | Related elements sharing implicit state (Select+Option, Tabs+Panel) | `>8 boolean props` controlling modes |
| **Custom Hooks** | Reusable stateful logic without UI. Preferred over HOCs/render props | Logic duplicated across 3+ components |
| **Container/Presentational** | Data layer separated from display. Server Components are natural containers | `useEffect` + fetch + rendering in same component |
| **Composition (children/slots)** | Flexible component API without prop drilling | Component has `>5 render-related props` |

### Evaluate structure

**Responsibility:**
- Component >300 lines mixing data fetching + rendering + business logic → `⚠` god component
- Exception: page-level components composing other components can be longer
- Component doing fetch + transform + render → suggest hook or Server Component for data layer

**Props:**
- Component with >8 props → `⚠` consider compound component or composition pattern
- Props passed through >3 intermediate components unchanged → `⚠` prop drilling. Suggest context, composition, or Zustand slice
- Boolean prop that inverts component behavior entirely → `⚠` should be two components
- Exception: UI library wrappers (Button, Input) naturally have many props

**State:**
- Multiple `useState` that always change together → `⚠` use `useReducer` or single object
- State derivable from other state stored separately → `⚠` computed value, not state
- Global state for purely local concern (modal open in Redux) → `info`

**Missing patterns:**
- No error boundary wrapping async components (React) → `⚠`
- No `<Suspense>` with lazy-loaded or `use()` components → `✗` (React 19)
- Missing TypeScript types on props (when project uses TS) → `info`

### Context exclusions
- Storybook files, test files, mock data: skip architecture review
- Generated code (GraphQL codegen, Prisma client): skip entirely
- Third-party library wrappers: evaluate the wrapper, not the library

## Step 5 — Output

```markdown
# UI Review

**Framework:** [React 19 / Next.js App Router / Vue 3 / Svelte / ...]
**Styling:** [Tailwind / CSS Modules / ...]
**State management:** [Zustand / Redux / Context / TanStack Query / ...]

## Accessibility (WCAG 2.2 AA)
### Critical
- `✗` [file:line] — [issue] — SC [number] [name] → [fix]

### Warnings
- `⚠` [file:line] — [issue] — SC [number] [name] → [fix]

## Performance (Core Web Vitals)
### Critical
- `✗` [file:line] — [issue] — [CWV metric] → [fix]

### Warnings
- `⚠` [file:line] — [issue] — [CWV metric] → [fix]

## Architecture
- `⚠` [file:line] — [issue] → [recommendation + pattern name]

## Summary
| Category | Critical | Warning | Info |
|----------|----------|---------|------|
| Accessibility | N | N | N |
| Performance | N | N | N |
| Architecture | — | N | N |
```

</process>

<fast_mode>
When invoked with `-fast` flag: audit only files changed in the current branch. Skip architecture review. Focus on accessibility critical + performance critical only.
</fast_mode>

<success_criteria>
- Every accessibility finding references the exact WCAG 2.2 SC number and name
- Performance findings map to a specific CWV metric (CLS, LCP, INP)
- Custom widgets are verified against WAI-ARIA APG required patterns
- React 19 / Next.js App Router patterns checked when framework is detected
- Architecture findings reference established pattern names (Compound, Hooks, Container/Presentational)
- No findings on test files, storybook files, or generated code
- Framework-specific advice matches the actual framework and version detected
</success_criteria>
