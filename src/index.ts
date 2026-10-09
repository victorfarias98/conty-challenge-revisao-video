import { serve } from "@hono/node-server";
import { createApp } from "./app.ts";
import { openDatabase } from "./db.ts";

const db = openDatabase(process.env.DB_PATH ?? "data/revisao-video.sqlite");
const port = Number(process.env.PORT ?? 3008);

serve({ fetch: createApp(db).fetch, port }, (info) => {
  console.log(`revisão de vídeo em http://127.0.0.1:${info.port}`);
});
