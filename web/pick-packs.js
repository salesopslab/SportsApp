// AI picks access: the free first pick (Free / Edge / Edge+), the credit
// balance, and "Unlock This Pick — 1 Credit". Pick Packs are no longer sold:
// every picker's pick is included with Edge Pro and during the free trial.
// Funnel: Free Pick -> Edge Pro.
// Uses globals from index.html: API, apiFetch, escapeHtml, currentUser,
// refreshAccount, openAuthModal, openPricingModal, goToNav.
(function(){
  const $ = (id) => document.getElementById(id);
  const esc = (s) => escapeHtml(s == null ? '' : String(s));
  const money = (cents) => `$${(cents / 100).toFixed(2)}`;
  const NUDGE_KEY = 'betedge_upgrade_nudge_at';
  const NUDGE_EVERY_MS = 3 * 86400e3; // the membership nudge shows at most every 3 days
  const FREE_DISMISS_KEY = 'betedge_free_pick_cta_dismissed';

  const state = { data: null, loading: null, pending: null, record: null, view: {} };
  const acct = () => state.data && state.data.account;
  const credits = () => (acct() ? acct().credits : (currentUser && currentUser.pickCredits) || 0);
  const allPicks = () => !!(acct() && acct().allPicksIncluded);
  const allPicksLabel = () => (acct() && acct().allPicksVia === 'trial') ? 'free during your trial' : 'included with Edge Pro';
  const OUT_NOTE = "You've used your free AI pick. Upgrade to Edge Pro to see every pick from all three AI pickers.";
  const store = { get(k){ try{ return localStorage.getItem(k); }catch{ return null; } }, set(k, v){ try{ localStorage.setItem(k, v); }catch{} } };

  // ---- data ----------------------------------------------------------------
  async function load(){
    if(state.loading) return state.loading;
    state.loading = (async () => {
      try{
        const res = await apiFetch('/api/pick-packs');
        const d = await res.json();
        if(res.ok) state.data = d;
      }catch{ /* keep whatever we had */ }
      finally{ state.loading = null; }
      setBalance(acct() ? acct().credits : null);
      return state.data;
    })();
    return state.loading;
  }

  function setBalance(n){
    if(n == null) { updateCreditUi(); return; }
    if(acct()) acct().credits = n;
    if(currentUser && currentUser.pickCredits !== n){
      currentUser.pickCredits = n;
      try{ localStorage.setItem('betedge_user', JSON.stringify(currentUser)); }catch{}
    }
    updateCreditUi();
  }

  // ---- balance everywhere it shows ----------------------------------------
  function updateCreditUi(){
    const chip = $('creditChip');
    if(chip){
      const n = credits();
      // Edge Pro / trial: nothing to count. Others: only while they hold a credit.
      chip.classList.toggle('hidden', !currentUser || allPicks() || n < 1);
      chip.innerHTML = `🎯 <span class="cc-n">${n}</span><span class="cc-l"> free pick${n === 1 ? '' : 's'}</span>`;
      chip.setAttribute('aria-label', `AI pick credits: ${n}. About AI picks`);
    }
    if($('accountCredits')) $('accountCredits').textContent = allPicks() ? `All picks (${allPicksLabel()})` : String(credits());
    if($('accountCreditsBtn')) $('accountCreditsBtn').style.display = allPicks() ? 'none' : '';
    renderFreeCta();
    renderRecordCredits();
  }

  function renderAccountCredits(){
    const box = $('accountPurchases');
    if(!box) return;
    const a = acct();
    if(!a || !a.purchases || !a.purchases.length){ box.innerHTML = ''; return; }
    box.innerHTML = `<details class="pp-history"><summary>Past Pick Pack purchases (${a.purchases.length})</summary>${a.purchases.map(p => `
      <div class="pp-history-row"><span>${esc(p.name)}</span><span>${money(p.amountCents)} · ${esc(new Date(p.purchasedAt).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'numeric' }))}</span></div>`).join('')}</details>`;
  }

  // ---- free pick funnel ----------------------------------------------------
  // Board CTA: logged out, or logged in and not claimed yet. Once claimed
  // and unused, a compact "your free pick is ready" reminder instead.
  function renderFreeCta(){
    const box = $('freePickCta');
    if(!box) return;
    const a = acct();
    const fp = a && a.freePick;
    if(allPicks()){ box.innerHTML = ''; return; }
    if(store.get(FREE_DISMISS_KEY) === '1' && !(fp && fp.claimed && !fp.used && a.credits > 0)){ box.innerHTML = ''; return; }
    if(!currentUser || (fp && fp.eligible)){
      box.innerHTML = `<div class="pp-free-cta" role="region" aria-label="Free AI pick">
        <button type="button" class="pp-free-close" data-pp="dismiss-free" aria-label="Dismiss">×</button>
        <div>
          <div class="pp-free-title">GET YOUR FIRST AI PICK FREE</div>
          <div class="pp-free-text">Create a free account and unlock your first BetEdge AI pick. No credit card required.</div>
        </div>
        <div>
          <button type="button" class="pp-free-btn" data-pp="claim-free">${currentUser ? 'Claim my free pick' : 'Get my free pick'}</button>
          <div class="pp-free-fine">1 Free AI Pick — $0 · One per account · Every pick with Edge Pro</div>
        </div>
      </div>`;
    }else if(fp && fp.claimed && !fp.used && a.credits > 0){
      box.innerHTML = `<div class="pp-free-cta compact">
        <div><div class="pp-free-title">🎯 Your free AI pick is ready</div><div class="pp-free-text">Tap any locked pick on AI Record to unlock it.</div></div>
        <button type="button" class="pp-free-btn" data-pp="go-record">Choose my pick</button>
      </div>`;
    }else{
      box.innerHTML = '';
    }
    wire(box);
  }

  async function claimFree(){
    if(!currentUser){ state.pending = { type:'claim' }; openAuthModal('signup'); return; }
    try{
      const res = await apiFetch('/api/pick-packs/claim-free', { method:'POST' });
      const d = await res.json();
      if(d.account) state.data = Object.assign({}, state.data, { account: d.account });
      setBalance(d.account ? d.account.credits : null);
      if(!res.ok){ open({ note: d.error || "Couldn't claim your free pick." }); return; }
      open({ success: `Your free AI pick is ready. Tap any 🔒 locked pick on AI Record and unlock it with your credit.`, successAction: 'record' });
    }catch{
      open({ note: "Couldn't reach BetEdge AI — try again in a moment." });
    }
  }

  // ---- upgrade (Pick Packs are no longer sold) ------------------------------
  function upgrade(){
    store.set(NUDGE_KEY, String(Date.now()));
    close();
    if(!currentUser){ openAuthModal('signup'); return; }
    openPricingModal();
  }

  // Back from Stripe: confirm server-side right away so the balance is
  // correct immediately (the webhook may still be on its way). Safe to
  // repeat — credits are only ever added once per payment.
  async function confirmReturn(){
    const q = new URLSearchParams(location.search);
    if(q.get('pickpack') !== 'success') return;
    const sessionId = q.get('session_id');
    q.delete('pickpack'); q.delete('session_id');
    window.history.replaceState({}, '', location.pathname + (q.toString() ? '?' + q : ''));
    if(!sessionId || !currentUser) return;
    for(let attempt = 0; attempt < 4; attempt++){
      try{
        const res = await apiFetch('/api/pick-packs/confirm', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ sessionId }) });
        const d = await res.json();
        if(d.account){ state.data = Object.assign({}, state.data, { account: d.account }); setBalance(d.account.credits); }
        if(res.ok && d.confirmed){
          open({ success: `Payment confirmed. Your AI Pick Credits balance is now ${d.account ? d.account.credits : credits()}.`, successAction: 'record' });
          return;
        }
        if(res.status !== 202) break;
      }catch{ /* retry */ }
      await new Promise(r => setTimeout(r, 2500));
    }
    await load();
    open({ note: "Your payment is processing. Credits are added the moment Stripe confirms it — refresh in a minute if you don't see them." });
  }

  // ---- unlock --------------------------------------------------------------
  // onUnlocked(pick) is called with the full pick once it's unlocked.
  async function requestUnlock(pickId, onUnlocked){
    if(!currentUser){ state.pending = { type:'unlock', pickId, onUnlocked }; open(); return; }
    if(!acct()) await load();
    if(allPicks()){ reloadRecordIfShowing(); return; } // already included — just refresh the view
    if(credits() < 1){ open({ note: OUT_NOTE }); return; }
    confirmUnlock(pickId, onUnlocked);
  }

  function confirmUnlock(pickId, onUnlocked){
    ensureModals();
    const n = credits();
    $('ppConfirmBody').innerHTML = `
      <h2>Unlock This Pick — 1 Credit</h2>
      <div class="pp-sub">You'll see the full pick and analysis now, before kickoff. It stays unlocked for you — viewing it again is free.</div>
      <div class="pp-balance"><span>AI Pick Credits</span><b>${n} → ${n - 1}</b></div>
      <div class="modal-error" id="ppConfirmError"></div>
      <div class="pp-confirm-actions">
        <button type="button" class="modal-submit" id="ppConfirmGo">Unlock This Pick — 1 Credit</button>
        <button type="button" class="pp-cancel" id="ppConfirmCancel">Cancel</button>
      </div>`;
    $('ppConfirmModal').classList.remove('hidden');
    $('ppConfirmCancel').onclick = closeConfirm;
    $('ppConfirmGo').onclick = async () => {
      const go = $('ppConfirmGo');
      go.disabled = true; go.textContent = 'Unlocking…';
      try{
        const res = await apiFetch('/api/pick-packs/unlock', { method:'POST', headers:{ 'Content-Type':'application/json' }, body: JSON.stringify({ pickId }) });
        const d = await res.json();
        if(res.status === 402 || d.needCredits){ setBalance(0); closeConfirm(); open({ note: OUT_NOTE }); return; }
        if(!res.ok) throw new Error(d.error || "Couldn't unlock that pick.");
        setBalance(d.credits);
        closeConfirm();
        if(typeof onUnlocked === 'function' && d.pick) onUnlocked(d.pick);
        load().then(renderRecordCredits); // refresh free-pick / nudge state
      }catch(e){
        $('ppConfirmError').textContent = e.message;
        go.disabled = false; go.textContent = 'Unlock This Pick — 1 Credit';
      }
    };
  }
  function closeConfirm(){ $('ppConfirmModal').classList.add('hidden'); }

  // ---- membership nudge (non-intrusive, throttled) -------------------------
  function nudgeDue(){
    const a = acct();
    if(!a || !a.showUpgrade) return false;
    const last = Number(store.get(NUDGE_KEY) || 0);
    return Date.now() - last > NUDGE_EVERY_MS;
  }
  function nudgeHtml(){
    return `<div class="pp-nudge" role="note">
      <button type="button" class="pp-free-close" data-pp="dismiss-nudge" aria-label="Dismiss">×</button>
      <div class="pp-nudge-title">Get Every AI Pick</div>
      <div class="pp-nudge-text">Edge Pro includes every pick from Lone Wolf, The Professor and The Fader before kickoff — no credits needed.</div>
      <button type="button" class="pp-nudge-btn" data-pp="membership">UPGRADE TO EDGE PRO</button>
    </div>`;
  }

  // ---- AI Record page strip -------------------------------------------------
  function renderRecordCredits(){
    const box = $('recCredits');
    if(!box) return;
    if(!currentUser){
      box.innerHTML = `<div class="rec-credit-line"><span>🎯 Your first AI pick is free — no card required.</span><button type="button" data-pp="claim-free">Get it free</button></div>`;
    }else if(allPicks()){
      box.innerHTML = `<div class="rec-credit-line"><span>✓ Every AI pick is <b>${allPicksLabel()}</b> — shown before kickoff.</span></div>`;
    }else{
      const a = acct();
      const n = credits();
      const fp = a && a.freePick;
      const action = fp && fp.eligible ? `<button type="button" data-pp="claim-free">Claim free pick</button>` : `<button type="button" data-pp="membership">Get every pick</button>`;
      const label = n ? `Free AI picks: <b>${n}</b> · tap 🔒 Unlock on any pick below` : (fp && fp.eligible ? 'Your first AI pick is free' : 'Every AI pick is included with Edge Pro');
      box.innerHTML = `<div class="rec-credit-line"><span>${label}</span>${action}</div>${nudgeDue() ? nudgeHtml() : ''}`;
    }
    wire(box);
  }

  // ---- Record stats for the trust CTA (always from the real ledger) --------
  async function loadRecordStat(){
    if(state.record && Date.now() - state.record.at < 5 * 60e3) return state.record;
    try{
      const d = await apiFetch('/api/picks/leaderboard?range=all').then(r => r.json());
      if(!d || !d.available || !Array.isArray(d.pickers)) return null;
      const t = d.pickers.reduce((s, p) => ({ wins:s.wins + (p.wins||0), losses:s.losses + (p.losses||0), pushes:s.pushes + (p.pushes||0), units:s.units + (p.units||0), graded:s.graded + (p.graded||0) }), { wins:0, losses:0, pushes:0, units:0, graded:0 });
      state.record = { ...t, at: Date.now() };
      return state.record;
    }catch{ return null; }
  }
  function recordStatHtml(t){
    if(!t) return '';
    if(!t.graded) return `<div class="pp-trust-stat">No graded picks yet — every pick will be graded here in public, wins and losses.</div>`;
    const u = Math.round(t.units * 100) / 100;
    return `<div class="pp-trust-stat">All three pickers combined: <b>${t.wins}-${t.losses}${t.pushes ? '-' + t.pushes : ''}</b> · <b>${u > 0 ? '+' : ''}${u.toFixed(2)}u</b> over ${t.graded} graded pick${t.graded === 1 ? '' : 's'}${t.graded < 100 ? ' (small sample)' : ''}.</div>`;
  }

  // ---- Pick Packs screen ----------------------------------------------------
  function ensureModals(){
    if($('pickPacksModal')) return;
    const wrap = document.createElement('div');
    wrap.innerHTML = `
      <div class="modal-overlay hidden" id="pickPacksModal" role="dialog" aria-modal="true" aria-labelledby="ppTitle">
        <div class="modal-card pp-modal-card">
          <button class="modal-close" id="pickPacksModalClose" aria-label="Close">×</button>
          <div id="pickPacksBody"></div>
        </div>
      </div>
      <div class="modal-overlay hidden" id="ppConfirmModal" role="dialog" aria-modal="true">
        <div class="modal-card pp-confirm-card"><div id="ppConfirmBody"></div></div>
      </div>`;
    document.querySelector('.app').appendChild(wrap);
    $('pickPacksModalClose').onclick = close;
    $('pickPacksModal').addEventListener('click', (e) => { if(e.target.id === 'pickPacksModal') close(); });
    $('ppConfirmModal').addEventListener('click', (e) => { if(e.target.id === 'ppConfirmModal') closeConfirm(); });
  }

  function render(){
    const body = $('pickPacksBody');
    if(!body) return;
    const d = state.data;
    const v = state.view || {};
    if(!d){ body.innerHTML = '<div class="board-msg"><div class="spin"></div><div>Loading…</div></div>'; return; }
    const a = d.account;
    const fp = a && a.freePick;
    const showFreeHero = !allPicks() && (!currentUser || (fp && fp.eligible));

    let hero = '';
    if(allPicks()){
      hero = `<h2 id="ppTitle">Every AI pick is ${esc(allPicksLabel())}</h2>
      <div class="pp-sub">You see every pick from 🐺 Lone Wolf, 🎓 The Professor and 🔄 The Fader as soon as it's posted — before kickoff, no credits needed.</div>`;
    }else{
      hero = (showFreeHero ? `<div class="pp-free-cta pp-hero">
        <div>
          <div class="pp-free-title" id="ppTitle">GET YOUR FIRST AI PICK FREE</div>
          <div class="pp-free-text">Every account gets one free BetEdge AI pick — the full pick and analysis, before kickoff. No credit card required.</div>
        </div>
        <div>
          <button type="button" class="pp-free-btn" data-pp="claim-free">${currentUser ? 'Claim my free pick' : 'Create free account'}</button>
          <div class="pp-free-fine">1 Free AI Pick — $0</div>
        </div>
      </div>` : `<h2 id="ppTitle">AI Picks</h2>`) + `
      <div class="pp-nudge" style="margin-top:14px">
        <div class="pp-nudge-title">Get every AI pick with Edge Pro</div>
        <div class="pp-nudge-text">Edge Pro includes every pick from 🐺 Lone Wolf, 🎓 The Professor and 🔄 The Fader before kickoff. Edge and Edge+ members get one free pick. New accounts get every pick free during the trial.</div>
        <button type="button" class="pp-nudge-btn" data-pp="membership">${currentUser ? 'UPGRADE TO EDGE PRO' : 'START FREE TRIAL'}</button>
      </div>`;
    }

    body.innerHTML = `
      ${v.success ? `<div class="pp-success">${esc(v.success)}${v.successAction === 'record' ? `<div style="margin-top:8px"><button type="button" class="pp-trust-btn" data-pp="go-record">Choose a pick on AI Record</button></div>` : ''}</div>` : ''}
      ${v.note ? `<div class="pp-note">${esc(v.note)}</div>` : ''}
      ${hero}
      ${a && !allPicks() && a.credits > 0 ? `<div class="pp-balance"><span>Free AI picks left</span><b>${a.credits}</b></div>` : ''}
      <div class="pp-trust">
        <button type="button" class="pp-trust-btn" data-pp="go-record">SEE THE AI RECORD</button>
        <div class="pp-trust-text">Every pick is graded in public — wins and losses.</div>
        <div id="ppRecordStat">${recordStatHtml(state.record)}</div>
      </div>
      <div class="pp-foot">Picks are information, not advice — no outcome is guaranteed. 21+. Gambling problem? Call 1-800-GAMBLER.</div>`;
    wire(body);
    loadRecordStat().then(t => { const el = $('ppRecordStat'); if(el) el.innerHTML = recordStatHtml(t); });
  }

  async function open(view = {}){
    ensureModals();
    state.view = view;
    $('pickPacksModal').classList.remove('hidden');
    render();
    await load();
    render();
  }
  function close(){
    const m = $('pickPacksModal');
    if(m) m.classList.add('hidden');
    state.view = {};
  }

  // ---- one click handler for every data-pp button --------------------------
  function wire(root){
    root.querySelectorAll('[data-pp]').forEach(el => {
      if(el.__ppWired) return;
      el.__ppWired = true;
      el.addEventListener('click', (e) => {
        const act = el.dataset.pp;
        if(act === 'claim-free') claimFree();
        else if(act === 'open') open();
        else if(act === 'go-record'){ close(); goToNav('record'); }
        else if(act === 'membership') upgrade();
        else if(act === 'dismiss-free'){ store.set(FREE_DISMISS_KEY, '1'); renderFreeCta(); }
        else if(act === 'dismiss-nudge'){ store.set(NUDGE_KEY, String(Date.now())); e.target.closest('.pp-nudge')?.remove(); }
      });
    });
  }

  // ---- auth hooks (called from index.html) ----------------------------------
  const reloadRecordIfShowing = () => {
    const rec = $('record');
    if(rec && rec.classList.contains('active') && window.__recordReload) window.__recordReload();
  };
  window.__afterAuth = async (mode) => {
    await load();
    reloadRecordIfShowing(); // locks depend on who's looking
    const p = state.pending;
    state.pending = null;
    if(!p) return;
    const fp = acct() && acct().freePick;
    if(p.type === 'claim') return fp && fp.eligible ? claimFree() : open();
    if(p.type === 'unlock'){
      if(allPicks()) return; // trial / Edge Pro: the record reload above already shows it
      // A brand-new account gets its free pick first, then the unlock.
      if(fp && fp.eligible){ await claimFree(); close(); }
      return requestUnlock(p.pickId, p.onUnlocked);
    }
  };
  window.__afterLogout = () => { state.data = null; state.pending = null; load(); reloadRecordIfShowing(); };
  window.__updateCreditUi = updateCreditUi;
  window.__renderAccountCredits = () => { renderAccountCredits(); load().then(() => { renderAccountCredits(); updateCreditUi(); }); };

  window.BetEdgePickPacks = { open, close, requestUnlock, credits, load };

  const chip = $('creditChip');
  if(chip) chip.addEventListener('click', () => open());
  load().then(confirmReturn);
})();
