## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Use `openwiki/` as a just-in-time repository index:

- At task start, read `openwiki/quickstart.md`, then search the wiki for the task's concepts and read only the relevant linked sections.
- Before a repository-wide `rg`, `find`, or exploratory directory scan, check the wiki's source maps. When they name relevant files, symbols, or tests, inspect those paths directly.
- Re-consult the wiki when entering a different subsystem, when source evidence contradicts the current understanding, or when blocked by an unfamiliar test or build failure. Do not reread content already returned by retrieval unless surrounding context is needed.
- Treat source code and tests as authoritative. Verify wiki claims in source before editing.
- Before finishing a public API or cross-package change, trace it from implementation through barrel/package exports, generated or publish mirrors, initialization or registration, and the import path consumers actually use. Consult the relevant wiki integration or delivery guidance and run the narrowest consumer-facing check; internal unit tests alone do not prove the shipped surface works.
- If an `openwiki_retrieval` MCP server is available, use `search` for focused retrieval. Use `change_surface` before public, cross-package, generated-artifact, or runtime-registration edits. After changing public symbols, call `trace_symbols` once with all of them and treat missing groups as verification gaps, not automatic requirements.
- For stateful or lifecycle changes, translate each externally observable acceptance criterion into a focused test checklist. Cover relevant initial state, false-to-true and true-to-false transitions, unchanged updates, missing dependencies, independent tracker instances, reset/reuse and observation windows, deferred or re-entrant net effects, and composition between static and temporal constraints; map every criterion to a passing test before finishing.
- When behavior is unfamiliar, relevant tests are large, or no analogous focused check is known, call `search` with the `tests` scope using that behavior matrix, then inspect the cited tests directly. Skip this search when the exact focused test is already known.
- When the repository generates or copies package artifacts, identify the canonical source and repository-supported synchronization command. Do not hand-edit derived output unless the documented workflow explicitly requires it.
- Do not read operations, release, or integration pages unless the task affects those areas. If a requested feature does not exist yet, use the wiki to locate extension points, then inspect source rather than searching the wiki for the implementation.
- Prefer the narrowest quiet validation command available. Suppress successful build/test noise when possible, but preserve complete failure output.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
