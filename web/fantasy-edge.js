// Fantasy Edge — frontend for /api/fantasy (NFL).
// Loaded after index.html's main script; uses its globals (apiFetch,
// escapeHtml, agoLabel, upgradePromptHtml, wireUpgradePrompts, currentUser).
(function(){
  'use strict';
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const STORE = 'betedge_fantasy';

  // ---- State -------------------------------------------------------------
  let scoring = 'ppr';
  let tool = 'startsit';
  let roster = []; // [{name, position, team, slot, lineupSlot, matched}]
  let waiverPos = 'ALL';
  let chatHistory = [];
  let busy = false;

  try{
    const saved = JSON.parse(localStorage.getItem(STORE) || 'null');
    if(saved){
      if(['ppr','half','standard'].includes(saved.scoring)) scoring = saved.scoring;
      if(Array.isArray(saved.roster)) roster = saved.roster.slice(0, 25);
    }
  }catch{}
  function save(){
    try{ localStorage.setItem(STORE, JSON.stringify({ scoring, roster })); }catch{}
  }

  // ---- API ---------------------------------------------------------------
  async function call(path, body){
    const res = await apiFetch(`/api/fantasy/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json().catch(() => ({}));
    if(res.status === 402){
      const err = new Error(data.error || 'Upgrade required');
      err.paywall = { requiredTier: data.requiredTier || 'standard', loggedIn: data.loggedIn };
      throw err;
    }
    if(!res.ok) throw new Error(data.error || `Something went wrong (${res.status}).`);
    return data;
  }

  function paywallHtml(pw){
    return upgradePromptHtml(pw.requiredTier, 'Fantasy Edge is included with every paid plan and your free trial.', { signedOut: !pw.loggedIn });
  }

  function showError(target, err){
    if(err.paywall){
      target.innerHTML = `<div class="fe-card">${paywallHtml(err.paywall)}</div>`;
      wireUpgradePrompts(target);
      return;
    }
    target.innerHTML = `<div class="fe-card"><div class="fe-error">${esc(err.message)}</div></div>`;
  }

  // ---- Shared renderers ----------------------------------------------------
  function statusClass(st){
    const l = String(st?.label || '').toUpperCase();
    if(/^(OUT|INJURED RESERVE|IR|SUSPENDED|PUP)/.test(l)) return 'bad';
    if(/^(QUESTIONABLE|DOUBTFUL|LISTED)/.test(l)) return 'warn';
    if(/UNCONFIRMED/.test(l)) return 'unk';
    return '';
  }
  function statusHtml(st){
    if(!st) return '';
    const when = st.updated_at ? `Updated ${agoLabel(st.updated_at)}` : (st.retrieved_at ? `Checked ${agoLabel(st.retrieved_at)}` : null);
    const src = st.source_url ? `<a href="${esc(st.source_url)}" target="_blank" rel="noopener">${esc(st.source)}</a>` : esc(st.source || '');
    const bits = [];
    if(st.injury) bits.push(esc(st.injury));
    if(st.practiceStatus) bits.push(`Practice: ${esc(st.practiceStatus)}`);
    const meta = [when ? esc(when) : null, st.source ? `Source: ${src}` : null].filter(Boolean).join(' · ');
    let conflict = '';
    if(Array.isArray(st.conflict) && st.conflict.length > 1){
      conflict = `<div class="fe-status-conflict">Sources differ: ${st.conflict.map(c => `${esc(c.source)} — ${esc(c.gameDesignation || 'not listed')}`).join(' · ')}</div>`;
    }
    const note = /UNCONFIRMED/.test(st.label || '') && st.note ? `<div class="fe-status-meta">${esc(st.note)}</div>` : '';
    return `<div class="fe-status">
      <div class="fe-status-label">Injury status</div>
      <div class="fe-status-val ${statusClass(st)}">${esc(st.label || 'STATUS UNCONFIRMED')}${bits.length ? ` <span class="fe-status-meta">(${bits.join(', ')})</span>` : ''}</div>
      ${meta ? `<div class="fe-status-meta">${meta}</div>` : ''}${note}${conflict}
    </div>`;
  }
  function scoreHtml(edge){
    if(!edge) return '';
    return `<div class="fe-score tier-${esc(edge.tier)}">
      <div class="fe-score-cap">Fantasy Edge</div>
      <div class="fe-score-num">${esc(edge.score)}</div>
      <div class="fe-score-tier">${esc(edge.icon)} ${esc(edge.label)}</div>
    </div>`;
  }
  function metaLine(p){
    const parts = [p.position, p.teamAbbr || p.team].filter(Boolean).map(esc);
    if(p.upcoming) parts.push(`${p.upcoming.homeAway === 'away' ? '@' : 'vs'} ${esc(p.upcoming.opponent)}`);
    if(p.unresolved) parts.push('Player not found on current rosters');
    return parts.join(' · ');
  }
  function lastGamesHtml(p){
    if(!p.lastGames || !p.lastGames.length) return '';
    return `<div class="fe-lastgames">Last games: ${p.lastGames.map(g => `${g.opponent ? esc(g.opponent) : 'Wk ' + esc(g.week)} ${esc(g.points)}`).join(' · ')} pts</div>`;
  }
  function tagsHtml(tags){
    if(!Array.isArray(tags) || !tags.length) return '';
    return `<div class="fe-tags">${tags.slice(0, 3).map(t => `<span class="fe-tag">${esc(t)}</span>`).join('')}</div>`;
  }
  function playerCard(p, extra = '', isPick = false){
    return `<div class="fe-player${isPick ? ' is-pick' : ''}">
      <div class="fe-player-top">
        <div style="min-width:0">
          <div class="fe-player-name">${esc(p.name)}</div>
          <div class="fe-player-meta">${metaLine(p)}</div>
        </div>
        ${scoreHtml(p.edge)}
      </div>
      ${tagsHtml(p.tags)}
      ${statusHtml(p.status)}
      ${extra}
      ${lastGamesHtml(p)}
    </div>`;
  }
  function sourcesHtml(d){
    const list = (d.sources || []).slice(0, 6);
    const parts = [];
    if(list.length) parts.push('Sources: ' + list.map(s => s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.label)}</a>` : esc(s.label)).join(' · '));
    parts.push(`Scoring: ${esc(d.scoring)}`);
    if(d.answeredAt) parts.push(`Analyzed ${esc(agoLabel(d.answeredAt) || 'just now')}`);
    return `<div class="fe-sources">${parts.join(' · ')}</div>`;
  }
  function loadingHtml(msg){
    return `<div class="fe-card"><div class="fe-loading"><div class="spin"></div><div>${esc(msg)}</div></div></div>`;
  }
  function dl(pairs){
    const rows = pairs.filter(([, v]) => v && (!Array.isArray(v) || v.length)).map(([k, v]) =>
      `<dt>${esc(k)}</dt><dd>${Array.isArray(v) ? `<ul>${v.map(x => `<li>${esc(x)}</li>`).join('')}</ul>` : esc(v)}</dd>`
    );
    return rows.length ? `<dl class="fe-details">${rows.join('')}</dl>` : '';
  }

  // ---- Roster (screenshot / typed) -------------------------------------------
  function renderRoster(){
    const box = $('feRosterBox');
    if(!roster.length){
      box.innerHTML = `<div class="fe-add-row"><input class="fe-input" id="feAddPlayer" type="text" placeholder="…or type a player to add"><button type="button" class="fe-secondary" id="feAddBtn">Add</button></div>`;
    }else{
      const groups = [['starter', 'Starters'], ['bench', 'Bench'], ['ir', 'IR'], [null, 'Roster']];
      const html = groups.map(([slot, label]) => {
        const list = roster.map((p, i) => ({ p, i })).filter(({ p }) => (p.slot || null) === slot);
        if(!list.length) return '';
        return `<div class="fe-roster-group">${label}</div><div class="fe-pchips">${list.map(({ p, i }) => `
          <span class="fe-pchip${p.matched === false ? ' unmatched' : ''}" title="${p.matched === false ? 'Not matched to a current NFL roster — check the spelling' : ''}">
            ${p.position ? `<span class="pos">${esc(p.lineupSlot && p.slot === 'starter' ? p.lineupSlot : p.position)}</span>` : ''}
            <span class="nm">${esc(p.name)}</span>
            <button type="button" class="move" data-move="${i}" aria-label="Move ${esc(p.name)} between starters and bench">${p.slot === 'starter' ? '↓' : '↑'}</button>
            <button type="button" class="x" data-remove="${i}" aria-label="Remove ${esc(p.name)}">✕</button>
          </span>`).join('')}</div>`;
      }).join('');
      box.innerHTML = `<div class="fe-roster">
        <div class="fe-roster-head"><span>Your roster (${roster.length})</span><button type="button" id="feClearRoster">Clear</button></div>
        ${html}
        <div class="fe-add-row"><input class="fe-input" id="feAddPlayer" type="text" placeholder="Add a player"><button type="button" class="fe-secondary" id="feAddBtn">Add</button></div>
      </div>`;
    }
    const add = () => {
      const v = $('feAddPlayer').value.trim();
      if(!v) return;
      roster.push({ name: v, slot: roster.length ? 'bench' : null });
      save(); renderRoster(); renderPanel();
    };
    $('feAddBtn').onclick = add;
    $('feAddPlayer').onkeydown = (e) => { if(e.key === 'Enter') add(); };
    const clr = $('feClearRoster');
    if(clr) clr.onclick = () => { roster = []; save(); renderRoster(); renderPanel(); };
    box.querySelectorAll('[data-remove]').forEach(b => b.onclick = () => { roster.splice(Number(b.dataset.remove), 1); save(); renderRoster(); renderPanel(); });
    box.querySelectorAll('[data-move]').forEach(b => b.onclick = () => {
      const p = roster[Number(b.dataset.move)];
      p.slot = p.slot === 'starter' ? 'bench' : 'starter';
      save(); renderRoster();
    });
  }

  function downscale(file){
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Could not read that file — try again.'));
      reader.onload = () => {
        const img = new Image();
        img.onerror = () => resolve(reader.result); // unknown format: send as-is
        img.onload = () => {
          const max = 1800;
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          if(scale === 1 && reader.result.length < 4_000_000) return resolve(reader.result);
          const c = document.createElement('canvas');
          c.width = Math.round(img.width * scale); c.height = Math.round(img.height * scale);
          c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
          resolve(c.toDataURL('image/jpeg', 0.88));
        };
        img.src = reader.result;
      };
      reader.readAsDataURL(file);
    });
  }

  async function handleScreenshot(file){
    if(!file || !file.type || !file.type.startsWith('image/')){
      $('feResult').innerHTML = '<div class="fe-card"><div class="fe-error">Upload an image — a screenshot of your fantasy team.</div></div>';
      return;
    }
    const btn = $('feUploadBtn');
    btn.disabled = true; btn.textContent = 'Reading your screenshot…';
    try{
      const image = await downscale(file);
      const d = await call('screenshot', { image });
      if(!d.players || !d.players.length) throw new Error("Couldn't find any players in that screenshot. Try a tighter crop of your roster.");
      roster = d.players.map(p => ({ name: p.name, position: p.position, team: p.team, slot: p.slot, lineupSlot: p.lineupSlot, matched: p.matched }));
      save(); renderRoster();
      const unmatched = roster.filter(p => p.matched === false).length;
      $('feResult').innerHTML = `<div class="fe-card">
        <div class="fe-card-title">✅ Found ${roster.length} players${d.platform && d.platform !== 'Unknown' ? ` from ${esc(d.platform)}` : ''}</div>
        <div class="fe-panel-desc">${unmatched ? `${unmatched} name${unmatched === 1 ? '' : 's'} (dashed) couldn't be matched to a current NFL roster — fix or remove ${unmatched === 1 ? 'it' : 'them'}. ` : ''}Now optimize your lineup, or ask Fantasy Edge below.</div>
        <div class="fe-actions"><button type="button" class="fe-primary" id="feGoLineup">Optimize my lineup</button><button type="button" class="fe-secondary" id="feGoAsk">Ask a question</button></div>
      </div>`;
      $('feGoLineup').onclick = () => { selectTool('lineup'); runTool(); };
      $('feGoAsk').onclick = () => { $('feChatInput').focus(); $('feChatInput').scrollIntoView({ behavior: 'smooth', block: 'center' }); };
    }catch(err){
      showError($('feResult'), err);
    }finally{
      btn.disabled = false; btn.textContent = '📷 Upload screenshot';
      $('feFileInput').value = '';
    }
  }

  // ---- Tool panels -----------------------------------------------------------------
  const rosterNames = () => roster.map(p => p.name);
  function datalist(){
    return `<datalist id="feRosterList">${rosterNames().map(n => `<option value="${esc(n)}">`).join('')}</datalist>`;
  }
  function renderPanel(){
    const panel = $('fePanel');
    if(tool === 'startsit'){
      panel.innerHTML = `<div class="fe-card-title">Start/Sit AI</div>
        <div class="fe-panel-desc">Compare 2–4 players. Fantasy Edge checks matchup, usage, injuries, depth chart, weather and the betting line.</div>
        <div class="fe-inputs" id="feSSInputs">
          ${[0,1].map(i => `<input class="fe-input" list="feRosterList" data-ss placeholder="Player ${i + 1}">`).join('')}
        </div>${datalist()}
        <div class="fe-actions"><button type="button" class="fe-secondary" id="feSSMore">+ Add player</button><button type="button" class="fe-primary" id="feRun">Who should I start?</button></div>`;
      $('feSSMore').onclick = () => {
        const wrap = $('feSSInputs');
        if(wrap.querySelectorAll('[data-ss]').length >= 4) return;
        wrap.insertAdjacentHTML('beforeend', `<input class="fe-input" list="feRosterList" data-ss placeholder="Player ${wrap.children.length + 1}">`);
        if(wrap.querySelectorAll('[data-ss]').length >= 4) $('feSSMore').remove();
      };
    }else if(tool === 'waiver'){
      panel.innerHTML = `<div class="fe-card-title">Waiver Edge</div>
        <div class="fe-panel-desc">Finds pickups from injured starters, rising usage and new roles.</div>
        <div class="fe-poschips">${['ALL','QB','RB','WR','TE','DEF','K'].map(p => `<button type="button" class="fe-poschip${p === waiverPos ? ' active' : ''}" data-pos="${p}">${p === 'ALL' ? 'All' : p}</button>`).join('')}</div>
        <label class="fe-label" for="feAvail">Players available in your league (optional)</label>
        <input class="fe-input" id="feAvail" type="text" placeholder="e.g. Noah Brown, Tyler Allgeier">
        <div class="fe-actions"><button type="button" class="fe-primary" id="feRun">Find waiver targets</button></div>`;
      panel.querySelectorAll('[data-pos]').forEach(b => b.onclick = () => { waiverPos = b.dataset.pos; renderPanel(); });
    }else if(tool === 'lineup'){
      panel.innerHTML = `<div class="fe-card-title">Lineup Optimizer</div>
        <div class="fe-panel-desc">${roster.length ? `Uses your ${roster.length}-player roster above. Mark current starters with ↑ so changes are highlighted.` : 'Upload a screenshot or add your players above first.'}</div>
        <label class="fe-label" for="feSlots">Lineup slots</label>
        <input class="fe-input" id="feSlots" type="text" value="QB, RB, RB, WR, WR, TE, FLEX, K, DEF">
        <div class="fe-actions"><button type="button" class="fe-primary" id="feRun"${roster.length < 3 ? ' disabled' : ''}>Optimize my lineup</button></div>`;
    }else if(tool === 'injury'){
      panel.innerHTML = `<div class="fe-card-title">Injury Impact AI</div>
        <div class="fe-panel-desc">See who gains or loses fantasy value when a player misses time.</div>
        <input class="fe-input" id="feInjPlayer" list="feRosterList" type="text" placeholder="Injured player, e.g. Terry McLaurin">${datalist()}
        <div class="fe-actions"><button type="button" class="fe-primary" id="feRun">Show fantasy impact</button></div>`;
    }else if(tool === 'trade'){
      panel.innerHTML = `<div class="fe-card-title">Trade Analyzer</div>
        <div class="fe-panel-desc">Separate players with commas. Judged on rest-of-season value, not just projections.</div>
        <div class="fe-trade">
          <div><label class="fe-label" for="feTradeA">Team A (you) gives</label><input class="fe-input" id="feTradeA" type="text" placeholder="Player(s)"></div>
          <div><label class="fe-label" for="feTradeB">Team B gives</label><input class="fe-input" id="feTradeB" type="text" placeholder="Player(s)"></div>
        </div>
        <div class="fe-actions"><button type="button" class="fe-primary" id="feRun">Analyze trade</button></div>`;
    }
    const run = $('feRun');
    if(run) run.onclick = runTool;
    panel.querySelectorAll('input').forEach(inp => inp.addEventListener('keydown', (e) => { if(e.key === 'Enter' && inp.id !== 'feAddPlayer') runTool(); }));
  }

  function selectTool(t){
    tool = t;
    document.querySelectorAll('#feTools .fe-tool').forEach(b => b.classList.toggle('active', b.dataset.tool === t));
    renderPanel();
  }

  const splitNames = (v) => String(v || '').split(/[,\n]/).map(s => s.trim()).filter(Boolean);

  async function runTool(){
    if(busy) return;
    const out = $('feResult');
    let path, body, msg, render;
    if(tool === 'startsit'){
      const players = [...document.querySelectorAll('[data-ss]')].map(i => i.value.trim()).filter(Boolean);
      if(players.length < 2){ out.innerHTML = '<div class="fe-card"><div class="fe-error">Enter at least 2 players to compare.</div></div>'; return; }
      path = 'start-sit'; body = { players, scoring }; msg = 'Checking matchups, usage and the latest injury reports…'; render = renderStartSit;
    }else if(tool === 'waiver'){
      path = 'waiver'; body = { position: waiverPos, scoring, available: splitNames($('feAvail').value), roster }; msg = 'Scanning injuries and depth charts for opportunities…'; render = renderWaiver;
    }else if(tool === 'lineup'){
      if(roster.length < 3){ out.innerHTML = '<div class="fe-card"><div class="fe-error">Add your roster first — upload a screenshot or type players above.</div></div>'; return; }
      path = 'lineup'; body = { roster, scoring, lineupSlots: $('feSlots').value }; msg = 'Checking every player on your roster…'; render = renderLineup;
    }else if(tool === 'injury'){
      const player = $('feInjPlayer').value.trim();
      if(!player){ out.innerHTML = '<div class="fe-card"><div class="fe-error">Enter the injured player.</div></div>'; return; }
      path = 'injury-impact'; body = { player, scoring }; msg = 'Pulling the injury report and depth chart…'; render = renderInjury;
    }else if(tool === 'trade'){
      const a = splitNames($('feTradeA').value), b = splitNames($('feTradeB').value);
      if(!a.length || !b.length){ out.innerHTML = '<div class="fe-card"><div class="fe-error">Add at least one player on each side.</div></div>'; return; }
      path = 'trade'; body = { teamAGives: a, teamBGives: b, scoring, roster }; msg = 'Weighing rest-of-season value on both sides…'; render = renderTrade;
    }
    busy = true;
    const run = $('feRun'); if(run) run.disabled = true;
    out.innerHTML = loadingHtml(msg);
    out.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    try{
      const d = await call(path, body);
      out.innerHTML = render(d);
    }catch(err){
      showError(out, err);
    }finally{
      busy = false;
      const r2 = $('feRun'); if(r2) r2.disabled = tool === 'lineup' && roster.length < 3;
    }
  }

  // ---- Result renderers ------------------------------------------------------------
  function renderStartSit(d){
    const pick = d.players.find(p => p.name === d.start) || d.players[0];
    const cards = d.players.map(p => playerCard(p, dl([
      ['Upside', p.upside], ['Floor', p.floor], ['Matchup', p.matchup], ['Risk factors', p.risks], ['Injury concerns', p.injuryConcerns],
    ]), p === pick)).join('');
    return `<div class="fe-card fe-verdict">
        <div class="fe-verdict-label">Start</div>
        <div class="fe-verdict-name">${esc(pick ? pick.name : d.start)}</div>
        ${pick && pick.edge ? `<div class="fe-verdict-label" style="color:var(--sub)">Edge Score ${esc(pick.edge.score)} · ${esc(pick.edge.label)}</div>` : ''}
        <div class="fe-why" style="margin-top:8px">${esc(d.why)}</div>
      </div>
      <div class="fe-players">${cards}</div>${sourcesHtml(d)}`;
  }
  function renderWaiver(d){
    if(!d.targets || !d.targets.length) return `<div class="fe-card"><div class="fe-why">${esc(d.summary || 'No strong waiver targets found right now.')}</div></div>${sourcesHtml(d)}`;
    return `${d.summary ? `<div class="fe-card"><div class="fe-why">${esc(d.summary)}</div></div>` : ''}
      <div class="fe-players">${d.targets.map(p => playerCard(p, dl([
        ['Opportunity', p.opportunity], ['Matchup', p.matchup], ['Why add', p.whyAdd],
      ]) + (p.faab ? `<div class="fe-faab">FAAB: ${esc(p.faab)}</div>` : ''))).join('')}</div>${sourcesHtml(d)}`;
  }
  function slotRow(p, changed){
    return `<div class="fe-slot${changed ? ' changed' : ''}"><span class="s">${esc(p.slot || '')}</span><span class="n">${esc(p.name)}${p.status && /OUT|UNCONFIRMED|QUESTIONABLE|DOUBTFUL/.test(p.status.label) ? ` <span class="fe-status-meta">· ${esc(p.status.label)}</span>` : ''}</span>${p.edge ? `<span class="sc tier-${esc(p.edge.tier)}"><span class="fe-score-num" style="font-size:15px">${esc(p.edge.score)}</span></span>` : ''}</div>`;
  }
  function renderLineup(d){
    const startNames = new Set((d.changes || []).map(c => c.start));
    const current = d.current && d.current.length ? d.current.map(p => slotRow(p, false)).join('') : '<div class="fe-status-meta">Not marked — use ↑ on your roster to mark starters.</div>';
    const optimized = (d.optimized || []).map(p => slotRow(p, startNames.has(p.name))).join('');
    const changes = (d.changes || []).length
      ? d.changes.map(c => `<div class="fe-change"><span class="lbl">BENCH</span><span class="bench">${esc(c.bench)}</span><span>⬇️</span><span class="lbl">START${c.slot ? ` · ${esc(c.slot)}` : ''}</span><span class="start">${esc(c.start)}</span><div class="why">${esc(c.why)}</div></div>`).join('')
      : '<div class="fe-why">Your lineup is already the strongest option. No changes recommended.</div>';
    return `<div class="fe-lineups">
        <div class="fe-card fe-lineup"><h4>Current lineup</h4>${current}</div>
        <div class="fe-card fe-lineup opt"><h4>BetEdge optimized lineup</h4>${optimized}</div>
      </div>
      <div class="fe-card"><div class="fe-card-title">Recommended changes</div>${changes}${d.summary ? `<div class="fe-why" style="margin-top:10px">${esc(d.summary)}</div>` : ''}</div>
      ${sourcesHtml(d)}`;
  }
  function renderInjury(d){
    const p = d.player || {};
    const impacts = (d.impacts || []).map(x => `<div class="fe-impact">
        <div class="who"><b>${esc(x.name)}</b> <span class="fe-status-meta">${esc([x.position, x.teamAbbr].filter(Boolean).join(' · '))}</span>
          ${x.status ? `<div class="fe-status-meta">Status: ${esc(x.status.label)}</div>` : ''}
          <div class="why">${esc(x.why)}</div></div>
        <div class="lvl ${x.direction === 'down' ? 'down' : 'up'}">${x.direction === 'down' ? '↓' : '↑'} ${esc(x.level)}</div>
      </div>`).join('');
    const e = d.effects || {};
    const effects = [['Carries', e.carries], ['Targets', e.targets], ['Snap share', e.snapShare], ['Red zone', e.redZone], ['Fantasy projection', e.projection], ['Depth chart', e.depthChart]]
      .filter(([, v]) => v).map(([k, v]) => `<div><b>${esc(k)}</b>${esc(v)}</div>`).join('');
    return `<div class="fe-card fe-verdict">
        <div class="fe-verdict-name">${esc(p.name)} — ${esc(p.status ? p.status.label : 'STATUS UNCONFIRMED')}</div>
        <div class="fe-status-meta">${esc(d.scenario)}</div>
        ${statusHtml(p.status)}
      </div>
      <div class="fe-card"><div class="fe-card-title">Fantasy impact</div>${impacts || '<div class="fe-why">No clear fantasy ripple effect found.</div>'}</div>
      ${effects ? `<div class="fe-card"><div class="fe-effects">${effects}</div></div>` : ''}
      ${d.summary ? `<div class="fe-card"><div class="fe-why">${esc(d.summary)}</div></div>` : ''}
      ${sourcesHtml(d)}`;
  }
  function renderTrade(d){
    const side = (label, s, win) => `<div class="fe-card fe-side${win ? ' win' : ''}">
        <div class="fe-verdict-label" style="color:var(--sub)">${label} gives</div>
        <div class="fe-why"><b>${esc((s.gives || []).join(', '))}</b></div>
        ${s.valueScore != null ? `<div class="v">${esc(s.valueScore)}</div><div class="fe-score-cap">Value received</div>` : ''}
        <div class="fe-why" style="margin-top:8px">${esc(s.analysis)}</div>
      </div>`;
    return `<div class="fe-card fe-verdict"><div class="fe-verdict-label">Verdict</div><div class="fe-verdict-name">${esc(d.verdictText || (d.verdict === 'EVEN' ? 'Fairly even trade' : `Team ${d.verdict} wins`))}</div><div class="fe-why">${esc(d.summary)}</div></div>
      <div class="fe-sides">${side('Team A', d.sideA, d.verdict === 'A')}${side('Team B', d.sideB, d.verdict === 'B')}</div>
      ${(d.tradeoffs || []).length ? `<div class="fe-card"><div class="fe-card-title">Major tradeoffs</div>${dl([['', d.tradeoffs]]).replace('<dt></dt>', '')}</div>` : ''}
      ${(d.players || []).length ? `<div class="fe-players">${d.players.map(p => playerCard(p, p.note ? `<div class="fe-details">${esc(p.note)}</div>` : '')).join('')}</div>` : ''}
      ${sourcesHtml(d)}`;
  }

  // ---- Chat --------------------------------------------------------------------
  function addMsg(role, html){
    const log = $('feChatLog');
    const el = document.createElement('div');
    el.className = `msg ${role}`;
    el.innerHTML = html;
    log.appendChild(el);
    log.scrollTop = log.scrollHeight;
    return el;
  }
  async function sendChat(text){
    const message = (text || $('feChatInput').value).trim();
    if(!message) return;
    $('feChatInput').value = '';
    addMsg('user', esc(message));
    const pending = addMsg('ai', '<span class="fe-status-meta">Checking the latest data…</span>');
    try{
      const d = await call('chat', { message, roster, scoring, history: chatHistory });
      chatHistory.push({ role: 'user', text: message }, { role: 'assistant', text: d.reply });
      chatHistory = chatHistory.slice(-8);
      const statuses = (d.players || []).slice(0, 6).map(p => `${esc(p.name)}: ${esc(p.status.label)}${p.status.updated_at ? ` (${esc(agoLabel(p.status.updated_at))}${p.status.source ? `, ${esc(p.status.source)}` : ''})` : ''}`);
      pending.innerHTML = esc(d.reply) + (statuses.length ? `<div class="fe-status-meta" style="margin-top:8px">Status check — ${statuses.join(' · ')}</div>` : '');
    }catch(err){
      if(err.paywall){ pending.innerHTML = paywallHtml(err.paywall); wireUpgradePrompts(pending); }
      else pending.innerHTML = `<span class="fe-error">${esc(err.message)}</span>`;
    }
  }

  // ---- Wire up -----------------------------------------------------------------
  document.querySelectorAll('.fe-seg').forEach(b => {
    b.classList.toggle('active', b.dataset.scoring === scoring);
    b.onclick = () => {
      scoring = b.dataset.scoring; save();
      document.querySelectorAll('.fe-seg').forEach(x => x.classList.toggle('active', x === b));
    };
  });
  document.querySelectorAll('#feTools .fe-tool').forEach(b => b.onclick = () => selectTool(b.dataset.tool));
  $('feUploadBtn').onclick = () => $('feFileInput').click();
  $('feFileInput').onchange = (e) => handleScreenshot(e.target.files && e.target.files[0]);
  $('feChatSend').onclick = () => sendChat();
  $('feChatInput').onkeydown = (e) => { if(e.key === 'Enter') sendChat(); };
  document.querySelectorAll('#feChatChips .fe-chip').forEach(c => c.onclick = () => sendChat(c.textContent));

  renderRoster();
  renderPanel();
  window.__feOnShow = () => {};
})();
