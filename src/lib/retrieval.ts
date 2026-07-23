// ============================================================
// Hybrid Retrieval Pipeline
// Dense (pgvector) + Lexical (tsvector) + Graph (entity_edges)
// Merged via Reciprocal Rank Fusion
// ============================================================

import { supabase } from "./supabase";
import { generateEmbedding } from "./ai";
import type { RetrievedChunk, EntityEdge } from "./types";

const DEFAULT_TOP_K = 10;
const RRF_K = 60; // Standard RRF constant

/**
 * Reciprocal Rank Fusion: merges two ranked lists into one.
 * score(doc) = sum over lists of 1 / (k + rank(doc))
 */
function reciprocalRankFusion(
  denseResults: Array<{ id: string; score: number; [key: string]: unknown }>,
  lexicalResults: Array<{ id: string; score: number; [key: string]: unknown }>
): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();

  denseResults.forEach((item, rank) => {
    const existing = scores.get(item.id) || 0;
    scores.set(item.id, existing + 1 / (RRF_K + rank + 1));
  });

  lexicalResults.forEach((item, rank) => {
    const existing = scores.get(item.id) || 0;
    scores.set(item.id, existing + 1 / (RRF_K + rank + 1));
  });

  return Array.from(scores.entries())
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Dense vector search via pgvector cosine similarity.
 */
async function denseSearch(
  queryEmbedding: number[],
  topK: number
): Promise<Array<{ id: string; document_id: string; content: string; score: number; document_title: string }>> {
  // Use Supabase RPC to call a pgvector similarity function
  const { data, error } = await supabase.rpc("match_chunks", {
    query_embedding: JSON.stringify(queryEmbedding),
    match_count: topK,
  });

  if (error) {
    console.error("Dense search error:", error);
    // Fallback: try direct query if RPC not available
    return [];
  }

  return (data || []).map((row: { id: string; document_id: string; content: string; similarity: number; document_title: string }) => ({
    id: row.id,
    document_id: row.document_id,
    content: row.content,
    score: row.similarity,
    document_title: row.document_title || "Unknown",
  }));
}

/**
 * Lexical search using Postgres full-text search (tsvector/ts_rank).
 */
async function lexicalSearch(
  query: string,
  topK: number
): Promise<Array<{ id: string; document_id: string; content: string; score: number; document_title: string }>> {
  // Convert query to tsquery format
  const tsQuery = query
    .split(/\s+/)
    .filter((w) => w.length > 2)
    .join(" & ");

  if (!tsQuery) return [];

  const { data, error } = await supabase.rpc("search_chunks_lexical", {
    search_query: tsQuery,
    match_count: topK,
  });

  if (error) {
    console.error("Lexical search error:", error);
    return [];
  }

  return (data || []).map((row: { id: string; document_id: string; content: string; rank: number; document_title: string }) => ({
    id: row.id,
    document_id: row.document_id,
    content: row.content,
    score: row.rank,
    document_title: row.document_title || "Unknown",
  }));
}

/**
 * Graph expansion: given a set of chunk IDs, find entity_edges
 * connected to those chunks and pull in chunks from connected documents.
 */
