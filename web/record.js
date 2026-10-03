// Record page: the public, graded track record of the three pickers.
// Uses globals from index.html: apiFetch, API, escapeHtml, sportTabLabel.
(function(){
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const INFO = (typeof PICKER_INFO !== 'undefined') ? PICKER_INFO : {};
  const ICON = Object.fromEntries(Object.entries(INFO).map(([k, v]) => [k, v.icon]));
  const CONF_RANK = { Low:1, Medium:2, High:3 };
  const state = { range:'all', sport:'all', picker:'', status:'', sort:'date:desc', shown:50, picks:[], board:null, loadedKey:'', access:null };

  const fmtUnits = (u) => u == null ? '—' : `${u > 0 ? '+' : ''}${Number(u).toFixed(2)}u`;
  const fmtOdds = (o) => o == null ? '—' : (o > 0 ? `+${o}` : String(o));
  const fmtPct = (p, dp = 1) => p == null ? '—' : `${Number(p).toFixed(dp)}%`;
  const dateLabel = (iso) => new Date(iso).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short' });
  const sportName = (s) => (typeof sportTabLabel === 'function' ? sportTabLabel(s) : String(s).toUpperCase());

  function sparkline(series){
    if(!series || series.length < 2) return '<div class="rec-conf">Units chart appears after 2 graded picks.</div>';
    const W = 300, H = 44, pad = 3;
    const ys = series.map(p => p.units).concat([0]);
    const min = Math.min(...ys), max = Math.max(...ys), span = (max - min) || 1;
    const x = (i) => pad + (i / (series.length - 1)) * (W - pad * 2);
    const y = (v) => H - pad - ((v - min) / span) * (H - pad * 2);
    const pts = series.map((p, i) => `${x(i).toFixed(1)},${y(p.units).toFixed(1)}`).join(' ');
    const last = series[series.length - 1].units;
    const color = last >= 0 ? 'var(--green)' : 'var(--red)';
    return `<svg class="rec-spark" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Units over time, now ${fmtUnits(last)}">
      <line x1="0" x2="${W}" y1="${y(0).toFixed(1)}" y2="${y(0).toFixed(1)}" stroke="var(--line)" stroke-dasharray="3 3" vector-effect="non-scaling-stroke"/>
      <polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2" vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>
    </svg>`;
  }

  function renderCards(){
    const box = $('recCards');
    const b = state.board;
    if(!b){ box.innerHTML = '<div class="board-msg"><div class="spin"></div><div>Loading the record…</div></div>'; return; }
    if(b.error){ box.innerHTML = `<div class="rec-empty">${esc(b.error)}</div>`; return; }
    const leaderUnits = Math.max(...b.pickers.filter(p => p.graded > 0).map(p => p.units), -Infinity);
    box.innerHTML = b.pickers.map((p, i) => {
      const lead = p.graded > 0 && p.units === leaderUnits && b.pickers.filter(x => x.graded > 0).length > 1;
      const conf = ['High','Medium','Low'].map(c => {
        const s = p.byConfidence?.[c];
        return s && s.graded ? `${c}: ${s.wins}-${s.losses}${s.pushes ? '-' + s.pushes : ''} (${fmtUnits(s.units)})` : null;
      }).filter(Boolean).join(' · ');
      return `<div class="rec-card${lead ? ' leader' : ''}">
        <div class="rec-card-top">
          <div class="rec-rank">${p.graded ? `#${i + 1}` : 'No graded picks yet'}${lead ? ' · LEADING' : ''}</div>
          ${p.smallSample ? '<span class="rec-badge" title="Under 100 graded picks — results are mostly noise this early">Small sample, under 100 picks</span>' : ''}
        </div>
        <div class="rec-name">${ICON[p.picker] || '🤖'} ${esc(p.picker)}</div>
        ${INFO[p.picker] ? `<div class="rec-style">${esc(INFO[p.picker].style)}</div>` : ''}
        <div class="rec-big">
          <span class="rec-units ${p.units > 0 ? 'pos' : p.units < 0 ? 'neg' : ''}">${fmtUnits(p.units)}</span>
          <span class="rec-rec">${p.wins}-${p.losses}${p.pushes ? '-' + p.pushes : ''}</span>
        </div>
        <div class="rec-sample">${p.graded} graded pick${p.graded === 1 ? '' : 's'}${p.pending ? ` · ${p.pending} pending` : ''}${p.void ? ` · ${p.void} void` : ''}</div>
        ${sparkline(p.series)}
        <div class="rec-stats">
          <div class="rec-stat"><div class="l">ROI</div><div class="v">${fmtPct(p.roi)}</div></div>
          <div class="rec-stat"><div class="l">Win %</div><div class="v">${fmtPct(p.winPct)}</div></div>
          <div class="rec-stat"><div class="l">Streak</div><div class="v">${esc(p.streak || '—')}</div></div>
          <div class="rec-stat" title="Average implied probability of the odds it bet — what the market said its picks' chances were"><div class="l">Avg implied</div><div class="v">${fmtPct(p.avgImpliedProb)}</div></div>
          <div class="rec-stat" title="Closing-line value: how much better (+) or worse (−) its price was than the final market line, in percentage points"><div class="l">CLV</div><div class="v">${p.clv ? `${p.clv.avgPoints > 0 ? '+' : ''}${p.clv.avgPoints.toFixed(1)} pts` : '—'}</div></div>
          <div class="rec-stat"><div class="l">Picks</div><div class="v">${p.picks}</div></div>
        </div>
        ${conf ? `<div class="rec-conf">By confidence — ${esc(conf)}</div>` : ''}
        <button type="button" class="rec-card-link" data-picker="${esc(p.picker)}">See ${esc(p.picker)}'s picks ↓</button>
      </div>`;
    }).join('');
    box.querySelectorAll('.rec-card-link').forEach(btn => btn.onclick = () => {
      state.picker = btn.dataset.picker; $('recPicker').value = state.picker; state.shown = 50;
      renderTable(); $('recTable').scrollIntoView({ behavior:'smooth', block:'start' });
    });
    // Picker filter options follow whoever is on the board.
    const sel = $('recPicker'), keep = sel.value;
    sel.innerHTML = '<option value="">All pickers</option>' + b.pickers.map(p => `<option value="${esc(p.picker)}">${esc(p.picker)}</option>`).join('');
    sel.value = keep;
  }

  function filtered(){
    let rows = state.picks;
    if(state.picker) rows = rows.filter(p => p.picker === state.picker);
    if(state.status) rows = rows.filter(p => p.result === state.status);
    const [key, dir] = state.sort.split(':');
    const val = {
      date: p => Date.parse(p.kickoff_at || p.created_at) + p.id / 1e6,
      units: p => p.units == null ? -Infinity : p.units,
      odds: p => p.odds ?? -Infinity,
      implied: p => p.implied_prob ?? -1,
      picker: p => p.picker,
      confidence: p => CONF_RANK[p.confidence] || 0,
    }[key] || (p => Date.parse(p.kickoff_at));
    const m = dir === 'asc' ? 1 : -1;
    return rows.slice().sort((a, b) => { const x = val(a), y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * m; });
  }

  function csvHref(){
    const q = new URLSearchParams();
    if(state.range !== 'all') q.set('range', state.range);
    if(state.sport !== 'all') q.set('sport', state.sport);
    if(state.picker) q.set('picker', state.picker);
    if(state.status) q.set('status', state.status);
    return `${API}/api/picks/export.csv${q.toString() ? '?' + q : ''}`;
  }

  function renderTable(){
    const box = $('recTable');
    $('recCsv').href = csvHref();
    if(!state.board){ box.innerHTML = ''; return; }
    const rows = filtered();
    if(!state.picks.length){
      box.innerHTML = `<div class="rec-empty">No picks ${state.range === 'all' ? 'yet' : 'in this range'}${state.sport !== 'all' ? ' for ' + esc(sportName(state.sport)) : ''}. Every pick lands here the moment it's made — before kickoff — and stays here win or lose.</div>`;
      return;
    }
    if(!rows.length){ box.innerHTML = '<div class="rec-empty">No picks match these filters.</div>'; return; }
    const [key, dir] = state.sort.split(':');
    const th = (k, label) => `<th data-sort="${k}" class="${key === k ? 'sorted' + (dir === 'asc' ? ' asc' : '') : ''}" scope="col">${label}</th>`;
    const shown = rows.slice(0, state.shown);
    const a = state.access || {};
    const lockbar = a.entitled && a.lockedCount ? `<div class="rec-lockbar open">🔓 You're seeing today's picks early with Hot Picks. Everyone else sees them at kickoff.</div>`
      : a.lockedCount ? `<div class="rec-lockbar"><span>🔒 ${a.lockedCount} pick${a.lockedCount === 1 ? '' : 's'} locked until kickoff. Unlock one for 1 AI pick credit, or all of today's with Hot Picks. Results are always public.</span><button type="button" class="rec-unlock">Hot Picks</button></div>` : '';
    const lockedRow = (p) => `<tr class="locked">
        <td class="c-date">Posted ${esc(new Date(p.created_at).toLocaleString('en-US', { month:'short', day:'numeric', hour:'numeric', minute:'2-digit', timeZoneName:'short' }))}</td>
        <td class="c-picker">${ICON[p.picker] || ''} ${esc(p.picker)}</td>
        <td class="c-game"><span class="sport-badge">${esc(sportName(p.sport))}</span> 🔒 Locked until kickoff</td>
        <td class="c-bet"><button type="button" class="rec-unlock-credit" data-pick="${Number(p.id)}" aria-label="Unlock this ${esc(p.picker)} pick for 1 credit">🔓 Unlock This Pick</button></td>
        <td class="c-odds num">—</td><td class="c-imp num">—</td><td class="c-conf">—</td>
        <td class="c-res"><span class="rec-res pending">pending</span><div class="rec-mob-units"></div></td>
        <td class="c-units num">—</td>
      </tr>`;
    box.innerHTML = lockbar + `<table class="rec-table">
      <thead><tr>${th('date','Date')}${th('picker','Picker')}<th scope="col">Game</th><th scope="col">Bet</th>${th('odds','Odds')}${th('implied','Implied')}${th('confidence','Conf.')}<th scope="col">Result</th>${th('units','Units')}</tr></thead>
      <tbody>${shown.map(p => p.locked ? lockedRow(p) : `<tr>
        <td class="c-date">${esc(dateLabel(p.kickoff_at))}</td>
        <td class="c-picker">${ICON[p.picker] || ''} ${esc(p.picker)}</td>
        <td class="c-game"><span class="sport-badge">${esc(sportName(p.sport))}</span> ${esc(p.game)}</td>
        <td class="c-bet"><b>${esc(p.bet)}</b>${p.unlocked ? ' <span class="rec-res unlocked" title="Unlocked with your AI pick credit — public at kickoff">unlocked</span>' : p.early ? ' <span class="rec-res pending" title="Hot Picks early access — public at kickoff">early</span>' : ''}<div class="rec-reason">${esc(p.reason)}</div><div class="rec-mob-meta">${fmtOdds(p.odds)} · ${fmtPct(p.implied_prob * 100)} implied · ${esc(p.confidence)} confidence</div></td>
        <td class="c-odds num">${fmtOdds(p.odds)}${p.closing_odds != null ? `<div class="rec-reason">close ${fmtOdds(p.closing_odds)}</div>` : ''}</td>
        <td class="c-imp num">${fmtPct(p.implied_prob * 100)}</td>
        <td class="c-conf">${esc(p.confidence)}</td>
        <td class="c-res"><span class="rec-res ${esc(p.result)}">${esc(p.result)}</span><div class="rec-mob-units">${p.units == null ? '' : fmtUnits(p.units)}</div></td>
        <td class="c-units num">${fmtUnits(p.units)}</td>
      </tr>`).join('')}</tbody></table>
      ${rows.length > state.shown ? `<button type="button" class="rec-more" id="recMore">Show more (${rows.length - state.shown} more)</button>` : `<div class="rec-conf" style="text-align:center;margin-top:10px">${rows.length} pick${rows.length === 1 ? '' : 's'}</div>`}`;
    box.querySelectorAll('th[data-sort]').forEach(h => h.onclick = () => {
      const k = h.dataset.sort;
      state.sort = `${k}:${key === k && dir === 'desc' ? 'asc' : (k === 'picker' ? 'asc' : 'desc')}`;
      $('recSort').value = [...$('recSort').options].some(o => o.value === state.sort) ? state.sort : $('recSort').value;
      renderTable();
    });
    const more = $('recMore'); if(more) more.onclick = () => { state.shown += 100; renderTable(); };
    box.querySelectorAll('.rec-unlock').forEach(b => b.onclick = () => { if(typeof openHotPicksModal === 'function') openHotPicksModal(); });
    // One credit unlocks one pick (Pick Packs); with no credits this opens the Pick Packs screen.
    box.querySelectorAll('.rec-unlock-credit').forEach(b => b.onclick = () => {
      if(!window.BetEdgePickPacks) return;
      window.BetEdgePickPacks.requestUnlock(Number(b.dataset.pick), (pick) => {
        const i = state.picks.findIndex(x => x.id === pick.id);
        if(i >= 0) state.picks[i] = pick;
        if(state.access && state.access.lockedCount) state.access.lockedCount--;
        renderTable();
      });
    });
  }

  async function load(){
    const key = `${state.range}|${state.sport}`;
    state.loadedKey = key;
    state.board = null; state.picks = [];
    renderCards(); renderTable();
    try{
      const q = `range=${state.range}${state.sport !== 'all' ? '&sport=' + state.sport : ''}`;
      const [lbRes, first] = await Promise.all([
        apiFetch(`/api/picks/leaderboard?${q}`).then(r => r.json()),
        apiFetch(`/api/picks?${q}&limit=500&page=1`).then(r => r.json()),
      ]);
      let picks = first.picks || [];
      for(let page = 2; page <= Math.min(first.pages || 1, 20); page++){
        const more = await apiFetch(`/api/picks?${q}&limit=500&page=${page}`).then(r => r.json());
        picks = picks.concat(more.picks || []);
      }
      if(state.loadedKey !== key) return; // a newer filter won
      if(lbRes.error) throw new Error(lbRes.error);
      state.board = lbRes; state.picks = picks; state.access = first.access || null;
    }catch(e){
      if(state.loadedKey !== key) return;
      state.board = { error: "Couldn't load the record right now — try again in a minute." };
    }
    renderCards(); renderTable();
  }

  document.querySelectorAll('#recRange button').forEach(b => b.onclick = () => {
    state.range = b.dataset.range; state.shown = 50;
    document.querySelectorAll('#recRange button').forEach(x => { x.classList.toggle('active', x === b); x.setAttribute('aria-checked', String(x === b)); });
    load();
  });
  $('recSport').onchange = (e) => { state.sport = e.target.value; state.shown = 50; load(); };
  $('recPicker').onchange = (e) => { state.picker = e.target.value; state.shown = 50; renderTable(); };
  $('recStatus').onchange = (e) => { state.status = e.target.value; state.shown = 50; renderTable(); };
  $('recSort').onchange = (e) => { state.sort = e.target.value; renderTable(); };

  let loadedOnce = false;
  window.__recordReload = () => { loadedOnce = true; window.__recordLoadedAt = Date.now(); load(); };
  window.__recordOnShow = () => { if(!loadedOnce || Date.now() - (window.__recordLoadedAt || 0) > 120000){ loadedOnce = true; window.__recordLoadedAt = Date.now(); load(); } };
  if(document.getElementById('record').classList.contains('active')) window.__recordOnShow();
})();
