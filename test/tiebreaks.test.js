import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { newTournament, snapshot, standings, updateTournament } from '../backend/tournament.js';

const game = (white, black, result) => ({ white, black, result });
const bye = (id, result = 'bye') => game(id, null, result);
function group(ids, rounds) {
  return { players: ids.split('').map(id => ({ id, name: id })),
    rounds: rounds.map((matches, index) => ({ number: index + 1, matches })) };
}
const byId = ranked => Object.fromEntries(ranked.map(player => [player.id, player]));

test('checks all 31 reference records against FIDE 2026, preserving documented publication differences', () => {
  const fixture = JSON.parse(readFileSync(new URL('./fixtures/chess-results-1477698.json', import.meta.url)));
  const rounds = Array.from({ length: 7 }, (_, index) => ({ number: index + 1, matches: [] }));
  for (const player of fixture.players) {
    for (const [r, value] of player.rounds.entries()) {
      if (value === '-0') {
        rounds[r].matches.push(bye(player.id, 'zero-bye'));
        continue;
      }
      const [, opponent, color, score] = value.match(/^(\d+)([wb])([10½+\-])$/);
      if (Number(player.id) > Number(opponent)) continue;
      const other = fixture.players.find(p => p.id === opponent).rounds[r].at(-1);
      const white = color === 'w' ? player.id : opponent;
      const black = color === 'b' ? player.id : opponent;
      const result = score === '½' ? 'draw' : score === '-' && other === '-' ? 'double-forfeit' :
        ['+', '-'].includes(score) ? ((score === '+') === (color === 'w') ? 'white-forfeit' : 'black-forfeit') :
          ((score === '1') === (color === 'w') ? 'white' : 'black');
      rounds[r].matches.push(game(white, black, result));
    }
  }
  const ranked = standings({ players: fixture.players.map(p => ({ id: p.id, name: p.id.padStart(2, '0') })), rounds }, 7);
  const actual = byId(ranked);
  // See docs/tiebreaks.md. The published crosstable alone does not reproduce
  // Article 16.3.2. Never silently change FIDE rules to fit these numbers.
  const differences = {
    3: [0.5, 0.5], 4: [0.5, 0.5], 5: [0.5, 0.5], 10: [0.5, 0.5], 13: [0.5, 0.5],
    15: [0.5, 0.5], 18: [1, 1], 19: [0.5, 0.5], 20: [0.5, 0.5], 21: [1, 1],
    22: [1, 0.5], 23: [1, 1], 24: [1.5, 0.5], 25: [0.5, 0.5], 27: [0.5, 0],
  };
  for (const expected of fixture.players) {
    const values = [actual[expected.id].points, actual[expected.id].buchholz, actual[expected.id].sonnebornBerger];
    const [bh, sb] = differences[expected.id] ?? [0, 0];
    assert.deepEqual(values, [expected.points, expected.bh + bh, expected.sb + sb], 'reference player ' + expected.id);
  }
  // Published 26/27 share BH/SB; applying Article 16.3.2 gives 27 a higher BH.
  assert.deepEqual(ranked.map(p => p.id), [
    '1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11', '12', '13', '15', '14',
    '16', '18', '17', '19', '20', '21', '22', '23', '24', '25', '27', '26', '28', '29', '30', '31',
  ]);
});

test('two-player DE outranks a higher SB; a draw falls through to BH/SB', () => {
  const g = group('abcd', [
    [game('a', 'b', 'white'), game('c', 'd', 'draw')],
    [game('a', 'c', 'black'), game('b', 'd', 'white')],
    [game('a', 'd', 'black'), game('b', 'c', 'black')],
  ]);
  let p = byId(standings(g));
  assert.equal(p.a.points, p.b.points);
  assert.ok(p.b.sonnebornBerger > p.a.sonnebornBerger);
  assert.ok(p.a.rank < p.b.rank);
  assert.deepEqual([p.a.directEncounter, p.b.directEncounter], [1, 0]);
  g.rounds[0].matches[0].result = 'draw';
  // Direct Encounter values are recalculated from the new score groups.
  p = byId(standings(g));
  assert.deepEqual([p.a.points, p.b.points], [0.5, 1.5]);
});

test('a drawn DE uses BH, and an unplayed head-to-head is excluded', () => {
  const g = group('abcd', [
    [game('a', 'b', 'draw'), game('c', 'd', 'white')],
    [game('a', 'c', 'draw'), game('b', 'd', 'draw')],
  ]);
  let p = byId(standings(g));
  assert.deepEqual([p.a.directEncounter, p.b.directEncounter], [0.5, 0.5]);
  assert.ok(p.a.buchholz > p.b.buchholz);
  assert.ok(p.a.rank < p.b.rank);
  g.rounds[0].matches[0].result = 'white-forfeit';
  g.rounds[1].matches = [game('a', 'c', 'black'), game('b', 'd', 'white')];
  p = byId(standings(g));
  assert.equal(p.a.points, p.b.points);
  assert.equal(p.a.directEncounter, null);
  assert.equal(p.b.directEncounter, null);
});

test('three-player win cycle stays tied, independent of roster order', () => {
  const g = group('abc', [
    [game('a', 'b', 'white'), bye('c')],
    [game('b', 'c', 'white'), bye('a')],
    [game('c', 'a', 'white'), bye('b')],
  ]);
  const ranked = standings(g);
  assert.deepEqual(ranked.map(p => [p.rank, p.directEncounter]), [[1, 1], [1, 1], [1, 1]]);
  g.players.reverse();
  assert.deepEqual(standings(g), ranked);
});

