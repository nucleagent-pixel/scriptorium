import { describe, expect, it } from "vitest";
import { planSync } from "../src/sync";

describe("sincronizar productos", () => {
  it("crea, enlaza y archiva sin duplicar", () => {
    const offers = [
      { id: "o1", name: "Reto Pilates", archived: false },
      { id: "o2", name: "Nutre", archived: false },
      { id: "o3", name: "Viejo", archived: true },
      { id: "o4", name: "Nuevo", archived: false },
    ];
    const products = [
      { id: "p1", data: { name: "Mi reto", offer: "o1", status: "activo" } },
      { id: "p2", data: { name: "nutre ", status: "activo" } },
      { id: "p3", data: { name: "Viejo", offer: "o3", status: "activo" } },
    ];
    const { create, patch } = planSync(offers, products);
    expect(create.map((c) => c.name)).toEqual(["Nuevo"]);
    expect(create[0]).toMatchObject({ offer: "o4", status: "activo" });
    expect(patch).toEqual([
      { id: "p2", data: { offer: "o2" }, kind: "enlazado", name: "Nutre" },
      { id: "p3", data: { status: "archivado" }, kind: "archivado", name: "Viejo" },
    ]);
    // Segunda vez no hace nada.
    const again = planSync(offers, [...products.map((p) => p.id === "p3" ? { ...p, data: { ...p.data, status: "archivado" } } : p), { id: "p4", data: { name: "Nuevo", offer: "o4" } }]);
    expect(again).toEqual({ create: [], patch: [] });
  });
});

describe("un producto por país", () => {
  const offers = [
    { id: "pil", name: "PILATES", archived: false },
    { id: "tec", name: "TÉCNICO", archived: false },
  ];
  const oc = [
    { offer_id: "pil", country: "co", weight: 300 },
    { offer_id: "pil", country: "VE", weight: 320 },
    { offer_id: "pil", country: "CL", weight: 100 },
    { offer_id: "pil", country: "BO" },
    { offer_id: "tec", country: "VE", weight: 50 },
  ];

  it("separa el producto viejo y crea los demás países", () => {
    const products = [
      { id: "p1", data: { name: "PILATES", offer: "pil", line: "3", avatar: "Ana" } },
      { id: "p2", data: { name: "Técnico reparación", offer: "tec" } },
    ];
    const { create, patch } = planSync(offers, products, oc);
    expect(patch).toEqual([
      { id: "p1", data: { country: "VE", name: "PILATES · VE" }, kind: "separado", name: "PILATES · VE" },
      { id: "p2", data: { country: "VE" }, kind: "separado", name: "Técnico reparación" },
    ]);
    expect(create.map((c) => c.name)).toEqual(["PILATES · CO", "PILATES · CL", "PILATES · BO"]);
    expect(create[0]).toMatchObject({ offer: "pil", country: "CO", line: "3", avatar: "Ana", status: "activo" });

    // Segunda vez no hace nada.
    const after = [
      { id: "p1", data: { name: "PILATES · VE", offer: "pil", country: "VE" } },
      { id: "p2", data: { name: "Técnico reparación", offer: "tec", country: "VE" } },
      ...create.map((data, i) => ({ id: `n${i}`, data })),
    ];
    expect(planSync(offers, after, oc)).toEqual({ create: [], patch: [] });
  });

  it("un país nuevo de una oferta crea solo ese producto", () => {
    const products = [{ id: "t", data: { name: "TÉCNICO · VE", offer: "tec", country: "VE" } }];
    const { create, patch } = planSync([offers[1]], products, [...oc, { offer_id: "tec", country: "BO" }]);
    expect(patch).toEqual([]);
    expect(create.map((c) => c.name)).toEqual(["TÉCNICO · BO"]);
  });
});
