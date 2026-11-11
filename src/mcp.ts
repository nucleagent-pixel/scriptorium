import type { Env } from "./env";
import { db } from "./supabase";
import { loadRoas, type RoasPayload } from "./roas";
import { syncProducts } from "./sync";

// Conector MCP de Scriptorium para Claude (conector personalizado).
// URL: https://<tu-worker>/mcp/<MCP_KEY>  (o /mcp con cabecera Authorization: Bearer <MCP_KEY>)
// Transporte "Streamable HTTP" con respuestas JSON (sin streaming).

const PROTOCOL_VERSION = "2025-06-18";

const AGENTS = ["desarrollador", "creador", "editor", "investigador"] as const;
const TASK_STATES = ["Pendiente", "En curso", "Hecha", "Descartada"] as const;
const STAGES: Record<string, string> = { pdf: "PDF", guiones: "Guiones", videos: "Videos", script: "Script WhatsApp", campanas: "Campañas" };

const productoProp = { type: "string", description: "Id o nombre del producto (basta una parte del nombre)" };

export const TOOLS = [
  {
    name: "listar_productos",
    description: "Lista los productos del equipo con su línea, celular, avatar, etapas listas y el ROAS por país de los últimos 3 días leído del NUCLEA Dashboard, con su semáforo (verde 1.80 o más, ámbar 1.43 a 1.79, rojo 1.42 o menos; bajo 1.25 se apaga).",
    inputSchema: {
      type: "object",
      properties: { estado: { type: "string", enum: ["activo", "apagado", "archivado", "todos"], default: "activo" } },
    },
  },
  {
    name: "ver_producto",
    description: "Ficha completa de un producto: datos, ROAS por país, enlaces (guiones, videos, Drive), tareas abiertas y entregas guardadas de los agentes. Úsalo antes de trabajar en un producto para tener el contexto.",
    inputSchema: { type: "object", properties: { producto: productoProp }, required: ["producto"] },
  },
  {
    name: "guardar_entrega",
    description: "Guarda en Scriptorium lo que entregó un agente (oferta, guiones, script de WhatsApp, copys, contenido del PDF, plan de edición, etc.) para que el equipo lo vea en el producto. Pide confirmación a la persona antes de guardar.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string", description: "Nombre corto de la entrega, por ejemplo 'Guiones ángulo dolor de espalda'" },
        contenido: { type: "string", description: "El texto completo de la entrega, en Markdown" },
        agente: { type: "string", enum: [...AGENTS], description: "Qué agente la hizo" },
        producto: { ...productoProp, description: "Id o nombre del producto (opcional)" },
        enlace: { type: "string", description: "Enlace opcional a un archivo (PDF, .zip de la app, video) en Drive u otro lugar" },
        autor: { type: "string", description: "Nombre de la persona del equipo que pidió la entrega" },
      },
      required: ["titulo", "contenido", "agente"],
    },
  },
  {
    name: "listar_entregas",
    description: "Entregas guardadas, de la más nueva a la más vieja. Devuelve título, agente, producto y fecha; con incluir_contenido trae también el texto.",
    inputSchema: {
      type: "object",
      properties: {
        producto: productoProp,
        agente: { type: "string", enum: [...AGENTS] },
        incluir_contenido: { type: "boolean", default: false },
        limite: { type: "integer", minimum: 1, maximum: 30, default: 10 },
      },
    },
  },
  {
    name: "listar_tareas",
    description: "Tareas del equipo. Por defecto solo las abiertas (Pendiente y En curso).",
    inputSchema: {
      type: "object",
      properties: {
        persona: { type: "string", description: "Nombre del responsable" },
        producto: productoProp,
        estado: { type: "string", enum: [...TASK_STATES, "abiertas", "todas"], default: "abiertas" },
      },
    },
  },
  {
    name: "crear_tarea",
    description: "Crea una tarea en Scriptorium. Pide confirmación a la persona antes de crearla.",
    inputSchema: {
      type: "object",
      properties: {
        titulo: { type: "string" },
        persona: { type: "string", description: "Responsable (nombre de alguien del equipo)" },
        producto: productoProp,
        prioridad: { type: "string", enum: ["Alta", "Media", "Baja"], default: "Media" },
        vence: { type: "string", description: "Fecha límite YYYY-MM-DD" },
        detalle: { type: "string" },
      },
      required: ["titulo"],
    },
  },
  {
    name: "actualizar_tarea",
    description: "Cambia el estado de una tarea y/o le agrega un comentario.",
    inputSchema: {
      type: "object",
      properties: {
        tarea_id: { type: "string" },
        estado: { type: "string", enum: [...TASK_STATES] },
        comentario: { type: "string" },
        autor: { type: "string", description: "Quién comenta" },
      },
      required: ["tarea_id"],
    },
  },
  {
    name: "registrar_hallazgo",
    description: "Registra un anunciante modelable encontrado en la biblioteca de anuncios de Meta (aparece en Productos → Encontrados).",
    inputSchema: {
      type: "object",
      properties: {
        fan_page: { type: "string" },
        tema: { type: "string", description: "De qué trata" },
        anuncios: { type: "integer", description: "Anuncios activos" },
        enlace: { type: "string", description: "Enlace a la biblioteca de anuncios" },
        origen: { type: "string", description: "Quién lo encontró", default: "Investigador" },
      },
      required: ["fan_page"],
    },
  },
  {
    name: "sincronizar_productos",
    description: "Trae las ofertas del NUCLEA Dashboard como productos de Scriptorium: crea un producto por cada país donde se vende la oferta (cada uno con su propio ROAS), enlaza productos con el mismo nombre y archiva los de ofertas archivadas. También corre sola cada hora.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "ver_equipo",
    description: "Nombres de las personas del equipo con acceso a Scriptorium, para asignar tareas.",
    inputSchema: { type: "object", properties: {} },
  },
];

