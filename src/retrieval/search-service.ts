import { buildRepositoryCorpus } from "./repository-index.js";
import {
  rankBm25,
  rankKeyword,
  reciprocalRankFusion,
  tokenize,
} from "./ranking.js";
import { SemanticRanker, type EmbeddingProvider } from "./semantic.js";
import type {
  ChangeSurfaceCategory,
  ChangeSurfaceResponse,
  IndexedChunk,
  OkfConcept,
  RankedHit,
  RepositoryCorpus,
  SearchResponse,
  SearchResultItem,
  SearchScope,
  SymbolTraceCategory,
  SymbolTraceResult,
  SymbolTraceResponse,
} from "./types.js";

const DEFAULT_LIMIT = 6;
const MAX_SEARCH_LIMIT = 10;
const MAX_SURFACE_LIMIT = 12;
const MAX_TRACE_LIMIT = 6;
const MAX_SYMBOLS = 12;
const MAX_QUERY_LENGTH = 500;
const MAX_RELATED_CONCEPTS = 2;
const MAX_SNIPPET_LENGTH = 220;
const DOTTED_IDENTIFIER =
  /^[A-Za-z_$][A-Za-z0-9_$]{0,99}(?:\.[A-Za-z_$][A-Za-z0-9_$]{0,99}){0,5}$/u;
const TRACE_CATEGORY_ORDER: SymbolTraceCategory[] = [
  "implementation",
  "exports",
  "publish_generated",
  "initialization",
  "consumer",
  "tests",
];
const CHANGE_SURFACE_CATEGORY_ORDER: ChangeSurfaceCategory[] = [
  "implementation",
  "state_transitions",
  "exports",
  "publish_generated",
  "initialization",
  "consumer",
  "tests",
];

export interface RetrievalServiceOptions {
  embeddingProvider: EmbeddingProvider;
  repoRoot: string;
  wikiRoot: string;
}

export class RetrievalService {
  private corpusPromise: Promise<RepositoryCorpus> | undefined;
  private readonly semantic: SemanticRanker;

  constructor(private readonly options: RetrievalServiceOptions) {
    this.semantic = new SemanticRanker(options.embeddingProvider);
  }

  async search(
    query: string,
    scope: SearchScope = "all",
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validScope = validateScope(scope);
    const chunks = scopedChunks(corpus.chunks, validScope);
    const semantic = await this.semantic.rank(chunks, validQuery);
    const lists = [
      { hits: rankKeyword(chunks, validQuery), name: "keyword", weight: 0.75 },
      { hits: rankBm25(chunks, validQuery), name: "bm25", weight: 1 },
      { hits: semantic.hits, name: "semantic", weight: 0.9 },
    ];
    if (validScope === "all" || validScope === "wiki") {
      lists.push({
        hits: rankOkfGraph(corpus, validQuery, 1),
        name: "okf_graph",
        weight: 0.8,
      });
    }
    const ranked = reciprocalRankFusion(lists);
    return response(
      validQuery,
      validScope === "tests" ? deduplicateTestMirrors(ranked) : ranked,
      normalizeLimit(limit, MAX_SEARCH_LIMIT, DEFAULT_LIMIT),
      validScope,
    );
  }

  async changeSurface(
    query: string,
    limit = 7,
  ): Promise<ChangeSurfaceResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validLimit = normalizeLimit(limit, MAX_SURFACE_LIMIT, 6);
    const concepts = await this.search(validQuery, "wiki", validLimit);
    const conceptChunks = conceptHits(corpus.chunks, concepts.results);
    const referencedPaths = extractPaths(
      conceptChunks.map((chunk) => chunk.text).join("\n"),
    );
    const symbols = extractSymbols(
      `${validQuery}\n${conceptChunks.map((chunk) => chunk.text).join("\n")}`,
    );
    const expandedQuery = [validQuery, ...symbols.slice(0, 24)].join(" ");
    const source = reciprocalRankFusion([
      {
        hits: rankBm25(sourceChunks(corpus.chunks), expandedQuery),
        name: "bm25",
        weight: 1,
      },
      {
        hits: boostReferencedPaths(
          rankKeyword(sourceChunks(corpus.chunks), expandedQuery),
          referencedPaths,
        ),
        name: "wiki_paths",
        weight: 1.1,
      },
    ]).slice(0, 160);
    const groups = emptyChangeSurfaceGroups();
    const candidates = emptyChangeSurfaceGroups();
    for (const hit of source) {
      for (const category of categorize(hit.chunk)) {
        candidates[category].push(toResultItem(hit));
      }
      if (isStateTransitionProducer(hit.chunk)) {
        candidates.state_transitions.push(toResultItem(hit));
      }
    }
    fillGroups(
      groups,
      candidates,
      validLimit,
      CHANGE_SURFACE_CATEGORY_ORDER,
    );
    return {
      groups,
      query: validQuery,
      relatedConcepts: concepts.results.slice(0, MAX_RELATED_CONCEPTS),
    };
  }

  async traceSymbols(
    symbols: string[],
    limit = 4,
  ): Promise<SymbolTraceResponse> {
    const validSymbols = validateSymbols(symbols);
    const validLimit = normalizeLimit(limit, MAX_TRACE_LIMIT, 4);
    this.corpusPromise = undefined;
    const chunks = sourceChunks((await this.corpus()).chunks);
    return {
      traces: validSymbols.map((symbol) =>
        traceSymbol(chunks, symbol, validLimit),
      ),
    };
  }

  private corpus(): Promise<RepositoryCorpus> {
    this.corpusPromise ??= buildRepositoryCorpus(this.options);
    return this.corpusPromise;
  }
}

