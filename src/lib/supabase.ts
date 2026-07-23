import { createClient } from "@supabase/supabase-js";

// Provide fallback values for build time if env vars are placeholders
const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL && process.env.NEXT_PUBLIC_SUPABASE_URL !== "your_supabase_url_here" 
  ? process.env.NEXT_PUBLIC_SUPABASE_URL 
  : "https://placeholder.supabase.co";
  
const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY !== "your_supabase_service_role_key_here"
  ? process.env.SUPABASE_SERVICE_ROLE_KEY
  : "placeholder_key";

const supabaseAnonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY && process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY !== "your_supabase_anon_key_here"
  ? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY
  : "placeholder_key";

// Server-side client with service role key (full access)
export const supabase = createClient(supabaseUrl, supabaseServiceKey);

// Client-side safe client (uses anon key, respects RLS)
export function createBrowserClient() {
  return createClient(supabaseUrl, supabaseAnonKey);
}
