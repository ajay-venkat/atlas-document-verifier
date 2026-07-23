import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

/**
 * Call Gemini with a system prompt and user message, expecting structured JSON back.
 * Retries once on JSON parse failure.
 */
export async function callGemini<T>(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096
): Promise<T> {
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash",
    contents: userMessage,
    config: {
      systemInstruction: systemPrompt,
      maxOutputTokens: maxTokens,
      responseMimeType: "application/json",
    },
  });

  const raw = response.text || "";

  // Extract JSON from the response (handles ```json ... ``` wrapping if any)
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  const jsonStr = jsonMatch ? jsonMatch[1].trim() : raw.trim();

  try {
    return JSON.parse(jsonStr) as T;
  } catch {
    // Retry once
    const retryResponse = await ai.models.generateContent({
      model: "gemini-2.5-flash",
      contents: `Fix this JSON:\n${raw}`,
      config: {
        systemInstruction: "You previously returned invalid JSON. Fix it and return ONLY valid JSON, no markdown fences.",
        maxOutputTokens: maxTokens,
        responseMimeType: "application/json",
      },
    });

    const retryBlock = retryResponse.text || "";
    return JSON.parse(retryBlock.trim()) as T;
  }
}

/**
 * Generate an embedding for a text string.
 * Uses text-embedding-004.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    // Basic text cleanup
    const sanitizedText = text.replace(/\n/g, " ").trim();
    
    // In a real app we'd batch these, but for the hackathon MVP we process one chunk at a time.
    const response = await ai.models.embedContent({
      model: "text-embedding-004",
      contents: sanitizedText,
    });
    
    // pgvector supports different dimensions, but 768 is default for gemini embeddings
    return response.embeddings?.[0]?.values || generateDevFallbackEmbedding(sanitizedText);
  } catch (error) {
    console.warn("Embedding API failed, falling back to local hash embeddings", error);
    return generateDevFallbackEmbedding(text);
  }
}

/**
 * Super naive fallback embedding generator for local dev without an API key.
 * Generates a deterministic 768-dimensional vector based on simple character hashes.
 */
function generateDevFallbackEmbedding(text: string): number[] {
  const dim = 768;
  const vec = new Array(dim).fill(0);
  
  // Use character codes to seed the vector
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    // Add to multiple dimensions to create some "semantic" spread
    vec[i % dim] += code / 255;
    vec[(i * 3) % dim] += code / 128;
    vec[(i * 7) % dim] -= code / 255;
  }
  
  // Normalize
  const magnitude = Math.sqrt(vec.reduce((sum, val) => sum + val * val, 0)) || 1;
  return vec.map((v) => v / magnitude);
}
