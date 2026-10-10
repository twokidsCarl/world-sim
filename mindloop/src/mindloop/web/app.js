/* mindloop 界面：状态、接口、案例库、舞台、层级走向条、亲自下场。 */
(function () {
  'use strict';

  const MAXD = 12;
  const { bars, pct, argmax } = window.Bubbles;
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
  const other = (r) => (r === 'a' ? 'b' : 'a');

  function h(tag, attrs, ...kids) {
    const e = document.createElement(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) {
        if (v == null || v === false) continue;
        if (k === 'class') e.className = v;
        else if (k === 'text') e.textContent = v;
        else if (k === 'html') e.innerHTML = v;
        else if (k === 'style') e.style.cssText = v;
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v === true ? '' : v);
      }
    }
    for (const c of kids.flat()) if (c != null && c !== false) e.append(c);
    return e;
  }

  const S = {
    cats: [], catsSig: '', caseId: null, card: null, built: false,
    depth: { a: null, b: null }, lam: { a: null, b: null }, bias: null, trueState: null,
    forced: { a: null, b: null }, pins: { a: {}, b: {} }, extra: [],
    play: null, // {as:'a'|'b', chosen:bool}
    persona: 'original', root: { a: null, b: null }, expanded: new Set(), pinOpen: null,
    data: null, prevSig: {}, prevDepth: { a: -1, b: -1 }, seq: 0, anim: null, claude: false,
  };

  // ───────────── 接口 ─────────────

  async function api(path, body, ms) {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), ms || 15000);
    try {
      const r = await fetch(path, body
        ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: ctl.signal }
        : { signal: ctl.signal });
      if (!r.ok) {
        let d = '';
        try { d = (await r.json()).detail; } catch (_) { /* 非 JSON */ }
        const e = new Error(typeof d === 'string' && d ? d : 'HTTP ' + r.status);
        e.status = r.status;
        throw e;
      }
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3800);
  }

  function params() {
    const p = { case_id: S.caseId };
    if (S.depth.a != null) p.depth_a = S.depth.a;
    if (S.depth.b != null) p.depth_b = S.depth.b;
    if (S.lam.a != null) p.lam_a = S.lam.a;
    if (S.lam.b != null) p.lam_b = S.lam.b;
    if (S.bias != null) p.bias = S.bias;
    if (S.trueState != null) p.true_state = S.trueState;
    if (S.forced.a != null) p.forced_a = S.forced.a;
    if (S.forced.b != null) p.forced_b = S.forced.b;
    if (Object.keys(S.pins.a).length || Object.keys(S.pins.b).length) p.pins = S.pins;
    if (S.extra.length) p.extra_messages = S.extra;
    return p;
  }

  // ───────────── 案例库 ─────────────

  async function loadLibrary() {
    try {
      const d = await api('/api/cases');
      const sig = JSON.stringify(d);
      if (sig === S.catsSig) return;
      S.catsSig = sig;
      S.cats = d.categories || [];
      renderLibrary();
    } catch (e) {
      if (!S.cats.length) toast('读不到案例库：' + e.message);
    }
  }

  async function checkHealth() {
    let ok = false;
    try { ok = !!(await api('/api/health', null, 5000)).claude; } catch (_) { ok = false; }
    const was = S.claude;
    S.claude = ok;
    $('#health-note').hidden = ok;
    if (ok && !was && S.data) hydrateMonologues();
  }

  const findCard = (id) => S.cats.flatMap((c) => c.cases).find((c) => c.id === id);
  const firstCard = () => S.cats.flatMap((c) => c.cases).find((c) => c.runnable) || S.cats.flatMap((c) => c.cases)[0];
  const catLabel = (id) => (S.cats.find((c) => c.id === id) || {}).label || '';

  function sourceShort(s) {
    return [s.work, s.locator].filter(Boolean).join(' · ');
  }

  function renderLibrary() {
    const nav = $('#library');
    nav.replaceChildren();
    for (const cat of S.cats) {
      const sec = h('section', { class: 'cat' },
        h('h2', { class: 'cat-h' }, h('span', { text: cat.label }), h('span', { class: 'cat-n', text: cat.cases.length || '' })));
      if (!cat.cases.length) sec.append(h('p', { class: 'cat-empty', text: '还没有案例' }));
      for (const c of cat.cases) {
        sec.append(h('button', {
          class: 'case-item' + (c.id === S.caseId ? ' active' : '') + (c.runnable ? '' : ' ro'),
          type: 'button', 'data-id': c.id, onclick: () => openCase(c.id),
        },
          h('span', { class: 'ci-top' },
            h('span', { class: 'ci-title', text: c.title }),
            !c.runnable && h('span', { class: 'tag', text: '读本' }),
            c.theory && h('span', { class: 'tag ghost', text: '理论' })),
          c.hook && h('span', { class: 'ci-hook', text: c.hook }),
          h('span', { class: 'ci-src', text: sourceShort(c.source) })));
      }
      nav.append(sec);
    }
  }

  function markActive() {
    $$('.case-item').forEach((b) => b.classList.toggle('active', b.dataset.id === S.caseId));
  }

  // ───────────── 地址栏 ─────────────

  function writeHash() {
    if (!S.caseId) return;
    const q = new URLSearchParams({ c: S.caseId });
    if (S.card && S.card.runnable && S.depth.a != null) { q.set('a', S.depth.a); q.set('b', S.depth.b); }
    const hash = '#' + q.toString();
    if (location.hash !== hash) history.replaceState(null, '', hash);
  }

  function readHash() {
    const q = new URLSearchParams(location.hash.replace(/^#/, ''));
    const num = (k) => (q.get(k) != null && /^\d+$/.test(q.get(k)) ? Math.min(MAXD, +q.get(k)) : null);
    return { id: q.get('c'), a: num('a'), b: num('b') };
  }

  // ───────────── 打开案例 ─────────────

  async function openCase(id, depths) {
    const card = findCard(id);
    if (!card) return;
    stopAnim();
    Object.assign(S, {
      caseId: id, card, built: false, data: null,
      depth: { a: depths && depths.a != null ? depths.a : null, b: depths && depths.b != null ? depths.b : null },
      lam: { a: null, b: null }, bias: null, trueState: null, forced: { a: null, b: null },
      pins: { a: {}, b: {} }, extra: [], play: null, root: { a: null, b: null }, pinOpen: null,
      prevSig: {}, prevDepth: { a: -1, b: -1 },
    });
    S.expanded.clear();
    M.queue = [];
    markActive();
    $('#main').scrollTop = 0;
    if (!card.runnable) {
      S.seq++;
      await openReader(id);
      writeHash();
      return;
    }
    await recompute();
  }

  async function recompute() {
    const seq = ++S.seq;
    let d;
    try {
      d = await api('/api/compute', params());
    } catch (e) {
      if (seq === S.seq) toast('计算失败：' + e.message);
      return;
    }
    if (seq !== S.seq) return;
    S.data = d;
    S.depth = { a: d.depth.a, b: d.depth.b };
    if (!S.built) { buildStage(); S.built = true; }
    update();
  }

  function setDepth(r, v) {
    v = Math.max(0, Math.min(MAXD, v));
    if (v === S.depth[r]) return false;
    S.depth[r] = v;
    S.pins[r] = {};
    S.root[r] = null;
    S.pinOpen = null;
    return true;
  }

  // ───────────── 读本（不可运行的案例） ─────────────

  function sourceBlock(s) {
    const bits = [s.work, s.author, s.year, s.locator].filter(Boolean).join(' · ');
    return h('div', { class: 'source' },
      h('div', { class: 'source-line' },
        h('span', { class: 'source-k', text: '出处' }),
        s.url ? h('a', { href: s.url, target: '_blank', rel: 'noopener', text: bits }) : h('span', { text: bits }),
        s.verified && h('span', { class: 'tag ghost', text: '已核对' })),
      s.quote && h('blockquote', { class: 'quote', text: s.quote }));
  }

  async function openReader(id) {
    const view = $('#view');
    let c;
    try { c = await api('/api/cases/' + encodeURIComponent(id)); } catch (e) { toast('读不到这个案例：' + e.message); return; }
    if (S.caseId !== id) return;
    view.replaceChildren(
      h('header', { class: 'case-head' },
        h('div', { class: 'eyebrow' }, h('span', { text: catLabel(c.category) }), h('span', { class: 'tag', text: '读本 · 只讲不算' }), c.theory && h('span', { class: 'tag ghost', text: '理论基准' })),
        h('h1', { text: c.title }),
        c.hook && h('p', { class: 'hook', text: c.hook }),
        sourceBlock(c.source),
        c.summary && h('p', { class: 'summary', text: c.summary.trim() })),
      h('section', { class: 'reader' },
        h('div', { class: 'reader-people' },
          ...['a', 'b'].map((r) => h('div', { class: 'rp role-' + r },
            h('div', { class: 'rp-av', html: avatarSvg(r) }),
            h('div', null,
              h('div', { class: 'rp-name', text: c[r].name }),
              c[r].persona && h('div', { class: 'rp-t', text: c[r].persona }),
              c[r].goal && h('div', { class: 'rp-g', text: '想要：' + c[r].goal }))))),
        h('h2', { class: 'sec-h', text: '一层一层往里想' }),
        (c.layers || []).length
          ? h('ol', { class: 'steps' }, ...c.layers.map((t, i) =>
            h('li', { class: 'step', style: `--i:${Math.min(i, 8)}` },
              h('span', { class: 'step-n', text: i }),
              h('span', { class: 'step-t', text: t }))))
          : h('p', { class: 'empty', text: '这个案例还没有写分层讲解。' }),
        c.canonical && c.canonical.note && h('p', { class: 'canon-note', text: c.canonical.note })));
  }

  // ───────────── 舞台骨架（每个案例建一次） ─────────────

  function avatarSvg(r) {
    const ex = r === 'a' ? 37 : 27; // 眼睛朝向对方
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><circle class="av-head" cx="32" cy="22" r="14"/>` +
      `<path class="av-body" d="M8 62c0-14 10.5-22 24-22s24 8 24 22z"/><circle class="av-eye" cx="${ex}" cy="21" r="2.1"/></svg>`;
  }

  function depthControl(r) {
    const canon = S.data.case.canonical['depth_' + r];
    const range = h('input', {
      type: 'range', min: 0, max: MAXD, step: 1, class: 'rng depth', 'aria-label': '想到第几层',
      oninput: (e) => { stopAnim(); if (setDepth(r, +e.target.value)) recompute(); },
    });
    return h('div', { class: 'ctl role-' + r, 'data-r': r },
      h('div', { class: 'ctl-row' },
        h('span', { class: 'ctl-k' }, '想到第 ', h('b', { class: 'dval' }), ' 层'),
        canon != null && h('button', { class: 'link tiny', type: 'button', text: '回到原作', onclick: () => { stopAnim(); if (setDepth(r, canon)) recompute(); } })),
      h('div', { class: 'slider-wrap' }, range,
        h('div', { class: 'ticks' }, ...Array.from({ length: MAXD + 1 }, (_, i) => h('i', { text: i % 3 === 0 ? i : '' }))),
        canon != null && h('span', { class: 'orig', style: `left:calc(9px + (100% - 18px) * ${canon / MAXD})`, title: `原作里${S.data.case[r].name}想到第 ${canon} 层`, text: '原作' })),
      h('div', { class: 'ctl-row lam-row' },
        h('span', { class: 'ctl-k' }, '理性度 ', h('b', { class: 'lval' })),
        h('input', {
          type: 'range', min: 0.2, max: 5, step: 0.1, class: 'rng lam', 'aria-label': '理性度',
          title: '理性度低 = 常凭感觉乱选；高 = 几乎总选最划算的',
          oninput: (e) => { S.lam[r] = +e.target.value; recompute(); },
        })),
      h('button', { class: 'btn play-as', type: 'button', onclick: () => togglePlayAs(r) }));
  }

  function buildStage() {
    const d = S.data, c = d.case, g = d.game;
    const view = $('#view');
    const q = g.quadratic;
    view.replaceChildren(
      h('header', { class: 'case-head' },
        h('div', { class: 'eyebrow' }, h('span', { text: catLabel(c.category) }),
          h('span', { class: 'tag ghost', text: g.kind === 'signaling' ? '一个说，一个猜' : '同时出手' }),
          c.theory && h('span', { class: 'tag ghost', text: '理论基准' })),
        h('h1', { text: c.title }),
        c.hook && h('p', { class: 'hook', text: c.hook }),
        sourceBlock(c.source),
        c.summary && h('p', { class: 'summary', text: c.summary.trim() }),
        c.canonical.note && h('p', { class: 'canon-note', text: '原作：' + c.canonical.note })),

      h('section', { class: 'stage kind-' + g.kind },
        h('div', { class: 'minds' }, h('div', { id: 'mind-a', class: 'mind side-a' }), h('div', { id: 'mind-b', class: 'mind side-b' })),
        h('div', { class: 'ground' },
          ...['a', 'b'].map((r) => h('div', { class: `person role-${r} side-${r}`, id: 'person-' + r },
            h('div', { class: 'tail', 'aria-hidden': 'true' }, h('i'), h('i'), h('i')),
            h('div', { class: 'p-body' },
              h('div', { class: 'avatar', html: avatarSvg(r) }),
              h('div', { class: 'p-info' },
                h('div', { class: 'p-name', text: c[r].name, title: c[r].persona }),
                c[r].goal && h('div', { class: 'p-goal', text: '想要：' + c[r].goal }),
                h('div', { class: 'p-you', text: '← 现在是你' }))),
            r === 'a' && g.kind === 'signaling' && h('div', { id: 'priv', class: 'priv' }))),
          h('div', { id: 'exchange', class: 'exchange' })),
        h('div', { class: 'controls' },
          depthControl('a'),
          h('div', { class: 'ctl-mid' },
            h('button', { id: 'btn-deepen', class: 'btn primary', type: 'button', onclick: toggleAnim }),
            h('button', { class: 'link', type: 'button', text: '全部回到原作', onclick: resetAll }),
            h('div', { class: 'seg', id: 'persona-seg', title: '独白用谁的口吻' },
              h('button', { type: 'button', 'data-v': 'original', text: '原作人设', onclick: () => setPersona('original') }),
              h('button', { type: 'button', 'data-v': 'neutral', text: '中性人设', onclick: () => setPersona('neutral') })),
            q && h('div', { class: 'bias-row' },
              h('span', { class: 'ctl-k' }, '私心（偏差）', h('b', { id: 'bias-val' })),
              h('input', {
                type: 'range', class: 'rng', id: 'bias', min: 0,
                max: Math.max(...q.state_values) - Math.min(...q.state_values) || 1,
                step: (Math.max(...q.state_values) - Math.min(...q.state_values) || 1) / 50,
                oninput: (e) => { S.bias = +e.target.value; recompute(); },
              }))),
          depthControl('b'))),

      h('section', { class: 'strip-sec' },
        h('div', { class: 'strip-head' },
          h('h2', { class: 'sec-h', text: '要是两个人都再多想几层呢？' }),
          h('span', { id: 'strip-verdict', class: 'verdict-pill' })),
        h('div', { id: 'strip', class: 'strip' }),
        h('p', { class: 'strip-hint', text: '每一格 = 两人都恰好想到这一层时各自会怎么做。左上角的小菱形 = 和上一层想的相反。点任意一格，把两人的层数都设到那里。' })));
  }

  // ───────────── 每次重算后的刷新 ─────────────

  function update() {
    renderMinds();
    renderPeople();
    renderExchange();
    renderStrip();
    syncControls();
    writeHash();
    hydrateMonologues();
  }

  const hiding = () => !!(S.play && !S.play.chosen);

  function renderMinds() {
    const d = S.data, g = d.game;
    const names = { a: d.case.a.name, b: d.case.b.name };
    for (const r of ['a', 'b']) {
      const box = $('#mind-' + r);
      box.replaceChildren();
      if (S.play && S.play.as === r) { box.append(playPanel(r)); continue; }
      if (hiding()) {
        box.append(h('div', { class: 'veil role-' + r },
          h('div', { class: 'veil-q', text: '？' }),
          h('div', { text: `${names[r]}在想什么，你看不见。` }),
          h('div', { class: 'veil-s', text: '你出手之后才亮牌。' })));
        continue;
      }
      const tower = d.towers[r];
      const depth = tower.length - 1;
      const sig = {};
      tower.forEach((L, j) => { sig[depth - j] = L.cols[L.choice[Math.min(L.focus_row || 0, L.rows.length - 1)]]; });
      const prev = S.prevSig[r], pd = S.prevDepth[r];
      box.append(window.Bubbles.render({
        tower, owner: r, names, game: g, root: S.root[r], expanded: S.expanded, pinOpen: S.pinOpen,
        isNew: (k) => pd >= 0 && k > pd,
        flipped: (k) => !!prev && prev[k] != null && prev[k] !== sig[k],
        on: {
          drill: (j) => { S.root[r] = j; renderMinds(); hydrateMonologues(); },
          openPin: (j) => { const key = j == null ? null : `${r}:${j}`; S.pinOpen = S.pinOpen === key ? null : key; renderMinds(); hydrateMonologues(); },
          pin: (j, row, col) => { (S.pins[r][j] = S.pins[r][j] || {})[row] = col; S.pinOpen = null; recompute(); },
          unpin: (j) => { delete S.pins[r][j]; recompute(); },
          toggle: (key) => { S.expanded.has(key) ? S.expanded.delete(key) : S.expanded.add(key); renderMinds(); hydrateMonologues(); },
        },
      }));
      S.prevSig[r] = sig;
      S.prevDepth[r] = depth;
    }
  }

  function renderPeople() {
    const d = S.data, g = d.game;
    for (const r of ['a', 'b']) $('#person-' + r).classList.toggle('is-you', !!(S.play && S.play.as === r));
    const priv = $('#priv');
    if (!priv) return;
    priv.replaceChildren();
    if (S.play && S.play.as === 'b' && !S.play.chosen) {
      priv.append(h('div', { class: 'priv-k', text: `只有${d.case.a.name}知道` }), h('div', { class: 'priv-hidden', text: '？ ？ ？' }));
      return;
    }
    priv.append(h('div', { class: 'priv-k', text: `底牌 · 只有${d.case.a.name}知道` }),
      h('div', { class: 'priv-opts' }, ...g.states.map((s, i) => h('button', {
        type: 'button', class: 'opt' + (i === g.true_state ? ' on' : ''), text: s,
        title: i === g.true_state ? '现在的真相' : '换成这个真相试试',
        onclick: () => { if (i !== g.true_state) { S.trueState = i; S.pins = { a: {}, b: {} }; if (S.play) { S.play.chosen = false; S.forced = { a: null, b: null }; } recompute(); } },
      }))));
  }

  const signed = (x) => (x > 0 ? '+' : x < 0 ? '−' : '') + (Math.abs(x) % 1 ? Math.abs(x).toFixed(1) : Math.abs(x));

  function wire(dir, who, text, cls) {
    return h('div', { class: `wire ${dir} role-${cls}` },
      h('div', { class: 'wire-who', text: who }),
      h('div', { class: 'wire-line' }, h('span', { class: 'chip', text })));
  }

  function renderExchange() {
    const d = S.data, g = d.game, o = d.outcome, c = d.case;
    const box = $('#exchange');
    box.replaceChildren();
    const A = c.a.name, B = c.b.name;
    const sig = g.kind === 'signaling';
    const wait = hiding();

    if (sig) {
      const msgs = g.messages.map((m) => m.text);
      if (wait && S.play.as === 'a') {
        box.append(h('div', { class: 'waiting', text: `${B}在等你表态…` }));
        return;
      }
      box.append(wire('a2b', `${A}摆出`, msgs[o.choice_a], 'a'));
      if (wait) { box.append(h('div', { class: 'waiting', text: '轮到你了：怎么办？' })); return; }
      box.append(h('div', { class: 'reads role-b' }, `${B}读成：`, h('b', { text: g.states[o.guess_state] }), ` ${pct(o.belief_b[o.guess_state])}`));
      box.append(wire('b2a', `${B}于是`, g.actions[o.choice_b], 'b'));
    } else {
      if (wait) { box.append(h('div', { class: 'waiting', text: '两人同时出手，互相看不见…' })); return; }
      box.append(h('div', { class: 'versus' },
        h('div', { class: 'vs-side role-a' }, h('div', { class: 'wire-who', text: A }), h('span', { class: 'chip', text: g.actions_a[o.choice_a] })),
        h('span', { class: 'vs-x', text: '对' }),
        h('div', { class: 'vs-side role-b' }, h('div', { class: 'wire-who', text: B }), h('span', { class: 'chip', text: g.actions_b[o.choice_b] }))));
    }

    let head, sub, good;
    if (sig) {
      good = o.b_acted_right;
      head = o.guessed_right ? `${B}猜中了` : `${B}猜错了`;
      sub = (o.guessed_right ? `确实是「${g.states[o.true_state]}」` : `其实是「${g.states[o.true_state]}」`) +
        (o.b_acted_right ? '，这一步走对了' : '，这一步走错了');
      if (o.guessed_right !== o.b_acted_right) good = null;
    } else if (o.payoff_a > o.payoff_b) { head = `${A}赢了这一手`; sub = `${B}没料到`; good = null; }
    else if (o.payoff_b > o.payoff_a) { head = `${B}赢了这一手`; sub = `${A}被猜透了`; good = null; }
    else { head = o.payoff_a > 0 ? '两人想到一块去了' : o.payoff_a < 0 ? '两败俱伤' : '打平'; sub = ''; good = o.payoff_a > 0 ? true : null; }

    const cm = d.canonical_match;
    box.append(h('div', { class: 'result' + (good === true ? ' good' : good === false ? ' bad' : '') },
      h('div', { class: 'res-head', text: head }),
      sub && h('div', { class: 'res-sub', text: sub }),
      h('div', { class: 'payoffs' },
        h('span', { class: 'pay role-a' }, A + ' ', h('b', { text: signed(o.payoff_a) })),
        h('span', { class: 'pay role-b' }, B + ' ', h('b', { text: signed(o.payoff_b) }))),
      cm && h('span', {
        class: 'badge ' + (cm.all ? 'ok' : 'no'),
        title: `原作：${[c.canonical.choice_a, c.canonical.choice_b].filter(Boolean).join(' / ')}`,
        text: cm.all ? '与原作一致 ✓' : '与原作不同 ✗',
      })));
  }

  // ───────────── 层级走向条 ─────────────

  // 第 i 个选项的深浅：选项 0 最浓，往后渐淡，一眼看出「又翻回去了」
  const shade = (i, n) => (n <= 1 ? 100 : Math.round(100 - (i / (n - 1)) * 86));

  function ladderPick(lv, g, t) {
    if (g.kind === 'signaling') { const m = lv.a.choice[t]; return { a: m, b: lv.b.choice[m] }; }
    return { a: lv.a.choice[0], b: lv.b.choice[0] };
  }

  function spark(row, label, series, lo, hi, n, eqText, fmt) {
    const span = hi - lo || 1;
    const y = (v) => 0.14 + (1 - (v - lo) / span) * 0.72;
    const plot = h('div', { class: 'sp-plot', style: `grid-row:${row};grid-column: 2 / span ${n}` });
    let svg = `<svg viewBox="0 0 ${n} 1" preserveAspectRatio="none">`;
    for (const s of series) {
      svg += `<polyline class="${s.cls}" vector-effect="non-scaling-stroke" points="${s.vals.map((v, i) => `${i + 0.5},${y(v).toFixed(3)}`).join(' ')}"/>`;
    }
    plot.innerHTML = svg + '</svg>';
    for (const s of series) {
      s.vals.forEach((v, i) => plot.append(h('i', {
        class: 'sp-dot ' + s.cls, style: `left:${((i + 0.5) / n) * 100}%;top:${y(v) * 100}%`,
        title: `第 ${i} 层 · ${s.name || label}：${fmt(v)}`,
      })));
    }
    return [h('div', { class: 'sp-label', style: `grid-row:${row};grid-column:1`, text: label }), plot, h('div', { class: 'sp-eq', style: `grid-row:${row};grid-column:${n + 2}`, text: eqText })];
  }

  function renderStrip() {
    const d = S.data, A = d.analysis, g = d.game, L = A.levels, n = L.length;
    const names = { a: d.case.a.name, b: d.case.b.name };
    const t = g.kind === 'signaling' ? g.true_state : 0;
    const box = $('#strip');
    box.replaceChildren();
    box.classList.toggle('concealed', hiding());
    const vp = $('#strip-verdict');
    vp.className = 'verdict-pill ' + A.verdict;
    vp.textContent = A.verdict === 'converged' ? `从第 ${A.settles_at} 层起收敛：再想也不变了`
      : A.verdict === 'cycle' ? `震荡 · 周期 ${A.period}：越想越绕，永远追不上`
        : `${n - 1} 层之内还没看出规律`;
    vp.hidden = hiding();
    if (hiding()) { box.append(h('div', { class: 'strip-veil', text: '亮牌之后再看。' })); return; }

    const grid = h('div', { class: 'sgrid', style: `--n:${n}` });
    // 括号：周期 / 收敛段
    grid.append(h('div', { class: 'sg-corner', style: 'grid-row:1;grid-column:1' }));
    if (A.period && A.settles_at != null) {
      const seg = (s, e, text) => grid.append(h('div', { class: 'brk ' + A.verdict, style: `grid-column:${s + 2} / ${e + 3}` }, text && h('span', { text })));
      if (A.verdict === 'converged') seg(A.settles_at, n - 1, `从第 ${A.settles_at} 层起收敛`);
      else for (let s = A.settles_at, first = true; s < n; s += A.period, first = false) seg(s, Math.min(s + A.period - 1, n - 1), first ? `周期 ${A.period}` : '');
    }
    // 层号
    grid.append(h('div', { class: 'sg-label muted', style: 'grid-row:2;grid-column:1', text: '层数' }));
    const picks = L.map((lv) => ladderPick(lv, g, t));
    L.forEach((lv, i) => {
      const cur = i === d.depth.a && i === d.depth.b;
      grid.append(h('button', {
        class: 'sg-col' + (cur ? ' cur' : ''), type: 'button', style: `grid-column:${i + 2};grid-row:2 / span 3`,
        title: `把两人都设到第 ${i} 层`, 'aria-label': `第 ${i} 层`,
        onclick: () => { stopAnim(); const x = setDepth('a', i), y = setDepth('b', i); if (x || y) recompute(); },
      }, h('span', { class: 'sg-d', text: i })));
    });
    grid.append(h('div', { class: 'sg-d inf', style: `grid-column:${n + 2};grid-row:2`, title: '无限层的极限（近似均衡）', text: '∞' }));
    // 两人的结论
    for (const r of ['a', 'b']) {
      const row = r === 'a' ? 3 : 4;
      grid.append(h('div', { class: 'sg-label role-' + r, style: `grid-row:${row};grid-column:1`, text: names[r] }));
      picks.forEach((p, i) => {
        const cols = L[i][r].cols;
        const flip = i > 0 && picks[i - 1][r] !== p[r];
        grid.append(h('div', {
          class: `sg-cell role-${r}` + (shade(p[r], cols.length) > 55 ? ' dark' : '') + (flip ? ' flip' : ''),
          style: `grid-row:${row};grid-column:${i + 2};--mix:${shade(p[r], cols.length)}%`, title: `第 ${i} 层的${names[r]}：${cols[p[r]]}` + (flip ? '（和上一层相反）' : ''),
        }, h('span', { text: cols[p[r]] }), flip && h('i', { class: 'flipmark' })));
      });
      const E = d.equilibrium[r];
      const er = g.kind === 'signaling' ? (r === 'a' ? t : argmax(d.equilibrium.a.policy[t])) : 0;
      const cell = h('div', { class: `sg-eq role-${r}`, style: `grid-row:${row};grid-column:${n + 2}`, title: '想到无穷层：只能按这个比例随机' });
      cell.append(bars(E.cols, E.policy[er], argmax(E.policy[er]), 'act mini', 3));
      grid.append(cell);
    }
    // 指标小图
    const mv = (k) => L.map((lv) => lv.metrics[k]);
    const em = d.equilibrium.metrics || {};
    const f2 = (v) => v.toFixed(2);
    if (g.kind === 'signaling') {
      grid.append(...spark(5, `${names.b}猜中率`, [{ vals: mv('accuracy'), cls: 'ink' }], 0, 1, n, em.accuracy != null ? pct(em.accuracy) : '', pct));
      const ib = mv('info_bits');
      grid.append(...spark(6, '话里的信息量', [{ vals: ib, cls: 'ink' }], 0, Math.max(1, ...ib), n, em.info_bits != null ? f2(em.info_bits) + ' bit' : '', (v) => f2(v) + ' bit'));
    } else {
      grid.append(...spark(5, '撞到一起的概率', [{ vals: mv('match'), cls: 'ink' }], 0, 1, n, em.match != null ? pct(em.match) : '', pct));
      const ea = mv('eu_a'), eb = mv('eu_b');
      grid.append(...spark(6, '期望得失', [{ vals: ea, cls: 'la', name: names.a }, { vals: eb, cls: 'lb', name: names.b }],
        Math.min(...ea, ...eb), Math.max(...ea, ...eb), n,
        em.eu_a != null ? `${signed(+em.eu_a.toFixed(1))} / ${signed(+em.eu_b.toFixed(1))}` : '', f2));
    }
    box.append(grid);
  }

  // ───────────── 控件同步 ─────────────

  function syncControls() {
    const d = S.data;
    for (const r of ['a', 'b']) {
      const ctl = $(`.ctl[data-r="${r}"]`);
      const me = S.play && S.play.as === r;
      ctl.classList.toggle('mine', !!me);
      $('.dval', ctl).textContent = d.depth[r];
      const dr = $('.depth', ctl);
      if (+dr.value !== d.depth[r]) dr.value = d.depth[r];
      dr.disabled = !!me;
      dr.style.setProperty('--fill', (d.depth[r] / MAXD) * 100 + '%');
      $('.lval', ctl).textContent = (+d.lam[r]).toFixed(1);
      const lr = $('.lam', ctl);
      if (Math.abs(+lr.value - d.lam[r]) > 1e-6) lr.value = d.lam[r];
      lr.style.setProperty('--fill', ((d.lam[r] - 0.2) / 4.8) * 100 + '%');
      $('.play-as', ctl).textContent = me ? `不玩了，让${d.case[r].name}自己来` : `我来当${d.case[r].name}`;
      $('.play-as', ctl).classList.toggle('on', !!me);
    }
    const bd = $('#btn-deepen');
    bd.textContent = S.anim ? '❚❚ 暂停' : '▶ 一起加深';
    bd.classList.toggle('on', !!S.anim);
    bd.disabled = !!S.play;
    $$('#persona-seg button').forEach((b) => b.classList.toggle('on', b.dataset.v === S.persona));
    $('#persona-seg').classList.toggle('off', !S.claude);
    const q = d.game.quadratic;
    if (q && $('#bias')) {
      $('#bias-val').textContent = ' ' + (+q.bias).toFixed(2);
      if (Math.abs(+$('#bias').value - q.bias) > 1e-6) $('#bias').value = q.bias;
    }
  }

  function setPersona(v) {
    if (S.persona === v) return;
    S.persona = v;
    syncControls();
    hydrateMonologues();
  }

  function resetAll() {
    stopAnim();
    const c = S.data.case.canonical;
    Object.assign(S, {
      depth: { a: c.depth_a, b: c.depth_b }, lam: { a: null, b: null }, bias: null, trueState: null,
      forced: { a: null, b: null }, pins: { a: {}, b: {} }, extra: [], play: null, root: { a: null, b: null }, pinOpen: null,
    });
    recompute();
  }

  // ───────────── 一起加深（动画） ─────────────

  function stopAnim() {
    if (!S.anim) return;
    clearInterval(S.anim);
    S.anim = null;
    if (S.data && S.built) { syncControls(); hydrateMonologues(); }
  }

  function stepAnim() {
    if (S.depth.a >= MAXD && S.depth.b >= MAXD) { stopAnim(); return; }
    const x = setDepth('a', S.depth.a + 1), y = setDepth('b', S.depth.b + 1);
    if (x || y) recompute();
  }

  function toggleAnim() {
    if (S.anim) { stopAnim(); return; }
    if (S.depth.a >= MAXD && S.depth.b >= MAXD) { setDepth('a', 0); setDepth('b', 0); recompute(); }
    S.anim = setInterval(stepAnim, 1400);
    syncControls();
    if (S.depth.a < MAXD || S.depth.b < MAXD) setTimeout(() => S.anim && stepAnim(), 250);
  }

  // ───────────── 亲自下场 ─────────────

  function togglePlayAs(r) {
    stopAnim();
    S.forced = { a: null, b: null };
    S.pinOpen = null;
    S.play = S.play && S.play.as === r ? null : { as: r, chosen: false };
    recompute();
  }

  function choose(r, i) {
    S.forced[r] = i;
    S.play.chosen = true;
    recompute();
  }

  function listLevels(xs) {
    if (xs.length <= 6) return xs.join('、');
    return xs.slice(0, 6).join('、') + '…';
  }

  function playPanel(r) {
    const d = S.data, g = d.game, o = d.outcome, c = d.case;
    const me = c[r], opp = c[other(r)];
    const sig = g.kind === 'signaling';
    const opts = sig ? (r === 'a' ? g.messages.map((m) => m.text) : g.actions) : (r === 'a' ? g.actions_a : g.actions_b);
    const p = h('div', { class: 'playpanel role-' + r });
    p.append(h('div', { class: 'pp-eyebrow', text: '你来当' }), h('div', { class: 'pp-name', text: me.name }));
    if (me.persona) p.append(h('p', { class: 'pp-t', text: me.persona }));
    if (me.goal) p.append(h('p', { class: 'pp-g', text: '你想要：' + me.goal }));

    if (!S.play.chosen) {
      if (sig && r === 'a') p.append(h('p', { class: 'pp-q' }, '只有你知道：', h('b', { text: g.states[g.true_state] }), '。你打算怎么表态？'));
      else if (sig) p.append(h('p', { class: 'pp-q' }, '真相你看不见。你只看到对方：', h('b', { text: `「${g.messages[o.choice_a].text}」` }), '。你怎么办？'));
      else p.append(h('p', { class: 'pp-q', text: `${opp.name}也在同时做决定，你看不见。你选哪个？` }));
      p.append(h('div', { class: 'pp-opts' }, ...opts.map((t, i) => h('button', { class: 'btn choice', type: 'button', text: t, onclick: () => choose(r, i) }))));
      if (sig && r === 'a') {
        const inp = h('input', { type: 'text', class: 'txt', placeholder: '或者自己编一句话 / 一个举动…', maxlength: 60 });
        const go = h('button', { class: 'btn', type: 'button', text: '就说这句' });
        const submit = async () => {
          const text = inp.value.trim();
          if (!text) return;
          go.disabled = true; go.textContent = '在琢磨这句话…';
          try {
            const m = await api('/api/lexicon', { case_id: S.caseId, text }, 60000);
            if (!m || !Array.isArray(m.literal)) throw new Error('返回格式不对');
            S.extra.push({ text: m.text || text, cost: m.cost || 0, literal: m.literal });
            S.pins = { a: {}, b: {} };
            choose('a', g.messages.length);
          } catch (e) {
            go.disabled = false; go.textContent = '就说这句';
            toast(e.status === 404 ? '还不能自己编话：后端的 /api/lexicon 尚未就绪' : '这句话没弄明白：' + e.message);
          }
        };
        go.addEventListener('click', submit);
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });
        p.append(h('div', { class: 'pp-own' }, inp, go));
      }
      return p;
    }

    const mine = r === 'a' ? o.choice_a : o.choice_b;
    const theirs = r === 'a' ? o.choice_b : o.choice_a;
    const theirOpts = sig ? (r === 'a' ? g.actions : g.messages.map((m) => m.text)) : (r === 'a' ? g.actions_b : g.actions_a);
    const played = (d.played || {})[r];
    p.append(h('p', { class: 'pp-q' }, '你选了 ', h('b', { text: `「${opts[mine]}」` })));
    if (played) {
      p.append(h('div', { class: 'pp-equiv' + (played.length ? '' : ' none') },
        played.length ? `你的选择相当于想了第 ${listLevels(played)} 层` : '你的选择不属于任何一层 —— 0 到 12 层的人都不会这么选'));
    }
    p.append(h('p', { class: 'pp-t' }, `${opp.name}想到第 ${d.depth[other(r)]} 层，`, sig && r === 'b' ? '摆出的是' : '选了', h('b', { text: `「${theirOpts[theirs]}」` }), '。右边/左边是对方当时的心思。'.replace('右边/左边', r === 'a' ? '右边' : '左边')));
    p.append(h('div', { class: 'pp-opts' },
      h('button', { class: 'btn', type: 'button', text: '再来一次', onclick: () => { S.forced = { a: null, b: null }; S.play.chosen = false; recompute(); } }),
      h('button', { class: 'btn', type: 'button', text: '不玩了', onclick: () => togglePlayAs(r) })));
    return p;
  }

  // ───────────── 内心独白（慢，逐个气泡异步补上） ─────────────

  const M = { cache: new Map(), queue: [], busy: new Set(), dead: false, timer: null, limit: 4 };

  function monoBody(owner, level) {
    return Object.assign(params(), { depth_a: S.depth.a, depth_b: S.depth.b, owner, level, persona_mode: S.persona });
  }

  function paintMono(node, text, pending) {
    const line = node.closest('.bubble').querySelector(':scope > .b-foot .concl-t');
    node.replaceChildren();
    node.classList.toggle('pending', !!pending);
    if (pending) { node.hidden = false; node.append(h('span', { class: 'shimmer', text: '正在想…' })); return; }
    if (!text || (line && text.trim() === line.textContent.trim())) { node.hidden = true; return; }
    node.hidden = false;
    node.append(h('span', { class: 'mono-t', text: `“${text.trim().replace(/^[“"「]+|[”"」]+$/g, '')}”` }),
      h('button', { class: 'link tiny regen', type: 'button', title: '换一种说法', text: '重新生成', onclick: () => regen(node) }));
  }

  function hydrateMonologues() {
    clearTimeout(M.timer);
    M.queue = [];
    const nodes = $$('.bubble > .mono');
    const live = S.claude && !M.dead && !S.anim;
    const want = [];
    for (const node of nodes) {
      const b = node.parentElement;
      const body = monoBody(b.dataset.owner, +b.dataset.level);
      const key = JSON.stringify(body);
      node.dataset.key = key;
      if (M.cache.has(key)) paintMono(node, M.cache.get(key));
      else if (live) { paintMono(node, null, true); want.push({ key, body }); }
      else node.hidden = true;
    }
    if (!want.length) return;
    // 稍等一下再发：拖滑块时不为每个中间状态都叫一次模型
    M.timer = setTimeout(() => { M.queue = want; pump(); }, 500);
  }

  function pump() {
    while (M.busy.size < M.limit && M.queue.length) {
      const job = M.queue.shift();
      if (M.cache.has(job.key) || M.busy.has(job.key)) continue;
      M.busy.add(job.key);
      api('/api/monologue', job.body, 90000).then((res) => {
        if (res && typeof res.text === 'string') M.cache.set(job.key, res.text);
        else M.cache.set(job.key, '');
      }).catch((e) => {
        if (e.status === 404 || e.status === 405) { M.dead = true; M.queue = []; }
        job.failed = true;
      }).finally(() => {
        M.busy.delete(job.key);
        // 状态已经变了的话，页面上就不再有这把钥匙对应的气泡，结果只进缓存
        for (const node of $$('.bubble > .mono')) {
          if (node.dataset.key !== job.key) continue;
          if (job.failed) { node.hidden = true; node.classList.remove('pending'); } else paintMono(node, M.cache.get(job.key));
        }
        if (M.dead) $$('.bubble > .mono.pending').forEach((n) => { n.hidden = true; });
        pump();
      });
    }
  }

  function regen(node) {
    const key = node.dataset.key;
    if (!key || M.busy.has(key)) return;
    M.cache.delete(key);
    paintMono(node, null, true);
    const base = JSON.parse(key);
    M.busy.add(key);
    api('/api/monologue', Object.assign({}, base, { regenerate: true }), 90000)
      .then((res) => { M.cache.set(key, (res && res.text) || ''); })
      .catch(() => { toast('重新生成失败'); })
      .finally(() => {
        M.busy.delete(key);
        for (const n of $$('.bubble > .mono')) if (n.dataset.key === key) { M.cache.has(key) ? paintMono(n, M.cache.get(key)) : (n.hidden = true); }
      });
  }

  // ───────────── 启动 ─────────────

  async function boot() {
    await Promise.all([loadLibrary(), checkHealth()]);
    const hsh = readHash();
    const start = (hsh.id && findCard(hsh.id)) || firstCard();
    if (start) await openCase(start.id, hsh.id === start.id ? hsh : null);
    else $('#view').replaceChildren(h('p', { class: 'empty', text: '案例库还是空的。' }));
    window.addEventListener('hashchange', () => {
      const x = readHash();
      if (!x.id || !findCard(x.id)) return;
      if (x.id !== S.caseId) { openCase(x.id, x); return; }
      if (S.card && S.card.runnable && S.data) {
        const p = x.a != null && setDepth('a', x.a), q = x.b != null && setDepth('b', x.b);
        if (p || q) recompute();
      }
    });
    setInterval(() => { loadLibrary().then(markActive); checkHealth(); }, 15000);
  }

  boot();
})();
