import type { DatabaseSync } from "node:sqlite";
import {
  type BlockingPiece,
  type CurrentVersions,
  type DeliveryStatus,
  PIECE_KINDS,
  type PieceKind,
  type PieceState,
  type VersionStatus,
  blockingPieces,
  deliveryStatus,
} from "./pieces.ts";

export type Clock = () => Date;

export type CommentView = { id: string; second: number; body: string; created_at: string };

export type VersionView = {
  id: string;
  delivery_id: string;
  kind: PieceKind;
  number: number;
  url: string;
  duration_seconds: number | null;
  status: VersionStatus;
  review_reason: string | null;
  // false quando já existe versão mais nova da mesma peça.
  is_current: boolean;
  submitted_at: string;
  reviewed_at: string | null;
  // Só os comentários feitos nesta versão.
  comments: CommentView[];
};

export type DeliveryView = {
  id: string;
  campaign_id: string;
  required_pieces: PieceKind[];
  status: DeliveryStatus;
  signed_off_at: string | null;
  // O que ainda impede a aprovação. Vazio quando a entrega pode ser (ou está) aprovada.
  blocking: BlockingPiece[];
  pieces: Array<{
    kind: PieceKind;
    required: boolean;
    state: PieceState;
    versions: number;
    current_version: Omit<VersionView, "comments"> | null;
  }>;
  history: Array<{ event: string; detail: string; at: string }>;
};

export class ReviewError extends Error {
  readonly status: 404 | 409 | 422;
  readonly code: string;
  readonly blocking?: BlockingPiece[];

  constructor(status: 404 | 409 | 422, code: string, message: string, blocking?: BlockingPiece[]) {
    super(message);
    this.status = status;
    this.code = code;
    this.blocking = blocking;
  }
}

type DeliveryRow = { id: string; campaign_id: string; signed_off_at: string | null; required_pieces_json: string };
type VersionRow = Omit<VersionView, "is_current" | "comments">;

const STATE_LABEL: Record<Exclude<PieceState, "approved">, string> = {
  missing: "não enviada",
  pending_review: "aguardando revisão",
  changes_requested: "com alteração pedida",
};

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function pieceKind(value: unknown): PieceKind | undefined {
  return PIECE_KINDS.find((kind) => kind === value);
}

