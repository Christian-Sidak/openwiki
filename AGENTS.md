## OpenWiki

This repository has documentation located in the /openwiki directory.

Start here:

- [OpenWiki quickstart](openwiki/quickstart.md)

OpenWiki includes repository overview, architecture notes, workflows, domain concepts, operations, integrations, testing guidance, and source maps.

When working in this repository, read the OpenWiki quickstart first, then follow its links to the relevant architecture, workflow, domain, operation, and testing notes.

<!-- OPENWIKI:START -->

## OpenWiki

This repository uses OpenWiki for recurring code documentation. Use `openwiki/` as a just-in-time repository index:

- At task start, read `openwiki/quickstart.md`, then search the wiki for the task's concepts and read only the relevant linked pages.
- Before a repository-wide `rg`, `find`, or exploratory directory scan, check the wiki's source maps. When they name relevant files, symbols, or tests, inspect those paths directly.
- Re-consult the wiki when entering a different subsystem, when source evidence contradicts the current understanding, or when blocked by an unfamiliar test or build failure.
- Treat source code and tests as authoritative. Verify wiki claims in source before editing.
- Before finishing a public API or cross-package change, trace it from implementation through barrel/package exports, generated or publish mirrors, initialization or registration, and the import path consumers actually use. Consult the relevant wiki integration or delivery guidance and run the narrowest consumer-facing check; internal unit tests alone do not prove the shipped surface works.
- If an `openwiki_retrieval` MCP server is available, use `change_surface` before editing and `symbol_trace` after adding or changing each public symbol. Treat missing groups as verification gaps to investigate against repository architecture, not automatic requirements.
- For stateful or lifecycle changes, translate each externally observable acceptance criterion into a focused test checklist. Cover relevant initial state, both transition directions, unchanged updates, missing dependencies, independent instances, reset or reuse, deferred or re-entrant mutation, and composition; map every criterion to a passing test before finishing.
- If the retrieval server provides `test_search`, use it with that behavior matrix to find analogous focused tests, then inspect the cited tests directly before implementing lifecycle semantics.
- When the repository generates or copies package artifacts, identify the canonical source and repository-supported synchronization command. Do not hand-edit derived output unless the documented workflow explicitly requires it.
- Do not read operations, release, or integration pages unless the task affects those areas. If a requested feature does not exist yet, use the wiki to locate extension points, then inspect source rather than searching the wiki for the implementation.
- Do not reread pages already consulted unless new evidence requires it.

The scheduled OpenWiki GitHub Actions workflow refreshes the repository wiki. Do not hand-edit generated OpenWiki pages unless explicitly asked; prefer updating source code/docs and letting OpenWiki regenerate.

<!-- OPENWIKI:END -->
