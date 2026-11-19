import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';
import { newTournament, snapshot } from '../backend/tournament.js';

test('dashboard renders the new columns, contextual DE and unplayed result options', async () => {
  const state = newTournament();
  state.groups.A.players = ['a', 'b', 'c'].map(id => ({ id, name: id, grade: 5 }));
  state.groups.A.rounds = [{ number: 1, matches: [
    { id: 'board', white: 'a', black: 'b', result: 'draw' },
    { id: 'bye', white: 'c', black: null, result: 'bye' },
  ] }];
  const elements = Object.fromEntries(['#dashboard', '#navigation', '#notice'].map(id =>
    [id, { innerHTML: '', addEventListener() {} }]));
  vm.runInNewContext(readFileSync(new URL('../frontend/app.js', import.meta.url), 'utf8'), {
    document: { querySelector: id => elements[id] },
    fetch: async () => ({ ok: true, json: async () => snapshot(state) }),
  });
  await new Promise(resolve => setImmediate(resolve));
  const html = elements['#dashboard'].innerHTML;
  const header = html.match(/<thead>(.*?)<\/thead>/s)[1].replace(/<[^>]*>/g, '').replace(/\s+/g, ' ').trim();
  assert.equal(header, 'RankStudentPoints DE BHSB Byes');
  assert.match(html, /<td>0\.5<\/td>/);
  for (const result of ['white-forfeit', 'black-forfeit', 'double-forfeit', 'half-bye', 'zero-bye']) {
    assert.ok(html.includes('value="' + result + '"'), result);
  }
});
