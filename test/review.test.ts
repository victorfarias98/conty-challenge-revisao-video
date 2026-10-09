import { beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.ts";
import { openDatabase } from "../src/db.ts";
import { type PieceKind, blockingPieces, deliveryStatus } from "../src/pieces.ts";
import type { DeliveryView, VersionView } from "../src/review.ts";

type App = ReturnType<typeof createApp>;
type ErrorBody = { error: { code: string; message: string; blocking?: Array<{ kind: string; state: string }> } };

let app: App;
let now: Date;

async function post(path: string, body?: unknown): Promise<Response> {
  return app.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function delivery(required: PieceKind[]): Promise<DeliveryView> {
  const campaign = (await (await post("/campaigns", { name: "Verão beleza", required_pieces: required })).json()) as { id: string };
  const res = await post("/deliveries", { campaign_id: campaign.id });
  expect(res.status).toBe(201);
  return (await res.json()) as DeliveryView;
}

async function submit(deliveryId: string, kind: PieceKind, extra: Record<string, unknown> = {}): Promise<VersionView> {
  const res = await post(`/deliveries/${deliveryId}/pieces/${kind}/versions`, { url: `https://cdn.exemplo/${kind}.bin`, ...extra });
  expect(res.status).toBe(201);
  return (await res.json()) as VersionView;
}

async function submitApproved(deliveryId: string, kind: PieceKind): Promise<VersionView> {
  const version = await submit(deliveryId, kind);
  expect((await post(`/versions/${version.id}/approval`)).status).toBe(200);
  return version;
}

async function view(deliveryId: string): Promise<DeliveryView> {
  return (await (await app.request(`/deliveries/${deliveryId}`)).json()) as DeliveryView;
}

async function version(id: string): Promise<VersionView> {
  return (await (await app.request(`/versions/${id}`)).json()) as VersionView;
}

beforeEach(() => {
  now = new Date("2026-03-10T15:00:00.000Z");
  app = createApp(openDatabase(), () => now);
});

describe("regra de peças exigidas (função pura)", () => {
  it("bloqueia pelas peças exigidas não aprovadas e ignora as não exigidas", () => {
    expect(blockingPieces(["script", "video", "cover"], { video: "approved", cover: "changes_requested", caption: "pending_review" })).toEqual([
      { kind: "script", state: "missing" },
      { kind: "cover", state: "changes_requested" },
    ]);
  });

  it("só considera aprovada a entrega com aprovação da marca e todas as exigidas aprovadas", () => {
    expect(deliveryStatus(["video"], { video: "approved" }, false)).toBe("ready_for_approval");
    expect(deliveryStatus(["video"], { video: "approved" }, true)).toBe("approved");
    expect(deliveryStatus(["video"], { video: "pending_review" }, true)).toBe("in_production");
  });
});

describe("aprovação da entrega", () => {
  it("falha com erro claro quando há peça exigida pendente, dizendo qual e em que estado", async () => {
    const created = await delivery(["script", "video", "cover", "caption"]);
    await submitApproved(created.id, "script");
    await submit(created.id, "video");
    const cover = await submit(created.id, "cover");
    await post(`/versions/${cover.id}/change-requests`, { reason: "Logo cortado" });

    const res = await post(`/deliveries/${created.id}/approval`);

    expect(res.status).toBe(409);
    const body = (await res.json()) as ErrorBody;
    expect(body.error.code).toBe("required_pieces_pending");
    expect(body.error.blocking).toEqual([
      { kind: "video", state: "pending_review" },
      { kind: "cover", state: "changes_requested" },
      { kind: "caption", state: "missing" },
    ]);
    expect(body.error.message).toContain("video (aguardando revisão)");
    expect(body.error.message).toContain("caption (não enviada)");
    expect((await view(created.id)).status).toBe("in_production");
  });

  it("aprova quando cada peça exigida tem a versão atual aprovada", async () => {
    const created = await delivery(["script", "video", "cover", "caption"]);
    for (const kind of ["script", "video", "cover", "caption"] as const) await submitApproved(created.id, kind);
    expect((await view(created.id)).status).toBe("ready_for_approval");

    const res = await post(`/deliveries/${created.id}/approval`);

    expect(res.status).toBe(200);
    expect((await res.json()) as DeliveryView).toMatchObject({ status: "approved", blocking: [], signed_off_at: now.toISOString() });
  });

  it("campanha só de vídeo não exige roteiro", async () => {
    const created = await delivery(["video"]);
    await submitApproved(created.id, "video");

    const res = await post(`/deliveries/${created.id}/approval`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DeliveryView;
    expect(body.status).toBe("approved");
    expect(body.pieces.map((piece) => piece.kind)).toEqual(["video"]);
  });

  it("peça que a campanha não pediu não bloqueia, mesmo sem aprovação", async () => {
    const created = await delivery(["video"]);
    await submitApproved(created.id, "video");
    await submit(created.id, "script");

    const res = await post(`/deliveries/${created.id}/approval`);

    expect(res.status).toBe(200);
    const body = (await res.json()) as DeliveryView;
    expect(body.status).toBe("approved");
    expect(body.pieces.find((piece) => piece.kind === "script")).toMatchObject({ required: false, state: "pending_review" });
  });

  it("a lista de exigidas vem da campanha: a mesma entrega muda de regra com outra campanha", async () => {
    const videoOnly = await delivery(["video"]);
    const videoAndCaption = await delivery(["video", "caption"]);
    await submitApproved(videoOnly.id, "video");
    await submitApproved(videoAndCaption.id, "video");

    expect((await post(`/deliveries/${videoOnly.id}/approval`)).status).toBe(200);
    expect((await post(`/deliveries/${videoAndCaption.id}/approval`)).status).toBe(409);
  });

  it("recusa campanha sem peça exigida ou com peça desconhecida", async () => {
    expect((await post("/campaigns", { name: "x", required_pieces: [] })).status).toBe(422);
    expect((await post("/campaigns", { name: "x", required_pieces: ["video", "podcast"] })).status).toBe(422);
  });
});

describe("versões", () => {
  it("a versão nova substitui a anterior como atual, e a anterior continua consultável", async () => {
    const created = await delivery(["video"]);
    const first = await submit(created.id, "video");
    await post(`/versions/${first.id}/change-requests`, { reason: "Áudio baixo" });
    const second = await submit(created.id, "video");

    const state = await view(created.id);

    expect(second.number).toBe(2);
    expect(state.pieces[0]).toMatchObject({ versions: 2, state: "pending_review", current_version: { id: second.id, number: 2 } });
    expect(await version(first.id)).toMatchObject({ number: 1, status: "changes_requested", review_reason: "Áudio baixo", is_current: false });
  });

  it("não deixa aprovar uma versão que já foi substituída", async () => {
    const created = await delivery(["video"]);
    const first = await submit(created.id, "video");
    await submit(created.id, "video");

    const res = await post(`/versions/${first.id}/approval`);

    expect(res.status).toBe(409);
    expect(((await res.json()) as ErrorBody).error.code).toBe("version_superseded");
    expect((await view(created.id)).status).toBe("in_production");
  });

  it("pedido de alteração precisa de motivo", async () => {
    const created = await delivery(["video"]);
    const first = await submit(created.id, "video");
    expect((await post(`/versions/${first.id}/change-requests`, {})).status).toBe(422);
    expect((await version(first.id)).status).toBe("pending_review");
  });
});

describe("entrega aprovada que recebe versão nova", () => {
  async function approvedDelivery(): Promise<DeliveryView> {
    const created = await delivery(["video", "cover"]);
    await submitApproved(created.id, "video");
    await submitApproved(created.id, "cover");
    const res = await post(`/deliveries/${created.id}/approval`);
    expect(res.status).toBe(200);
    return (await res.json()) as DeliveryView;
  }

  it("deixa de estar aprovada até a versão nova ser aprovada", async () => {
    const approved = await approvedDelivery();
    expect(approved.status).toBe("approved");

    const newVideo = await submit(approved.id, "video");

    const suspended = await view(approved.id);
    expect(suspended.status).toBe("in_production");
    expect(suspended.blocking).toEqual([{ kind: "video", state: "pending_review" }]);
    expect(suspended.signed_off_at).toBe(approved.signed_off_at);

    await post(`/versions/${newVideo.id}/approval`);

    const restored = await view(approved.id);
    expect(restored.status).toBe("approved");
    expect(restored.history.map((entry) => entry.event)).toEqual([
      "version_submitted",
      "version_approved",
      "version_submitted",
      "version_approved",
      "delivery_approved",
      "version_submitted",
      "approval_suspended",
      "version_approved",
      "approval_restored",
    ]);
  });

  it("continua sem aprovação se a versão nova recebe pedido de alteração", async () => {
    const approved = await approvedDelivery();
    const newVideo = await submit(approved.id, "video");

    await post(`/versions/${newVideo.id}/change-requests`, { reason: "Trilha errada" });

    expect(await view(approved.id)).toMatchObject({ status: "in_production", blocking: [{ kind: "video", state: "changes_requested" }] });
  });

  it("versão nova de peça não exigida não desfaz a aprovação", async () => {
    const approved = await approvedDelivery();
    await submit(approved.id, "caption");
    expect((await view(approved.id)).status).toBe("approved");
  });
});

describe("comentário ancorado em segundo", () => {
  it("fica visível na versão em que foi feito e não migra para a versão nova", async () => {
    const created = await delivery(["video"]);
    const first = await submit(created.id, "video", { duration_seconds: 60 });

    const res = await post(`/versions/${first.id}/comments`, { second: 12, body: "Cortar esta pausa" });
    expect(res.status).toBe(201);
    await post(`/versions/${first.id}/comments`, { second: 3, body: "Logo maior" });
    const second = await submit(created.id, "video", { duration_seconds: 55 });

    expect((await version(first.id)).comments.map((entry) => [entry.second, entry.body])).toEqual([
      [3, "Logo maior"],
      [12, "Cortar esta pausa"],
    ]);
    expect((await version(second.id)).comments).toEqual([]);
  });

  it("recusa segundo negativo, fracionado ou além da duração do vídeo", async () => {
    const created = await delivery(["video"]);
    const first = await submit(created.id, "video", { duration_seconds: 60 });

    expect((await post(`/versions/${first.id}/comments`, { second: -1, body: "x" })).status).toBe(422);
    expect((await post(`/versions/${first.id}/comments`, { second: 1.5, body: "x" })).status).toBe(422);
    expect((await post(`/versions/${first.id}/comments`, { second: 61, body: "x" })).status).toBe(422);
    expect((await post(`/versions/${first.id}/comments`, { second: 60, body: "x" })).status).toBe(201);
    expect((await post(`/versions/${first.id}/comments`, { second: 5 })).status).toBe(422);
  });

  it("só aceita comentário em vídeo e na versão atual", async () => {
    const created = await delivery(["video", "cover"]);
    const cover = await submit(created.id, "cover");
    const first = await submit(created.id, "video");
    await submit(created.id, "video");

    const onCover = await post(`/versions/${cover.id}/comments`, { second: 1, body: "x" });
    const onOld = await post(`/versions/${first.id}/comments`, { second: 1, body: "x" });

    expect(((await onCover.json()) as ErrorBody).error.code).toBe("comments_only_on_video");
    expect(((await onOld.json()) as ErrorBody).error.code).toBe("version_superseded");
  });
});
