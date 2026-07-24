import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY!,
});

async function withRateLimitRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let attempt = 0;
  while (attempt < maxRetries) {
    try {
      return await fn();
    } catch (error: any) {
      const isRateLimit = error?.status === 429 || error?.message?.includes("429") || error?.message?.includes("Quota exceeded");
      if (isRateLimit && attempt < maxRetries - 1) {
        attempt++;
        // The API often requires a ~30s cooldown when the free tier limit is hit
        const delay = 30000;
        console.warn(`Rate limited (429). Retrying in ${delay/1000}s... (Attempt ${attempt}/${maxRetries})`);
        await new Promise(r => setTimeout(r, delay));
      } else {
        throw error;
      }
    }
  }
  return fn();
}

/**
 * Call OpenRouter with a system prompt and user message, expecting structured JSON back.
 * Retries once on JSON parse failure.
 */
export async function callGemini<T>(
  systemPrompt: string,
  userMessage: string,
  maxTokens: number = 4096
): Promise<T> {
  const fetchOpenRouter = async (sys: string, user: string) => {
    const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: "nvidia/nemotron-3-ultra-550b-a55b:free",
        messages: [
          { role: "system", content: sys },
          { role: "user", content: user }
        ]
      })
    });

    if (!res.ok) {
      const errorText = await res.text();
      throw { status: res.status, message: errorText };
    }

    const data = await res.json();
    return data.choices?.[0]?.message?.content || "";
  };

  const raw = await withRateLimitRetry(() => fetchOpenRouter(systemPrompt, userMessage));

  function extractJson(text: string): string {
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/);
    if (jsonMatch) return jsonMatch[1].trim();
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1 && end > start) {
      return text.substring(start, end + 1);
    }
    return text.trim();
  }

  let jsonStr = extractJson(raw);

  try {
    const parsed = JSON.parse(jsonStr) as any;
    // Handle potential wrapped output e.g. {"output": {...}}
    if (parsed && !parsed.sub_questions && !parsed.verdict && !parsed.overall_risk_score) {
      if (parsed.output) return parsed.output as T;
      if (parsed.result) return parsed.result as T;
      if (parsed.response) return parsed.response as T;
      // Also attempt case-insensitive key search for verdict just in case
      const keys = Object.keys(parsed);
      for (const k of keys) {
         if (k.toLowerCase() === 'verdict') parsed.verdict = parsed[k];
      }
    }
    return parsed as T;
  } catch {
    // Retry once
    const retryRaw = await withRateLimitRetry(() => fetchOpenRouter(
      "You previously returned invalid JSON. Fix it and return ONLY valid JSON, no markdown fences, no conversational text.",
      `Fix this JSON:\n${raw}`
    ));

    const retryJson = extractJson(retryRaw);
    const parsed = JSON.parse(retryJson) as any;
    if (parsed && !parsed.sub_questions && !parsed.verdict && !parsed.overall_risk_score) {
      if (parsed.output) return parsed.output as T;
      if (parsed.result) return parsed.result as T;
      if (parsed.response) return parsed.response as T;
      const keys = Object.keys(parsed);
      for (const k of keys) {
         if (k.toLowerCase() === 'verdict') parsed.verdict = parsed[k];
      }
    }
    return parsed as T;
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
