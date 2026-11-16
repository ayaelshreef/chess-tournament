const dashboard = document.querySelector('#dashboard');
const navigation = document.querySelector('#navigation');
const notice = document.querySelector('#notice');
const labels = { A: 'Group A', B: 'Group B', final: 'Championship final' };
const grades = { A: 'Grades 4–6', B: 'Grades 7–12' };
const resultChoices = [
  ['', 'Awaiting result'], ['white', '1–0 · White wins'], ['draw', '½–½ · Draw'], ['black', '0–1 · Black wins'],
];
const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const options = (choices, selected) => choices.map(([value, label]) =>
  `<option value="${esc(value)}" ${value === (selected ?? '') ? 'selected' : ''}>${esc(label)}</option>`).join('');
let tournament;
let section = 'A';
let roundNumber = null;
let busy = false;

async function load() {
  const response = await fetch('/api/tournament');
  if (!response.ok) throw new Error('The tournament could not be loaded.');
  tournament = await response.json();
  render();
}

async function action(name, payload = {}) {
  if (busy) return;
  busy = true;
  notice.textContent = '';
  dashboard.setAttribute('aria-busy', 'true');
  const focus = document.activeElement?.id;
  const revision = tournament.revision;
  let registered = false;
  try {
    const response = await fetch('/api/tournament/actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: name, group: section, revision, ...payload }),
    });
    const data = await response.json();
    if (!response.ok) {
      if (data.tournament) tournament = data.tournament;
      throw new Error(data.error);
    }
    tournament = data;
    registered = name === 'add-player';
    if (name === 'generate' || name === 'delete-round') roundNumber = null;
    render();
    notice.textContent = ({
      'add-player': 'Student added.', 'remove-player': 'Student removed.', generate: 'Round generated.',
      result: 'Result saved.', 'delete-round': 'Round deleted.', playoff: 'Playoff result saved.', final: 'Final result saved.',
    })[name];
  } catch (error) {
    if (name !== 'add-player' || revision !== tournament.revision) render();
    notice.textContent = error.message || 'The change could not be saved.';
  } finally {
    busy = false;
    dashboard.removeAttribute('aria-busy');
    if (registered || focus) document.getElementById(registered ? 'student' : focus)?.focus();
  }
}

function render() {
  navigation.innerHTML = Object.entries(labels).map(([id, label]) =>
    `<button id="nav-${id}" data-section="${id}" ${id === section ? 'aria-current="page"' : ''}>${label}</button>`).join('');
  dashboard.innerHTML = section === 'final' ? finalPage() : groupPage(tournament.groups[section]);
}

