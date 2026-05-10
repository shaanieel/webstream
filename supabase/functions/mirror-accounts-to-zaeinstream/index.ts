// supabase/functions/mirror-accounts-to-zaeinstream/index.ts
//
// One-way mirror Edge Function — DEPLOYED TO PROJECT 1 (Zaeinstore).
//
// Architecture:
//   Project 1 (Zaeinstore)  →  Project 2 (Zaeinstream)
//   public.accounts         →  public.users_profile
//
// Triggered by a Supabase Database Webhook on Project 1's
// `public.accounts` table for INSERT / UPDATE / DELETE events.
// The webhook POSTs a payload here; this function uses Project 2's
// service-role key to upsert / soft-delete the corresponding row in
// `public.users_profile`.
//
// Mapping (explicit, no raw payload forwarding):
//   accounts.id    → users_profile.user_id  (uuid)
//   accounts.email → users_profile.email
//
// `accounts.password` is never read or forwarded — passwords live in
// Supabase Auth (`auth.users`), not in `accounts`.
//
// Required Edge Function secrets (set in Project 1 only):
//   PROJECT_2_SUPABASE_URL       e.g. https://gmjudsbreuyyznxtfjve.supabase.co
//   PROJECT_2_SERVICE_ROLE_KEY   service_role key from Project 2 → Settings → API
//   MIRROR_WEBHOOK_SECRET        any random string; same string is set in the
//                                webhook's Authorization: Bearer <…> header.
//
// Deploy:
//   supabase functions deploy mirror-accounts-to-zaeinstream
//   supabase secrets set PROJECT_2_SUPABASE_URL=...
//   supabase secrets set PROJECT_2_SERVICE_ROLE_KEY=...
//   supabase secrets set MIRROR_WEBHOOK_SECRET=...

// deno-lint-ignore-file no-explicit-any
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.45.4";

type WebhookPayload = {
  type: "INSERT" | "UPDATE" | "DELETE";
  table: string;
  schema: string;
  record: Record<string, any> | null;
  old_record: Record<string, any> | null;
};

const PROJECT_2_URL = Deno.env.get("PROJECT_2_SUPABASE_URL") ?? "";
const PROJECT_2_KEY = Deno.env.get("PROJECT_2_SERVICE_ROLE_KEY") ?? "";
const WEBHOOK_SECRET = Deno.env.get("MIRROR_WEBHOOK_SECRET") ?? "";

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

function checkAuth(req: Request): string | null {
  if (!WEBHOOK_SECRET) return "MIRROR_WEBHOOK_SECRET not configured on function";
  const auth = req.headers.get("Authorization") ?? "";
  if (!auth.startsWith("Bearer ")) return "Missing Bearer token";
  const got = auth.slice("Bearer ".length).trim();
  if (got !== WEBHOOK_SECRET) return "Invalid bearer token";
  return null;
}

function p2Client() {
  if (!PROJECT_2_URL || !PROJECT_2_KEY) {
    throw new Error("PROJECT_2_SUPABASE_URL or PROJECT_2_SERVICE_ROLE_KEY not configured");
  }
  return createClient(PROJECT_2_URL, PROJECT_2_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function handleInsertOrUpdate(rec: Record<string, any> | null) {
  if (!rec || !rec.id) return { ok: false, error: "missing record.id" };
  const row = {
    user_id: rec.id,
    email: rec.email ?? null,
    // best-effort copy of optional columns if they exist on accounts.
    expired_at: rec.expired_at ?? null,
    status: "active",
    updated_at: new Date().toISOString(),
  };
  // Drop fields that are null/undefined so we don't overwrite good data with NULL.
  const cleanedEntries = Object.entries(row).filter(([, v]) => v !== null && v !== undefined);
  const cleaned = Object.fromEntries(cleanedEntries) as Record<string, unknown>;
  // user_id must always be present so onConflict has something to match on.
  cleaned.user_id = rec.id;

  const sb = p2Client();
  const { error, data } = await sb
    .from("users_profile")
    .upsert(cleaned, { onConflict: "user_id" })
    .select("id, user_id, email, status")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

async function handleDelete(oldRec: Record<string, any> | null) {
  if (!oldRec || !oldRec.id) return { ok: false, error: "missing old_record.id" };
  // Soft-delete: flip status to 'inactive' so historical billing / VIP grants
  // remain auditable. If the `status` column is not present in users_profile,
  // this update will fail; the deployment guide includes a migration that
  // adds the column.
  const sb = p2Client();
  const { error, data } = await sb
    .from("users_profile")
    .update({ status: "inactive", updated_at: new Date().toISOString() })
    .eq("user_id", oldRec.id)
    .select("id, user_id, email, status")
    .single();
  if (error) return { ok: false, error: error.message };
  return { ok: true, row: data };
}

serve(async (req) => {
  if (req.method !== "POST") return json(405, { ok: false, error: "Method not allowed" });
  const authErr = checkAuth(req);
  if (authErr) return json(401, { ok: false, error: authErr });

  let payload: WebhookPayload;
  try {
    payload = (await req.json()) as WebhookPayload;
  } catch {
    return json(400, { ok: false, error: "Invalid JSON body" });
  }
  if (!payload || !payload.type || payload.table !== "accounts") {
    return json(400, { ok: false, error: "Unexpected payload (expected accounts table webhook)" });
  }

  try {
    let result: { ok: boolean; error?: string; row?: unknown };
    switch (payload.type) {
      case "INSERT":
      case "UPDATE":
        result = await handleInsertOrUpdate(payload.record);
        break;
      case "DELETE":
        result = await handleDelete(payload.old_record);
        break;
      default:
        return json(400, { ok: false, error: `Unsupported event type: ${payload.type}` });
    }
    if (!result.ok) return json(500, { ok: false, error: result.error });
    return json(200, { ok: true, event: payload.type, row: result.row });
  } catch (e) {
    return json(500, { ok: false, error: e instanceof Error ? e.message : String(e) });
  }
});
