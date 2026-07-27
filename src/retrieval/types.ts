export type SearchScope = "all" | "source" | "wiki";

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
  scope: Exclude<SearchScope, "all">;
  tags: string[];
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
  score: number;
  signals?: Record<string, number>;
  snippet: string;
  tags?: string[];
  title?: string;
  type?: string;
}

export interface SearchResponse {
  engine: string;
  query: string;
  results: SearchResultItem[];
}

export type ChangeSurfaceCategory =
  | "consumer"
  | "exports"
  | "implementation"
  | "initialization"
  | "publish_generated"
  | "tests";

export interface ChangeSurfaceResponse {
  groups: Record<ChangeSurfaceCategory, SearchResultItem[]>;
  query: string;
  relatedConcepts: SearchResultItem[];
}

export interface SymbolTraceResponse {
  groups: Record<ChangeSurfaceCategory, SearchResultItem[]>;
  missing: ChangeSurfaceCategory[];
  symbol: string;
}
