import type { IncomingMessage, ServerResponse } from 'node:http';
import { createAppServer } from '../server.ts';

let serverPromise: ReturnType<typeof createAppServer> | null = null;

function getServerlessApp() {
  if (!serverPromise) {
    serverPromise = createAppServer({
      enableVite: false,
      serverless: true,
    }).catch((err) => {
      serverPromise = null;
      throw err;
    });
  }
  return serverPromise;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    const { app } = await getServerlessApp();
    app(req, res);
  } catch (err) {
    console.error('[vercel-api] Serverless handler startup error:', err);
    if (!res.headersSent) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(
        JSON.stringify({
          error: 'Service initialization failed.',
          detail: err instanceof Error ? err.message : 'Unknown initialization error',
        })
      );
    }
  }
}