function rankOkfGraph(
  corpus: RepositoryCorpus,
  query: string,
  hops: number,
): RankedHit[] {
  const wikiChunks = corpus.chunks.filter((chunk) => chunk.scope === "wiki");
  const seeds = rankBm25(wikiChunks, query).slice(0, 20);
  const scores = new Map<string, number>();
  const seedConcepts = new Set<string>();
  for (const [index, hit] of seeds.entries()) {
    if (!hit.chunk.conceptPath) continue;
    const score = 1 / (index + 1);
    scores.set(
      hit.chunk.conceptPath,
      (scores.get(hit.chunk.conceptPath) ?? 0) + score,
    );
    seedConcepts.add(hit.chunk.conceptPath);
  }
  let frontier = seedConcepts;
  for (let hop = 0; hop < hops; hop += 1) {
    const next = new Set<string>();
    for (const conceptPath of frontier) {
      const concept = corpus.concepts.get(conceptPath);
      if (!concept) continue;
      const base = scores.get(conceptPath) ?? 0;
      for (const neighbor of graphNeighbors(concept, corpus.concepts)) {
        scores.set(neighbor, (scores.get(neighbor) ?? 0) + base * 0.35);
        next.add(neighbor);
      }
    }
    frontier = next;
  }
  return [...scores.entries()]
    .map(([conceptPath, score]) => {
      const chunk = bestConceptChunk(wikiChunks, conceptPath, query);
      return chunk ? { chunk, score } : null;
    })
    .filter((hit): hit is RankedHit => hit !== null)
    .sort((left, right) => right.score - left.score);
}

function graphNeighbors(
  concept: OkfConcept,
  concepts: Map<string, OkfConcept>,
): Set<string> {
  const neighbors = new Set([
    ...concept.relationships.map((relationship) => relationship.target),
    ...concept.incoming,
  ]);
  if (concept.tags.length > 0) {
    for (const candidate of concepts.values()) {
      if (
        candidate.path !== concept.path &&
        candidate.tags.some((tag) => concept.tags.includes(tag))
      ) {
        neighbors.add(candidate.path);
      }
    }
  }
  return neighbors;
}

function bestConceptChunk(
  chunks: IndexedChunk[],
  conceptPath: string,
  query: string,
): IndexedChunk | undefined {
  return (
    rankBm25(
      chunks.filter((chunk) => chunk.conceptPath === conceptPath),
      query,
    )[0]?.chunk ?? chunks.find((chunk) => chunk.conceptPath === conceptPath)
  );
}

function conceptHits(
  chunks: IndexedChunk[],
  results: SearchResultItem[],
): IndexedChunk[] {
  const keys = new Set(results.map((item) => `${item.path}:${item.lineStart}`));
  return chunks.filter((chunk) => keys.has(`${chunk.path}:${chunk.lineStart}`));
}

function boostReferencedPaths(
  hits: RankedHit[],
  paths: Set<string>,
): RankedHit[] {
  return hits
    .map((hit) => ({
      ...hit,
      score:
        hit.score *
        ([...paths].some(
          (candidate) =>
            hit.chunk.path === candidate || hit.chunk.path.endsWith(candidate),
        )
          ? 2.5
          : 1),
    }))
    .sort((left, right) => right.score - left.score);
}