async function graphExpand(
  topChunkDocIds: string[],
  existingChunkIds: Set<string>,
  maxExpansionChunks: number = 5
): Promise<{ chunks: RetrievedChunk[]; edges: EntityEdge[] }> {
  if (topChunkDocIds.length === 0) return { chunks: [], edges: [] };

  // 1. Get entity edges from the source documents
  const { data: edges, error: edgeError } = await supabase
    .from("entity_edges")
    .select("*")
    .in("source_document_id", topChunkDocIds);

  if (edgeError || !edges) {
    console.error("Graph expansion edge query error:", edgeError);
    return { chunks: [], edges: [] };
  }

  // 2. Find subjects/objects that appear in edges from OTHER documents
  const entityTerms = new Set<string>();
  edges.forEach((e: EntityEdge) => {
    entityTerms.add(e.subject);
    entityTerms.add(e.object);
  });

  // 3. Find entity_edges from OTHER documents that share these entities
  const connectedEdges: EntityEdge[] = [];
  const connectedDocIds = new Set<string>();

  if (entityTerms.size > 0) {
    const terms = Array.from(entityTerms).slice(0, 20); // Limit to prevent huge queries

    const { data: relatedEdges } = await supabase
      .from("entity_edges")
      .select("*")
      .or(`subject.in.(${terms.map((t) => `"${t}"`).join(",")}),object.in.(${terms.map((t) => `"${t}"`).join(",")})`)
      .limit(50);

    if (relatedEdges) {
      for (const re of relatedEdges) {
        if (!topChunkDocIds.includes(re.source_document_id)) {
          connectedEdges.push(re);
          connectedDocIds.add(re.source_document_id);
        }
      }
    }
  }

  // 4. Pull chunks from connected documents
  const expandedChunks: RetrievedChunk[] = [];
  if (connectedDocIds.size > 0) {
    const { data: relatedChunks } = await supabase
      .from("chunks")
      .select("id, document_id, content, documents(title)")
      .in("document_id", Array.from(connectedDocIds))
      .order("chunk_index", { ascending: true })
      .limit(maxExpansionChunks);

    if (relatedChunks) {
      for (const rc of relatedChunks as unknown as Array<{
        id: string;
        document_id: string;
        content: string;
        documents: { title: string } | { title: string }[] | null;
      }>) {
        if (!existingChunkIds.has(rc.id)) {
          expandedChunks.push({
            chunk_id: rc.id,
            document_id: rc.document_id,
            document_title: (Array.isArray(rc.documents) ? rc.documents[0]?.title : rc.documents?.title) || "Unknown",
            content: rc.content,
            score: 0.1, // Low base score for graph-expanded results
            source: "graph",
          });
        }
      }
    }
  }

  return { chunks: expandedChunks, edges: [...edges, ...connectedEdges] };
}

/**
 * Main hybrid retrieval function.
 * Combines dense + lexical + graph expansion with reciprocal rank fusion.
 */
export async function retrieve(
  query: string,
  options: { topK?: number } = {}
): Promise<{ chunks: RetrievedChunk[]; edges: EntityEdge[] }> {
  const topK = options.topK || DEFAULT_TOP_K;

  // 1. Generate query embedding
  const queryEmbedding = await generateEmbedding(query);

  // 2. Run dense and lexical search in parallel
  const [denseResults, lexicalResults] = await Promise.all([
    denseSearch(queryEmbedding, topK * 2),
    lexicalSearch(query, topK * 2),
  ]);

  // 3. Merge with Reciprocal Rank Fusion
  const fused = reciprocalRankFusion(
    denseResults.map((r) => ({ ...r, id: r.id })),
    lexicalResults.map((r) => ({ ...r, id: r.id }))
  );

  // 4. Build the merged chunk list
  const allResults = new Map<
    string,
    { id: string; document_id: string; content: string; document_title: string }
  >();
  for (const r of [...denseResults, ...lexicalResults]) {
    allResults.set(r.id, r);
  }

  const mergedChunks: RetrievedChunk[] = fused.slice(0, topK).map((f) => {
    const original = allResults.get(f.id);
    return {
      chunk_id: f.id,
      document_id: original?.document_id || "",
      document_title: original?.document_title || "Unknown",
      content: original?.content || "",
      score: f.score,
      source: denseResults.some((d) => d.id === f.id) ? "dense" as const : "lexical" as const,
    };
  });

  // 5. Graph expansion from top results
  const topDocIds = [...new Set(mergedChunks.slice(0, 5).map((c) => c.document_id))];
  const existingIds = new Set(mergedChunks.map((c) => c.chunk_id));
  const { chunks: graphChunks, edges } = await graphExpand(
    topDocIds,
    existingIds
  );

  // 6. Combine and deduplicate
  const finalChunks = [...mergedChunks, ...graphChunks];

  return { chunks: finalChunks, edges };
}
