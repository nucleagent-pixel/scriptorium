import { describe, expect, it } from "vitest";
import { planSync } from "../src/sync";

const src = (offer_id: string, country: string, active = true) => ({ offer_id, country, active });

describe("sincronizar productos (una tarjeta por oferta y país)", () => {
  it("parte un producto viejo por países y crea los que faltan", () => {
    const offers = [{ id: "o1", name: "PILATES", archived: false }, { id: "o2", name: "Nutre", archived: false }];
    const sources = [src("o1", "VE"), src("o1", "co"), src("o1", "CL"), src("o1", "MX", false), src("o2", "CO")];
    const products = [
      { id: "p1", data: { name: "PILATES", offer: "o1", status: "activo" } },
      { id: "p2", data: { name: "nutre", status: "activo" } },
    ];
    const { create, patch } = planSync(offers, sources, products);
    expect(patch).toEqual([
      { id: "p1", data: { offer: "o1", country: "CL" }, kind: "enlazado", name: "PILATES CL" },
      { id: "p2", data: { offer: "o2", country: "CO" }, kind: "enlazado", name: "Nutre CO" },
    ]);
    expect(create.map((c) => `${c.name} ${c.country}`)).toEqual(["PILATES CO", "PILATES VE"]);
    const all = [...products, ...create.map((d, i) => ({ id: `n${i}`, data: d }))];
    expect(planSync(offers, sources, all)).toEqual({ create: [], patch: [] });
  });

  it("archiva los productos de una oferta archivada", () => {
    const { patch } = planSync([{ id: "o3", name: "Viejo", archived: true }], [src("o3", "VE")], [{ id: "p3", data: { name: "Viejo", offer: "o3", country: "VE", status: "activo" } }]);
    expect(patch).toEqual([{ id: "p3", data: { status: "archivado" }, kind: "archivado", name: "Viejo VE" }]);
  });
});
