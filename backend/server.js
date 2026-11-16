import { createServer } from 'node:http';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { newTournament, snapshot, TournamentError, updateTournament } from './tournament.js';

const defaultFile = fileURLToPath(new URL('../data/tournament.json', import.meta.url));
const assets = new Map([
  ['/', ['index.html', 'text/html']],
  ['/styles.css', ['styles.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
]);

function send(response, status, type, body) {
  response.writeHead(status, {
    'Content-Type': type + '; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
  });
  response.end(body);
}

const json = (response, status, data) => send(response, status, 'application/json', JSON.stringify(data));

async function readAction(request) {
  let body = '';
  request.setEncoding('utf8');
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    body += chunk;
    if (body.length > 8192) throw new TournamentError('The request is too large.');
  }
  try {
    const input = JSON.parse(body);
    if (input && typeof input === 'object' && !Array.isArray(input)) return input;
  } catch {
    // Report a single error for invalid JSON and invalid payload shapes.
  }
  throw new TournamentError('Send a valid tournament action.');
}

export function createTournamentServer(file = defaultFile) {
  let state;
  try {
    state = JSON.parse(readFileSync(file, 'utf8'));
    snapshot(state);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    state = newTournament();
  }
  const save = next => {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file + '.tmp', JSON.stringify(next, null, 2), 'utf8');
    renameSync(file + '.tmp', file);
    state = next;
  };

  return createServer(async (request, response) => {
    const path = request.url.split('?')[0];
    try {
      if (request.method === 'GET' && path === '/api/tournament') {
        return json(response, 200, snapshot(state));
      }
      if (request.method === 'POST' && path === '/api/tournament/actions') {
        const localOrigin = 'http://' + request.headers.host;
        if (request.headers['sec-fetch-site'] === 'cross-site' ||
            (request.headers.origin && request.headers.origin !== localOrigin)) {
          return json(response, 403, { error: 'Open the tournament directly to make changes.' });
        }
        if (request.headers['content-type']?.split(';')[0] !== 'application/json') {
          return json(response, 415, { error: 'Send the action as JSON.' });
        }
        const input = await readAction(request);
        if (input.revision !== state.revision) {
          return json(response, 409, {
            error: 'The tournament changed in another window. The latest data is now displayed.',
            tournament: snapshot(state),
          });
        }
        const next = structuredClone(state);
        updateTournament(next, input.action, input);
        next.revision++;
        save(next);
        return json(response, 200, snapshot(state));
      }
      if (request.method === 'GET' && assets.has(path)) {
        const [filename, type] = assets.get(path);
        return send(response, 200, type, readFileSync(new URL('../frontend/' + filename, import.meta.url)));
      }
      return json(response, 404, { error: 'Page not found.' });
    } catch (error) {
      if (error instanceof TournamentError) return json(response, 400, { error: error.message });
      console.error(error);
      return json(response, 500, { error: 'The server could not complete the request. Try again.' });
    }
  });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT ?? 3000);
  const server = createTournamentServer();
  server.listen(port, '127.0.0.1', () => {
    console.log('Chess tournament running at http://127.0.0.1:' + server.address().port);
  });
}
