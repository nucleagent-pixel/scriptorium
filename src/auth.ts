import type { Env } from "./env";
import { db } from "./supabase";

export type Role = "admin" | "equipo" | "pendiente";
export interface Member { user_id: string; email: string | null; name: string; role: Role }

interface AuthUser { id?: string; email?: string; user_metadata?: { full_name?: string; name?: string } }

async function authUser(req: Request, env: Env): Promise<AuthUser | null> {
  const token = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) return null;
  const res = await fetch(`${env.SUPABASE_URL.replace(/\/+$/, "")}/auth/v1/user`, {
    headers: { apikey: env.SUPABASE_ANON_KEY, Authorization: `Bearer ${token}` },
  });
  if (!res.ok) return null;
  const u = (await res.json()) as AuthUser;
  return u.id ? u : null;
}

export function displayName(u: AuthUser): string {
  const n = u.user_metadata?.full_name || u.user_metadata?.name || "";
  if (n.trim()) return n.trim().slice(0, 60);
  return (u.email || "Sin nombre").split("@")[0].slice(0, 60);
}

/**
 * Devuelve la ficha de Scriptorium de quien llama. La primera vez que alguien entra
 * se crea su ficha: la primera persona queda como admin, las demás quedan pendientes
 * hasta que un admin las apruebe.
 */
export async function currentMember(req: Request, env: Env, create = false): Promise<Member | null> {
  const u = await authUser(req, env);
  if (!u?.id) return null;
  const found = await db<Member[]>(env, `sc_members?user_id=eq.${u.id}&select=user_id,email,name,role`);
  if (found.data?.[0]) return found.data[0];
  if (!create) return null;
  const any = await db<{ user_id: string }[]>(env, "sc_members?select=user_id&role=eq.admin&limit=1");
  const role: Role = any.data && any.data.length ? "pendiente" : "admin";
  const row = { user_id: u.id, email: u.email ?? null, name: displayName(u), role };
  const ins = await db<Member[]>(env, "sc_members", {
    method: "POST",
    body: JSON.stringify(row),
    prefer: "return=representation,resolution=ignore-duplicates",
  });
  return ins.data?.[0] ?? row;
}

export function approved(m: Member | null): m is Member {
  return !!m && (m.role === "admin" || m.role === "equipo");
}