function groupPage(group) {
  const latest = group.rounds.at(-1);
  const pending = latest?.matches.filter(match => match.result === null).length ?? 0;
  const round = group.rounds.find(item => item.number === roundNumber) ?? latest;
  const canGenerate = group.players.length >= 2 && group.rounds.length < 4 && !pending;

  return `<section class="hero">
    <div class="heading"><p class="eyebrow">${grades[section]}</p><h1>${labels[section]}</h1>
      <p>${group.players.length} registered · ${group.completedRounds} of 4 rounds complete</p></div>
    <div class="round-track" aria-label="Round progress">${[1, 2, 3, 4].map(number => {
      const status = number <= group.completedRounds ? 'Complete' : number <= group.rounds.length ? 'In play' : 'Upcoming';
      return `<button id="round-${number}" class="round-square" data-round="${number}"
        aria-label="Round ${number}, ${status}" aria-pressed="${round?.number === number}"
        ${number > group.rounds.length ? 'disabled' : ''}><strong>${number}</strong><small>${status}</small></button>`;
    }).join('')}</div>
  </section>
  <div class="desk">
    <div class="desk-main">
      <section class="panel">
        <div class="panel-head"><div><h2>Pairings &amp; results</h2>
          ${round ? `<p>Round ${round.number} · ${round === latest ? (pending ? pending + ' results pending' : 'Complete') : 'Complete · locked'}</p>` : ''}
        </div>
        <button id="generate" class="primary" data-action="generate" ${canGenerate ? '' : 'disabled'}>${group.rounds.length === 4 ? 'All rounds generated' : 'Generate round ' + (group.rounds.length + 1)}</button></div>
        ${round ? boards(group, round, latest) : '<p class="empty">Register at least two students to generate the first round.</p>'}
        ${round && round === latest ? `<button class="link danger" data-delete="${round.number}">Delete round ${round.number}</button>` : ''}
      </section>
      <section class="panel">
        <div class="panel-head"><div><h2>Standings</h2><p>Points → Buchholz → Sonneborn–Berger → Wins</p></div></div>
        ${standings(group)}
        ${group.tiedForFirst.length ? `<div class="callout">
          <label for="playoff">Playoff winner</label>
          <p>First place is tied. Hold a playoff and choose its winner here.</p>
          <select id="playoff" data-playoff>${options([['', 'Awaiting playoff'], ...group.tiedForFirst.map(p => [p.id, p.name + (p.className ? ' · ' + p.className : '')])], group.playoffWinner)}</select>
        </div>` : ''}
        ${group.finalist ? `<p class="callout success">${labels[section]} winner · <strong>${esc(group.finalist.name)}</strong></p>` : ''}
      </section>
    </div>
    ${roster(group)}
  </div>`;
}

function boards(group, round, latest) {
  const names = new Map(group.players.map(player => [player.id, player.name]));
  return `<div class="board-list">${round.matches.map((match, index) => {
    const white = esc(names.get(match.white));
    if (match.black === null) return `<div class="board bye"><span class="board-number">Bye</span><strong>${white}</strong><span>1 point</span></div>`;
    return `<div class="board">
      <span class="board-number">${String(index + 1).padStart(2, '0')}</span>
      <div class="opponents">
        <span><i class="piece white"></i><span class="sr-only">White: </span>${white}</span>
        <span><i class="piece"></i><span class="sr-only">Black: </span>${esc(names.get(match.black))}</span>
        ${match.repeat ? '<small class="rematch">Rematch</small>' : ''}
      </div>
      <select id="game-${esc(match.id)}" data-match="${esc(match.id)}"
        aria-label="Result for board ${index + 1}" ${round !== latest ? 'disabled' : ''}>${options(resultChoices, match.result)}</select>
    </div>`;
  }).join('')}</div>`;
}

function standings(group) {
  if (!group.standings.length) return '<p class="empty">Standings appear as students are registered.</p>';
  return `<div class="table-scroll"><table>
    <thead><tr><th scope="col">Rank</th><th scope="col">Student</th><th scope="col">Pts</th>
      <th scope="col"><abbr title="Buchholz">BH</abbr></th><th scope="col"><abbr title="Sonneborn–Berger">SB</abbr></th>
      <th scope="col">Wins</th><th scope="col">Byes</th></tr></thead>
    <tbody>${group.standings.map(p => `<tr>
      <td>${p.rank}</td><th scope="row">${esc(p.name)}${p.className ? `<small>${esc(p.className)}</small>` : ''}</th>
      <td><strong>${p.points}</strong></td><td>${p.buchholz}</td><td>${p.sonnebornBerger}</td><td>${p.wins}</td><td>${p.byes}</td>
    </tr>`).join('')}</tbody></table></div>`;
}

