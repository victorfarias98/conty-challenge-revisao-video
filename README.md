# Conty. Revisão de vídeo

Versões de cada peça de uma entrega (roteiro, vídeo, capa, legenda), comentários presos a um segundo do vídeo e a regra de que a entrega só fica aprovada quando tudo o que a campanha exigiu tem a versão atual aprovada.

## Como rodar

Node 22 ou mais novo.

```bash
npm install
npm test
npm run dev
```

A API sobe em `http://127.0.0.1:3008` e grava em `data/revisao-video.sqlite` (`PORT` e `DB_PATH` mudam isso). Não há upload: cada versão é uma URL.

## Por onde ler

1. `src/pieces.ts`: a regra de peças exigidas, em duas funções puras de poucas linhas.
2. `src/review.ts`: versões, comentários, aprovação e o histórico da entrega.
3. `test/review.test.ts`.
4. `src/db.ts` e `src/app.ts`: schema e HTTP.

## A regra

**As peças exigidas são dado da campanha.** A campanha é criada com `required_pieces`, uma lista tirada de `script`, `video`, `cover` e `caption`. O código nunca pergunta "é campanha de vídeo?": `blockingPieces(required, current)` percorre a lista que veio da campanha.

**Cada peça tem versões.** Enviar de novo cria a versão seguinte; a anterior continua consultável. A versão atual é a de maior número. Só a atual pode ser revisada ou comentada.

**Estado de uma peça** é o da sua versão atual: `missing` (nenhuma versão), `pending_review`, `changes_requested` ou `approved`.

**Status da entrega**, sempre calculado a partir das peças:

| Status | Quando |
|---|---|
| `in_production` | alguma peça exigida não tem a versão atual aprovada |
| `ready_for_approval` | todas as exigidas aprovadas; falta a marca aprovar a entrega |
| `approved` | todas as exigidas aprovadas e a marca aprovou a entrega |

- Aprovar a entrega com peça exigida pendente responde `409 required_pieces_pending`, com a lista do que falta e o estado de cada peça.
- Peça que a campanha não pediu aparece na entrega com `required: false` e não bloqueia, esteja como estiver.

**A aprovação vale para a versão atual.** A aprovação da marca é gravada (`signed_off_at`), mas o status é recalculado a cada leitura. Se uma peça exigida de uma entrega aprovada recebe versão nova:

1. a entrega volta a `in_production` na hora, e o histórico ganha `approval_suspended`;
2. quando a versão nova é aprovada, a entrega volta a `approved` e o histórico ganha `approval_restored`.

Não é preciso aprovar a entrega de novo: aprovar a versão nova já é o ato da marca que faltava. Se a versão nova recebe pedido de alteração, a entrega continua fora de aprovada.

**Comentário pertence à versão.** Um comentário é (versão, segundo, texto). Ele aparece em `GET /versions/:id` da versão em que foi feito e em nenhuma outra; a versão nova nasce sem comentários. Só vídeo aceita comentário, o segundo é inteiro e, se o vídeo declarou `duration_seconds`, não pode passar dela.

## API

| Rota | Faz |
|---|---|
| `POST /campaigns` | cria a campanha com `name` e `required_pieces` |
| `POST /deliveries` | cria a entrega de uma campanha (`campaign_id`) |
| `GET /deliveries/:id` | status, o que bloqueia, peças e histórico |
| `POST /deliveries/:id/pieces/:kind/versions` | envia versão nova da peça (`url`, `duration_seconds` opcional para vídeo) |
| `GET /versions/:id` | a versão e os comentários feitos nela |
| `POST /versions/:id/approval` | aprova a versão |
| `POST /versions/:id/change-requests` | pede alteração (`reason` obrigatório) |
| `POST /versions/:id/comments` | comenta num segundo do vídeo (`second`, `body`) |
| `POST /deliveries/:id/approval` | aprova a entrega |

Erros: `{ "error": { "code", "message" } }`, com `422` para entrada inválida, `409` para o que o estado não permite e `404` para o que não existe.

### Exemplos

Campanha que exige vídeo e capa, com o vídeo ainda em revisão e a capa não enviada:

```bash
curl -s -X POST localhost:3008/campaigns -H 'content-type: application/json' \
  -d '{"name":"Verão beleza","required_pieces":["video","cover"]}'
curl -s -X POST localhost:3008/deliveries -H 'content-type: application/json' -d '{"campaign_id":"cmp_…"}'
curl -s -X POST localhost:3008/deliveries/dlv_…/pieces/video/versions -H 'content-type: application/json' \
  -d '{"url":"https://cdn.exemplo/video-v1.mp4","duration_seconds":60}'
curl -s -X POST localhost:3008/deliveries/dlv_…/approval
```

```json
{
  "error": {
    "code": "required_pieces_pending",
    "message": "a campanha exige peças ainda não aprovadas: video (aguardando revisão), cover (não enviada)",
    "blocking": [
      { "kind": "video", "state": "pending_review" },
      { "kind": "cover", "state": "missing" }
    ]
  }
}
```

Comentário no segundo 12 da versão 1:

```bash
curl -s -X POST localhost:3008/versions/ver_…/comments -H 'content-type: application/json' \
  -d '{"second":12,"body":"Cortar esta pausa"}'
```

```json
{
  "id": "ver_…",
  "delivery_id": "dlv_…",
  "kind": "video",
  "number": 1,
  "url": "https://cdn.exemplo/video-v1.mp4",
  "duration_seconds": 60,
  "status": "pending_review",
  "review_reason": null,
  "submitted_at": "2026-03-10T15:00:00.000Z",
  "reviewed_at": null,
  "is_current": true,
  "comments": [
    { "id": "cmt_…", "second": 12, "body": "Cortar esta pausa", "created_at": "2026-03-10T15:00:00.000Z" }
  ]
}
```

Histórico de uma entrega aprovada que recebeu vídeo novo e teve o vídeo novo aprovado:

```
version_submitted, version_approved, version_submitted, version_approved, delivery_approved,
version_submitted, approval_suspended, version_approved, approval_restored
```

## O que ficou de fora

- **Pagamento.** O enunciado fala em liberar pagamento; aqui existe só o status. Quem paga precisa reagir a `approval_suspended`, e um pagamento já feito não é desfeito por este serviço.
- **Papéis.** Não há autenticação nem separação entre marca e criador; qualquer chamada aprova.
- **Reaprovar sozinho é uma escolha.** Li "deixa de estar aprovada até a nova versão ser aprovada" ao pé da letra. Se a marca precisar confirmar a entrega inteira de novo, a mudança é em `deliveryStatus`.
- **Mudar as peças exigidas de uma campanha** com entregas em andamento. Hoje a lista é fixada na criação.
- **Comentário em roteiro, capa e legenda**, resposta a comentário e marcar comentário como resolvido.
- **Upload real** e conferência de que a URL existe ou de que a duração informada é a do arquivo.
- Listagens, paginação e concorrência entre processos.

## Uso de IA

O código, os testes e este README foram escritos com Claude Code (Claude Opus), a partir do enunciado. O modelo de status calculado e a decisão de reaprovar sozinho foram propostos pela IA.

O que eu revisei: os padrões de backend, as tipagens, os early returns, as constantes e se os testes realmente testam os cenários de falha.
