// app/api/_supabase.ts
import { createClient } from "@supabase/supabase-js";

const supabaseUrl = process.env.SUPABASE_URL!;
const serviceRoleKey = process.env.SUPABASE_KEY!;

if (!supabaseUrl || !serviceRoleKey) {
throw new Error("Missing SUPABASE_URL or SUPABASE_KEY");
}

export const supabaseAdmin = createClient(supabaseUrl, serviceRoleKey, {
  auth: { persistSession: false },
});