test('complete four-player mini-table reapplies DE to each remaining tied subset', () => {
  const g = group('abcd', [
    [game('a', 'b', 'white'), game('c', 'd', 'white')],
    [game('a', 'c', 'white'), game('b', 'd', 'white')],
    [game('d', 'a', 'white'), game('b', 'c', 'white')],
    [bye('a', 'zero-bye'), bye('b', 'zero-bye'), bye('c'), bye('d')],
  ]);
  assert.deepEqual(standings(g).map(p => [p.id, p.points, p.directEncounterPath, p.rank]), [
    ['a', 2, [2, 1], 1], ['b', 2, [2, 0], 2], ['c', 2, [1, 1], 3], ['d', 2, [1, 0], 4],
  ]);
});

test('incomplete DE extracts only a mathematically guaranteed leader', () => {
  const g = group('abcd', [
    [game('a', 'b', 'white'), game('c', 'd', 'draw')],
    [game('a', 'c', 'white'), game('b', 'd', 'draw')],
    [bye('a', 'zero-bye'), bye('b'), bye('c'), bye('d')],
    [bye('a', 'half-bye'), bye('b'), bye('c'), bye('d', 'zero-bye')],
  ]);
  // a,b,c all have 2.5; a has beaten both so is guaranteed first.
  let p = byId(standings(g));
  assert.deepEqual([p.a.points, p.b.points, p.c.points], [2.5, 2.5, 2.5]);
  assert.ok(p.a.rank < p.b.rank && p.a.rank < p.c.rank);
  assert.equal(p.a.directEncounter, 2);
  // Incomplete group with no guaranteed leader must skip DE entirely.
  const incomplete = group('abcd', [[game('a', 'b', 'draw'), game('c', 'd', 'draw')]]);
  assert.ok(standings(incomplete).every(p => p.directEncounter === null && p.rank === 1));
});

test('repeated encounters use their average in DE rather than their sum', () => {
  const g = group('abc', [
    [game('a', 'b', 'white'), bye('c', 'zero-bye')],
    [game('a', 'b', 'black'), bye('c', 'zero-bye')],
    [game('a', 'c', 'draw'), bye('b', 'half-bye')],
    [game('b', 'c', 'draw'), bye('a', 'half-bye')],
    [bye('a', 'zero-bye'), bye('b', 'zero-bye'), bye('c')],
  ]);
  assert.ok(standings(g).every(p => p.points === 2 && p.directEncounter === 1 && p.rank === 1));
});

test('2026 dummy scores cap byes and forfeits and exclude unplayed colors', () => {
  const g = group('ab', [[game('a', 'b', 'white-forfeit')], [bye('a'), bye('b', 'half-bye')]]);
  const p = byId(standings(g, 2));
  // a's forfeit dummy is capped by b's adjusted 0.5; bye dummy capped at 1.
  assert.deepEqual([p.a.points, p.a.buchholz, p.a.sonnebornBerger], [2, 1.5, 1.5]);
  assert.deepEqual([p.b.points, p.b.buchholz, p.b.sonnebornBerger], [0.5, 1, 0.25]);
  assert.deepEqual(p.a.colors, []);
  assert.equal(p.a.directEncounter, null);
});

test('trailing requested byes adjust opponents scores until a non-VUR occurs', () => {
  const g = group('abc', [
    [game('a', 'b', 'white'), bye('c')],
    [bye('a'), bye('b', 'zero-bye'), bye('c')],
    [game('b', 'c', 'black-forfeit'), bye('a')],
  ]);
  let p = byId(standings(g));
  // b has zero points; its trailing requested bye is a draw for a's BH/SB.
  assert.equal(p.a.buchholz, 4.5);
  assert.equal(p.a.sonnebornBerger, 4.5);
  // Playing a later round stops the requested bye being a trailing VUR.
  g.rounds[2].matches[0].result = 'black';
  p = byId(standings(g));
  assert.equal(p.a.buchholz, 4);
});

test('pending games do not count as played, forfeited, or withdrawn', () => {
  const g = group('abc', [[game('a', 'b', null), bye('c')]]);
  const p = byId(standings(g));
  assert.deepEqual([p.a.points, p.a.buchholz, p.a.byes, p.a.directEncounter], [0, 0, 0, null]);
  assert.deepEqual(p.a.colors, []);
  assert.deepEqual([p.c.buchholz, p.c.sonnebornBerger], [1, 1]);
});

test('result editing validates types and recalculates standings without changing pairings', () => {
  const tournament = newTournament();
  tournament.groups.A = group('ab', [[{ ...game('a', 'b', null), id: 'board' }]]);
  for (const result of ['white-forfeit', 'black-forfeit', 'double-forfeit', 'draw', null]) {
    updateTournament(tournament, 'result', { group: 'A', match: 'board', result });
    assert.equal(tournament.groups.A.rounds[0].matches[0].result, result);
    const p = byId(snapshot(tournament).groups.A.standings);
    assert.equal(p.a.points + p.b.points, result === null || result === 'double-forfeit' ? 0 : 1);
  }
  assert.throws(() => updateTournament(tournament, 'result', { group: 'A', match: 'board', result: 'bye' }));
  tournament.groups.A.rounds[0].matches.push({ ...bye('c'), id: 'bye' });
  tournament.groups.A.players.push({ id: 'c', name: 'c' });
  for (const result of ['half-bye', 'zero-bye', 'bye']) {
    updateTournament(tournament, 'result', { group: 'A', match: 'bye', result });
    assert.equal(byId(snapshot(tournament).groups.A.standings).c.points, result === 'bye' ? 1 : result === 'half-bye' ? 0.5 : 0);
  }
  assert.throws(() => updateTournament(tournament, 'result', { group: 'A', match: 'bye', result: 'white' }));
});
