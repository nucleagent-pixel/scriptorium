import type { Env } from "./env";
import { db, dashTarget } from "./supabase";

interface Offer { id: string; name: string; archived: boolean }
interface Item { id: string; data: Record<string, unknown> }
export interface SyncResult { creados: string[]; enlazados: string[]; archivados: string[] }

/**
 * Decide qué cambiar para que cada oferta del Dashboard tenga su producto en Scriptorium.
 * - Oferta sin producto: si hay un producto sin oferta con el mismo nombre, se enlaza; si no, se crea.
 * - Oferta archivada en el Dashboard: su producto activo pasa a archivado.
 * No toca nombres, etapas ni nada que el equipo haya editado.
 */
export function planSync(offers: Offer[], products: Item[]) {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const byOffer = new Map(products.filter((p) => p.data.offer).map((p) => [String(p.data.offer), p]));
  const create: Record<string, unknown>[] = [];
  const patch: { id: string; data: Record<string, unknown>; kind: "enlazado" | "archivado"; name: string }[] = [];
  const now = new Date().toISOString();
  for (const o of offers) {
    const p = byOffer.get(o.id);
    if (p) {
      if (o.archived && (p.data.status || "activo") === "activo") patch.push({ id: p.id, data: { status: "archivado" }, kind: "archivado", name: o.name });
      continue;
    }
    const twin = products.find((x) => !x.data.offer && norm(x.data.name) === norm(o.name));
    if (twin) {
      twin.data.offer = o.id;
      patch.push({ id: twin.id, data: { offer: o.id }, kind: "enlazado", name: o.name });
      continue;
    }
    create.push({ name: o.name, status: o.archived ? "archivado" : "activo", offer: o.id, countries: [], stages: {}, links: {}, from: "dashboard", createdAt: now });
  }
  return { create, patch };
}

export async function syncProducts(env: Env): Promise<SyncResult> {
  const [offers, products] = await Promise.all([
    db<Offer[]>(env, "offers?select=id,name,archived&order=created_at", {}, dashTarget(env)),
    db<Item[]>(env, "sc_items?col=eq.products&select=id,data&limit=5000"),
  ]);
  if (!offers.ok || !offers.data) throw new Error("No se pudieron leer las ofertas del Dashboard");
  if (!products.ok || !products.data) throw new Error("No se pudieron leer los productos de Scriptorium");
  const { create, patch } = planSync(offers.data, products.data);
  const out: SyncResult = { creados: [], enlazados: [], archivados: [] };
  if (create.length) {
    const r = await db(env, "sc_items", { method: "POST", body: JSON.stringify(create.map((data) => ({ col: "products", data }))) });
    if (!r.ok) throw new Error("No se pudieron crear los productos");
    out.creados = create.map((c) => String(c.name));
  }
  for (const p of patch) {
    const cur = products.data.find((x) => x.id === p.id);
    const r = await db(env, `sc_items?id=eq.${p.id}`, { method: "PATCH", body: JSON.stringify({ data: { ...(cur?.data || {}), ...p.data } }) });
    if (r.ok) (p.kind === "enlazado" ? out.enlazados : out.archivados).push(p.name);
  }
  return out;
}
