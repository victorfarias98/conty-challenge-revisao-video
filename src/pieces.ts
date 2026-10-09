// As peças que uma campanha pode exigir e a regra de quando a entrega pode ser aprovada.
// Nada aqui sabe qual campanha exige o quê: a lista de exigidas chega como dado.

export const PIECE_KINDS = ["script", "video", "cover", "caption"] as const;
export type PieceKind = (typeof PIECE_KINDS)[number];

export type VersionStatus = "pending_review" | "changes_requested" | "approved";
export type PieceState = VersionStatus | "missing";
export type DeliveryStatus = "in_production" | "ready_for_approval" | "approved";

// Estado da versão ATUAL de cada peça. Peça sem nenhuma versão não aparece.
export type CurrentVersions = Partial<Record<PieceKind, VersionStatus>>;
export type BlockingPiece = { kind: PieceKind; state: Exclude<PieceState, "approved"> };

// Peças exigidas cuja versão atual ainda não está aprovada. Peça que a campanha não pediu
// nunca entra aqui, esteja no estado que estiver.
export function blockingPieces(required: PieceKind[], current: CurrentVersions): BlockingPiece[] {
  return required.flatMap((kind) => {
    const state: PieceState = current[kind] ?? "missing";
    return state === "approved" ? [] : [{ kind, state }];
  });
}

// A aprovação da entrega vale para a versão atual de cada peça exigida. Se a marca já aprovou
// a entrega e uma peça exigida recebe versão nova, a entrega volta a "in_production" sozinha e
// só volta a "approved" quando essa versão for aprovada.
export function deliveryStatus(required: PieceKind[], current: CurrentVersions, signedOff: boolean): DeliveryStatus {
  if (blockingPieces(required, current).length > 0) return "in_production";
  return signedOff ? "approved" : "ready_for_approval";
}
