import type { DatabaseSync } from "node:sqlite";
import { Hono } from "hono";
import type { Context } from "hono";
import { type Clock, ReviewError, createReview } from "./review.ts";

async function jsonBody(c: Context): Promise<Record<string, unknown>> {
  const body: unknown = await c.req.json().catch(() => null);
  return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}

export function createApp(db: DatabaseSync, clock: Clock = () => new Date()) {
  const review = createReview(db, clock);
  const app = new Hono();

  app.onError((error, c) => {
    if (error instanceof ReviewError) {
      const body = { code: error.code, message: error.message, ...(error.blocking ? { blocking: error.blocking } : {}) };
      return c.json({ error: body }, error.status);
    }
    console.error(error);
    return c.json({ error: { code: "internal_error", message: "erro interno" } }, 500);
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.post("/campaigns", async (c) => c.json(review.createCampaign(await jsonBody(c)), 201));

  app.post("/deliveries", async (c) => c.json(review.createDelivery(await jsonBody(c)), 201));

  app.get("/deliveries/:id", (c) => c.json(review.deliveryView(c.req.param("id"))));

  app.post("/deliveries/:id/approval", (c) => c.json(review.approveDelivery(c.req.param("id"))));

  app.post("/deliveries/:id/pieces/:kind/versions", async (c) =>
    c.json(review.submitVersion(c.req.param("id"), c.req.param("kind"), await jsonBody(c)), 201),
  );

  app.get("/versions/:id", (c) => c.json(review.versionView(c.req.param("id"))));

  app.post("/versions/:id/approval", (c) => c.json(review.approveVersion(c.req.param("id"))));

  app.post("/versions/:id/change-requests", async (c) =>
    c.json(review.requestChanges(c.req.param("id"), await jsonBody(c))),
  );

  app.post("/versions/:id/comments", async (c) => c.json(review.comment(c.req.param("id"), await jsonBody(c)), 201));

  return app;
}
