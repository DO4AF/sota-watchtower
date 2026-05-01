# SOTA Watchtower — Style Guide

## Design Philosophy
Professional SaaS look. Dark mode first. Clean, minimal, functional. Ham radio operators are the users — they care about data density and readability, not flashy animations.

## Typography
- **Font**: Inter (Google Fonts) — loaded in `web/src/index.html`
- **Monospace**: For callsigns, frequencies, coordinates — use `font-family: 'Courier New', monospace`
- **Sizes**: Follow PrimeNG defaults, override sparingly

## Color System (CSS Custom Properties)

### Dark Theme (default)
```scss
--surface-0: #0d1117;        // Page background
--surface-card: #161b22;     // Card/panel background
--surface-border: #30363d;   // Borders
--text-color: #e6edf3;       // Primary text
--text-muted: #8b949e;       // Secondary text
--primary-color: #58a6ff;    // Links, active states
--primary-glow: rgba(88, 166, 255, 0.3);
--sidebar-bg: #0d1117;       // Sidebar background
--sidebar-width: 240px;
--sidebar-collapsed-width: 64px;
```

### Light Theme
```scss
--surface-0: #f6f8fa;
--surface-card: #ffffff;
--surface-border: #d0d7de;
--text-color: #1f2328;
--text-muted: #656d76;
--primary-color: #0969da;
--sidebar-bg: #f6f8fa;
```

## Map Tiles
- **Dark mode**: CARTO Dark Matter — `https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png`
- **Light mode**: CARTO Voyager — `https://{s}.basemaps.cartocdn.com/rastertiles/voyager/{z}/{x}/{y}{r}.png`
- Attribution: `&copy; OpenStreetMap contributors &copy; CARTO`

## Summit Marker Colors (by points)
Points 1-10, gradient from green to red:
```
1pt  → #00c853 (bright green)
2pt  → #64dd17 (light green)
3pt  → #aeea00 (yellow-green)
4pt  → #ffd600 (yellow)
5pt  → #ffab00 (amber)
6pt  → #ff6d00 (deep orange)
7pt  → #dd2c00 (red-orange)
8pt  → #c62828 (red)
9pt  → #b71c1c (dark red)
10pt → #880e4f (deep red/maroon)
```
- Marker type: `L.circleMarker` (radius 6, fillOpacity 0.85, weight 1.5)
- No clustering — individual markers at all zoom levels

## Walker Marker Freshness Colors
Based on age of last position:
```
< 5 min   → opacity 1.0, color #00e676 (bright green), pulsing animation
5-15 min  → opacity 0.85, color #ffeb3b (yellow)
15-30 min → opacity 0.65, color #ff9800 (orange)
30+ min   → opacity 0.4, color #9e9e9e (gray)
```

## Layout
- **Sidebar**: Fixed left, 240px wide (64px collapsed)
- **Content**: `margin-left: var(--sidebar-width)`, full height
- **Map**: `height: 100%` within content area
- **No top navbar** — all navigation is in the sidebar

## Component Conventions
- All components are standalone (no NgModules)
- SCSS files use BEM-like naming: `.component-name__element--modifier`
- No inline styles
- PrimeNG components preferred over custom HTML for forms/tables
- Leaflet for map only

## Animations
- Summit markers: subtle `pulse` keyframe for active alerts
- Walker markers: `bounce` keyframe for very fresh positions (< 5 min)
- Sidebar: smooth `width` transition on collapse/expand

## Accessibility
- Color is never the only indicator — always pair with text/icon
- Sufficient contrast ratios in both themes
- Keyboard navigation supported via PrimeNG

## Code Style
- TypeScript strict mode
- No `any` types — use proper interfaces
- Signals preferred over BehaviorSubject for local state
- `inject()` preferred over constructor injection
- Always run `npx ng build --configuration production` before pushing