function categorize(chunk: IndexedChunk): SymbolTraceCategory[] {
  const value = `${chunk.path}\n${chunk.text}`;
  const categories = new Set<SymbolTraceCategory>();
  if (
    /\b(?:exports|entrypoint|public api)\b/iu.test(value) ||
    /\bexport\s+(?:\*|\{[^}]+\})\s+from\b/iu.test(chunk.text) ||
    /(?:^|\/)index\.[cm]?[jt]sx?$/u.test(chunk.path)
  ) {
    categories.add("exports");
  }
  if (
    /\b(?:publish|generated|bundle|build artifact|package\.json|dist)\b/iu.test(
      value,
    )
  ) {
    categories.add("publish_generated");
  }
  if (
    /\b(?:initialize|register|registry|factory|createStore|createWorld|setup)\b/u.test(
      value,
    )
  ) {
    categories.add("initialization");
  }
  if (isTestChunk(chunk)) {
    categories.add("tests");
  }
  if (
    /\bimport\s+.+\s+from\s+['"][^./]/u.test(chunk.text) ||
    /(?:^|\/)(?:examples?|apps?|publish\/tests)(?:\/|$)/iu.test(chunk.path)
  ) {
    categories.add("consumer");
  }
  if (categories.size === 0 || /(?:^|\/)src(?:\/|$)/u.test(chunk.path)) {
    categories.add("implementation");
  }
  return [...categories];
}

function isTestChunk(chunk: IndexedChunk): boolean {
  return (
    /(?:^|\/)(?:test|tests|spec|specs)(?:\/|$)/iu.test(chunk.path) ||
    /(?:^|[._-])(?:test|tests|spec|specs)(?:[._-]|$)/iu.test(chunk.path)
  );
}

function isStateTransitionProducer(chunk: IndexedChunk): boolean {
  if (
    isTestChunk(chunk) ||
    /(?:^|\/)query\/(?:modifier|modifiers)(?:\/|$)/u.test(chunk.path)
  ) {
    return false;
  }
  const producerPath =
    /(?:^|\/)(?:actions?|entity|mutation|relation|store|trait|world)(?:\/|[._-])/u.test(
      chunk.path,
    );
  const transitionText =
    /\b(?:add|change|defer|destroy|emit|flush|remove|replace|reset|trigger|update)(?:d|s|ing)?\b/iu.test(
      chunk.text,
    );
  return producerPath && transitionText;
}

