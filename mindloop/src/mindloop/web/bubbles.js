/* 嵌套思维气泡：把一座「我猜你猜我」的塔画成一层套一层的气泡。
   只负责画，不管状态；所有交互通过 ctx.on.* 回调交给 app.js。 */
(function () {
  'use strict';

  const MAXVIS = 4; // 完整画出的最外几层，再深的折叠成「还有 n 层」

  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  }

  const pct = (x) => (x >= 0.995 ? '100' : x < 0.005 ? '0' : Math.round(x * 100)) + '%';
  const argmax = (xs) => xs.reduce((best, x, i) => (x > xs[best] ? i : best), 0);

  /* 一组横向概率条。chosen = 最可能的那一项（加粗、实色）。 */
  function bars(labels, probs, chosen, variant, max) {
    const box = el('div', 'bars ' + (variant || ''));
    let idx = labels.map((_, i) => i);
    max = max || 5;
    if (labels.length > max) {
      idx = idx.slice().sort((x, y) => probs[y] - probs[x]).slice(0, max - 1).sort((x, y) => x - y);
    }
    for (const i of idx) {
      const r = el('div', 'bar' + (i === chosen ? ' top' : ''));
      r.append(el('span', 'bar-l', labels[i]));
      const t = el('span', 'bar-t');
      const f = el('i');
      f.style.width = (probs[i] * 100).toFixed(1) + '%';
      t.append(f);
      r.append(t, el('span', 'bar-p', pct(probs[i])));
      box.append(r);
    }
    if (idx.length < labels.length) box.append(el('div', 'bar-more', `… 另有 ${labels.length - idx.length} 项`)), box.lastChild.title = labels.filter((_, i) => !idx.includes(i)).map((l, k) => l).join('、');
    return box;
  }

  /* 某一层在某一行（某个真相 / 听到某句话）下的想法。 */
  function rowBlock(L, row, game, names, focus) {
    const box = el('div', 'rowblock' + (focus ? ' focus' : ' alt'));
    if (game.kind !== 'signaling') {
      box.append(bars(L.cols, L.policy[0], L.choice[0], 'act'));
      return box;
    }
    if (L.role === 'a') {
      box.append(el('div', 'cap', `若真相是「${L.rows[row]}」，${names.a}会`));
      box.append(bars(L.cols, L.policy[row], L.choice[row], 'act'));
    } else {
      box.classList.add('two');
      const l = el('div', 'half'), r = el('div', 'half');
      l.append(el('div', 'cap', `见到「${L.rows[row]}」，${names.b}以为`), bars(game.states, L.belief[row], argmax(L.belief[row]), 'belief'));
      r.append(el('div', 'cap', '于是'), bars(L.cols, L.policy[row], L.choice[row], 'act'));
      box.append(l, r);
    }
    return box;
  }

  /* 第 k 重嵌套的气泡该怎么称呼（从塔主人的视角）。 */
  function pathLabel(owner, k, names) {
    const me = names[owner];
    const ot = names[owner === 'a' ? 'b' : 'a'];
    if (k === 0) return `我 · ${me}`;
    if (k === 1) return `我心里的${ot}`;
    if (k === 2) return `${ot}心里的我`;
    if (k === 3) return `${ot}心里的我 · 所猜的他`;
    return k % 2 ? `再往里一重的${ot}` : '再往里一重的我';
  }

  function fullPath(owner, k, names) {
    const me = names[owner];
    const ot = names[owner === 'a' ? 'b' : 'a'];
    const parts = [];
    for (let i = 0; i <= k; i++) parts.push(i % 2 ? ot : me);
    return parts.join(' 猜 ');
  }

  /* ctx = { tower, owner, names:{a,b}, game, root, expanded:Set, pinOpen,
            isNew(k), flipped(k), on:{drill, openPin, pin, unpin, toggle, regen} } */
  function render(ctx) {
    const { tower, owner, names, game } = ctx;
    const depth = tower.length - 1;
    const root = ctx.root == null ? depth : Math.max(0, Math.min(depth, ctx.root));
    const wrap = el('div', 'tower');

    if (root < depth) {
      const bc = el('div', 'crumbs');
      bc.append(el('span', 'crumbs-l', '往外：'));
      for (let j = depth; j > root; j--) {
        const c = el('button', 'crumb role-' + tower[j].role, j === depth ? `${names[owner]} · 第${j}层` : `第${j}层`);
        c.type = 'button';
        c.title = pathLabel(owner, depth - j, names);
        c.addEventListener('click', () => ctx.on.drill(j === depth ? null : j));
        bc.append(c, el('span', 'crumb-sep', '›'));
      }
      bc.append(el('span', 'crumb here', `第${root}层`));
      wrap.append(bc);
    }

    function build(j) {
      const L = tower[j];
      const k = depth - j; // 从主人往里数第几重
      const vis = root - j; // 在当前视图里第几重
      const pinned = L.pinned && Object.keys(L.pinned).length > 0;
      const b = el('div', `bubble role-${L.role} tone-${Math.min(vis, 4)}`);
      if (ctx.isNew && ctx.isNew(k)) b.classList.add('grow');
      if (ctx.flipped && ctx.flipped(k)) {
        b.classList.add('flash');
        b.style.setProperty('--flash-delay', Math.max(0, j) * 90 + 'ms');
      }
      if (pinned) b.classList.add('pinned');
      b.dataset.owner = owner;
      b.dataset.level = j;

      // —— 头：这是谁心里的谁
      const head = el('div', 'b-head');
      head.append(el('span', 'b-dot'));
      const lab = el('span', 'b-label', pathLabel(owner, k, names));
      lab.title = fullPath(owner, k, names);
      head.append(lab);
      head.append(el('span', 'b-lv', `第${j}层`));
      if (j === 0) head.append(el('span', 'b-naive', game.kind === 'signaling' ? '不动脑筋 · 只看字面' : '不动脑筋 · 凭直觉'));
      if (pinned) {
        head.append(el('span', 'b-pin', '📌 已钉住'));
        const un = el('button', 'link', '取消');
        un.type = 'button';
        un.addEventListener('click', () => ctx.on.unpin(j));
        head.append(un);
      }
      b.append(head);

      // —— 独白（由 app.js 填）
      const mono = el('div', 'mono');
      mono.hidden = true;
      b.append(mono);

      // —— 里面套着的下一层
      if (j > 0) {
        const cvis = root - (j - 1);
        if (cvis < MAXVIS || (j - 1 === 0 && cvis === MAXVIS)) {
          b.append(build(j - 1));
        } else {
          const chip = el('button', 'more-chip');
          chip.type = 'button';
          const dots = el('span', 'more-dots');
          for (let i = j - 1; i >= Math.max(0, j - 7); i--) dots.append(el('i', 'role-' + tower[i].role));
          chip.append(dots, el('span', null, `… 还有 ${j} 层，点开往里看`));
          chip.addEventListener('click', () => ctx.on.drill(j));
          b.append(chip);
        }
      }

      // —— 脚：这一层的想法与结论
      const foot = el('div', 'b-foot');
      const fr = Math.min(L.focus_row || 0, L.rows.length - 1);
      const key = `${owner}:${k}`;
      const multi = L.rows.length > 1;
      // 概率条只在最外层常驻；里层靠一句结论说话，点「看概率」再展开
      const open = ctx.expanded.has(key);
      if (vis === 0 || open) foot.append(rowBlock(L, fr, game, names, true));
      if (multi && open) {
        const alt = el('div', 'altrows');
        L.rows.forEach((_, r) => { if (r !== fr) alt.append(rowBlock(L, r, game, names, false)); });
        foot.append(alt);
      }
      const row = el('div', 'concl-row');
      const concl = el('button', 'concl');
      concl.type = 'button';
      concl.title = '点一下：把这一层的结论钉成别的，看外层怎么变';
      concl.append(el('span', 'concl-arrow', '→'), el('span', 'concl-t', L.line));
      concl.addEventListener('click', () => ctx.on.openPin(j));
      row.append(concl);
      if (multi || vis > 0) {
        const tg = el('button', 'link tiny', open ? '收起' : vis > 0 ? '看概率' : '换个情况呢');
        tg.type = 'button';
        tg.addEventListener('click', () => ctx.on.toggle(key));
        row.append(tg);
      }
      foot.append(row);

      if (ctx.pinOpen === `${owner}:${j}`) {
        const pp = el('div', 'pinpanel');
        pp.append(el('div', 'pin-title', '📌 假如这一层偏要这么想：'));
        const order = [fr, ...L.rows.map((_, r) => r).filter((r) => r !== fr)];
        for (const r of order) {
          const line = el('div', 'pin-line');
          if (multi) line.append(el('span', 'pin-row', (L.role === 'a' ? '若' : '见') + `「${L.rows[r]}」`));
          L.cols.forEach((c, ci) => {
            const cur = L.pinned && L.pinned[String(r)] === ci;
            const bt = el('button', 'opt' + (cur ? ' on' : L.choice[r] === ci ? ' cur' : ''), c);
            bt.type = 'button';
            bt.addEventListener('click', () => ctx.on.pin(j, r, ci));
            line.append(bt);
          });
          pp.append(line);
        }
        const cl = el('button', 'link tiny', '算了');
        cl.type = 'button';
        cl.addEventListener('click', () => ctx.on.openPin(null));
        pp.append(cl);
        foot.append(pp);
      }
      b.append(foot);
      return b;
    }

    wrap.append(build(root));
    return wrap;
  }

  window.Bubbles = { render, bars, pct, argmax, pathLabel };
})();
