import { createHash, timingSafeEqual } from 'node:crypto';
import { newTournament, snapshot, TournamentError, updateTournament } from './tournament.js';

const headers = {
  'Cache-Control': 'private, no-store',
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
};
const json = (status, data, extra = {}) =>
  Response.json(data, { status, headers: { ...headers, ...extra } });
const digest = value => createHash('sha256').update(value).digest();

function authenticated(request, password) {
  const authorization = request.headers.get('Authorization') ?? '';
  const token = authorization.match(/^Basic ([A-Za-z0-9+/]+={0,2})$/i)?.[1];
  if (!token) return false;
  let credentials;
  try {
    credentials = new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(atob(token), c => c.charCodeAt(0)));
  } catch {
    return false;
  }
  return timingSafeEqual(digest(credentials), digest('organizer:' + password));
}

async function readState(db) {
  const row = await db.prepare('SELECT state FROM tournament WHERE id = 1').first();
  return row ? JSON.parse(row.state) : newTournament();
}

async function readAction(request) {
  const reader = request.body?.getReader();
  let body = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  if (reader) {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 8192) {
        await reader.cancel();
        throw new TournamentError('The request is too large.');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  }
  try {
    const input = JSON.parse(body);
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch {
    // Use the same message for malformed JSON and invalid payload shapes.
  }
  throw new TournamentError('Send a valid tournament action.');
}

async function conflict(db) {
  return json(409, {
    error: 'The tournament changed in another window. The latest data is now displayed.',
    tournament: snapshot(await readState(db)),
  });
}

export default {
  async fetch(request, env) {
    try {
      if (!env.TOURNAMENT_PASSWORD) return json(503, { error: 'Tournament access has not been configured.' });
      if (!authenticated(request, env.TOURNAMENT_PASSWORD)) {
        return json(401, { error: 'Sign in as the tournament organizer.' }, {
          'WWW-Authenticate': 'Basic realm="School Chess Tournament", charset="UTF-8"',
        });
      }

      const { origin, pathname } = new URL(request.url);
      if (request.method === 'GET' && pathname === '/api/tournament') {
        return json(200, snapshot(await readState(env.DB)));
      }
      if (request.method === 'POST' && pathname === '/api/tournament/actions') {
        if (request.headers.get('Origin') !== origin) {
          return json(403, { error: 'Open the tournament directly to make changes.' });
        }
        if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json') {
          return json(415, { error: 'Send the action as JSON.' });
        }
        const input = await readAction(request);
        const state = await readState(env.DB);
        if (input.revision !== state.revision) return await conflict(env.DB);

        updateTournament(state, input.action, input);
        state.revision++;
        // Atomically initialize an empty tournament or update the exact revision
        // read above. A competing request from another window changes zero rows.
        const stored = JSON.stringify(state);
        const write = input.revision === 0
          ? env.DB.prepare('INSERT INTO tournament (id, revision, state) VALUES (1, ?, ?) ON CONFLICT(id) DO NOTHING')
            .bind(state.revision, stored)
          : env.DB.prepare('UPDATE tournament SET revision = ?, state = ? WHERE id = 1 AND revision = ?')
            .bind(state.revision, stored, input.revision);
        const result = await write.run();
        if (result.meta.changes !== 1) return await conflict(env.DB);
        return json(200, snapshot(state));
      }
      if (pathname.startsWith('/api/')) return json(404, { error: 'Page not found.' });
      const asset = await env.ASSETS.fetch(request);
      const response = new Response(asset.body, asset);
      for (const [name, value] of Object.entries(headers)) response.headers.set(name, value);
      return response;
    } catch (error) {
      if (error instanceof TournamentError) return json(400, { error: error.message });
      console.error(error);
      return json(500, { error: 'The server could not complete the request. Try again.' });
    }
  },
};
