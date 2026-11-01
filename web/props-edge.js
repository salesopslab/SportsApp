// Props Edge — frontend for /api/props (DraftKings player props, NFL + NBA).
// Loaded after index.html's main script; uses its globals (apiFetch,
// escapeHtml, agoLabel, fmtOdds, timeLabel, upgradePromptHtml,
// wireUpgradePrompts).
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const STORE = 'betedge_props';

  // ---- State -------------------------------------------------------------
  let sport = defaultSport();
  let day = 'today';
  let slate = null;
  let slateKey = null;
  const open = new Set();          // expanded game ids
  const gameData = new Map();      // eventId -> props response
  const view = new Map();          // eventId -> { market, q, sort }
  const aiState = new Map();       // eventId -> { loading, data, error }
  const tracked = new Set();       // `${eventId}|${propId}|${side}` tracked this session

  function defaultSport(){
    try{
      const s = JSON.parse(localStorage.getItem(STORE) || 'null');
      if(s && ['nfl','nba'].includes(s.sport)) return s.sport;
    }catch{}
    const dow = new Date().getDay(); // Sun, Mon, Thu = NFL days
    return [0, 1, 4].includes(dow) ? 'nfl' : 'nba';
  }
  function save(){ try{ localStorage.setItem(STORE, JSON.stringify({ sport })); }catch{} }

  // ---- Helpers ---------------------------------------------------------------
  const nick = (team) => String(team || '').split(' ').slice(-1)[0];
  function viewFor(id){
    if(!view.has(id)) view.set(id, { market: 'all', q: '', sort: 'edge' });
    return view.get(id);
  }
  function evBadge(ev){
    if(ev == null) return '';
    const cls = ev >= 3 ? 'good' : ev >= 0 ? 'ok' : 'neg';
    return `<span class="pe-ev ${cls}">${ev > 0 ? '+' : ''}${ev.toFixed(1)}% EV</span>`;
  }
  // The headline "edge" for a prop row: EV first, then line gap, then price gap.
  function edgeHtml(p){
    if(p.kind === 'yes'){
      if(p.priceGap != null && p.priceGap >= 1) return `<span class="pe-ev good">Pays above market</span>`;
      if(p.priceGap != null && p.priceGap <= -1) return `<span class="pe-ev neg">Below market price</span>`;
      return '';
    }
    const bits = [];
    if(p.best && p.best.ev != null && p.best.ev > -2) bits.push(`${evBadge(p.best.ev)} <span class="pe-side">${esc(p.best.side)}</span>`);
    if(p.lineGap != null && Math.abs(p.lineGap) >= 1){
      bits.push(`<span class="pe-gap">${p.lineGap > 0 ? 'Line ' + p.lineGap + ' below market (Over)' : 'Line ' + Math.abs(p.lineGap) + ' above market (Under)'}</span>`);
    }
    return bits.join(' ');
  }
  function edgeScore(p){
    if(p.kind === 'yes') return (p.priceGap || 0) / 2;
    return Math.max(p.best?.ev ?? -99, Math.abs(p.lineGap || 0) * 2);
  }
  function priceBtn(gid, p, side, label, price){
    if(price == null) return `<div class="pe-price muted"><span class="lbl">${esc(label)}</span> —</div>`;
    const done = tracked.has(`${gid}|${p.id}|${side}`);
    return `<button type="button" class="pe-price${done ? ' tracked' : ''}" data-track="${esc(p.id)}" data-side="${side}" aria-label="Track ${esc(p.player)} ${side} ${esc(p.marketLabel)} at ${esc(fmtOdds(price))}"><span class="lbl">${done ? '✓ ' : ''}${esc(label)}</span> ${esc(fmtOdds(price))}</button>`;
  }
  function priceCell(gid, p){
    if(p.kind === 'yes') return priceBtn(gid, p, 'Yes', 'Yes', p.yes);
    const ln = p.line == null ? '' : p.line;
    return priceBtn(gid, p, 'Over', `O ${ln}`, p.over) + priceBtn(gid, p, 'Under', `U ${ln}`, p.under);
  }
  function detailLine(p){
    if(p.kind === 'yes'){
      return p.marketAvgImplied != null ? `DK implies ${p.dkImplied?.yes ?? '—'}% · other books avg ${p.marketAvgImplied}%` : 'No other books to compare yet';
    }
    const parts = [];
    if(p.fair) parts.push(`Fair Over ${p.fair.over}% (${p.fairBooks} book${p.fairBooks === 1 ? '' : 's'})`);
    if(p.consensusLine != null) parts.push(`Market line ${p.consensusLine}`);
    if(!parts.length) parts.push('No other books to compare yet');
    return parts.join(' · ');
  }

  // ---- Rendering ----------------------------------------------------------------
  function renderControls(){
    document.querySelectorAll('#props .pe-seg[data-sport]').forEach(b => b.classList.toggle('active', b.dataset.sport === sport));
    document.querySelectorAll('#props .pe-seg[data-day]').forEach(b => b.classList.toggle('active', b.dataset.day === day));
  }

  function renderSlate(){
    const box = $('peGames');
    if(!slate){ box.innerHTML = `<div class="board-msg"><div class="spin"></div><div>Loading games…</div></div>`; return; }
    if(slate.error){ box.innerHTML = `<div class="pe-card"><div class="pe-error">${esc(slate.error)}</div></div>`; return; }
    if(!slate.games.length){
      box.innerHTML = `<div class="pe-card pe-empty">No ${sport.toUpperCase()} games ${day === 'today' ? 'today' : 'tomorrow'}.${day === 'today' ? ' <button type="button" class="pe-link" data-day-jump="tomorrow">See tomorrow</button>' : ''}</div>`;
      const j = box.querySelector('[data-day-jump]');
      if(j) j.addEventListener('click', () => { day = 'tomorrow'; renderControls(); loadSlate(); });
      return;
    }
    box.innerHTML = slate.games.map(gameCardHtml).join('');
    box.querySelectorAll('.pe-game-head').forEach(h => h.addEventListener('click', () => toggleGame(h.dataset.id)));
    for(const id of open) wireGame(id);
  }

  function gameCardHtml(g){
    const isOpen = open.has(g.id);
    const loaded = gameData.get(g.id);
    const status = g.started ? '<span class="pe-live">Started</span>'
      : g.propsFetchedAt ? `<span class="pe-meta-sm">Props updated ${esc(agoLabel(g.propsFetchedAt) || 'recently')}</span>`
      : '<span class="pe-meta-sm">Tap to load props</span>';
    return `<div class="pe-card pe-game${isOpen ? ' open' : ''}" data-id="${esc(g.id)}">
      <button type="button" class="pe-game-head" data-id="${esc(g.id)}" aria-expanded="${isOpen}">
        <div class="pe-matchup">
          <div class="pe-teams">${esc(g.awayTeam)} <span class="at">@</span> ${esc(g.homeTeam)}</div>
          <div class="pe-when">${esc(timeLabel(g.commenceTime))} · ${status}</div>
        </div>
        <span class="pe-chev">${isOpen ? '▾' : '▸'}</span>
      </button>
      <div class="pe-game-body" id="peBody-${esc(g.id)}">${isOpen ? bodyHtml(g, loaded) : ''}</div>
    </div>`;
  }

  function bodyHtml(g, d){
    if(!d) return `<div class="pe-loading"><div class="spin"></div><div>Pulling DraftKings props…</div></div>`;
    if(d.error) return `<div class="pe-error">${esc(d.error)}</div>`;
    if(!d.data){
      return `<div class="pe-note">${esc(d.pausedReason || 'Props aren’t available for this game yet.')}</div>`;
    }
    const data = d.data;
    if(!data.props.length){
      return `<div class="pe-note">DraftKings hasn’t posted player props for this game yet. Props usually go up the day before ${sport === 'nfl' ? 'kickoff' : 'tip-off'}.</div>${footHtml(d)}`;
    }
    const v = viewFor(g.id);
    const chips = [{ key: 'all', label: 'All', count: data.props.length }, ...data.markets.filter(m => m.count)]
      .map(m => `<button type="button" class="pe-chip${v.market === m.key ? ' active' : ''}" data-market="${esc(m.key)}">${esc(m.label)} <span>${m.count}</span></button>`).join('');
    return `
      ${aiHtml(g.id)}
      <div class="pe-tools">
        <div class="pe-chips">${chips}</div>
        <div class="pe-search-row">
          <input type="search" class="chat-input pe-search" placeholder="Search player" value="${esc(v.q)}" data-role="search" aria-label="Search player">
          <button type="button" class="pe-sort" data-role="sort">${v.sort === 'edge' ? 'Best edge' : 'A–Z'}</button>
        </div>
      </div>
      <div class="pe-hint">Tap a price to track it in Ledger AI.</div>
      <div class="pe-list" data-role="list">${listHtml(g.id, data.props, v)}</div>
      ${footHtml(d)}`;
  }

  function listHtml(gid, props, v){
    const q = v.q.trim().toLowerCase();
    let rows = props.filter(p => (v.market === 'all' || p.market === v.market) && (!q || p.player.toLowerCase().includes(q)));
    rows = rows.slice().sort(v.sort === 'edge' ? (a, b) => edgeScore(b) - edgeScore(a) : (a, b) => a.player.localeCompare(b.player) || a.marketLabel.localeCompare(b.marketLabel));
    if(!rows.length) return `<div class="pe-note">No props match.</div>`;
    return rows.slice(0, 150).map(p => `
      <div class="pe-row">
        <div class="pe-row-main">
          <div class="pe-player">${esc(p.player)}</div>
          <div class="pe-mkt">${esc(p.marketLabel)}</div>
          <div class="pe-edge">${edgeHtml(p)}</div>
          <div class="pe-detail">${esc(detailLine(p))}</div>
        </div>
        <div class="pe-prices">${priceCell(gid, p)}</div>
      </div>`).join('');
  }

  function footHtml(d){
    const books = d.data?.booksCompared || [];
    const parts = [`DraftKings odds${books.length ? ', compared with ' + books.map(esc).join(', ') : ''}`];
    if(d.fetchedAt) parts.push(`updated ${esc(agoLabel(d.fetchedAt) || 'just now')}`);
    const paused = d.pausedReason ? `<div class="pe-note warn">${esc(d.pausedReason)}</div>` : '';
    return `${paused}<div class="pe-src">${parts.join(' · ')}</div>`;
  }

  // ---- AI edge picks ----------------------------------------------------------------
  function aiHtml(id){
    const st = aiState.get(id);
    if(!st) return `<button type="button" class="pe-ai-btn" data-role="ai">✨ AI Edge Picks for this game</button>`;
    if(st.loading) return `<div class="pe-ai"><div class="pe-loading"><div class="spin"></div><div>Finding the best edges… <span class="think-time" data-t0="${st.t0}">0s</span></div></div></div>`;
    if(st.paywall) return `<div class="pe-ai">${st.paywall}</div>`;
    if(st.error) return `<div class="pe-ai"><div class="pe-error">${esc(st.error)}</div><button type="button" class="pe-link" data-role="ai">Try again</button></div>`;
    const d = st.data;
    const picks = d.picks || [];
    const cards = picks.length ? picks.map(pk => `
      <div class="pe-pick conf-${esc(pk.confidence.toLowerCase())}">
        <div class="pe-pick-top">
          <div>
            <div class="pe-pick-name">${esc(pk.player)}</div>
            <div class="pe-pick-bet">${esc(pk.side)}${pk.line != null ? ' ' + esc(pk.line) : ''} ${esc(pk.marketLabel)} <b>${esc(fmtOdds(pk.price))}</b> <span class="pe-mkt">DraftKings</span></div>
          </div>
          <span class="pe-conf">${esc(pk.confidence)}</span>
        </div>
        ${pickTrackBtn(id, pk)}
        <div class="pe-pick-nums">${pk.ev != null ? evBadge(pk.ev) : ''}${pk.fairPct != null ? ` <span class="pe-meta-sm">Fair ${esc(pk.fairPct)}%</span>` : ''}${pk.consensusLine != null && pk.line != null && pk.consensusLine !== pk.line ? ` <span class="pe-meta-sm">Market line ${esc(pk.consensusLine)}</span>` : ''}</div>
        <div class="pe-pick-why">${esc(pk.reason)}</div>
        ${pk.risk ? `<div class="pe-pick-risk">Risk: ${esc(pk.risk)}</div>` : ''}
      </div>`).join('') : `<div class="pe-note">No prop stands out enough in this game right now — passing is a pick too.</div>`;
    const src = (d.sources || []).length ? `<div class="pe-src">Sources: ${(d.sources).map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label)).join(' · ')}</div>` : '';
    return `<div class="pe-ai">
      <div class="pe-ai-head">✨ AI Edge Picks</div>
      ${d.summary ? `<div class="pe-ai-sum">${esc(d.summary)}</div>` : ''}
      ${cards}
      ${src}
      <div class="pe-src">Analysis, not a guarantee. Generated ${esc(agoLabel(d.generatedAt) || 'just now')}.</div>
    </div>`;
  }

  function pickTrackBtn(id, pk){
    const done = tracked.has(`${id}|${pk.id}|${pk.side}`);
    return `<button type="button" class="pe-track${done ? ' tracked' : ''}" data-track="${esc(pk.id)}" data-side="${esc(pk.side)}"${done ? ' disabled' : ''}>${done ? '✓ Tracked in Ledger AI' : '+ Track this pick'}</button>`;
  }

  // Open the shared "Track this pick" modal (index.html) for one side of a prop.
  function startTrack(id, propId, side){
    const g = slate?.games?.find(x => x.id === id);
    const prop = gameData.get(id)?.data?.props?.find(p => p.id === propId);
    if(!g || !prop || typeof trackProp !== 'function') return;
    const price = side === 'Over' ? prop.over : side === 'Under' ? prop.under : prop.yes;
    trackProp({
      sport, gameId: id, homeTeam: g.homeTeam, awayTeam: g.awayTeam, commenceTime: g.commenceTime,
      player: prop.player, side, marketLabel: prop.marketLabel,
      line: prop.kind === 'yes' ? null : prop.line, price,
      trackKey: `${id}|${prop.id}|${side}`,
    });
  }
  document.addEventListener('betedge:tracked', (e) => {
    const key = e.detail && e.detail.trackKey;
    if(!key) return;
    tracked.add(key);
    const id = key.split('|')[0];
    if(open.has(id)) rerenderBody(id);
    if(typeof showHintToast === 'function') showHintToast('Tracked in Ledger AI', 'Settle it in Ledger AI after the game — player props aren’t graded automatically.');
  });

  async function runAI(id){
    aiState.set(id, { loading: true, t0: Date.now() });
    rerenderBody(id);
    try{
      const res = await apiFetch(`/api/props/edge/${sport}/${encodeURIComponent(id)}`, { method: 'POST' });
      const data = await res.json().catch(() => ({}));
      if(res.status === 402){
        const html = data.loggedIn === false
          ? upgradePromptHtml('standard', 'Create a free account to get AI Edge Picks — the Free plan includes 3 a day.', { signedOut: true })
          : upgradePromptHtml(data.requiredTier || 'standard', data.error || 'Upgrade for more AI Edge Picks.');
        aiState.set(id, { paywall: html });
      } else if(!res.ok){
        aiState.set(id, { error: data.error || `Something went wrong (${res.status}).` });
      } else {
        aiState.set(id, { data });
      }
    }catch(e){
      aiState.set(id, { error: 'Couldn’t reach the server. Check your connection and try again.' });
    }
    rerenderBody(id);
  }

  // ---- Wiring ---------------------------------------------------------------------
  function rerenderBody(id){
    const body = $(`peBody-${id}`);
    const g = slate?.games?.find(x => x.id === id);
    if(!body || !g) return;
    body.innerHTML = bodyHtml(g, gameData.get(id));
    wireGame(id);
  }

  function wireGame(id){
    const body = $(`peBody-${id}`);
    if(!body) return;
    wireUpgradePrompts(body);
    body.querySelectorAll('[data-role="ai"]').forEach(b => b.addEventListener('click', () => runAI(id)));
    if(!body.dataset.trackWired){
      body.dataset.trackWired = '1';
      body.addEventListener('click', (e) => {
        const b = e.target.closest('[data-track]');
        if(!b || b.disabled) return;
        startTrack(id, b.dataset.track, b.dataset.side);
      });
    }
    const d = gameData.get(id);
    if(!d?.data?.props?.length) return;
    const v = viewFor(id);
    const list = body.querySelector('[data-role="list"]');
    body.querySelectorAll('.pe-chip').forEach(c => c.addEventListener('click', () => {
      v.market = c.dataset.market;
      body.querySelectorAll('.pe-chip').forEach(x => x.classList.toggle('active', x === c));
      list.innerHTML = listHtml(id, d.data.props, v);
    }));
    const search = body.querySelector('[data-role="search"]');
    search.addEventListener('input', () => { v.q = search.value; list.innerHTML = listHtml(id, d.data.props, v); });
    const sortBtn = body.querySelector('[data-role="sort"]');
    sortBtn.addEventListener('click', () => {
      v.sort = v.sort === 'edge' ? 'az' : 'edge';
      sortBtn.textContent = v.sort === 'edge' ? 'Best edge' : 'A–Z';
      list.innerHTML = listHtml(id, d.data.props, v);
    });
  }

  async function toggleGame(id){
    const card = document.querySelector(`#peGames .pe-game[data-id="${CSS.escape(id)}"]`);
    if(open.has(id)){
      open.delete(id);
      if(card){ card.classList.remove('open'); card.querySelector('.pe-chev').textContent = '▸'; card.querySelector('.pe-game-head').setAttribute('aria-expanded', 'false'); $(`peBody-${id}`).innerHTML = ''; }
      return;
    }
    open.add(id);
    if(card){ card.classList.add('open'); card.querySelector('.pe-chev').textContent = '▾'; card.querySelector('.pe-game-head').setAttribute('aria-expanded', 'true'); }
    rerenderBody(id);
    if(!gameData.has(id) || gameData.get(id).error) await loadGame(id);
  }

  async function loadGame(id){
    gameData.delete(id);
    rerenderBody(id);
    try{
      const res = await apiFetch(`/api/props/game/${sport}/${encodeURIComponent(id)}`);
      const data = await res.json().catch(() => ({}));
      gameData.set(id, res.ok ? data : { error: data.error || `Couldn’t load props (${res.status}).` });
      const g = slate?.games?.find(x => x.id === id);
      if(res.ok && g && data.fetchedAt) g.propsFetchedAt = data.fetchedAt;
    }catch{
      gameData.set(id, { error: 'Couldn’t reach the server. Check your connection and try again.' });
    }
    if(open.has(id)) rerenderBody(id);
  }

  async function loadSlate(force){
    const key = `${sport}|${day}`;
    if(!force && slate && slateKey === key && !slate.error) return renderSlate();
    slate = null; slateKey = key;
    renderSlate();
    try{
      const res = await apiFetch(`/api/props/slate?sport=${sport}&day=${day}`);
      const data = await res.json().catch(() => ({}));
      if(slateKey !== key) return; // user switched while loading
      slate = res.ok ? data : { error: data.error || `Couldn’t load games (${res.status}).` };
    }catch{
      if(slateKey !== key) return;
      slate = { error: 'Couldn’t reach the server. Check your connection and try again.' };
    }
    renderSlate();
  }

  document.querySelectorAll('#props .pe-seg[data-sport]').forEach(b => b.addEventListener('click', () => {
    if(sport === b.dataset.sport) return;
    sport = b.dataset.sport; save(); open.clear(); renderControls(); loadSlate();
  }));
  document.querySelectorAll('#props .pe-seg[data-day]').forEach(b => b.addEventListener('click', () => {
    if(day === b.dataset.day) return;
    day = b.dataset.day; open.clear(); renderControls(); loadSlate();
  }));

  // Elapsed-seconds counter on "Finding the best edges…".
  setInterval(() => {
    document.querySelectorAll('#props .think-time[data-t0]').forEach(t => {
      t.textContent = Math.floor((Date.now() - Number(t.dataset.t0)) / 1000) + 's';
    });
  }, 1000);

  window.__peOnShow = () => { renderControls(); loadSlate(); };
  renderControls();
})();
