---
name: MendCode
description: The customizable coding terminal.
---

# Design System: MendCode

## Overview

**Creative North Star: "The Living Terminal Map"**

MendCode uses the terminal as an interactive product surface, not as a container for a generic chat application. Interfaces should reveal relationships, state, and workflow through precise spatial composition while preserving the speed and directness of text. The system is theme-adaptive and terminal-native: it inherits configured semantic colors, renders real character cells, and degrades predictably when capabilities are limited.

MendCode rejects OpenCode-clone surfaces, decorative dashboard card grids, fake visualizations, and image-based terminal effects. Product views should feel authored for their task, with strong hierarchy and few containers.

**Key Characteristics:**

- Dense but scannable
- Keyboard-first and mouse-capable
- Theme-adaptive rather than palette-prescriptive
- Honest about persisted state, sampling, and fallbacks
- Spatial when relationships matter, linear when sequence matters

## Colors

The active MendCode theme is the source of truth. Graphs use a full functional palette derived from semantic theme roles, with category colors assigned consistently and edge colors kept quieter than nodes.

**The Semantic Color Rule.** Color communicates category, health, relation, selection, or warning. Decorative color without a data role is prohibited.

**The Redundant Meaning Rule.** No state or relation may rely on color alone. Glyph, line style, label, or text metadata must carry the same meaning.

## Typography

MendCode inherits the user's terminal font. Hierarchy comes from placement, concise copy, semantic color, weight where supported, and deliberate whitespace rather than multiple font families or oversized display treatment.

**Display Font:** Active terminal monospace
**Body Font:** Active terminal monospace
**Label/Mono Font:** Active terminal monospace

**Character:** Precise, compact, and operational. Labels are short, values are aligned when comparison matters, and prose is capped before it becomes a terminal wall of text.

### Hierarchy

- **Display:** Reserved for home identity and intentional ASCII marks.
- **Headline:** One concise route or panel title.
- **Title:** Selected object, current operation, or active focus.
- **Body:** Operational content with bounded line length and honest wrapping.
- **Label:** Compact metadata, shortcuts, counts, and relation types.

**The One Title Rule.** A surface must not repeat the same title in nested borders, headers, and content.

## Elevation

The TUI is flat by default. Depth is created with focus order, negative space, restrained borders, overlays for transient interaction, and tonal background roles supplied by the active theme. Decorative shadows and glass effects do not apply in terminal output.

**The Structure Before Border Rule.** Use spacing and alignment before adding a panel border. Nested boxes are prohibited unless the inner boundary has an independent interaction contract.

## Components

### Graph Canvas

- Occupies the dominant area on dedicated graph surfaces.
- Uses Braille subcells when supported and a plain ASCII fallback when not.
- Draws edges before nodes, selected nodes last, and contextual labels only where they remain readable.
- Uses deterministic layout for stable mental mapping.
- Exposes pan, zoom, auto-fit, keyboard selection, search, minimap, and legend on dedicated routes.
- Compact variants are static summaries and never pretend to offer full interaction.

### Panels and Containers

- Use a single perimeter only when it clarifies ownership or focus.
- Keep metadata outside the graph's visual center.
- Avoid repeated equal-sized cards and redundant status blocks.
- Preserve a useful single-column fallback on narrow terminals.

### Inputs and Search

- Search is progressive and keyboard-first.
- Focus is visible without color alone.
- Empty results explain whether no data exists or a filter removed all matches.

### Navigation

- Arrow keys and `hjkl` support spatial navigation where appropriate.
- Escape returns to the previous level consistently.
- Mouse interactions supplement keyboard behavior and never replace it.

## Do's and Don'ts

### Do:

- **Do** render persisted relationships and identify sampled or inferred data explicitly.
- **Do** use semantic theme roles and maintain readable monochrome output.
- **Do** keep layouts deterministic so nodes do not jump between renders.
- **Do** provide text summaries for graph health, relation type, focus, and visibility limits.
- **Do** let dedicated routes breathe while keeping tool calls compact.

### Don't:

- **Don't** create OpenCode-clone surfaces that do not establish a distinct MendCode identity.
- **Don't** use decorative dashboards made from repeated cards and badges.
- **Don't** show fake visualizations that imply relationships or runtime state not present in persisted data.
- **Don't** use image-based terminal effects that cannot degrade to readable text.
- **Don't** infer edges merely because two memories share a category.
- **Don't** copy GPL implementation code into MendCode's MIT codebase.