type Json = Record<string, unknown>;
interface Item { id: string; data: Json; created_at: string }
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class ToolError extends Error {}

const str = (v: unknown, max = 200) => (v == null ? "" : String(v)).trim().slice(0, max);

export function semaforo(roas: number | null): string {
  if (roas == null) return "sin pauta";
  if (roas >= 1.8) return "verde";
  if (roas >= 1.43) return "ámbar";
  return roas < 1.25 ? "rojo · apagar" : "rojo";
}

async function items(env: Env, col: string): Promise<Item[]> {
  const r = await db<Item[]>(env, `sc_items?col=eq.${col}&select=id,data,created_at&order=created_at.desc&limit=2000`);
  if (!r.ok || !r.data) throw new ToolError("No se pudieron leer los datos de Scriptorium");
  return r.data;
}

async function insert(env: Env, col: string, data: Json): Promise<string> {
  const r = await db<Item[]>(env, "sc_items", { method: "POST", prefer: "return=representation", body: JSON.stringify({ col, data, created_by: null, updated_by: null }) });
  if (!r.ok || !r.data?.[0]) throw new ToolError("No se pudo guardar en Scriptorium");
  return r.data[0].id;
}

/** Busca un producto por id o por parte del nombre. Si hay varios parecidos, pide precisar. */
export function findProduct(products: Item[], q: string): Item {
  const key = q.trim().toLowerCase();
  if (!key) throw new ToolError("Falta el producto");
  const byId = products.find((p) => p.id === q.trim());
  if (byId) return byId;
  const exact = products.filter((p) => str(p.data.name).toLowerCase() === key);
  if (exact.length === 1) return exact[0];
  const partial = products.filter((p) => str(p.data.name).toLowerCase().includes(key));
  if (partial.length === 1) return partial[0];
  if (!partial.length) throw new ToolError(`No encontré un producto que se llame "${q}". Usa listar_productos para ver los nombres.`);
  throw new ToolError(`Hay varios productos parecidos a "${q}": ${partial.map((p) => p.data.name).join(", ")}. Di cuál.`);
}

function countries(p: Item, roas: RoasPayload | null) {
  const offer = str(p.data.offer);
  const country = str(p.data.country).toUpperCase();
  if (offer && roas && !roas.error) {
    return roas.rows
      .filter((r) => r.offer_id === offer && (!country || r.country === country))
      .sort((a, b) => b.pauta - a.pauta)
      .map((r) => ({ pais: r.country, roas: r.roas, semaforo: semaforo(r.roas), ventas: r.ventas, neto_cop: r.neto, pauta_cop: r.pauta }));
  }
  const manual = Array.isArray(p.data.countries) ? (p.data.countries as { code: string; roas: number | null }[]) : [];
  return manual.map((c) => ({ pais: c.code, roas: c.roas, semaforo: semaforo(c.roas), fuente: "a mano" }));
}

