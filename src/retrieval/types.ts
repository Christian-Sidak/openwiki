export type SearchScope = "all" | "source_code" | "tests" | "wiki";

export type IndexedScope = "source_code" | "wiki";

export type ChunkKind = "source" | "wiki-section";

export interface IndexedChunk {
  conceptPath?: string;
  fields: string;
  heading?: string;
  id: string;
  kind: ChunkKind;
  lineEnd: number;
  lineStart: number;
  path: string;
  scope: IndexedScope;
  tags: string[];
  testNames?: string[];
  text: string;
  title?: string;
  type?: string;
}

export interface OkfRelationship {
  context: string;
  target: string;
}

export interface OkfConcept {
  description?: string;
  incoming: Set<string>;
  path: string;
  relationships: OkfRelationship[];
  resource?: string;
  tags: string[];
  title: string;
  type: string;
}

export interface RepositoryCorpus {
  chunks: IndexedChunk[];
  concepts: Map<string, OkfConcept>;
}

export interface RankedHit {
  chunk: IndexedChunk;
  score: number;
  signals?: Record<string, number>;
}

export interface SearchResultItem {
  heading?: string;
  lineEnd: number;
  lineStart: number;
  path: string;
  snippet: string;
  tags?: string[];
  testNames?: string[];
  title?: string;
  type?: string;
}

export interface SearchResponse {
  query: string;
  results: SearchResultItem[];
  scope: SearchScope;
}

export type SymbolTraceCategory =
  | "consumer"
  | "exports"
  | "implementation"
  | "initialization"
  | "publish_generated"
  | "tests";

export type ChangeSurfaceCategory =
  | SymbolTraceCategory
  | "state_transitions";

export interface ChangeSurfaceResponse {
  groups: Record<ChangeSurfaceCategory, SearchResultItem[]>;
  query: string;
  relatedConcepts: SearchResultItem[];
}

export interface SymbolTraceResult {
  groups: Record<SymbolTraceCategory, SearchResultItem[]>;
  missing: SymbolTraceCategory[];
  symbol: string;
}

export interface SymbolTraceResponse {
  traces: SymbolTraceResult[];
}