function roster(group) {
  const locked = group.rounds.length > 0;
  return `<section class="panel roster">
    <h2>Student roster <span class="count">${group.players.length}</span></h2>
    ${locked ? '<p class="muted">Roster locked after round generation.</p>' : `<form id="register">
      <label for="student">Student name</label><input id="student" name="name" maxlength="80" required>
      <div class="form-row"><div><label for="grade">Grade</label><select id="grade" name="grade">
        ${group.grades.map(grade => `<option value="${grade}">Grade ${grade}</option>`).join('')}</select></div>
        <div><label for="class">Class <small>(optional)</small></label><input id="class" name="className" maxlength="30"></div></div>
      <button id="add-student" class="primary">Add student</button>
    </form>`}
    ${group.players.length ? `<ul class="roster-list">${group.players.map(p => `<li>
      <div><strong>${esc(p.name)}</strong><small>Grade ${p.grade}${p.className ? ' · ' + esc(p.className) : ''}</small></div>
      ${locked ? '' : `<button class="link danger" data-remove="${esc(p.id)}" aria-label="Remove ${esc(p.name)}">Remove</button>`}
    </li>`).join('')}</ul>` : ''}
  </section>`;
}

function finalPage() {
  const { groups, final } = tournament;
  const ready = groups.A.finalist && groups.B.finalist;
  return `<section class="hero"><div class="heading"><h1>Championship final</h1><p>The two group winners meet for the school title.</p></div></section>
    <div class="finalists">${['A', 'B'].map(id => {
      const group = groups[id];
      return `<section class="panel"><p class="eyebrow">${labels[id]} finalist</p>
        <h2>${group.finalist ? esc(group.finalist.name) : group.completedRounds < 4 ? 'Group rounds in progress' : 'Awaiting playoff winner'}</h2>
        <p>${group.finalist ? group.finalist.points + ' points · Grade ' + group.finalist.grade : group.completedRounds + ' of 4 rounds complete'}</p>
      </section>`;
    }).join('')}</div>
    <section class="panel">
      <h2>Final result</h2>
      ${ready ? `<label for="final-result">Result</label><select id="final-result" data-final>${options([
        ['', 'Awaiting result'], ['A', groups.A.finalist.name + ' wins'], ['B', groups.B.finalist.name + ' wins'],
        ['draw', 'Draw · playoff required'],
      ], final)}</select>
      ${final === 'draw' ? '<p class="callout">Hold a playoff and select the winner here.</p>' :
        final ? `<p class="callout success">School chess champion · <strong>${esc(groups[final].finalist.name)}</strong></p>` : ''}
      ` : '<p class="empty">Complete both groups and confirm their winners to record the final.</p>'}
    </section>`;
}

navigation.addEventListener('click', event => {
  const button = event.target.closest('[data-section]');
  if (busy || !button) return;
  section = button.dataset.section;
  roundNumber = null;
  notice.textContent = '';
  render();
  document.getElementById(button.id).focus();
});

dashboard.addEventListener('submit', event => {
  if (event.target.id !== 'register') return;
  event.preventDefault();
  const data = Object.fromEntries(new FormData(event.target));
  action('add-player', { ...data, grade: Number(data.grade) });
});

dashboard.addEventListener('click', event => {
  const button = event.target.closest('button');
  if (!button || busy) return;
  if (button.dataset.action) action(button.dataset.action);
  if (button.dataset.round) {
    roundNumber = Number(button.dataset.round);
    render();
    document.getElementById(button.id).focus();
  }
  if (button.dataset.remove && confirm('Remove this student?')) action('remove-player', { player: button.dataset.remove });
  if (button.dataset.delete && confirm('Delete this round and all of its results?')) {
    action('delete-round', { round: Number(button.dataset.delete) });
  }
  if (button.id === 'retry') open();
});

dashboard.addEventListener('change', event => {
  const { value, dataset } = event.target;
  if (busy) {
    render();
    return;
  }
  if (dataset.match) action('result', { match: dataset.match, result: value || null });
  if ('playoff' in dataset) action('playoff', { player: value || null });
  if ('final' in dataset) action('final', { result: value || null });
});

function open() {
  load().catch(() => {
    dashboard.innerHTML = '<p>The tournament server could not be reached.</p><button id="retry" class="primary">Try again</button>';
  });
}

open();