export function createReview(db: DatabaseSync, clock: Clock) {
  function deliveryRow(id: string): DeliveryRow {
    const row = db
      .prepare(
        `SELECT d.id, d.campaign_id, d.signed_off_at, c.required_pieces_json
         FROM deliveries d JOIN campaigns c ON c.id = d.campaign_id WHERE d.id = ?`,
      )
      .get(id) as DeliveryRow | undefined;
    if (!row) throw new ReviewError(404, "delivery_not_found", "entrega não encontrada");
    return row;
  }

  function versionsOf(deliveryId: string): VersionRow[] {
    return db
      .prepare(
        `SELECT id, delivery_id, kind, number, url, duration_seconds, status, review_reason, submitted_at, reviewed_at
         FROM piece_versions WHERE delivery_id = ? ORDER BY kind, number`,
      )
      .all(deliveryId) as VersionRow[];
  }

  // A versão atual de uma peça é a de maior número.
  function currentByKind(versions: VersionRow[]): Map<PieceKind, VersionRow> {
    const current = new Map<PieceKind, VersionRow>();
    for (const version of versions) current.set(version.kind, version);
    return current;
  }

  function evaluate(deliveryId: string) {
    const delivery = deliveryRow(deliveryId);
    const required = JSON.parse(delivery.required_pieces_json) as PieceKind[];
    const versions = versionsOf(deliveryId);
    const current = currentByKind(versions);
    const statuses: CurrentVersions = Object.fromEntries([...current].map(([kind, version]) => [kind, version.status]));
    return {
      delivery,
      required,
      versions,
      current,
      blocking: blockingPieces(required, statuses),
      status: deliveryStatus(required, statuses, delivery.signed_off_at !== null),
    };
  }

  function log(deliveryId: string, event: string, detail: string): void {
    db.prepare("INSERT INTO delivery_events (delivery_id, event, detail, at) VALUES (?, ?, ?, ?)").run(
      deliveryId,
      event,
      detail,
      clock().toISOString(),
    );
  }

  // Toda mudança numa entrega passa por aqui: o que aconteceu vai para o histórico e, se o status
  // da entrega mudou por consequência (aprovação suspensa ou retomada), isso também.
  function change<T>(deliveryId: string, event: string, detail: string, work: () => T): T {
    db.exec("BEGIN IMMEDIATE");
    try {
      const before = evaluate(deliveryId).status;
      const result = work();
      log(deliveryId, event, detail);
      const after = evaluate(deliveryId).status;
      if (before === "approved" && after !== "approved") {
        log(deliveryId, "approval_suspended", "uma peça exigida recebeu versão nova depois da aprovação");
      }
      if (before !== "approved" && after === "approved" && event !== "delivery_approved") {
        log(deliveryId, "approval_restored", "a versão nova da peça exigida foi aprovada");
      }
      db.exec("COMMIT");
      return result;
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }
  }

  function deliveryView(deliveryId: string): DeliveryView {
    const { delivery, required, versions, current, blocking, status } = evaluate(deliveryId);
    const kinds = PIECE_KINDS.filter((kind) => required.includes(kind) || current.has(kind));
    return {
      id: delivery.id,
      campaign_id: delivery.campaign_id,
      required_pieces: required,
      status,
      signed_off_at: delivery.signed_off_at,
      blocking,
      pieces: kinds.map((kind) => {
        const version = current.get(kind);
        return {
          kind,
          required: required.includes(kind),
          state: version?.status ?? "missing",
          versions: versions.filter((entry) => entry.kind === kind).length,
          current_version: version ? { ...version, is_current: true } : null,
        };
      }),
      history: db
        .prepare("SELECT event, detail, at FROM delivery_events WHERE delivery_id = ? ORDER BY seq")
        .all(deliveryId) as DeliveryView["history"],
    };
  }

  function versionRow(id: string): VersionRow & { is_current: boolean } {
    const row = db
      .prepare(
        `SELECT id, delivery_id, kind, number, url, duration_seconds, status, review_reason, submitted_at, reviewed_at
         FROM piece_versions WHERE id = ?`,
      )
      .get(id) as VersionRow | undefined;
    if (!row) throw new ReviewError(404, "version_not_found", "versão não encontrada");
    const { latest } = db
      .prepare("SELECT MAX(number) AS latest FROM piece_versions WHERE delivery_id = ? AND kind = ?")
      .get(row.delivery_id, row.kind) as { latest: number };
    return { ...row, is_current: row.number === latest };
  }

  function versionView(id: string): VersionView {
    return {
      ...versionRow(id),
      comments: db
        .prepare("SELECT id, second, body, created_at FROM comments WHERE version_id = ? ORDER BY second, rowid")
        .all(id) as CommentView[],
    };
  }

  function createCampaign(input: { name?: unknown; required_pieces?: unknown }) {
    const name = text(input.name);
    const raw = Array.isArray(input.required_pieces) ? input.required_pieces : [];
    const required = PIECE_KINDS.filter((kind) => raw.includes(kind));
    if (!name) throw new ReviewError(422, "name_required", "nome da campanha é obrigatório");
    if (required.length === 0 || raw.some((kind) => !pieceKind(kind))) {
      throw new ReviewError(422, "required_pieces_invalid", `required_pieces deve ter ao menos uma de: ${PIECE_KINDS.join(", ")}`);
    }
    const id = `cmp_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO campaigns (id, name, required_pieces_json, created_at) VALUES (?, ?, ?, ?)").run(
      id,
      name,
      JSON.stringify(required),
      clock().toISOString(),
    );
    return { id, name, required_pieces: required };
  }

  function createDelivery(input: { campaign_id?: unknown }): DeliveryView {
    const campaignId = text(input.campaign_id);
    if (!db.prepare("SELECT 1 FROM campaigns WHERE id = ?").get(campaignId)) {
      throw new ReviewError(404, "campaign_not_found", "campanha não encontrada");
    }
    const id = `dlv_${crypto.randomUUID()}`;
    db.prepare("INSERT INTO deliveries (id, campaign_id, created_at) VALUES (?, ?, ?)").run(id, campaignId, clock().toISOString());
    return deliveryView(id);
  }

  function submitVersion(deliveryId: string, rawKind: string, input: { url?: unknown; duration_seconds?: unknown }): VersionView {
    deliveryRow(deliveryId);
    const kind = pieceKind(rawKind);
    const url = text(input.url);
    const duration = input.duration_seconds ?? null;
    if (!kind) throw new ReviewError(422, "piece_kind_invalid", `peça deve ser uma de: ${PIECE_KINDS.join(", ")}`);
    if (!url) throw new ReviewError(422, "url_required", "url do arquivo é obrigatória");
    if (duration !== null && (typeof duration !== "number" || !Number.isInteger(duration) || duration <= 0 || kind !== "video")) {
      throw new ReviewError(422, "duration_invalid", "duration_seconds é um inteiro positivo e só vale para vídeo");
    }
    const id = `ver_${crypto.randomUUID()}`;
    return change(deliveryId, "version_submitted", kind, () => {
      const { next } = db
        .prepare("SELECT COALESCE(MAX(number), 0) + 1 AS next FROM piece_versions WHERE delivery_id = ? AND kind = ?")
        .get(deliveryId, kind) as { next: number };
      db.prepare(
        `INSERT INTO piece_versions (id, delivery_id, kind, number, url, duration_seconds, status, submitted_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending_review', ?)`,
      ).run(id, deliveryId, kind, next, url, duration, clock().toISOString());
      return versionView(id);
    });
  }

  function reviewable(versionId: string): VersionRow {
    const version = versionRow(versionId);
    if (!version.is_current) {
      throw new ReviewError(409, "version_superseded", "já existe versão mais nova desta peça; revise a atual");
    }
    if (version.status !== "pending_review") {
      throw new ReviewError(409, "version_already_reviewed", "esta versão já foi revisada");
    }
    return version;
  }

  function approveVersion(versionId: string): VersionView {
    const version = reviewable(versionId);
    return change(version.delivery_id, "version_approved", `${version.kind} v${version.number}`, () => {
      db.prepare("UPDATE piece_versions SET status = 'approved', reviewed_at = ? WHERE id = ?").run(clock().toISOString(), versionId);
      return versionView(versionId);
    });
  }

  function requestChanges(versionId: string, input: { reason?: unknown }): VersionView {
    const version = reviewable(versionId);
    const reason = text(input.reason);
    if (!reason) throw new ReviewError(422, "reason_required", "pedido de alteração precisa de motivo");
    return change(version.delivery_id, "changes_requested", `${version.kind} v${version.number}`, () => {
      db.prepare("UPDATE piece_versions SET status = 'changes_requested', review_reason = ?, reviewed_at = ? WHERE id = ?").run(
        reason,
        clock().toISOString(),
        versionId,
      );
      return versionView(versionId);
    });
  }

  function comment(versionId: string, input: { second?: unknown; body?: unknown }): VersionView {
    const version = versionRow(versionId);
    const second = input.second;
    const body = text(input.body);
    if (version.kind !== "video") {
      throw new ReviewError(422, "comments_only_on_video", "comentário ancorado em segundo só existe em vídeo");
    }
    if (!version.is_current) {
      throw new ReviewError(409, "version_superseded", "já existe versão mais nova deste vídeo; comente na atual");
    }
    if (typeof second !== "number" || !Number.isInteger(second) || second < 0) {
      throw new ReviewError(422, "second_invalid", "second deve ser um inteiro maior ou igual a zero");
    }
    if (version.duration_seconds !== null && second > version.duration_seconds) {
      throw new ReviewError(422, "second_out_of_range", `o vídeo tem ${version.duration_seconds} segundos`);
    }
    if (!body) throw new ReviewError(422, "body_required", "texto do comentário é obrigatório");
    db.prepare("INSERT INTO comments (id, version_id, second, body, created_at) VALUES (?, ?, ?, ?, ?)").run(
      `cmt_${crypto.randomUUID()}`,
      versionId,
      second,
      body,
      clock().toISOString(),
    );
    return versionView(versionId);
  }

  function approveDelivery(deliveryId: string): DeliveryView {
    const { blocking, status } = evaluate(deliveryId);
    if (blocking.length > 0) {
      const list = blocking.map((piece) => `${piece.kind} (${STATE_LABEL[piece.state]})`).join(", ");
      throw new ReviewError(409, "required_pieces_pending", `a campanha exige peças ainda não aprovadas: ${list}`, blocking);
    }
    if (status === "approved") return deliveryView(deliveryId);
    return change(deliveryId, "delivery_approved", "todas as peças exigidas com a versão atual aprovada", () => {
      db.prepare("UPDATE deliveries SET signed_off_at = ? WHERE id = ?").run(clock().toISOString(), deliveryId);
      return deliveryView(deliveryId);
    });
  }

  return {
    createCampaign,
    createDelivery,
    deliveryView,
    submitVersion,
    versionView,
    approveVersion,
    requestChanges,
    comment,
    approveDelivery,
  };
}
