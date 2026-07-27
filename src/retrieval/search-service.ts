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
  SymbolTraceResponse,
} from "./types.js";

const DEFAULT_LIMIT = 8;
const MAX_LIMIT = 20;
const MAX_QUERY_LENGTH = 500;
const MAX_RELATED_CONCEPTS = 3;
const MAX_SNIPPET_LENGTH = 320;
const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,99}$/u;
const SURFACE_CATEGORY_ORDER: ChangeSurfaceCategory[] = [
  "consumer",
  "tests",
  "exports",
  "publish_generated",
  "initialization",
  "implementation",
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

  async keywordSearch(
    query: string,
    scope: SearchScope = "all",
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const { chunks } = await this.corpus();
    return response(
      "field-weighted-keyword",
      query,
      rankKeyword(scopedChunks(chunks, scope), validateQuery(query)),
      validateLimit(limit),
    );
  }

  async bm25Search(
    query: string,
    scope: SearchScope = "all",
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const { chunks } = await this.corpus();
    return response(
      "bm25",
      query,
      rankBm25(scopedChunks(chunks, scope), validateQuery(query)),
      validateLimit(limit),
    );
  }

  async semanticSearch(
    query: string,
    scope: SearchScope = "all",
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const { chunks } = await this.corpus();
    const ranked = await this.semantic.rank(
      chunks,
      validateQuery(query),
      validateScope(scope),
    );
    return response(ranked.engine, query, ranked.hits, validateLimit(limit));
  }

  async okfGraphSearch(
    query: string,
    limit = DEFAULT_LIMIT,
    hops = 1,
  ): Promise<SearchResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validHops =
      Number.isInteger(hops) && hops >= 0 && hops <= 2 ? hops : 1;
    const hits = rankOkfGraph(corpus, validQuery, validHops);
    return response("okf-graph", validQuery, hits, validateLimit(limit));
  }

  async hybridSearch(
    query: string,
    scope: SearchScope = "all",
    limit = DEFAULT_LIMIT,
  ): Promise<SearchResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validScope = validateScope(scope);
    const chunks = scopedChunks(corpus.chunks, validScope);
    const semantic = await this.semantic.rank(
      corpus.chunks,
      validQuery,
      validScope,
    );
    const lists = [
      { hits: rankKeyword(chunks, validQuery), name: "keyword", weight: 0.55 },
      { hits: rankBm25(chunks, validQuery), name: "bm25", weight: 1 },
      { hits: semantic.hits, name: "semantic", weight: 0.9 },
    ];
    if (validScope !== "source") {
      lists.push({
        hits: rankOkfGraph(corpus, validQuery, 1),
        name: "okf_graph",
        weight: 0.8,
      });
    }
    return response(
      `hybrid-rrf:${semantic.engine}`,
      validQuery,
      reciprocalRankFusion(lists),
      validateLimit(limit),
    );
  }

  async testSearch(query: string, limit = 5): Promise<SearchResponse> {
    const validQuery = validateQuery(query);
    const validLimit = validateLimit(limit);
    const testChunks = (await this.corpus()).chunks.filter(
      (chunk) => chunk.scope === "source" && isTestChunk(chunk),
    );
    const semantic = await this.semantic.rank(testChunks, validQuery, "source");
    return response(
      `test-hybrid-rrf:${semantic.engine}`,
      validQuery,
      reciprocalRankFusion([
        {
          hits: rankKeyword(testChunks, validQuery),
          name: "keyword",
          weight: 0.6,
        },
        { hits: rankBm25(testChunks, validQuery), name: "bm25", weight: 1 },
        { hits: semantic.hits, name: "semantic", weight: 0.9 },
      ]),
      validLimit,
    );
  }

  async changeSurface(
    query: string,
    limit = 6,
  ): Promise<ChangeSurfaceResponse> {
    const corpus = await this.corpus();
    const validQuery = validateQuery(query);
    const validLimit = validateLimit(limit);
    const concepts = await this.hybridSearch(validQuery, "wiki", validLimit);
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
        hits: rankBm25(scopedChunks(corpus.chunks, "source"), expandedQuery),
        name: "bm25",
        weight: 1,
      },
      {
        hits: boostReferencedPaths(
          rankKeyword(scopedChunks(corpus.chunks, "source"), expandedQuery),
          referencedPaths,
        ),
        name: "wiki_paths",
        weight: 1.1,
      },
    ]).slice(0, 160);
    const groups = emptySurfaceGroups();
    const candidates = emptySurfaceGroups();
    for (const hit of source) {
      for (const category of categorize(hit.chunk)) {
        candidates[category].push(toResultItem(hit));
      }
    }
    fillSurfaceGroups(groups, candidates, validLimit);
    return {
      groups,
      query: validQuery,
      relatedConcepts: concepts.results.slice(0, MAX_RELATED_CONCEPTS),
    };
  }

  async symbolTrace(query: string, limit = 6): Promise<SymbolTraceResponse> {
    const symbol = validateIdentifier(query);
    const validLimit = validateLimit(limit);
    this.corpusPromise = undefined;
    const sourceChunks = scopedChunks((await this.corpus()).chunks, "source");
    const exactIdentifier = new RegExp(
      `(?:^|[^A-Za-z0-9_$])${escapeRegExp(symbol)}(?:$|[^A-Za-z0-9_$])`,
      "u",
    );
    const candidates = emptySurfaceGroups();
    for (const hit of rankKeyword(sourceChunks, symbol)) {
      if (!exactIdentifier.test(hit.chunk.text)) continue;
      for (const category of categorize(hit.chunk)) {
        candidates[category].push(toResultItem(hit));
      }
    }
    const groups = emptySurfaceGroups();
    fillSurfaceGroups(groups, candidates, validLimit);
    return {
      groups,
      missing: SURFACE_CATEGORY_ORDER.filter(
        (category) => groups[category].length === 0,
      ),
      symbol,
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

function categorize(chunk: IndexedChunk): ChangeSurfaceCategory[] {
  const value = `${chunk.path}\n${chunk.text}`;
  const categories = new Set<ChangeSurfaceCategory>();
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
    /(?:^|\/)(?:test|tests|spec|specs)(?:\/|\.)/iu.test(chunk.path) ||
    /\b(?:describe|it|test)\s*\(/u.test(chunk.text)
  );
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

function emptySurfaceGroups(): Record<
  ChangeSurfaceCategory,
  SearchResultItem[]
> {
  return {
    consumer: [],
    exports: [],
    implementation: [],
    initialization: [],
    publish_generated: [],
    tests: [],
  };
}

function fillSurfaceGroups(
  groups: Record<ChangeSurfaceCategory, SearchResultItem[]>,
  candidates: Record<ChangeSurfaceCategory, SearchResultItem[]>,
  totalLimit: number,
): void {
  let remaining = totalLimit;
  let index = 0;
  while (remaining > 0) {
    let added = false;
    for (const category of SURFACE_CATEGORY_ORDER) {
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
  engine: string,
  query: string,
  hits: RankedHit[],
  limit: number,
): SearchResponse {
  return {
    engine,
    query,
    results: hits.slice(0, limit).map(toResultItem),
  };
}

function toResultItem(hit: RankedHit): SearchResultItem {
  return {
    ...(hit.chunk.heading ? { heading: hit.chunk.heading } : {}),
    lineEnd: hit.chunk.lineEnd,
    lineStart: hit.chunk.lineStart,
    path: hit.chunk.path,
    score: Number(hit.score.toFixed(6)),
    ...(hit.signals ? { signals: hit.signals } : {}),
    snippet: compactSnippet(hit.chunk.text),
    ...(hit.chunk.tags.length > 0 ? { tags: hit.chunk.tags } : {}),
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
  return valid === "all"
    ? chunks
    : chunks.filter((chunk) => chunk.scope === valid);
}

function validateScope(scope: SearchScope): SearchScope {
  if (scope !== "all" && scope !== "source" && scope !== "wiki") {
    throw new Error("scope must be all, source, or wiki.");
  }
  return scope;
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

function validateIdentifier(query: string): string {
  const identifier = validateQuery(query);
  if (!IDENTIFIER.test(identifier)) {
    throw new Error("symbol must be a single 1-100 character identifier.");
  }
  return identifier;
}

function validateLimit(limit: number): number {
  if (!Number.isInteger(limit) || limit < 1 || limit > MAX_LIMIT) {
    throw new Error(`limit must be an integer between 1 and ${MAX_LIMIT}.`);
  }
  return limit;
}
