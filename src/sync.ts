import type { Env } from "./env";
import { db, dashTarget } from "./supabase";

interface Offer { id: string; name: string; archived: boolean }
interface Source { offer_id: string; country: string; active: boolean }
interface Item { id: string; data: Record<string, unknown> }
export interface SyncResult { creados: string[]; enlazados: string[]; archivados: string[] }

type Patch = { id: string; data: Record<string, unknown>; kind: "enlazado" | "archivado"; name: string };

/**
 * Cada oferta + país del Dashboard es un producto en Scriptorium (su propia tarjeta, línea y ROAS).
 * - Combinación sin producto: se usa un producto de esa oferta que todavía no tenga país, o uno sin
 *   oferta con el mismo nombre; si no hay, se crea.
 * - Oferta archivada en el Dashboard: sus productos activos pasan a archivado.
 * No toca nombres, etapas ni nada que el equipo haya editado.
 */
export function planSync(offers: Offer[], sources: Source[], products: Item[]) {
  const norm = (s: unknown) => String(s ?? "").trim().toLowerCase();
  const key = (o: unknown, c: unknown) => `${o}|${String(c ?? "").toUpperCase()}`;
  const have = new Set(products.filter((p) => p.data.offer && p.data.country).map((p) => key(p.data.offer, p.data.country)));
  const create: Record<string, unknown>[] = [];
  const patch: Patch[] = [];
  const now = new Date().toISOString();
  for (const o of offers) {
    const countries = [...new Set(sources.filter((s) => s.offer_id === o.id && s.active).map((s) => String(s.country).toUpperCase()))].sort();
    for (const c of countries) {
      if (have.has(key(o.id, c))) continue;
      const legacy = products.find((p) => p.data.offer === o.id && !p.data.country)
        || products.find((p) => !p.data.offer && !p.data.country && norm(p.data.name) === norm(o.name));
      if (legacy) {
        legacy.data.offer = o.id; legacy.data.country = c;
        patch.push({ id: legacy.id, data: { offer: o.id, country: c }, kind: "enlazado", name: `${o.name} ${c}` });
      } else {
        create.push({ name: o.name, country: c, status: o.archived ? "archivado" : "activo", offer: o.id, countries: [], stages: {}, links: {}, from: "dashboard", createdAt: now });
      }
      have.add(key(o.id, c));
    }
    if (o.archived) {
      for (const p of products) {
        if (p.data.offer === o.id && (p.data.status || "activo") === "activo") {
          p.data.status = "archivado";
          patch.push({ id: p.id, data: { status: "archivado" }, kind: "archivado", name: `${o.name} ${p.data.country || ""}`.trim() });
        }
      }
    }
  }
  return { create, patch };
}

export async function syncProducts(env: Env): Promise<SyncResult> {
  const target = dashTarget(env);
  const [offers, sources, products] = await Promise.all([
    db<Offer[]>(env, "offers?select=id,name,archived&order=created_at", {}, target),
    db<Source[]>(env, "sources?select=offer_id,country,active", {}, target),
    db<Item[]>(env, "sc_items?col=eq.products&select=id,data&limit=5000"),
  ]);
  if (!offers.ok || !offers.data || !sources.ok || !sources.data) throw new Error("No se pudieron leer las ofertas del Dashboard");
  if (!products.ok || !products.data) throw new Error("No se pudieron leer los productos de Scriptorium");
  const original = new Map(products.data.map((p) => [p.id, { ...p.data }]));
  const { create, patch } = planSync(offers.data, sources.data, products.data);
  const out: SyncResult = { creados: [], enlazados: [], archivados: [] };
  if (create.length) {
    const r = await db(env, "sc_items", { method: "POST", body: JSON.stringify(create.map((data) => ({ col: "products", data }))) });
    if (!r.ok) throw new Error("No se pudieron crear los productos");
    out.creados = create.map((c) => `${c.name} ${c.country}`);
  }
  // Varios cambios pueden caer sobre el mismo producto: se juntan.
  const merged = new Map<string, Record<string, unknown>>();
  for (const p of patch) merged.set(p.id, { ...(merged.get(p.id) || {}), ...p.data });
  for (const [id, data] of merged) {
    const r = await db(env, `sc_items?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ data: { ...(original.get(id) || {}), ...data } }) });
    if (!r.ok) continue;
    for (const p of patch.filter((x) => x.id === id)) (p.kind === "enlazado" ? out.enlazados : out.archivados).push(p.name);
  }
  return out;
}