function productSummary(p: Item, roas: RoasPayload | null, offers: Map<string, string>) {
  const d = p.data;
  const stages = (d.stages || {}) as Record<string, boolean>;
  return {
    id: p.id,
    nombre: d.name,
    estado: d.status || "activo",
    linea: d.line || null,
    celular: d.phone || null,
    avatar: d.avatar || null,
    oferta_dashboard: d.offer ? offers.get(String(d.offer)) || "conectada" : null,
    pais: d.country || null,
    roas_3_dias: countries(p, roas),
    etapas_listas: Object.keys(STAGES).filter((k) => stages[k]).map((k) => STAGES[k]),
  };
}

async function safeRoas(env: Env): Promise<RoasPayload | null> {
  try { return await loadRoas(env); } catch { return null; }
}

export async function callTool(env: Env, name: string, args: Json): Promise<unknown> {
  switch (name) {
    case "listar_productos": {
      const estado = str(args.estado) || "activo";
      const [products, roas] = await Promise.all([items(env, "products"), safeRoas(env)]);
      const offers = new Map((roas?.offers || []).map((o) => [o.id, o.name]));
      const list = products
        .filter((p) => estado === "todos" || (p.data.status || "activo") === estado)
        .sort((a, b) => str(a.data.name).localeCompare(str(b.data.name)))
        .map((p) => productSummary(p, roas, offers));
      return { roas_periodo: roas ? `${roas.from} a ${roas.to}` : "no disponible", productos: list };
    }

    case "ver_producto": {
      const [products, tasks, delivs, roas] = await Promise.all([items(env, "products"), items(env, "tasks"), items(env, "deliverables"), safeRoas(env)]);
      const p = findProduct(products, str(args.producto));
      const offers = new Map((roas?.offers || []).map((o) => [o.id, o.name]));
      const links = (p.data.links || {}) as Json;
      return {
        ...productSummary(p, roas, offers),
        roas_periodo: roas ? `${roas.from} a ${roas.to}` : "no disponible",
        enlaces: { guiones: links.guiones || null, videos: links.videos || null, drive: links.drive || null },
        tareas_abiertas: tasks
          .filter((t) => t.data.product === p.id && (t.data.status === "Pendiente" || t.data.status === "En curso"))
          .map((t) => ({ id: t.id, titulo: t.data.title, estado: t.data.status, responsable: t.data.who || null, vence: t.data.due || null })),
        entregas: delivs
          .filter((d) => d.data.product === p.id)
          .slice(0, 15)
          .map((d) => ({ id: d.id, titulo: d.data.title, agente: d.data.agent, fecha: d.created_at.slice(0, 10) })),
      };
    }

    case "guardar_entrega": {
      const titulo = str(args.titulo, 120), contenido = String(args.contenido ?? "").trim(), agente = str(args.agente);
      if (!titulo || !contenido) throw new ToolError("Faltan el título o el contenido");
      if (!(AGENTS as readonly string[]).includes(agente)) throw new ToolError(`agente debe ser uno de: ${AGENTS.join(", ")}`);
      if (contenido.length > 200_000) throw new ToolError("La entrega es demasiado larga (máximo 200.000 caracteres). Divídela en partes.");
      let product = "", productName = "";
      if (str(args.producto)) {
        const p = findProduct(await items(env, "products"), str(args.producto));
        product = p.id; productName = str(p.data.name);
      }
      const link = str(args.enlace, 500);
      if (link && !/^https?:\/\//i.test(link)) throw new ToolError("El enlace debe empezar por https://");
      const id = await insert(env, "deliverables", {
        title: titulo, content: contenido, agent: agente, product, link, who: str(args.autor, 60) || "Claude",
        via: "mcp", createdAt: new Date().toISOString(),
      });
      return { ok: true, id, guardada_en: productName || "sin producto" };
    }

    case "listar_entregas": {
      const limite = Math.min(30, Math.max(1, Number(args.limite) || 10));
      const [delivs, products] = await Promise.all([items(env, "deliverables"), items(env, "products")]);
      const names = new Map(products.map((p) => [p.id, str(p.data.name)]));
      let list = delivs;
      if (str(args.producto)) { const p = findProduct(products, str(args.producto)); list = list.filter((d) => d.data.product === p.id); }
      if (str(args.agente)) list = list.filter((d) => d.data.agent === str(args.agente));
      return {
        entregas: list.slice(0, limite).map((d) => ({
          id: d.id, titulo: d.data.title, agente: d.data.agent, producto: names.get(str(d.data.product)) || null,
          fecha: d.created_at.slice(0, 10), autor: d.data.who || null, enlace: d.data.link || null,
          ...(args.incluir_contenido ? { contenido: d.data.content } : {}),
        })),
      };
    }

    case "listar_tareas": {
      const estado = str(args.estado) || "abiertas";
      const [tasks, products] = await Promise.all([items(env, "tasks"), items(env, "products")]);
      const names = new Map(products.map((p) => [p.id, str(p.data.name)]));
      let list = tasks;
      if (estado === "abiertas") list = list.filter((t) => t.data.status === "Pendiente" || t.data.status === "En curso");
      else if (estado !== "todas") list = list.filter((t) => t.data.status === estado);
      if (str(args.persona)) { const who = str(args.persona).toLowerCase(); list = list.filter((t) => str(t.data.who).toLowerCase().includes(who)); }
      if (str(args.producto)) { const p = findProduct(products, str(args.producto)); list = list.filter((t) => t.data.product === p.id); }
      return {
        tareas: list.slice(0, 100).map((t) => ({
          id: t.id, titulo: t.data.title, estado: t.data.status, responsable: t.data.who || null, prioridad: t.data.priority || null,
          vence: t.data.due || null, producto: names.get(str(t.data.product)) || null, detalle: t.data.notes || null,
        })),
      };
    }

    case "crear_tarea": {
      const titulo = str(args.titulo, 200);
      if (!titulo) throw new ToolError("Falta el título");
      const vence = str(args.vence);
      if (vence && !DATE.test(vence)) throw new ToolError("vence debe ser YYYY-MM-DD");
      const prioridad = ["Alta", "Media", "Baja"].includes(str(args.prioridad)) ? str(args.prioridad) : "Media";
      let product = "";
      if (str(args.producto)) product = findProduct(await items(env, "products"), str(args.producto)).id;
      const id = await insert(env, "tasks", {
        title: titulo, who: str(args.persona, 60), priority: prioridad, due: vence, product, stage: "",
        notes: str(args.detalle, 4000), status: "Pendiente", comments: [], links: [], createdAt: new Date().toISOString(),
      });
      return { ok: true, id };
    }

    case "actualizar_tarea": {
      const id = str(args.tarea_id);
      if (!UUID.test(id)) throw new ToolError("tarea_id no es válido");
      const r = await db<Item[]>(env, `sc_items?id=eq.${id}&col=eq.tasks&select=id,data,created_at`);
      const t = r.data?.[0];
      if (!t) throw new ToolError("Tarea no encontrada");
      const patch: Json = {};
      const estado = str(args.estado);
      if (estado) {
        if (!(TASK_STATES as readonly string[]).includes(estado)) throw new ToolError(`estado debe ser uno de: ${TASK_STATES.join(", ")}`);
        patch.status = estado;
        if (estado === "Hecha" || estado === "Descartada") patch.doneAt = new Date().toISOString();
      }
      if (str(args.comentario)) {
        const prev = Array.isArray(t.data.comments) ? t.data.comments : [];
        patch.comments = [...prev, { who: str(args.autor, 60) || "Claude", text: str(args.comentario, 2000), at: new Date().toISOString() }];
      }
      if (!Object.keys(patch).length) throw new ToolError("Di qué cambiar: estado o comentario");
      const up = await db(env, `sc_items?id=eq.${id}`, { method: "PATCH", body: JSON.stringify({ data: { ...t.data, ...patch } }) });
      if (!up.ok) throw new ToolError("No se pudo actualizar la tarea");
      return { ok: true, id, ...patch };
    }

    case "registrar_hallazgo": {
      const page = str(args.fan_page, 120);
      if (!page) throw new ToolError("Falta la fan page");
      const url = str(args.enlace, 500);
      if (url && !/^https?:\/\//i.test(url)) throw new ToolError("El enlace debe empezar por https://");
      const today = new Intl.DateTimeFormat("en-CA", { timeZone: "America/Bogota" }).format(new Date());
      const id = await insert(env, "found", {
        page, topic: str(args.tema, 200), ads: args.anuncios != null ? String(Number(args.anuncios) || 0) : "", url,
        date: today, source: str(args.origen, 60) || "Investigador", createdAt: new Date().toISOString(),
      });
      return { ok: true, id };
    }

    case "sincronizar_productos": {
      try { return await syncProducts(env); } catch (e) { throw new ToolError(e instanceof Error ? e.message : "No se pudo sincronizar"); }
    }

    case "ver_equipo": {
      const r = await db<{ name: string; role: string }[]>(env, "sc_members?select=name,role&role=neq.pendiente&order=name");
      return { equipo: (r.data || []).map((m) => m.name) };
    }
  }
  throw new ToolError(`Herramienta desconocida: ${name}`);
}

function rpcResult(id: unknown, result: unknown) { return { jsonrpc: "2.0", id, result }; }
function rpcError(id: unknown, code: number, message: string) { return { jsonrpc: "2.0", id, error: { code, message } }; }

async function handleMessage(env: Env, msg: Json): Promise<Json | null> {
  const id = msg.id ?? null;
  const method = String(msg.method ?? "");
  const isNotification = msg.id === undefined;
  try {
    switch (method) {
      case "initialize":
        return rpcResult(id, {
          protocolVersion: (msg.params as Json | undefined)?.protocolVersion ?? PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "scriptorium", version: "1.0.0" },
          instructions:
            "Scriptorium es la app de operaciones del equipo NUCLEA (productos digitales de bienestar que se venden por WhatsApp con anuncios de Meta). " +
            "Antes de trabajar en un producto, usa ver_producto para tener su contexto (línea, avatar, ROAS por país, entregas anteriores). " +
            "Cuando termines una entrega (oferta, guiones, script, copys, contenido del PDF, plan de edición), ofrece guardarla con guardar_entrega. " +
            "Pide confirmación antes de crear o cambiar tareas. Todo en español.",
        });
      case "ping":
        return rpcResult(id, {});
      case "tools/list":
        return rpcResult(id, { tools: TOOLS });
      case "tools/call": {
        const p = (msg.params ?? {}) as Json;
        try {
          const out = await callTool(env, String(p.name ?? ""), (p.arguments ?? {}) as Json);
          return rpcResult(id, { content: [{ type: "text", text: JSON.stringify(out, null, 2) }], structuredContent: out });
        } catch (err) {
          if (err instanceof ToolError) return rpcResult(id, { content: [{ type: "text", text: err.message }], isError: true });
          throw err;
        }
      }
      default:
        if (isNotification) return null;
        return rpcError(id, -32601, `Método no soportado: ${method}`);
    }
  } catch (err) {
    console.error("MCP", method, err);
    return rpcError(id, -32603, "Error interno");
  }
}

/** Comparación en tiempo constante para la clave del conector. */
export function safeEqual(a: string, b: string): boolean {
  const ea = new TextEncoder().encode(a);
  const eb = new TextEncoder().encode(b);
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export async function handleMcp(req: Request, env: Env, pathKey: string | null): Promise<Response> {
  const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "") ?? null;
  const key = pathKey ?? bearer;
  if (!env.MCP_KEY || env.MCP_KEY.length < 16 || !key || !safeEqual(key, env.MCP_KEY)) {
    // 403 y no 401: con 401 Claude intenta iniciar sesión por OAuth, y este conector usa la clave en la URL.
    const why = !env.MCP_KEY || env.MCP_KEY.length < 16 ? "Falta MCP_KEY (16 caracteres o más) en Cloudflare" : "Clave del conector inválida: revisa la URL";
    return Response.json({ error: why }, { status: 403 });
  }
  if (req.method === "GET") return new Response(null, { status: 405, headers: { Allow: "POST" } });
  if (req.method === "DELETE") return new Response(null, { status: 204 });
  if (req.method !== "POST") return new Response(null, { status: 405 });

  let body: unknown;
  try { body = await req.json(); } catch { return Response.json(rpcError(null, -32700, "JSON inválido"), { status: 400 }); }

  const batch = Array.isArray(body);
  const msgs = (batch ? body : [body]) as Json[];
  const out = (await Promise.all(msgs.map((m) => handleMessage(env, m)))).filter((r): r is Json => r !== null);
  if (!out.length) return new Response(null, { status: 202 });
  return Response.json(batch ? out : out[0]);
}
