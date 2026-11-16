import { randomInt, randomUUID } from 'node:crypto';

export const grades = { A: [4, 5, 6], B: [7, 8, 9, 10, 11, 12] };
export const newTournament = () => ({
  revision: 0,
  groups: Object.fromEntries(Object.keys(grades).map(id =>
    [id, { players: [], rounds: [], playoffWinner: null }])),
  final: null,
});

const results = ['white', 'draw', 'black'];
const complete = round => round.matches.every(match => match.result !== null);
const pairKey = (a, b) => a < b ? a + ':' + b : b + ':' + a;
const compare = (a, b) => b.points - a.points || b.buchholz - a.buchholz ||
  b.sonnebornBerger - a.sonnebornBerger || b.wins - a.wins;

export function standings(group) {
  const players = new Map(group.players.map(player => [player.id, {
    ...player, points: 0, buchholz: 0, sonnebornBerger: 0, wins: 0, byes: 0, colors: [],
  }]));
  const played = group.rounds.flatMap(round => round.matches).filter(match => match.result !== null);
  for (const match of played) {
    const white = players.get(match.white);
    if (match.black === null) {
      white.points++;
      white.byes++;
      continue;
    }
    const black = players.get(match.black);
    white.colors.push('white');
    black.colors.push('black');
    if (match.result === 'draw') {
      white.points += 0.5;
      black.points += 0.5;
    } else {
      const winner = match.result === 'white' ? white : black;
      winner.points++;
      winner.wins++;
    }
  }
  for (const match of played) {
    if (match.black === null) continue;
    const white = players.get(match.white);
    const black = players.get(match.black);
    white.buchholz += black.points;
    black.buchholz += white.points;
    if (match.result === 'draw') {
      white.sonnebornBerger += black.points / 2;
      black.sonnebornBerger += white.points / 2;
    } else if (match.result === 'white') {
      white.sonnebornBerger += black.points;
    } else {
      black.sonnebornBerger += white.points;
    }
  }
  const ranked = [...players.values()].sort((a, b) => compare(a, b) || a.name.localeCompare(b.name));
  let rank = 0;
  return ranked.map((player, index) => {
    if (index === 0 || compare(ranked[index - 1], player)) rank = index + 1;
    return { ...player, rank };
  });
}

function colorCost(player, color) {
  const colors = player.colors;
  const balance = colors.reduce((sum, current) => sum + (current === color ? 1 : -1), 1);
  const sameAsLast = colors.at(-1) === color;
  return Math.abs(balance) * 3 + (sameAsLast ? 7 : 0) +
    (sameAsLast && colors.at(-2) === color ? 40 : 0);
}

function makePair(a, b, history) {
  const forward = colorCost(a, 'white') + colorCost(b, 'black');
  const reverse = colorCost(a, 'black') + colorCost(b, 'white');
  const gap = Math.abs(a.points - b.points);
  const repeat = history.has(pairKey(a.id, b.id));
  return {
    white: reverse < forward ? b.id : a.id,
    black: reverse < forward ? a.id : b.id,
    repeat,
    cost: (repeat ? 100_000 : 0) + gap * 150 + gap ** 2 * 50 + Math.min(forward, reverse),
  };
}

function exactPairing(players, history) {
  const pairs = players.map(a => players.map(b => makePair(a, b, history)));
  const all = (1 << players.length) - 1;
  const costs = new Float64Array(all + 1);
  const partner = new Int8Array(all + 1).fill(-1);
  const index = bit => 31 - Math.clz32(bit);

  function solve(mask) {
    if (!mask || partner[mask] >= 0) return costs[mask];
    const first = mask & -mask;
    const i = index(first);
    let best = Infinity;
    for (let bits = mask ^ first; bits; bits &= bits - 1) {
      const bit = bits & -bits;
      const j = index(bit);
      const cost = pairs[i][j].cost + solve(mask ^ first ^ bit);
      if (cost < best) {
        best = cost;
        partner[mask] = j;
      }
    }
    return costs[mask] = best;
  }

  solve(all);
  const selected = [];
  for (let mask = all; mask;) {
    const i = index(mask & -mask);
    const j = partner[mask];
    selected.push(pairs[i][j]);
    mask ^= (1 << i) | (1 << j);
  }
  return selected;
}

function largePairing(players, history) {
  const remaining = [...players];
  const boards = [];
  while (remaining.length) {
    const a = remaining.shift();
    let best = 0;
    let cost = Infinity;
    for (const [i, b] of remaining.entries()) {
      const candidate = makePair(a, b, history).cost;
      if (candidate < cost) {
        cost = candidate;
        best = i;
      }
    }
    boards.push([a, remaining.splice(best, 1)[0]]);
  }
  // With at most three prior opponents per player, at most six other boards
  // can obstruct a swap. This branch always has at least eleven boards.
  for (const [i, [a, b]] of boards.entries()) {
    if (!history.has(pairKey(a.id, b.id))) continue;
    let best = null;
    for (const [j, [c, d]] of boards.entries()) {
      if (i === j) continue;
      for (const [x, y] of [[c, d], [d, c]]) {
        const first = makePair(a, x, history);
        const second = makePair(b, y, history);
        const cost = first.cost + second.cost;
        if (!first.repeat && !second.repeat && (!best || cost < best.cost)) best = { j, x, y, cost };
      }
    }
    if (best) {
      boards[i] = [a, best.x];
      boards[best.j] = [b, best.y];
    }
  }
  return boards.map(([a, b]) => makePair(a, b, history));
}

