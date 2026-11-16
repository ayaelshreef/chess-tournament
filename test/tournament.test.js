import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createTournamentServer } from '../backend/server.js';
import { newTournament, standings, updateTournament } from '../backend/tournament.js';

test('standings count byes in opponent scores and retain quarter-point tie-breaks', () => {
  const players = ['a', 'b', 'c'].map(id => ({ id, name: id }));
  const rounds = [
    { matches: [{ white: 'a', black: 'b', result: 'draw' }, { white: 'c', black: null, result: 'bye' }] },
    { matches: [{ white: 'a', black: 'c', result: 'white' }, { white: 'b', black: null, result: 'bye' }] },
  ];
  const score = standings({ players, rounds }).map(p =>
    [p.id, p.points, p.buchholz, p.sonnebornBerger, p.wins, p.rank]);
  assert.deepEqual(score, [['a', 1.5, 2.5, 1.75, 1, 1], ['b', 1.5, 1.5, 0.75, 0, 2], ['c', 1, 1.5, 0, 0, 3]]);
});

test('odd groups rotate byes and avoid repeat opponents', () => {
  for (const size of [5, 9, 21, 23]) {
    const tournament = newTournament();
    const update = (action, payload) => updateTournament(tournament, action, { group: 'A', ...payload });
    for (let i = 0; i < size; i++) update('add-player', { name: 'Student ' + i, grade: 5 });
    const played = new Set();
    const byes = new Set();
    for (let round = 0; round < 4; round++) {
      update('generate');
      const participants = new Set();
      for (const match of tournament.groups.A.rounds.at(-1).matches) {
        assert.ok(!participants.has(match.white));
        participants.add(match.white);
        if (match.black === null) {
          assert.ok(!byes.has(match.white));
          byes.add(match.white);
          continue;
        }
        assert.ok(!participants.has(match.black));
        participants.add(match.black);
        const key = [match.white, match.black].sort().join(':');
        assert.ok(!played.has(key));
        played.add(key);
        update('result', { match: match.id, result: 'draw' });
      }
      assert.equal(participants.size, size);
    }
    assert.equal(byes.size, 4);
  }
});

test('runs a 20-student tournament through the API and restores it after restart', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'chess-tournament-'));
  const file = join(dir, 'tournament.json');
  let server;
  async function start() {
    server = createTournamentServer(file).listen(0, '127.0.0.1');
    await once(server, 'listening');
    return 'http://127.0.0.1:' + server.address().port;
  }
  async function stop() {
    if (server?.listening) await new Promise(resolve => server.close(resolve));
  }
  try {
    let url = await start();
    const homepage = await fetch(url);
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /School Chess Championship/);
    for (const path of ['/app.js', '/styles.css']) assert.equal((await fetch(url + path)).status, 200);
    let current = await (await fetch(url + '/api/tournament')).json();
    async function action(name, payload, expectedStatus = 200) {
      const response = await fetch(url + '/api/tournament/actions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ revision: current.revision, action: name, ...payload }),
      });
      const data = await response.json();
      assert.equal(response.status, expectedStatus, JSON.stringify(data));
      if (response.ok) current = data;
      return data;
    }
    for (const [group, count, grade] of [['A', 8, 5], ['B', 12, 8]]) {
      for (let i = 0; i < count; i++) await action('add-player', { group, grade, name: group + ' student ' + i });
      const played = new Set();
      for (let round = 1; round <= 4; round++) {
        await action('generate', { group });
        const { matches } = current.groups[group].rounds.at(-1);
        assert.equal(matches.length, count / 2);
        await action('generate', { group }, 400);
        const participants = matches.flatMap(match => [match.white, match.black]);
        assert.equal(new Set(participants).size, count);
        for (const match of matches) {
          const key = [match.white, match.black].sort().join(':');
          assert.ok(!played.has(key));
          played.add(key);
          await action('result', { group, match: match.id, result: 'draw' });
        }
        assert.equal(current.groups[group].completedRounds, round);
      }
      assert.equal(current.groups[group].tiedForFirst.length, count);
      assert.equal(current.groups[group].finalist, null);
      await action('final', { result: 'A' }, 400);
      const player = current.groups[group].tiedForFirst.at(-1).id;
      await action('playoff', { group, player });
      assert.equal(current.groups[group].finalist.id, player);
    }
    await action('final', { result: 'draw' });
    await action('final', { result: 'A' });
    await action('final', { result: 'B', revision: current.revision - 1 }, 409);
    await stop();
    url = await start();
    assert.deepEqual(await (await fetch(url + '/api/tournament')).json(), current);
    await action('delete-round', { group: 'A', round: 4 });
    assert.equal(current.final, null);
    assert.equal(current.groups.A.finalist, null);
  } finally {
    await stop();
    await rm(dir, { recursive: true, force: true });
  }
});
