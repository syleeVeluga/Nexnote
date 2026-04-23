---
name: component
description: Create a new React component for WekiFlow's frontend
argument-hint: "<ComponentName> [description]"
allowed-tools: Read, Glob, Grep, Bash, Write, Edit
---

Create a new React component for WekiFlow.

## Arguments
- `$0` — Component name in PascalCase (e.g., `GraphPanel`, `RevisionDiff`)
- Remaining — Description of what the component does

## Existing components
```!
ls packages/web/src/components/ 2>/dev/null || echo "No components directory yet"
```

## Instructions

1. Determine the right location:
   - Reusable UI → `packages/web/src/components/ui/`
   - Feature-specific → `packages/web/src/components/<feature>/`
   - Layout → `packages/web/src/components/layout/`
   - Editor-related → `packages/web/src/components/editor/`
2. Create the component file with:
   - TypeScript with proper props interface
   - React 19 patterns (use, transitions where appropriate)
   - No unnecessary state libraries
3. If the component needs data, create a corresponding hook in `packages/web/src/hooks/`
4. Follow the existing styling approach in the project
5. Consider the three-panel layout context:
   - Left: folder tree navigation
   - Center: editor area
   - Right: tabbed panel (Graph, Triples, Revision, Linked Pages, AI Activity)