function generate(group) {
  const ranked = standings(group);
  if (!group.rounds.length) {
    for (let i = ranked.length - 1; i > 0; i--) {
      const j = randomInt(i + 1);
      [ranked[i], ranked[j]] = [ranked[j], ranked[i]];
    }
  }
  const history = new Set(group.rounds.flatMap(round => round.matches)
    .filter(match => match.black !== null).map(match => pairKey(match.white, match.black)));
  const lowestFirst = [...ranked].reverse();
  const withoutBye = lowestFirst.filter(player => !player.byes);
  const candidates = ranked.length % 2 ? (withoutBye.length ? withoutBye : lowestFirst) : [null];
  let best;
  for (const bye of candidates) {
    const players = ranked.filter(player => player !== bye);
    const pairing = players.length <= 20 ? exactPairing(players, history) : largePairing(players, history);
    const repeats = pairing.filter(pair => pair.repeat).length;
    if (!best || repeats < best.repeats) best = { bye, pairing, repeats };
    if (!repeats) break;
  }
  const matches = best.pairing.map(({ white, black, repeat }) =>
    ({ id: randomUUID(), white, black, repeat, result: null }));
  if (best.bye) matches.push({ id: randomUUID(), white: best.bye.id, black: null, result: 'bye' });
  return { number: group.rounds.length + 1, matches };
}

function qualifiers(group, ranked = standings(group)) {
  if (group.rounds.length !== 4 || !group.rounds.every(complete)) return [];
  return ranked.filter(player => player.rank === 1);
}

export function snapshot(tournament) {
  const groups = Object.fromEntries(Object.entries(tournament.groups).map(([id, group]) => {
    const ranked = standings(group);
    const tied = qualifiers(group, ranked);
    const finalist = tied.length === 1 ? tied[0] : tied.find(player => player.id === group.playoffWinner);
    return [id, { ...group, grades: grades[id], standings: ranked,
      completedRounds: group.rounds.filter(complete).length,
      tiedForFirst: tied.length > 1 ? tied : [], finalist: finalist ?? null,
    }];
  }));
  return { ...tournament, groups };
}

export class TournamentError extends Error {}

function requireRule(condition, message) {
  if (!condition) throw new TournamentError(message);
}

export function updateTournament(tournament, action, input) {
  if (action === 'final') {
    const { groups } = snapshot(tournament);
    requireRule(groups.A.finalist && groups.B.finalist, 'Confirm both group winners first.');
    requireRule([null, 'A', 'B', 'draw'].includes(input.result), 'Choose a valid final result.');
    tournament.final = input.result;
    return;
  }

  requireRule(Object.hasOwn(grades, input.group), 'Choose Group A or Group B.');
  const group = tournament.groups[input.group];
  const latest = group.rounds.at(-1);
  switch (action) {
    case 'add-player': {
      requireRule(!latest, 'Delete the generated rounds before changing the roster.');
      const name = typeof input.name === 'string' ? input.name.trim() : '';
      const className = typeof input.className === 'string' ? input.className.trim() : '';
      requireRule(name.length > 0 && name.length <= 80, 'Enter a student name of up to 80 characters.');
      requireRule(grades[input.group].includes(input.grade), 'Choose a grade in this group.');
      requireRule(className.length <= 30, 'Enter a class of up to 30 characters.');
      group.players.push({ id: randomUUID(), name, grade: input.grade, className });
      return;
    }
    case 'remove-player':
      requireRule(!latest, 'Delete the generated rounds before changing the roster.');
      requireRule(group.players.some(player => player.id === input.player), 'Student was not found.');
      group.players = group.players.filter(player => player.id !== input.player);
      return;
    case 'generate':
      requireRule(group.players.length >= 2, 'Register at least two students.');
      requireRule(group.rounds.length < 4, 'All four rounds have been generated.');
      requireRule(!latest || complete(latest), 'Record all results before generating the next round.');
      group.rounds.push(generate(group));
      return;
    case 'result': {
      const match = latest?.matches.find(game => game.id === input.match);
      requireRule(match && match.black !== null, 'Choose a game in the latest round.');
      requireRule(input.result === null || results.includes(input.result), 'Choose a valid game result.');
      if (match.result === input.result) return;
      match.result = input.result;
      break;
    }
    case 'delete-round':
      requireRule(latest && latest.number === input.round, 'Choose the latest round.');
      group.rounds.pop();
      break;
    case 'playoff': {
      const tied = qualifiers(group);
      requireRule(tied.length > 1, 'There is no unresolved group tie for first place.');
      requireRule(input.player === null || tied.some(player => player.id === input.player),
        'Choose a student tied for first place.');
      group.playoffWinner = input.player;
      tournament.final = null;
      return;
    }
    default:
      throw new TournamentError('Unknown tournament action.');
  }
  group.playoffWinner = null;
  tournament.final = null;
}
