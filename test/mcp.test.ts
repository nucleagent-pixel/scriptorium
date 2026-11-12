import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleMcp, findProduct, semaforo } from "../src/mcp";
import type { Env } from "../src/env";

const KEY = "k".repeat(32);
const env = { SUPABASE_URL: "https://sb.test", SUPABASE_ANON_KEY: "a", SUPABASE_SERVICE_ROLE_KEY: "s", MCP_KEY: KEY } as Env;
type Row = { id: string; col: string; data: Record<string, unknown>; created_at: string };
let rows: Row[] = [];
let n = 0;

beforeEach(() => {
  n = 0;
  rows = [
    { id: "00000000-0000-4000-8000-000000000001", col: "products", data: { name: "Reto Pilates 30", status: "activo", offer: "o1", line: "3", stages: { pdf: true } }, created_at: "2026-11-01T00:00:00Z" },
    { id: "00000000-0000-4000-8000-000000000002", col: "products", data: { name: "Nutre con Laura", status: "activo", countries: [{ code: "CO", roas: 1.5 }] }, created_at: "2026-11-01T00:00:00Z" },
    { id: "00000000-0000-4000-8000-000000000003", col: "tasks", data: { title: "Grabar", status: "Pendiente", who: "Anyelita", product: "00000000-0000-4000-8000-000000000001", comments: [] }, created_at: "2026-11-02T00:00:00Z" },
  ];
  vi.stubGlobal("fetch", async (input: string, init: RequestInit = {}) => {
    const u = new URL(input);
    const p = u.pathname.replace("/rest/v1/", "");
    const method = init.method || "GET";
    if (p === "rpc/rendimiento") return Response.json([{ offer_id: "o1", producto: "Reto", archivado: false, country: "CO", ventas: 5, neto_cop: 200, pauta_cop: 100 }, { offer_id: "o1", producto: "Reto", archivado: false, country: "BO", ventas: 1, neto_cop: 110, pauta_cop: 100 }]);
    if (p === "offers") return Response.json([{ id: "o1", name: "Reto Pilates", archived: false }]);
    if (p === "sc_members") return Response.json([{ name: "Anyelita", role: "equipo" }, { name: "NUCLEA", role: "admin" }]);
    if (p === "sc_items" && method === "GET") {
      const col = u.searchParams.get("col")?.replace("eq.", ""); const id = u.searchParams.get("id")?.replace("eq.", "");
      return Response.json(rows.filter((r) => (!col || r.col === col) && (!id || r.id === id)));
    }
    if (p === "sc_items" && method === "POST") {
      const b = JSON.parse(String(init.body)); const r = { id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, col: b.col, data: b.data, created_at: new Date().toISOString() };
      rows.push(r); return Response.json([r], { status: 201 });
    }
    if (p === "sc_items" && method === "PATCH") {
      const id = u.searchParams.get("id")?.replace("eq.", ""); const r = rows.find((x) => x.id === id)!; r.data = JSON.parse(String(init.body)).data; return new Response(null, { status: 204 });
    }
    return new Response("no", { status: 404 });
  });
});

async function call(name: string, args: Record<string, unknown> = {}, key = KEY) {
  const res = await handleMcp(new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }) }), env, key);
  return { status: res.status, body: (await res.json()) as { result: { isError?: boolean; structuredContent: any; content: { text: string }[] } } };
}

describe("conector MCP", () => {
  it("rechaza una clave equivocada", async () => {
    expect((await call("ver_equipo", {}, "mala")).status).toBe(403);
  });

  it("lista herramientas", async () => {
    const res = await handleMcp(new Request("https://x/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) }), env, KEY);
    const j = (await res.json()) as { result: { tools: { name: string }[] } };
    expect(j.result.tools.map((t) => t.name)).toContain("guardar_entrega");
  });

  it("lista productos con ROAS del Dashboard o a mano", async () => {
    const { body } = await call("listar_productos");
    const [nutre, reto] = body.result.structuredContent.productos;
    expect(reto.roas_3_dias).toMatchObject([{ pais: "CO", roas: 2, semaforo: "verde" }, { pais: "BO", roas: 1.1, semaforo: "rojo · apagar" }]);
    expect(reto.oferta_dashboard).toBe("Reto Pilates");
    expect(nutre.roas_3_dias[0]).toMatchObject({ pais: "CO", semaforo: "ámbar", fuente: "a mano" });
  });

  it("ver_producto trae tareas abiertas", async () => {
    const { body } = await call("ver_producto", { producto: "pilates" });
    expect(body.result.structuredContent.tareas_abiertas).toHaveLength(1);
  });

  it("guarda una entrega en el producto", async () => {
    const { body } = await call("guardar_entrega", { titulo: "Oferta", contenido: "# Oferta", agente: "desarrollador", producto: "Reto", autor: "Anyelita" });
    expect(body.result.structuredContent).toMatchObject({ ok: true, guardada_en: "Reto Pilates 30" });
    const d = rows.find((r) => r.col === "deliverables")!;
    expect(d.data).toMatchObject({ title: "Oferta", product: "00000000-0000-4000-8000-000000000001", who: "Anyelita" });
    const bad = await call("guardar_entrega", { titulo: "x", contenido: "y", agente: "otro" });
    expect(bad.body.result.isError).toBe(true);
  });

  it("crea y actualiza tareas", async () => {
    const c = await call("crear_tarea", { titulo: "Subir PDF", persona: "Nicole", vence: "2026-11-20" });
    const id = c.body.result.structuredContent.id;
    await call("actualizar_tarea", { tarea_id: id, estado: "Hecha", comentario: "Listo", autor: "Nicole" });
    const t = rows.find((r) => r.id === id)!;
    expect(t.data).toMatchObject({ status: "Hecha", title: "Subir PDF" });
    expect((t.data.comments as unknown[]).length).toBe(1);
    expect((await call("crear_tarea", { titulo: "x", vence: "mañana" })).body.result.isError).toBe(true);
  });

  it("registra un hallazgo con calificación, estado, enlaces y notas", async () => {
    const { body } = await call("registrar_hallazgo", { nombre: "Huerto", estado: "analisis", calificacion: 9, anuncios: 33, enlace: "https://www.facebook.com/ads/library/?q=huerto", notas: ["Ver PDF"] });
    expect(body.result.structuredContent.ok).toBe(true);
    const r = rows.find((x) => x.col === "found")!;
    expect(r.data).toMatchObject({ nombre: "Huerto", estado: "analisis", calificacion: 5, anuncios: 33, biblioteca: "https://www.facebook.com/ads/library/?q=huerto" });
    expect((r.data.notas as { t: string }[])[0].t).toBe("Ver PDF");
    expect((await call("registrar_hallazgo", { nombre: "x", enlace: "ftp://x" })).body.result.isError).toBe(true);
  });

  it("pide precisar cuando el nombre es ambiguo", () => {
    const ps = [{ id: "1", data: { name: "Reto A" }, created_at: "" }, { id: "2", data: { name: "Reto B" }, created_at: "" }];
    expect(() => findProduct(ps, "reto")).toThrow(/varios/);
    expect(semaforo(1.43)).toBe("ámbar");
    expect(semaforo(null)).toBe("sin pauta");
  });
});