function traceSymbol(
  chunks: IndexedChunk[],
  symbol: string,
  limit: number,
): SymbolTraceResult {
  const leaf = symbol.split(".").at(-1) ?? symbol;
  const fullPattern = symbol.split(".").map(escapeRegExp).join("\\s*\\.\\s*");
  const exactSymbol = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${fullPattern}(?:$|[^A-Za-z0-9_$])`,
    "u",
  );
  const exactLeaf = new RegExp(
    `(?:^|[^A-Za-z0-9_$])${escapeRegExp(leaf)}(?:$|[^A-Za-z0-9_$])`,
    "u",
  );
  const candidates = emptyTraceGroups();
  for (const hit of rankKeyword(chunks, `${symbol} ${leaf}`)) {
    if (!exactSymbol.test(hit.chunk.text) && !exactLeaf.test(hit.chunk.text)) {
      continue;
    }
    for (const category of categorize(hit.chunk)) {
        candidates[category].push(toResultItem(hit));
    }
  }
  const groups = emptyTraceGroups();
  fillGroups(groups, candidates, limit, TRACE_CATEGORY_ORDER);
  return {
    groups,
    missing: TRACE_CATEGORY_ORDER.filter(
      (category) => candidates[category].length === 0,
    ),
    symbol,
  };
}

function deduplicateTestMirrors(hits: RankedHit[]): RankedHit[] {
  const deduplicated = new Map<string, RankedHit>();
  for (const hit of hits) {
    const key = canonicalTestKey(hit.chunk);
    const current = deduplicated.get(key);
    if (
      !current ||
      (isGeneratedTestPath(current.chunk.path) &&
        !isGeneratedTestPath(hit.chunk.path))
    ) {
      deduplicated.set(key, hit);
    }
  }
  return [...deduplicated.values()];
}

function canonicalTestKey(chunk: IndexedChunk): string {
  const normalizedPath = chunk.path
    .replace(
      /(?:^|\/)packages\/publish\/tests\/(?:core\/)?/u,
      "packages/core/tests/",
    )
    .replace(/(?:^|\/)(?:generated|publish)\/tests\//u, "tests/");
  return `${normalizedPath}:${chunk.lineStart}:${(chunk.testNames ?? []).join("|")}`;
}

function isGeneratedTestPath(value: string): boolean {
  return /(?:^|\/)(?:generated|publish)(?:\/|$)/u.test(value);
}

function extractPaths(value: string): Set<string> {
  const paths = value.match(
    /(?:^|[\s`("'])([A-Za-z0-9_.-]+\/(?:[A-Za-z0-9_.-]+\/)*[A-Za-z0-9_.-]+\.[A-Za-z0-9]+)/gmu,
  );
  return new Set(
    (paths ?? []).map((item) => item.trim().replace(/^[`("']/u, "")),
  );
}

function extractSymbols(value: string): string[] {
  const symbols = new Set<string>();
  for (const match of value.matchAll(/`([A-Za-z_$][A-Za-z0-9_$]{2,})`/gu)) {
    if (match[1]) symbols.add(match[1]);
  }
  for (const term of tokenize(value)) {
    if (term.length >= 4) symbols.add(term);
  }
  return [...symbols];
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function emptyChangeSurfaceGroups(): Record<
  ChangeSurfaceCategory,
  SearchResultItem[]
> {
  return {
    consumer: [],
    exports: [],
    implementation: [],
    initialization: [],
    publish_generated: [],
    state_transitions: [],
    tests: [],
  };
}

function emptyTraceGroups(): Record<SymbolTraceCategory, SearchResultItem[]> {
  return {
    consumer: [],
    exports: [],
    implementation: [],
    initialization: [],
    publish_generated: [],
    tests: [],
  };
}

function fillGroups<Category extends string>(
  groups: Record<Category, SearchResultItem[]>,
  candidates: Record<Category, SearchResultItem[]>,
  totalLimit: number,
  categoryOrder: readonly Category[],
): void {
  let remaining = totalLimit;
  let index = 0;
  while (remaining > 0) {
    let added = false;
    for (const category of categoryOrder) {
      const candidate = candidates[category][index];
      if (!candidate || remaining === 0) continue;
      groups[category].push(candidate);
      remaining -= 1;
      added = true;
    }
    if (!added) return;
    index += 1;
  }
}

function response(
  query: string,
  hits: RankedHit[],
  limit: number,
  scope: SearchScope,
): SearchResponse {
  return {
    query,
    results: hits.slice(0, limit).map(toResultItem),
    scope,
  };
}

function toResultItem(hit: RankedHit): SearchResultItem {
  return {
    ...(hit.chunk.heading ? { heading: hit.chunk.heading } : {}),
    lineEnd: hit.chunk.lineEnd,
    lineStart: hit.chunk.lineStart,
    path: hit.chunk.path,
    snippet: compactSnippet(hit.chunk.text),
    ...(hit.chunk.tags.length > 0 ? { tags: hit.chunk.tags } : {}),
    ...(hit.chunk.testNames && hit.chunk.testNames.length > 0
      ? { testNames: hit.chunk.testNames }
      : {}),
    ...(hit.chunk.title ? { title: hit.chunk.title } : {}),
    ...(hit.chunk.type ? { type: hit.chunk.type } : {}),
  };
}

function compactSnippet(value: string): string {
  return value.replace(/\s+/gu, " ").trim().slice(0, MAX_SNIPPET_LENGTH);
}

function scopedChunks(
  chunks: IndexedChunk[],
  scope: SearchScope,
): IndexedChunk[] {
  const valid = validateScope(scope);
  if (valid === "all") return chunks;
  if (valid === "wiki") {
    return chunks.filter((chunk) => chunk.scope === "wiki");
  }
  if (valid === "tests") {
    return sourceChunks(chunks).filter(isTestChunk);
  }
  return sourceChunks(chunks).filter((chunk) => !isTestChunk(chunk));
}

function validateScope(scope: SearchScope): SearchScope {
  if (
    scope !== "all" &&
    scope !== "source_code" &&
    scope !== "tests" &&
    scope !== "wiki"
  ) {
    throw new Error("scope must be all, source_code, tests, or wiki.");
  }
  return scope;
}

function sourceChunks(chunks: IndexedChunk[]): IndexedChunk[] {
  return chunks.filter((chunk) => chunk.scope === "source_code");
}

function validateQuery(query: string): string {
  if (
    typeof query !== "string" ||
    !query.trim() ||
    query.length > MAX_QUERY_LENGTH
  ) {
    throw new Error(`query must be 1-${MAX_QUERY_LENGTH} characters.`);
  }
  return query.trim();
}

function validateSymbols(symbols: string[]): string[] {
  if (!Array.isArray(symbols) || symbols.length === 0) {
    throw new Error("symbols must contain at least one identifier.");
  }
  const unique = [...new Set(symbols.map((symbol) => symbol.trim()))];
  if (unique.length > MAX_SYMBOLS) {
    throw new Error(`symbols must contain at most ${MAX_SYMBOLS} identifiers.`);
  }
  for (const symbol of unique) {
    if (symbol.length > 200 || !DOTTED_IDENTIFIER.test(symbol)) {
      throw new Error(
        "each symbol must be a plain or dotted identifier up to 200 characters.",
      );
    }
  }
  return unique;
}

function normalizeLimit(
  limit: number,
  maximum: number,
  fallback: number,
): number {
  if (!Number.isInteger(limit)) return fallback;
  return Math.max(1, Math.min(maximum, limit));
}
