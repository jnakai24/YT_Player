// ==UserScript==
// @name         YT Player (Firefox)
// @namespace    jnaka.ytplayer
// @version      0.32
// @description  YouTube のページに再生リストのプルダウンと再生操作のバーを足す（YT Player の Firefox / Android 版）
// @match        https://m.youtube.com/*
// @match        https://www.youtube.com/*
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

// 使い方は android/README.md。YouTube のページの作りに頼っている部分は ytplayer.py と同じ（CLAUDE.md 参照）。
// YouTube は Trusted Types を使うので innerHTML は使わず DOM を組み立てる。

(function () {
  'use strict';
  const VERSION = '0.32';
  // 一覧の取得は、スマホ版（MWEB）として問い合わせると空が返るので、パソコン版（WEB）として問い合わせる。
  // 古すぎると断られることがあるので、壊れたらパソコン版のページの ytcfg INNERTUBE_CLIENT_VERSION に合わせる。
  const WEB_CLIENT_VERSION = '2.20261105.05.01';
  const STORE = 'ytp-settings';

  // ---- ページ側のものに触るための準備 ----
  // Firefox の Violentmonkey は、サイトによってはスクリプトをページと切り離した場所（コンテンツスクリプト）で動かす。
  // そこからは YouTube が要素に足したメソッド（#movie_player の nextVideo など）が見えないので、
  // wrappedJSObject（ページ側の中身）を通して触る。ページ側に渡す関数は exportFunction で渡す。
  // ページの中で動いているときはどちらもないので、そのまま使う。
  const IN_CONTENT = typeof window.wrappedJSObject === 'object' && window.wrappedJSObject !== null;
  const MODE = IN_CONTENT ? 'content' : 'page';
  function pageObj(o) { return o && IN_CONTENT && o.wrappedJSObject ? o.wrappedJSObject : o; }
  function pageFn(fn) {
    return IN_CONTENT && typeof exportFunction === 'function' ? exportFunction(fn, window) : fn;
  }

  // ---- 設定（youtube.com の localStorage に保存。この端末・このブラウザだけ） ----
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }
  const settings = load();
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) {}
  }

  // ---- アプリの画面のときの目隠し（0.29）----
  // 保存分 ↔ 通信の切り替わりなどでページを開き直すと、アプリの画面が出るまで（約 1 秒）YouTube のページが見えてちらつく（0.28 の実機）。
  // スクリプトはページの読み込みの最初（document-start）に動くので、アプリの画面にしているなら、すぐに黒で覆っておき、
  // アプリの画面が出て動画を枠に置いたら外す（placeView → dropCover）。出ないまま 15 秒たったら外す。
  // 読み込みの本当に最初は <html> 要素もまだないことがある（PC で document-start に入れて確認）。できるのを待って置く。
  let cover = null;
  if (location.hostname === 'www.youtube.com' && settings.view === 'app' && location.pathname.startsWith('/watch')) {
    cover = document.createElement('div');
    cover.id = 'ytp-cover';
    cover.style.cssText = 'position:fixed;left:0;top:0;width:100vw;height:100vh;min-width:100%;min-height:100%;' +
                          'z-index:2147483647;background:#0f0f0f;pointer-events:none';
    const put = () => {
      if (!cover) return;
      document.documentElement.append(cover);
      document.documentElement.style.background = '#0f0f0f';
    };
    if (document.documentElement) put();
    else new MutationObserver((m, o) => { if (document.documentElement) { o.disconnect(); put(); } })
      .observe(document, {childList: true});
    setTimeout(() => dropCover(), 15000);
  }
  function dropCover() {
    if (!cover) return;
    cover.remove();
    cover = null;
    if (document.documentElement) document.documentElement.style.background = '';
  }

  // ---- 動画のデータをどれだけ通信で取ったか（保存分で流せているかの確かめ用） ----
  // ページが取りに行った動画のデータ（アドレスに videoplayback を含むもの）の件数と、通信した大きさを数える。
  // 保存分で流れているなら、件数は増えても通信した大きさはほとんど増えないはず。記録と「記録をコピー」に出す。
  const media = {count: 0, bytes: 0, last: ''};
  try {
    new PerformanceObserver(list => {
      for (const e of list.getEntries()) {
        if (e.name.indexOf('videoplayback') < 0) continue;
        media.count++;
        media.bytes += e.transferSize || 0;
        media.last = Math.round(e.duration) + 'ms 通信' + (e.transferSize || 0) + 'B 中身' + (e.encodedBodySize || 0) + 'B' +
                     (e.workerStart > 0 ? ' SW経由' : '');
      }
    }).observe({type: 'resource', buffered: true});
  } catch (e) {}
  function mediaText() {
    return 'データ ' + media.count + ' 件 / 通信 ' + Math.round(media.bytes / 1024) + ' KB' + (media.last ? '（直近 ' + media.last + '）' : '');
  }

  // ---- 「PC 版で開く」：スマホ版（m.youtube.com）を開いたら、パソコン版の表示（www、app=desktop）へ移る ----
  // オフライン保存はパソコン版の表示にしかないので、毎回手で切り替えなくて済むようにする。既定はオフ。
  // 設定は m.youtube.com の側にある（localStorage はサイトごと）。戻すときは、パソコン版のバーの「スマホ版へ」。
  // URL に app= があるとき（パソコン版から戻された・自分でスマホ版を選んだ）は移らない。行ったり来たりを防ぐため。
  if (location.hostname === 'm.youtube.com' && settings.pc) {
    const u = new URL(location.href);
    if (!u.searchParams.has('app')) {
      u.hostname = 'www.youtube.com';
      u.searchParams.set('app', 'desktop');
      location.replace(u.href);
      return;
    }
  }

  // ---- 開いたら前回の続きから流す（「開いたら続きから」がオンのとき。既定はオン） ----
  // 前回の動画を止めた位置から開く URL。開いているサイト（m. / www.）のまま開く。
  // 「オフライン優先」がオンのときは、保存済みの曲を保存分で流す側（list=PPSV）で開く。
  // YouTube は、同じ動画でも watch?v=…&list=PPSV（「オフライン保存」の並び）で開くと、通信せずに保存分を再生する。
  // 元の再生リストの曲順（settings.orders）を知っているときだけ。保存済みの控え（settings.saved）があれば、保存済みの曲から始める。
  function onMobile() { return location.hostname === 'm.youtube.com'; }
  function resumeTarget(force) {
    if (!settings.last_url) return null;
    const u = new URL(settings.last_url);
    u.searchParams.delete('pp');
    u.searchParams.delete('t');
    let time = settings.last_time || 0;
    const x = u.searchParams.get('list'), order = x && (settings.orders || {})[x];
    const saved = settings.saved || [];
    // 保存済みの控えが空のときは、保存分の側へは行かない（行っても流せる曲がなく、次の曲へも進まない）。
    // 控えは、保存分の側を開いたとき・「このリストを保存」をしたときにできる。スイッチをオンにした直後だけは確かめに行く（force）
    if (!onMobile() && settings.offline && x !== 'PPSV' && order && order.length && (saved.length || force)) {
      let v = u.searchParams.get('v');
      if (saved.length && !saved.includes(v)) {
        const i = order.indexOf(v);
        v = order.slice(i + 1).concat(order.slice(0, i + 1)).find(id => saved.includes(id)) || null;
        time = 0;
        if (!v) log('保存済みの曲がないので、通信する側で開く');
      }
      if (v) {
        log('保存分の側で開く v=' + v + (time > 5 ? ' ' + time + ' 秒から' : ''));
        u.searchParams.set('v', v);
        u.searchParams.set('list', 'PPSV');
        u.searchParams.delete('index');
        settings.offline_list = x;
        save();
      }
    }
    if (time > 5) u.searchParams.set('t', time + 's');
    return {url: u.pathname + u.search, time: time};
  }
  // スクリプトが開いたページ（続きから・再生リストを選んだとき）では、開いたあとに再生を始め、前回の位置まで進める。
  // スマホ版の YouTube は、Firefox の自動再生を許可していても、開いただけでは再生を始めない。
  // また Firefox では URL の位置指定（t=）が効く前に再生が始まって先頭から流れることがあるので、位置はスクリプトが合わせる。
  // 開く前に印（進める秒数）を付け、開いた先のページで印を見て 1 回だけ消費する。
  function markAutoplay(seconds) {
    try { sessionStorage.setItem('ytp-play', String(Math.floor(seconds || 0))); } catch (e) {}
  }
  let wantPlay = false;
  let resumeSeek = 0;  // この位置まで進める（0 なら進めない）
  try {
    const mark = sessionStorage.getItem('ytp-play');
    sessionStorage.removeItem('ytp-play');
    if (mark !== null) {
      wantPlay = true;
      if (Number(mark) > 5) resumeSeek = Number(mark);
    }
  } catch (e) {}

  // タブごとに 1 回だけ。YouTube のロゴでトップに戻ったときや、開き直したときにまた飛ばないようにする。
  (function autoResume() {
    if (settings.autoresume === false || !settings.last_url) return;
    try {
      if (sessionStorage.getItem('ytp-resumed')) return;
      sessionStorage.setItem('ytp-resumed', '1');
    } catch (e) { return; }
    if (location.pathname === '/') {
      // トップページで開いたら、前回の動画へ（ページを読み込む前に飛ぶ）
      const r = resumeTarget();
      markAutoplay(r.time);
      location.replace(r.url);
    } else if (location.pathname === '/watch') {
      // Firefox が前回のタブを開き直したときなど。同じ動画で位置の指定がなければ、前回の位置まで進める
      const here = new URL(location.href).searchParams, last = new URL(settings.last_url).searchParams;
      if (here.get('v') === last.get('v') && !here.get('t') && (settings.last_time || 0) > 5) {
        resumeSeek = settings.last_time;
        wantPlay = true;
      }
    }
  })();

  // スマホでパソコン版の表示を開いたとき（切り替えるたびにページが読み直される）は、開いただけでは再生が始まらない
  // ことが多い（実機の記録で、▶ を押すまで「未開始」のまま）。動画のページなら、スクリプトが再生を始める。
  if (!wantPlay && location.hostname !== 'm.youtube.com' && location.pathname === '/watch' &&
      window.matchMedia && window.matchMedia('(pointer: coarse)').matches) wantPlay = true;

  // ---- 画面を消しても再生を続ける（「裏で再生」がオンのときだけ） ----
  // YouTube はページが見えなくなったこと（document.hidden / visibilitychange）を見て再生を止めるので、
  // ずっと見えていることにする。Premium の機能を回避する使い方なので、既定はオフ。
  // ページより先に仕込む必要があるため @run-at document-start。
  // ---- Firefox から届く知らせの記録（⚙ の行に出す） ----
  // 「Firefox を終了したときだけ止める」ための調査用。ページの中からは、Firefox が終了したのか、
  // 裏に回っただけなのか（別のアプリ・ホーム画面・画面を消した）を見分けられるか分かっていないので、
  // まず何が届くかを記録する。終了のときだけ届く知らせがあれば、それで止める。
  // 記録するもの：見える / 見えない（visibilitychange）、フォーカス、pagehide / pageshow / freeze / resume / beforeunload、
  // 描画の停止 / 再開（requestAnimationFrame が 3 秒以上来ない）。それぞれの時点の再生状態も添える。
  const realHidden = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden').get;
  // スクリプト自身の動き（どこを開いたか、どの曲へ移ったか、再生を試したか、エラー）もここに残す。
  // 80 件まで。⚙ の下には新しい 20 件を出し、「記録をコピー」で全部をコピーできる。
  function log(text) {
    const d = new Date(), hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    const p = player();
    const state = p ? ({'-1': '未開始', 0: '終了', 1: '再生中', 2: '停止中', 3: '読込中', 5: '待機'})[p.getPlayerState()] || '' : '';
    try {
      const lines = JSON.parse(localStorage.getItem('ytp-log') || '[]');
      const at = p && state && p.getCurrentTime ? ' ' + fmt(p.getCurrentTime()) : '';
      lines.push(hms + ' ' + text + (state ? '（' + state + at + '）' : ''));
      localStorage.setItem('ytp-log', JSON.stringify(lines.slice(-80)));
    } catch (e) {}
  }
  (function installBackground() {
    for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
      window.addEventListener(type, e => {
        if (type === 'visibilitychange') log(realHidden.call(document) ? '見えなくなった' : '見えるようになった');
        if (settings.bg) e.stopImmediatePropagation();
      }, true);
      document.addEventListener(type, e => { if (settings.bg) e.stopImmediatePropagation(); }, true);
    }
    // Firefox を最近のアプリ一覧から消しても、再生中はページが動き続け、何も届かない（0.9 の記録で確認）。
    // そのため「Firefox を閉じたら止める」はスクリプトからはできない。止めるのは通知・ロック画面の一時停止で。
    window.addEventListener('pagehide', e => log('pagehide' + (e.persisted ? '（保存）' : '')), true);
    window.addEventListener('pageshow', e => { if (e.persisted) log('pageshow（復帰）'); }, true);
    window.addEventListener('beforeunload', () => log('beforeunload'), true);
    document.addEventListener('freeze', () => log('freeze'), true);
    document.addEventListener('resume', () => log('resume'), true);
    window.addEventListener('blur', e => { if (e.target === window) log('フォーカスが外れた'); }, true);
    window.addEventListener('focus', e => { if (e.target === window) log('フォーカスが戻った'); }, true);
    let lastFrame = Date.now(), stalled = false;
    const frame = () => { lastFrame = Date.now(); requestAnimationFrame(frame); };
    requestAnimationFrame(frame);
    setInterval(() => {
      const gap = Date.now() - lastFrame;
      if (gap > 3000 && !stalled) { stalled = true; log('描画が止まった'); }
      else if (gap < 1000 && stalled) { stalled = false; log('描画が再開した'); }
    }, 1000);
    // YouTube が読む document.hidden などを上書きする（コンテンツスクリプトのときはページ側の document に）
    const doc = pageObj(document);
    const proto = Document.prototype;
    for (const [prop, fake] of [['hidden', false], ['webkitHidden', false],
                                ['visibilityState', 'visible'], ['webkitVisibilityState', 'visible']]) {
      const orig = Object.getOwnPropertyDescriptor(proto, prop);
      if (!orig || !orig.get) continue;
      try {
        Object.defineProperty(doc, prop, {
          configurable: true,
          get: pageFn(function () { return settings.bg ? fake : orig.get.call(document); })
        });
      } catch (e) {}
    }
  })();

  function player() {
    const p = pageObj(document.getElementById('movie_player'));
    return p && typeof p.getPlayerState === 'function' ? p : null;
  }
  // 再生リストの次 / 前の動画へ。パソコン版はプレイヤー自身が再生リストを持っているので nextVideo / previousVideo でよいが、
  // スマホ版はプレイヤーが再生リストを持たず（getPlaylist() が空で nextVideo が空振りする）、ページ側の一覧
  // （ytm-playlist-panel-video-renderer）が順番を管理している。そこから今の動画の次 / 前の項目を探して開く。
  // ページを開いた直後（広告の再生中など）は、ページ側の一覧がまだできていないことがある。
  // そのときは押された操作を覚えておき、一覧ができたら送る（最大 10 秒。過ぎたらプレイヤーに頼む）。
  let pendingStep = null;
  function step(delta) {
    const vt = virtual();
    if (vt && virtualStep(vt, delta, false) === true) return;
    const sc = vt ? null : streamCtx();
    if (sc && streamStep(sc, delta, false)) return;
    if (settings.shuffle && currentList()) {
      // シャッフル中：⏭ はまだ流していない曲へ、⏮ は直前に流した曲へ
      if (delta > 0) { if (jumpRandom()) return; }
      else if (history.length) {
        const it = items(), i = it.ids.indexOf(history.pop());
        if (i >= 0) { go(it, i); return; }
      }
    }
    pendingStep = {delta: delta, until: Date.now() + 10000};
    tryStep();
  }
  function tryStep() {
    if (!pendingStep) return;
    const delta = pendingStep.delta;
    const p = player();
    const list = p && typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
    if (list && list.length) {
      pendingStep = null;
      if (delta > 0) p.nextVideo(); else p.previousVideo();
      return;
    }
    const v = currentVideo();
    const links = panelLinks();
    const i = links.findIndex(a => new URL(a.href, location.href).searchParams.get('v') === v);
    if (i >= 0) {
      pendingStep = null;
      const target = links[i + delta];
      if (target) target.click();  // 先頭で ⏮ / 最後で ⏭ のときは何もしない
      return;
    }
    if (!currentList() || Date.now() > pendingStep.until) {
      // 再生リストでない動画、または一覧が出てこないとき
      pendingStep = null;
      if (p) { if (delta > 0) p.nextVideo(); else p.previousVideo(); }
    }
  }
  function panelLinks() {
    return [...document.querySelectorAll('ytm-playlist-panel-video-renderer, ytd-playlist-panel-video-renderer')]
      .map(item => item.querySelector('a[href*="/watch"]')).filter(Boolean);
  }
  function currentVideo() {
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  }
  function adShowing() {
    const box = document.getElementById('movie_player');
    return !!box && box.classList.contains('ad-showing');
  }

  // ---- シャッフル・リピート ----
  // YouTube のページのボタンには頼らず、曲の終わり（残り約 1 秒）で自分で次の曲へ移す。
  // 曲の一覧は、パソコン版はプレイヤーが持っている（getPlaylist / playVideoAt）。スマホ版はページ側の一覧のリンクを押す。
  // スマホ版の一覧は長い再生リストだと途中までしか読み込まれていないことがある。そのときは読み込まれている範囲で選ぶ。
  let played = [], history = [], playedList = null, jumpedAt = 0, restartFor = null, lastRestart = 0, lastCheck = 0;
  function items() {
    const p = player();
    const ids = p && typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
    if (ids && ids.length) return {source: 'player', ids: Array.from(ids), go: i => p.playVideoAt(i)};
    const links = panelLinks();
    return {source: 'page', ids: links.map(a => new URL(a.href, location.href).searchParams.get('v')),
            go: i => links[i].click()};
  }
  // 別の曲へ移るときは、開いたときの「前回の位置へ進める」（resumeSeek）を取り消す（前の曲の位置なので）
  function go(it, i) {
    jumpedAt = Date.now();
    pendingStep = null;
    resumeSeek = 0;
    log('→ ' + (it.ids[i] || i) + '（' + (i + 1) + ' / ' + it.ids.length + '）');
    if (it.source === 'player') watchMove(it.ids[i], currentList());
    it.go(i);
  }
  // まだ流していない曲から選ぶ。一巡したらやり直す
  function jumpRandom() {
    const it = items(), cur = currentVideo(), list = currentList();
    if (it.ids.length < 2) return false;
    if (playedList !== list) { playedList = list; played = []; history = []; }
    if (cur && !played.includes(cur)) played.push(cur);
    let rest = it.ids.map((v, i) => i).filter(i => !played.includes(it.ids[i]));
    if (!rest.length) {
      played = cur ? [cur] : [];
      rest = it.ids.map((v, i) => i).filter(i => it.ids[i] !== cur);
    }
    if (cur) history.push(cur);
    go(it, rest[Math.floor(Math.random() * rest.length)]);
    return true;
  }
  // ---- オフライン優先 ----
  // list=PPSV で開いている間、プレイヤーの曲の並び（getPlaylist）は「保存済みの曲」そのもの（新しく保存した順）。
  // 元の再生リストの順で流すため、曲の終わりごとに「元の順で次の、保存済みの曲」を探して移る。保存していない曲は飛ばす。
  function virtual() {
    if (onMobile() || !settings.offline || currentList() !== 'PPSV') return null;
    const x = settings.offline_list, order = x && (settings.orders || {})[x];
    if (!order || !order.length) return null;
    const p = player(), ids = p && typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
    if (!ids || !ids.length || !listReady(p)) return null;  // ページ内の移動の直後で、まだ前の一覧のとき
    const saved = Array.from(ids);
    return {list: x, order: order, saved: saved, avail: order.filter(v => saved.includes(v)),
            go: v => {
              jumpedAt = Date.now();
              pendingStep = null;
              resumeSeek = 0;
              restartFor = v;  // 保存済みの曲は前回の続きから始まることがあるので、始まったら先頭に戻す（checkEnd）
              log('→ ' + v + '（保存分 ' + (saved.indexOf(v) + 1) + ' / ' + saved.length + '、元の順 ' + (order.indexOf(v) + 1) + ' / ' + order.length + '）');
              watchMove(v, 'PPSV');
              p.playVideoAt(saved.indexOf(v));
            }};
  }
  // 元の再生リストの順（シャッフルなら、まだ流していない曲）で次の曲を選ぶ。保存済みかどうかは見ない。
  // 最後の曲の次は先頭（リピートがオフでも）。選べないときは null。
  function pickNext(list, order, delta, atEnd) {
    const cur = currentVideo();
    if (settings.shuffle) {
      const key = 'mix:' + list;
      if (playedList !== key) { playedList = key; played = []; history = []; }
      if (delta < 0) return history.length ? history.pop() : null;
      if (cur && !played.includes(cur)) played.push(cur);
      let rest = order.filter(v => !played.includes(v));
      if (!rest.length) {
        played = cur ? [cur] : [];
        rest = order.filter(v => v !== cur);
      }
      if (!rest.length) return null;
      if (cur) history.push(cur);
      return rest[Math.floor(Math.random() * rest.length)];
    }
    const n = order.length;
    let j = order.indexOf(cur) + delta;
    if (j < 0 || j >= n) {
      j =((j % n) + n) % n;
    }
    return order[j];
  }
  // 保存分の側（list=PPSV）と通信する側（list=再生リスト）は別の並びなので、行き来するときは移り直す（navigate）
  function openSide(list, v, savedSide) {
    settings.offline_list = list;
    settings.last_url = location.origin + '/watch?v=' + v + '&list=' + list;
    settings.last_time = 0;
    save();
    log('→ ' + v + (savedSide ? '（保存済みなので、保存分の側へ）' : '（保存していない曲なので、通信する側へ）'));
    jumpedAt = Date.now();
    pendingStep = null;
    resumeSeek = 0;
    navigate('/watch?v=' + v + '&list=' + (savedSide ? 'PPSV' : list), 0);
  }
  // プレイヤーが持っている曲の一覧が、URL の再生リストのものか。ページ内の移動の直後は、少しの間古い一覧のままのことがある。
  // そのまま「保存済みの一覧を覚える」などをすると、控えを別の再生リストで上書きしてしまうので、一致するまで待つ。
  // 「移る前の再生リストの一覧がまだ残っている」ときだけ待つ（移る前の ID を staleList に覚える）。保存分の側で getPlaylistId() が
  // 何を返すかは分からない（PC には保存済みの曲がなく確かめられない）ので、「URL の再生リストと同じか」では見ない。
  // ページを開き直したときは staleList がないので、今までどおり待たない。
  // 保存分の側では getPlaylistId() が null なので（PC で確認）、ID だけでなく一覧の中身（曲の並び）も比べる。
  let staleList = null;
  function playerListSig(p) {
    const id = p && typeof p.getPlaylistId === 'function' ? p.getPlaylistId() : null;
    const ids = p && typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
    return String(id) + '|' + (ids ? Array.from(ids).join(',') : '');
  }
  function listReady(p) {
    if (!staleList) return true;
    if (playerListSig(p) === staleList.sig && Date.now() - staleList.at < 15000) return false;
    staleList = null;
    return true;
  }
  // ---- ページ内の移動（0.30）----
  // 再生リストの切り替え・保存分 ↔ 通信の切り替え・オフライン優先の切り替えは、ページを開き直さず、YouTube のページ内の移動
  // （ytd-app に yt-navigate）で行う。開き直すと全画面が外れ（全画面はタップしたときにしか頼めない）、ちらつくため（0.29 の実機）。
  // Windows 版 0.3 と同じやり方。4 秒たっても移り終わらなければ、今までどおり開き直す。
  // 開き直したときに一度だけしていた準備（再生を始める・前回の位置へ進める・保存分の側の確かめ）は、移り終わったときにやり直す（checkNav）。
  let pendingNav = null;
  function navigate(url, seconds) {
    const u = new URL(url, location.href);
    const v = u.searchParams.get('v'), list = u.searchParams.get('list');
    const t = Math.max(0, Math.floor(seconds || 0));
    u.searchParams.delete('t');
    if (t > 5) u.searchParams.set('t', t + 's');
    const app = document.querySelector('ytd-app');
    if (onMobile() || IN_CONTENT || !app || !location.pathname.startsWith('/watch') || u.pathname !== '/watch' || !v) {
      markAutoplay(t);
      location.href = u.pathname + u.search;
      return;
    }
    const we = {videoId: v};
    if (list) we.playlistId = list;
    if (t > 5) we.startTimeSeconds = t;
    const p = player();
    staleList = list !== currentList() && p ? {sig: playerListSig(p), at: Date.now()} : null;
    pendingNav = {v: v, list: list, t: t, url: u.pathname + u.search, at: Date.now(), from: location.href};
    log('ページ内で移る v=' + v + ' list=' + (list === 'PPSV' ? list : (list || '-').slice(0, 6) + '…') + (t > 5 ? ' ' + t + ' 秒から' : ''));
    app.dispatchEvent(new CustomEvent('yt-navigate', {bubbles: true, composed: true, detail: {endpoint: {
      commandMetadata: {webCommandMetadata: {url: u.pathname + u.search, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832}},
      watchEndpoint: we}}}));
  }
  function checkNav() {
    if (!pendingNav) return;
    const n = pendingNav, p = player();
    // 一度その曲に着いたら、移れたことにする。短い曲がすぐ終わって次の曲へ進んでいても（同じ再生リストで URL が変わっていれば）移れている。
    // 「今その曲にいるか」だけで見ると、失敗と間違えて開き直してしまう（Windows 版 0.31 で、23 秒の曲で実際に起きた）。
    const moved = !!n.movedAt || (currentList() === n.list && (currentVideo() === n.v || location.href !== n.from));
    if (moved && !n.movedAt) n.movedAt = Date.now();
    // URL が変わったら、プレイヤーの一覧がそろうまで待つ（通信が遅いときのため最大 15 秒。そろわなくても先へ進み、
    // 一覧を覚える処理などは listReady で待たせる）
    if (moved && p && (listReady(p) || Date.now() - n.movedAt > 15000)) {
      pendingNav = null;
      ensured = false;
      whyLogged = false;
      startedAt = Date.now();
      wantPlay = true;
      resumeSeek = n.t > 5 ? n.t : 0;
      // 保存分の側は、YouTube が曲を前回やめた位置から始めることがある。先頭から流したいときは頭出しの見張りを付ける（checkEnd）
      if (n.list === 'PPSV' && !(n.t > 5)) { restartFor = n.v; jumpedAt = Date.now(); }
      log('ページ内で移った（' + (Date.now() - n.at) + 'ms）');
      startPlayback();
      return;
    }
    if (!moved && Date.now() - n.at > 4000) {  // 4 秒たっても URL が変わらない＝ページ内で移れなかった
      pendingNav = null;
      log('ページ内で移れない（今 v=' + currentVideo() + ' list=' + currentList() + ' 一覧=' + (p && p.getPlaylistId ? p.getPlaylistId() : '-') + '）→ 開き直す');
      markAutoplay(n.t);
      location.href = n.url;
    }
  }
  setInterval(safe(checkNav, 'checkNav'), 200);
  // ---- 移った曲が流れ始めるかの見張り（0.26）----
  // 実機の記録（0.25）：保存分の側で、ページが見えていない間に曲の終わりで playVideoAt したら、
  // 前の曲の最後（4:02）のまま「読み込み中」（video に src なし）で止まり、画面を点けても戻らなかった。
  // 前面でも、保存分の曲が「読み込み中」のまま始まらないことがあった。
  // 移ってから一定時間たっても流れ始めないときは、1 回目はプレイヤーにもう一度頼み、2 回目はページを開き直す。
  // 開き直しが続くとき（同じタブで 3 回まで）はあきらめる。
  let moving = null;
  function watchMove(v, list, wait) {
    if (onMobile() || !v || !list) { moving = null; return; }
    moving = {v: v, list: list, at: Date.now(), wait: wait || 10000, tries: 0};
  }
  function reopenCount(n) {
    try {
      if (n === undefined) return Number(sessionStorage.getItem('ytp-reopen') || 0);
      if (n) sessionStorage.setItem('ytp-reopen', String(n)); else sessionStorage.removeItem('ytp-reopen');
    } catch (e) {}
    return 0;
  }
  function checkMove() {
    const p = player();
    if (!moving) {
      if (p && p.getPlayerState() === 1 && reopenCount()) reopenCount(0);
      return;
    }
    if (!location.pathname.startsWith('/watch')) { moving = null; return; }
    if (!p) return;
    const d = p.getVideoData ? p.getVideoData() : null, state = p.getPlayerState();
    const here = !!d && d.video_id === moving.v;
    // 流れ始めた。または利用者が止めた（一時停止）
    if (here && (state === 1 || state === 2)) {
      if (moving.tries || reopenCount()) log('移った曲が流れ始めた（やり直し ' + moving.tries + ' 回、開き直し ' + reopenCount() + ' 回）');
      reopenCount(0);
      moving = null;
      return;
    }
    if (adShowing()) { moving.at = Date.now(); return; }
    if (Date.now() - moving.at < moving.wait) return;
    moving.tries++;
    moving.at = Date.now();
    log('移った曲が流れ始めない（' + moving.tries + ' 回目）: 今 ' + ((d && d.video_id) || '-') + ' 状態 ' + state + ' ' +
        fmt(p.getCurrentTime()) + ' / ' + playerDetail());
    if (moving.tries === 1) {
      const ids = typeof p.getPlaylist === 'function' ? Array.from(p.getPlaylist() || []) : [];
      const i = ids.indexOf(moving.v);
      jumpedAt = Date.now();
      if (!here && i >= 0) {
        if (moving.list === 'PPSV') restartFor = moving.v;
        log('→ ' + moving.v + '（もう一度移る）');
        p.playVideoAt(i);
      } else {
        log('もう一度再生を頼む');
        p.playVideo();
      }
      return;
    }
    const v = moving.v, list = moving.list, n = reopenCount() + 1;
    moving = null;
    // 読み込みはできていて、再生を断られているだけ（Firefox の自動再生の許可など）なら、開き直しても同じ
    if (here && (state === -1 || state === 5)) { log('再生が始まらないまま（開き直さない）'); return; }
    if (n > 3) { log('開き直しても流れ始めないので、あきらめる'); reopenCount(0); return; }
    reopenCount(n);
    log('→ ' + v + '（流れ始めないので開き直す。' + n + ' 回目）');
    jumpedAt = Date.now();
    pendingStep = null;
    resumeSeek = 0;
    markAutoplay(0);
    location.href = '/watch?v=' + v + '&list=' + list;
  }
  setInterval(safe(checkMove, 'checkMove'), 1000);
  // 保存分の側で次の曲へ。保存済みならそのまま移り、保存していない曲なら通信する側へ開き直す。
  // 移ったら true。
  function virtualStep(vt, delta, atEnd) {
    const v = pickNext(vt.list, vt.order, delta, atEnd);
    if (v === 'end') return 'end';
    if (!v) return false;
    if (vt.saved.includes(v)) vt.go(v); else openSide(vt.list, v, false);
    return true;
  }
  // 通信する側（list=再生リスト）で流しているとき。オフライン優先で、曲順と保存済みの控えがあるときだけ
  function streamCtx() {
    if (onMobile() || !settings.offline) return null;
    const id = currentList(), order = id && id !== 'PPSV' ? (settings.orders || {})[id] : null;
    const saved = settings.saved || [];
    if (!order || !order.length || !saved.length) return null;
    return {list: id, order: order, saved: saved};
  }
  // 通信する側で次の曲へ。次が保存済みなら保存分の側へ開き直す。次も保存していない曲なら、
  // 順番どおりのときは YouTube に任せ（false）、シャッフルのときは選んだ曲へ移る。
  function streamStep(sc, delta, atEnd) {
    const v = pickNext(sc.list, sc.order, delta, atEnd);
    if (!v || v === 'end') return false;
    if (sc.saved.includes(v)) { openSide(sc.list, v, true); return true; }
    if (!settings.shuffle) return false;
    const p = player(), ids = p && typeof p.getPlaylist === 'function' ? Array.from(p.getPlaylist() || []) : [];
    const i = ids.indexOf(v);
    if (i < 0) return false;
    jumpedAt = Date.now();
    pendingStep = null;
    resumeSeek = 0;
    log('→ ' + v + '（通信）');
    watchMove(v, sc.list);
    p.playVideoAt(i);
    return true;
  }
  // 曲順と保存済みの控え。パソコン版のプレイヤーだけが一覧を持っている。変わったら true
  function rememberLists(p) {
    const ids = typeof p.getPlaylist === 'function' ? p.getPlaylist() : null, id = currentList();
    if (onMobile() || !ids || !ids.length || !id || pendingNav || !listReady(p)) return false;  // 移っている途中は覚えない
    const list = Array.from(ids).slice(0, 1000);
    const same = a => Array.isArray(a) && a.length === list.length && a.every((v, i) => v === list[i]);
    if (id === 'PPSV') {
      if (same(settings.saved)) return false;
      settings.saved = list;
      return true;
    }
    const orders = settings.orders = settings.orders || {};
    if (same(orders[id])) return false;
    delete orders[id];  // 新しいものを後ろへ。10 件を超えたら古いものから捨てる
    orders[id] = list;
    const keys = Object.keys(orders);
    for (const k of keys.slice(0, Math.max(0, keys.length - 10))) delete orders[k];
    return true;
  }
  // プルダウンに出す再生リスト。保存分で流している間は、元の再生リスト
  function shownList() {
    const id = currentList();
    return id === 'PPSV' && settings.offline && settings.offline_list ? settings.offline_list : id;
  }
  function repeatMode() { return settings.repeat === 'all' || settings.repeat === 'one' ? settings.repeat : 'off'; }
  // 再生リストの最後の曲のあとは先頭へ戻る（YouTube に任せると、一覧にないおすすめの動画へ進むか止まる）。
  // リピートがオフのときは、先頭の曲が始まったところで一時停止する。ページを開き直すことがあるので sessionStorage にも覚える。
  let pauseTop = null;
  try { pauseTop = JSON.parse(sessionStorage.getItem('ytp-pause-top') || 'null'); } catch (e) {}
  function setPauseTop(v) {
    pauseTop = v ? {v: v, at: Date.now()} : null;
    try {
      if (pauseTop) sessionStorage.setItem('ytp-pause-top', JSON.stringify(pauseTop));
      else sessionStorage.removeItem('ytp-pause-top');
    } catch (e) {}
  }
  // 順番どおり・リピートがオフで、今の曲が order の最後なら、先頭の曲で止める印を付ける
  function markIfLast(order) {
    if (settings.shuffle || repeatMode() !== 'off' || !order.length) return;
    if (order.indexOf(currentVideo()) === order.length - 1) setPauseTop(order[0]);
  }
  function checkPauseTop() {
    if (!pauseTop) return;
    if (Date.now() - pauseTop.at > 60000) { setPauseTop(null); return; }
    const p = player();
    // 移った直後は曲 ID だけ先頭の曲になり、中身（位置・長さ）は前の曲の終わりのままのことがある（PC で確認）。
    // そこで止めると、再生を押したとき前の曲の終わりから流れてすぐ 2 曲目へ進むので、頭から流れ始めたのを見て止める
    // （保存分の側で途中から始まったときは、restartFor が頭出ししてから）。
    if (!p || adShowing() || !p.getVideoData || (p.getVideoData() || {}).video_id !== pauseTop.v || p.getPlayerState() !== 1 ||
        p.getCurrentTime() > 3) return;
    setPauseTop(null);
    wantPlay = false;  // 開いたページの「再生を始める」が一時停止を取り消さないように
    resumeSeek = 0;
    restartFor = null;  // 保存分の側の頭出しの見張りも（止めた曲を再生し直してしまう）
    p.pauseVideo();
    p.seekTo(0, true);
    log('最後の曲が終わったので、先頭の曲で止めた');
  }
  setInterval(safe(checkPauseTop, 'checkPauseTop'), 200);
  function checkEnd() {
    if (pendingNav) return;  // ページ内で移っている途中（前の曲の終わりでまた移らない）
    const repeat = repeatMode();
    const vt = virtual();
    const sc = vt ? null : streamCtx();
    if (!vt && !sc && !settings.shuffle && repeat === 'off' && !currentList()) return;
    const p = player();
    if (!p || !location.pathname.startsWith('/watch') || adShowing()) return;
    const state = p.getPlayerState();
    // 保存済みの曲は、YouTube が「前回やめた位置」から始める。このスクリプトは曲の終わりの直前で次へ移るので、
    // 一度流した曲の「前回やめた位置」はいつも終わりの直前になる。そのまま始まると、すぐ終わって次へ進み、
    // 曲が行ったり来たりする（実機の記録で確認）。移ってから 6 秒間は見張り、途中から始まったら先頭に戻す。
    // 位置が反映されるのは再生が始まった少しあとのことがあるので、1 回見ただけでは終わりにしない。
    // 見張っている間は、曲の終わりの判定をしない。
    if (restartFor) {
      if (Date.now() - jumpedAt > 6000) restartFor = null;
      else {
        const data = p.getVideoData ? p.getVideoData() : null;
        // 「途中から」＝移ってからたった時間より 3 秒以上先にいる（普通に 3 秒流れただけのときは戻さない）
        if (data && data.video_id === restartFor && p.getCurrentTime() > (Date.now() - jumpedAt) / 1000 + 3 &&
            Date.now() - lastRestart > 1000) {
          lastRestart = Date.now();
          log('途中（' + fmt(p.getCurrentTime()) + '）から始まったので先頭に戻す');
          p.seekTo(0, true);
          if (state !== 1 && state !== 3) p.playVideo();
        }
        return;
      }
    }
    // 移った曲がまだ流れ始めていない間は、曲の終わりを判定しない（前の曲の「終わり」でまた移ってしまう。見張りは checkMove）
    if (moving || Date.now() - jumpedAt < 3000) return;
    // 保存分で流している間に曲が終わってしまったとき（終わりの直前から始まったときなど）も、次の曲へ
    if (vt && state === 0) {
      log('曲が終わっていた → 次の保存済みの曲へ');
      markIfLast(vt.order);
      virtualStep(vt, 1, true);
      jumpedAt = Date.now();
      return;
    }
    const d = p.getDuration(), t = p.getCurrentTime();
    // 画面を消している間などは、この確認が数秒おきにしか動かないことがある（実機の記録で、曲が終わってから気づいていた）。
    // 前回の確認から間が空いているときは、その分だけ早めに「終わり」とみなす（最大 5 秒前）。
    const gap = Date.now() - lastCheck;
    lastCheck = Date.now();
    const lead = 1.2 + (gap > 600 ? Math.min(3.8, gap / 1000) : 0);
    // 終わってしまっていた（状態 0）ときも。短い曲や終わり近くから開いたときは、終わりの直前を見逃すことがある
    if (!(d > 0) || (state !== 1 && state !== 0) || d - t > lead) return;
    const data = p.getVideoData ? p.getVideoData() : null;
    if (data && data.isLive) return;  // ライブ配信はいつも「終わりの直前」に見える
    if (repeat === 'one') { jumpedAt = Date.now(); p.seekTo(0, true); if (state === 0) p.playVideo(); return; }
    if (vt) {
      // 保存分で流している間は、いつも自分で次の曲を選ぶ（YouTube に任せると保存した順に進んでしまう）
      log('曲の終わり');
      markIfLast(vt.order);
      if (!virtualStep(vt, 1, true)) setPauseTop(null);
      return;
    }
    if (!currentList()) return;
    // オフライン優先で通信する側にいるとき：次が保存済みの曲なら、保存分の側へ開き直す
    if (sc) {
      markIfLast(sc.order);
      if (streamStep(sc, 1, true)) return;
      setPauseTop(null);
    }
    if (settings.shuffle) { jumpRandom(); return; }
    // 最後の曲なら先頭へ（オフのときは先頭で一時停止）。一覧が途中までしか読み込まれていないことがあるので、本数と比べる
    const it = items(), i = it.ids.indexOf(currentVideo());
    const pl = (settings.playlists || []).find(x => x.id === currentList());
    const total = pl ? Number(String(pl.count).replace(/,/g, '')) : NaN;
    if (i >= 0 && i === it.ids.length - 1 && !(total > it.ids.length)) {
      if (repeat === 'off') setPauseTop(it.ids[0]);
      go(it, 0);
    }
  }
  // スクリプトの中で起きたエラーも記録に残す（同じ内容は 1 回だけ）
  let lastError = '';
  function safe(fn, name) {
    return function () {
      try { return fn.apply(this, arguments); } catch (e) {
        const text = name + ': ' + ((e && e.message) || e);
        if (text !== lastError) { lastError = text; log('スクリプトのエラー ' + text); }
      }
    };
  }
  // 保存分で流している間に曲が最後まで行ってしまったら、その場で次の曲へ移る。
  // 止まったままにすると、音が出ていないページとして Firefox に止められ、スクリプトも動かなくなる
  // （実機の記録で、曲が終わってから 14 分間、画面を点けるまで何も動いていなかった）。
  document.addEventListener('ended', safe(function (e) {
    if (!e.target || e.target.tagName !== 'VIDEO' || adShowing() || moving || Date.now() - jumpedAt < 3000) return;
    const vt = virtual(), p = player();
    if (!p) return;
    if (!vt) { checkEnd(); return; }  // 通信して流しているときも（最後の曲のあと、YouTube がおすすめの動画へ進む前に先頭へ）
    if (repeatMode() === 'one') {
      jumpedAt = Date.now();
      p.seekTo(0, true);
      p.playVideo();
      return;
    }
    log('曲が最後まで行った → すぐ次へ');
    virtualStep(vt, 1, true);
    jumpedAt = Date.now();
  }, 'ended'), true);
  document.addEventListener('timeupdate', safe(checkEnd, 'checkEnd'), true);
  setInterval(safe(checkEnd, 'checkEnd'), 250);
  function currentList() {
    try { return new URL(location.href).searchParams.get('list'); } catch (e) { return null; }
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }

  // ---- 再生リストの一覧 ----
  // YouTube の「再生リスト」ページと同じ一覧（保存した再生リスト・後で見るも。ミックスリストは出さない）。
  // m.youtube.com からはパソコン版のページを読めない（別のサイト扱い）ので、YouTube 自身が使っている
  // 内部 API（/youtubei/v1/browse、FEplaylist_aggregation）にログイン中の Cookie で問い合わせる。
  // 再生リスト（lockupViewModel）を out に集め、続きを読むための合言葉（continuationItemRenderer の token）を返す
  function collect(root, out, seen) {
    let token = null;
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.lockupViewModel) {
        const l = o.lockupViewModel, s = JSON.stringify(l);
        const title = l.metadata && l.metadata.lockupMetadataViewModel
                      && l.metadata.lockupMetadataViewModel.title.content;
        const badge = (s.match(/"text":"([^"]*?(?:本の動画|エピソード|レッスン|ミックスリスト|videos?|episodes?|lessons?|Mix)[^"]*)"/) || [])[1];
        const vid = (s.match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/) || [])[1];
        const n = badge && badge.match(/^([\d,]+) 本の動画$/);
        // ミックスリスト（ID が RD で始まる）は、YouTube が自動で作る終わりのない並びなので出さない（ユーザーの希望）
        if (l.contentId && title && !/^RD/.test(l.contentId) && !seen.has(l.contentId)) {
          seen.add(l.contentId);
          out.push({id: l.contentId, title: title, count: n ? n[1] : (badge || null), vid: vid || null});
        }
        return;
      }
      if (o.continuationItemRenderer) {
        // 絞り込みのボタンなどにも continuationCommand があるので、一覧の末尾のもの（continuationItemRenderer）だけを見る
        const t = (JSON.stringify(o.continuationItemRenderer).match(/"continuationCommand":\{[^{}]*?"token":"([^"]+)"/) || [])[1];
        if (t && !token) token = t;
        return;
      }
      for (const k in o) walk(o[k]);
    })(root);
    return token;
  }
  async function sha1(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  function loggedIn() { return /(^|; )(SAPISID|__Secure-3PAPISID)=/.test(document.cookie); }
  async function browse(body) {
    const cookies = {};
    for (const c of document.cookie.split('; ')) cookies[c.slice(0, c.indexOf('='))] = c.slice(c.indexOf('=') + 1);
    const sapisid = cookies.SAPISID || cookies['__Secure-3PAPISID'];
    if (!sapisid) throw new Error('YouTube にログインしていません');
    const ts = Math.floor(Date.now() / 1000);
    const auth = 'SAPISIDHASH ' + ts + '_' + await sha1(ts + ' ' + sapisid + ' ' + location.origin);
    const r = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json', 'Authorization': auth,
                'X-Origin': location.origin, 'X-Goog-AuthUser': '0'},
      body: JSON.stringify(Object.assign({
        context: {client: {clientName: 'WEB', clientVersion: WEB_CLIENT_VERSION, hl: 'ja', gl: 'JP'}}
      }, body))
    });
    if (!r.ok) throw new Error('再生リストを読めませんでした（' + r.status + '）');
    return r.json();
  }
  // 一覧をどう取れたか（診断で出す）
  let listInfo = null;
  async function fetchPlaylists() {
    const out = [], seen = new Set();
    let token, pages = 0, warn = null;
    try {
      token = collect(await browse({browseId: 'FEplaylist_aggregation'}), out, seen);
    } catch (e) {
      listInfo = {error: e.message};
      throw e;
    }
    if (!out.length) {
      listInfo = {error: '再生リストが見つかりませんでした'};
      throw new Error(listInfo.error);
    }
    // 最初の約 30 件より先。続きが読めなくても、読めたところまでは使う
    try {
      while (token && pages < 30) {
        const before = out.length;
        token = collect(await browse({continuation: token}), out, seen);
        pages++;
        if (out.length === before) break;
      }
    } catch (e) {
      warn = e.message;
    }
    listInfo = {count: out.length, pages: pages, warn: warn};
    return out;
  }

  // ---- 自己診断 ----
  // YouTube のページに頼っている部分が今も動くかを確かめる。[項目, 結果(true / false / null = 確かめられない), 説明]
  async function diagnose() {
    const out = [['版', null, 'v' + VERSION + ' · ' + MODE + ' · ' + location.hostname]];
    out.push(['ログイン', loggedIn(), loggedIn() ? 'ログイン中' : 'YouTube にログインしていません']);
    try { await fetchPlaylists(); } catch (e) {}
    const li = listInfo || {};
    if (li.error) out.push(['再生リストの一覧', false, li.error + '（clientVersion ' + WEB_CLIENT_VERSION + '）']);
    else if (li.warn) out.push(['再生リストの一覧', false, li.count + ' 件まで。続きを読めません: ' + li.warn]);
    else out.push(['再生リストの一覧', true, li.count + ' 件（続きを ' + li.pages + ' 回読み込み）']);
    if (!isMobile) {
      const orders = settings.orders || {};
      out.push(['オフライン優先', null, (settings.offline ? 'オン' : 'オフ') + ' · 保存済みの控え ' + (settings.saved || []).length +
                ' 曲 · 曲順を覚えた再生リスト ' + Object.keys(orders).length + ' 件']);
    }
    const p = player(), watch = location.pathname.startsWith('/watch');
    if (!watch) {
      out.push(['プレイヤー', null, '動画を開いていないので確かめられません']);
    } else {
      const raw = pageObj(document.getElementById('movie_player'));
      const need = ['playVideo', 'pauseVideo', 'seekTo', 'getPlayerState', 'getCurrentTime', 'getDuration', 'getVideoData']
        .concat(isMobile ? [] : ['nextVideo', 'previousVideo', 'getPlaylist', 'playVideoAt']);
      const miss = need.filter(n => !raw || typeof raw[n] !== 'function');
      out.push(['プレイヤー', !miss.length,
                !raw ? '#movie_player が見つかりません' : miss.length ? '使えない操作: ' + miss.join(', ') : '操作 ' + need.length + ' 種類すべて使えます']);
      const d = p && p.getVideoData ? p.getVideoData() : null;
      out.push(['曲名', !!(d && d.title), d && d.title ? '取得できます' : 'getVideoData() から曲名を取れません']);
      if (!currentList()) {
        out.push(['曲の一覧', null, '再生リストを再生していないので確かめられません']);
      } else {
        const it = items();
        out.push(['曲の一覧', it.ids.length > 0,
                  it.ids.length ? it.ids.length + ' 曲（' + (it.source === 'player' ? 'プレイヤーから' : 'ページの一覧から') + '）'
                                : '読めません（曲送り・シャッフル・全曲リピートが効きません）']);
      }
    }
    return out;
  }

  // ---- バー ----
  function el(tag, props, style) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    Object.assign(e.style, style || {});
    return e;
  }
  const isMobile = location.hostname === 'm.youtube.com';
  // スマホで「デスクトップ サイト」にして www を開いているとき（オフライン保存を使うとき）も、スマホ用の大きさにする。
  // そのときページは幅 980px ほどで描かれて縮小表示されるので、バーをその分だけ拡大する（applyZoom）。
  const touch = !!(window.matchMedia && window.matchMedia('(pointer: coarse)').matches);
  const phone = isMobile || touch;
  const ctrl = {background: '#272727', color: '#fff', border: '1px solid #444', borderRadius: '6px',
                font: 'inherit', padding: phone ? '6px 8px' : '3px 6px', minWidth: phone ? '40px' : '0',
                cursor: 'pointer'};
  // スマホでは押しやすいよう大きくする。⏮ ⏯ ⏭ はさらに大きく
  const tool = phone ? Object.assign({}, ctrl, {padding: '10px 0', minWidth: '52px', fontSize: '20px', lineHeight: '1'}) : ctrl;
  const big = phone ? Object.assign({}, ctrl, {padding: '12px 0', minWidth: '64px', fontSize: '26px', lineHeight: '1'}) : ctrl;
  const bar = el('div', {id: 'ytp-bar'}, {
    position: 'fixed', zIndex: '2147483647', boxSizing: 'border-box',
    // スマホ版は画面下に YouTube のメニューがあるので、その上に置く
    left: phone ? '6px' : 'auto', right: phone ? '6px' : '12px', bottom: isMobile ? '56px' : (phone ? '6px' : '12px'),
    display: 'flex', flexDirection: 'column', gap: '6px',
    background: 'rgba(15,15,15,.92)', color: '#fff', padding: '6px 8px', borderRadius: '10px',
    font: (phone ? '14px' : '13px') + ' Roboto, "Segoe UI", sans-serif',
    boxShadow: '0 2px 8px rgba(0,0,0,.5)', border: '1px solid #555'
  });
  const row1 = el('div', {}, {display: 'flex', gap: '6px', alignItems: 'center'});
  const row2 = el('div', {}, {display: 'flex', gap: '6px', alignItems: 'center'});
  const sel = el('select', {title: '再生リスト'}, Object.assign({}, ctrl, {flex: '1', minWidth: '0', maxWidth: phone ? 'none' : '280px',
                                                             padding: phone ? '12px 8px' : ctrl.padding}));
  const refreshBtn = el('button', {textContent: '⟳', title: '再生リストを取得し直す'}, tool);
  const foldBtn = el('button', {textContent: '▾', title: 'たたむ'}, tool);
  const optBtn = el('button', {textContent: '⚙', title: '設定'}, tool);
  // ボタンの絵は SVG で描く。絵文字（⏯ 🔀 🔁 など）は Android では色付きの四角い絵になり、
  // 押されたまま・何かのモード中のように見えるため。色は文字の色（currentColor）に従う。
  const ICONS = {
    prev: ['M6 6h2v12H6zm3.5 6l8.5 6V6z'],
    next: ['M6 18l8.5-6L6 6v12zM16 6v12h2V6h-2z'],
    play: ['M8 5v14l11-7z'],
    pause: ['M6 19h4V5H6v14zm8-14v14h4V5h-4z'],
    shuffle: ['M10.59 9.17L5.41 4 4 5.41l5.17 5.17 1.42-1.41zM14.5 4l2.04 2.04L4 18.59 5.41 20 17.96 7.46 20 9.5V4h-5.5z' +
              'm.33 9.41l-1.41 1.41 3.13 3.13L14.5 20H20v-5.5l-2.04 2.04-3.13-3.13z'],
    repeat: ['M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z'],
    repeat1: ['M7 7h10v3l4-4-4-4v3H5v6h2V7zm10 10H7v-3l-4 4 4 4v-3h12v-6h-2v4z', 'M13 15V9h-1l-2 1v1h1.5v4H13z']
  };
  function setIcon(btn, name) {
    if (btn.dataset.icon === name) return;
    btn.dataset.icon = name;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('width', '1.2em');
    svg.setAttribute('height', '1.2em');
    svg.style.display = 'block';
    svg.style.margin = '0 auto';
    svg.style.fill = 'currentColor';
    for (const d of ICONS[name]) {
      const path = document.createElementNS(NS, 'path');
      path.setAttribute('d', d);
      svg.append(path);
    }
    btn.replaceChildren(svg);
  }
  const prevBtn = el('button', {title: '前の動画'}, big);
  // 動画を見ていないとき（トップ・検索・再生リストのページなど）は、前回の動画を止めた位置から再生する
  const playBtn = el('button', {title: '再生 / 一時停止（動画を見ていないときは前回の続きから）'}, big);
  const nextBtn = el('button', {title: '次の動画'}, big);
  const shuffleBtn = el('button', {}, tool);
  const repeatBtn = el('button', {}, tool);
  setIcon(prevBtn, 'prev');
  setIcon(playBtn, 'play');
  setIcon(nextBtn, 'next');
  setIcon(shuffleBtn, 'shuffle');
  setIcon(repeatBtn, 'repeat');
  function paintMode() {
    // オンは黄色の絵と枠、オフは灰色の絵。塗りつぶしはしない
    const on = {color: '#ffd54a', borderColor: '#ffd54a'}, off = {color: '#bbb', borderColor: '#444'};
    const repeat = repeatMode();
    Object.assign(shuffleBtn.style, settings.shuffle ? on : off);
    Object.assign(repeatBtn.style, repeat !== 'off' ? on : off);
    shuffleBtn.title = 'シャッフル: ' + (settings.shuffle ? 'オン' : 'オフ');
    setIcon(repeatBtn, repeat === 'one' ? 'repeat1' : 'repeat');
    repeatBtn.title = 'リピート: ' + ({off: 'オフ', all: '再生リスト全体', one: '1 曲'})[repeat];
  }
  function checkbox(text, title) {
    const label = el('label', {title: title},
                     {display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap'});
    const box = el('input', {type: 'checkbox'});
    label.append(box, document.createTextNode(text));
    return [label, box];
  }
  const [resumeLabel, resumeBox] = checkbox('開いたら続きから', 'YouTube のトップを開いたら、前回の動画の続きから再生する');
  const [bgLabel, bgBox] = checkbox('裏で再生', '画面を消したり別のアプリに切り替えたりしても再生を続ける');
  // 知らせ（取得中・エラーなど）。あるときだけ 1 行使う
  const info = el('div', {}, {overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                              color: '#aaa', fontSize: '12px', display: 'none'});
  // 再生中の動画のタイトルと再生位置。動画を見ていないときは前回の動画（▶ で続きから流れるもの）
  const rowTitle = el('div', {}, {display: 'flex', gap: '8px', alignItems: 'baseline', fontSize: '13px'});
  const titleEl = el('span', {}, {flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap'});
  // 長いタイトルは 10 秒おきに左へ流す。後ろに同じタイトルをもう 1 つ並べ、それが先頭の位置に来たら止める
  // （見た目は先頭に戻ったのと同じ）。そこからまた 10 秒待つ。
  const titleMove = el('span', {}, {display: 'inline-block', whiteSpace: 'nowrap'});
  const titleA = el('span', {}, {paddingRight: '3em'});
  const titleB = el('span');
  titleMove.append(titleA, titleB);
  titleEl.append(titleMove);
  // 保存分（オフライン保存）で流しているときのタイトルの色。通信しているときは白
  const OFFLINE_COLOR = '#6fdc8c';
  let titleText = null, titleTimer = null, titleAnim = null, titleWidth = 0;
  function setTitle(text) {
    // 再生位置の桁が変わると幅が少し変わるので、少しの違いでは流し直さない
    if (text === titleText && Math.abs(titleEl.clientWidth - titleWidth) < 20) return;
    titleText = text;
    titleWidth = titleEl.clientWidth;
    titleEl.title = text;
    clearTimeout(titleTimer);
    if (titleAnim) { titleAnim.cancel(); titleAnim = null; }
    titleA.textContent = text;
    titleB.textContent = '';
    titleA.style.paddingRight = '0';
    if (!text || !titleWidth || titleA.offsetWidth <= titleWidth) return;  // 収まっている
    titleA.style.paddingRight = '3em';
    titleB.textContent = text;
    const distance = titleA.offsetWidth;
    const duration = distance / 40 * 1000;  // 1 秒に 40px
    const scroll = () => {
      titleAnim = titleMove.animate([{transform: 'translateX(0)'}, {transform: 'translateX(-' + distance + 'px)'}],
                                    {duration: duration, easing: 'linear'});
      // 終わりはタイマーで受ける（アニメーションの終了の知らせは、画面が描かれていないと届かないため）。
      // 取り消すと先頭の位置に戻るが、そのとき見えているのは 2 つ目のタイトルの先頭なので、見た目は変わらない
      titleTimer = setTimeout(() => {
        if (titleAnim) { titleAnim.cancel(); titleAnim = null; }
        titleTimer = setTimeout(scroll, 10000);
      }, duration);
    };
    titleTimer = setTimeout(scroll, 10000);
  }
  const timeEl = el('span', {}, {color: '#aaa', fontSize: '12px', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums'});
  rowTitle.append(titleEl, timeEl);
  // 設定（⚙ で開く）
  const row3 = el('div', {}, {display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap'});
  // アプリの画面（0.27。パソコン版の表示のときだけ）の切り替えと、アプリの画面のときのタブを閉じる ×
  const appBtn = el('button', {textContent: 'アプリ', title: '動画と曲の一覧だけのアプリの画面にする'},
                    Object.assign({}, tool, {fontSize: phone ? '15px' : 'inherit', padding: phone ? '10px 8px' : ctrl.padding}));
  const closeBtn = el('button', {textContent: '×', title: '止めて、YouTube のページを閉じる'},
                      Object.assign({}, tool, {fontSize: phone ? '24px' : '16px', color: '#f99', display: 'none', marginLeft: '6px'}));
  // 全画面（Firefox のアドレスバーと Android のバーを隠す）。全画面はタップしたときにしか頼めないのでボタンにする
  const fullBtn = el('button', {textContent: '⛶', title: '全画面'},
                     Object.assign({}, tool, {fontSize: phone ? '22px' : '15px', display: 'none'}));
  row1.append(sel, refreshBtn, optBtn, foldBtn);
  if (!isMobile) row1.append(appBtn, fullBtn, closeBtn);
  // 再生位置のバー（アプリの画面のときだけ出す）
  const seekEl = el('input', {type: 'range', min: '0', max: '1000', value: '0', title: '再生位置'},
                    {width: '100%', margin: phone ? '6px 0' : '0', accentColor: '#f33', display: 'none', boxSizing: 'border-box'});
  // 保存分で流している間の「保存済み 40 / 56」
  const offEl = el('span', {}, {flex: '1', minWidth: '0', overflow: 'hidden', whiteSpace: 'nowrap', textAlign: 'right',
                                color: '#aaa', fontSize: '12px'});
  row2.append(prevBtn, playBtn, nextBtn, offEl, shuffleBtn, repeatBtn);
  // 版と、スクリプトが動いている場所（page / content）。うまく動かないときの手がかり
  const about = el('span', {textContent: 'v' + VERSION + ' · ' + MODE}, {color: '#888', fontSize: '12px', marginLeft: 'auto'});
  // 裏に回ったときに何が届いたかの記録（新しいものが下）
  const logEl = el('div', {}, {width: '100%', color: '#888', fontSize: '11px', whiteSpace: 'pre-wrap', lineHeight: '1.4'});
  const diagBtn = el('button', {textContent: '診断', title: 'YouTube のページに頼っている部分が動いているか確かめる'},
                     Object.assign({}, ctrl, {fontSize: '12px'}));
  const diagEl = el('div', {}, {width: '100%', fontSize: '12px', lineHeight: '1.5', display: 'none'});
  // オフライン保存（Premium）はパソコン版のページにしかないので、www を開いているときだけ出す
  const [offLabel, offBox] = checkbox('オフライン優先', '保存済みの曲は、通信せずに保存分で流す（保存していない曲は飛ばす）');
  const saveBtn = el('button', {textContent: 'このリストを保存', title: '再生中の再生リストの曲を、YouTube のオフライン保存にまとめて入れる'},
                     Object.assign({}, ctrl, {fontSize: '12px'}));
  row3.append(resumeLabel, bgLabel);
  const [pcLabel, pcBox] = checkbox('PC 版で開く', 'YouTube を開いたら、パソコン版の表示へ移る（オフライン保存を使うため）');
  const mobileBtn = el('button', {textContent: 'スマホ版へ', title: 'スマホ版の表示（m.youtube.com）に戻る。「PC 版で開く」はそこでオフにできる'},
                       Object.assign({}, ctrl, {fontSize: '12px'}));
  if (isMobile) row3.append(pcLabel);
  else row3.append(offLabel, saveBtn);
  if (!isMobile && touch) row3.append(mobileBtn);
  // うまく動かないときに、記録（80 件）と今の状態をまとめてコピーする。チャットなどに貼って見せる
  const logBtn = el('button', {textContent: '記録をコピー', title: '記録と今の状態をクリップボードにコピーする'},
                    Object.assign({}, ctrl, {fontSize: '12px'}));
  row3.append(diagBtn, logBtn, about, diagEl, logEl);
  bar.append(row1, rowTitle, seekEl, row2, info, row3);
  const barCss = bar.style.cssText;
  // たたんだときに出す小さなボタン
  const openBtn = el('button', {id: 'ytp-open', textContent: '♪', title: 'YT Player のバーを開く'},
                     Object.assign({}, tool, {position: 'fixed', zIndex: '2147483647', right: '10px',
                                              bottom: isMobile ? '60px' : '14px', opacity: '.85',
                                              boxShadow: '0 2px 8px rgba(0,0,0,.5)'}));

  let message = '';
  function showMessage(text, isError) {
    message = text || '';
    info.textContent = message;
    info.title = message;
    info.style.color = isError ? '#f88' : '#aaa';
    info.style.display = message ? 'block' : 'none';
  }
  function fill(list, selected) {
    sel.replaceChildren(el('option', {value: '', textContent: '— 再生リスト —'}));
    for (const p of list || []) {
      sel.append(el('option', {value: p.id, textContent: p.count == null ? p.title : p.title + ' (' + p.count + ')'}));
    }
    sel.value = selected || '';
    if (sel.value !== (selected || '')) sel.value = '';
  }
  // スマホでパソコン版の表示を開いたときの、バーの大きさと位置。毎秒測り直す（ページの描かれ方があとから変わるため）。
  // 大きさ：ページが縮小表示されている分だけ拡大する（「デスクトップ サイト」では幅 980px ほどで描かれて約 0.44 倍に
  //   縮小表示されるので、約 2.3 倍）。画面の幅のまま描かれているときは、縦でも横でも等倍。
  //   ページの幅から決めると、横向きにしただけで巨大になる（0.22 の不具合）。
  // 位置：Firefox の上のバー（アドレスバー）が出ている間、画面の下に固定したものは下が切れることがある。
  //   バーの下端が見えている範囲からはみ出していたら、その分だけ上げる。
  let bottomFix = 0, loggedFix = -100, loggedWidth = -100;
  function applyZoom() {
    if (!touch || isMobile) { placeView(1); return; }
    const vv = window.visualViewport;
    const shrink = vv && vv.scale ? 1 / vv.scale : window.innerWidth / (screen.width || window.innerWidth);
    const z = String(Math.round(Math.min(3, Math.max(1, shrink)) * 100) / 100);
    if (bar.style.zoom !== z) {
      bar.style.zoom = openBtn.style.zoom = z;
      log('バーの拡大 ' + z + '（表示倍率 ' + (vv ? Math.round(vv.scale * 100) / 100 : '-') + '、ページの幅 ' + window.innerWidth +
          '、画面 ' + screen.width + '）');
    }
    if (placeView(Number(z))) return;  // アプリの画面の中にバーを置いているときは、位置合わせはしない
    if (!vv) return;
    // 横：ページが画面より少し広く描かれていると（YouTube のパソコン版は狭い画面で右がはみ出す）、
    // ページの幅いっぱいに置いたバーは右が切れる。見えている範囲の左端と幅に合わせる。
    const zn = Number(z);
    const left = Math.round((vv.offsetLeft + 6) / zn), width = Math.round((vv.width - 12) / zn);
    const page = document.documentElement.clientWidth || window.innerWidth;
    const right = Math.round((Math.max(0, page - vv.offsetLeft - vv.width) + 10) / zn);
    if (bar.style.left !== left + 'px' || bar.style.width !== width + 'px') {
      bar.style.right = 'auto';
      bar.style.left = left + 'px';
      bar.style.width = width + 'px';
      openBtn.style.right = right + 'px';
      if (Math.abs(width - loggedWidth) > 10) {
        loggedWidth = width;
        log('バーの幅 ' + width + 'px（見えている幅 ' + Math.round(vv.width) + '、ページの幅 ' + page + '、左 ' + Math.round(vv.offsetLeft) + '）');
      }
    }
    if (settings.collapsed) return;
    const over = bar.getBoundingClientRect().bottom - (vv.offsetTop + vv.height) + 6;  // 見えている下端から 6px 上に置きたい
    if (Math.abs(over) <= 2) return;
    bottomFix = Math.max(0, Math.min(200, bottomFix + over / Number(z)));
    bar.style.bottom = (6 + bottomFix) + 'px';
    openBtn.style.bottom = (14 + bottomFix) + 'px';
    if (Math.abs(bottomFix - loggedFix) > 10) {
      loggedFix = bottomFix;
      log('バーの位置を ' + Math.round(bottomFix) + 'px 上げた（見えている高さ ' + Math.round(vv.height) + '、ページの高さ ' + window.innerHeight + '）');
    }
  }
  function applyFold() {
    const fold = settings.collapsed && !viewShown;  // アプリの画面ではたたまない
    bar.style.display = fold ? 'none' : 'flex';
    openBtn.style.display = fold ? 'block' : 'none';
    foldBtn.style.display = viewShown ? 'none' : '';
  }
  async function refresh() {
    showMessage('取得中…');
    try {
      settings.playlists = await fetchPlaylists();
      save();
      fill(settings.playlists, shownList() || sel.value);
      if (listInfo && listInfo.warn) showMessage('⚠ 一覧の続きを読めませんでした（' + listInfo.count + ' 件まで）', true);
      else showMessage('');
    } catch (e) {
      showMessage(e.message, true);
    }
  }
  sel.addEventListener('change', () => {
    const id = sel.value;
    if (!id) return;
    settings.last_playlist = id;
    // 前にこの再生リストを聴いていたら、その続きから。初めてなら先頭の動画から
    // （watch?list=ID だけ（v= なし）だと再生されないので、必ず動画を指定する）
    const pos = (settings.positions || {})[id];
    const p = (settings.playlists || []).find(x => x.id === id);
    const url = pos && pos.url ? pos.url : (p && p.vid ? location.origin + '/watch?v=' + p.vid + '&list=' + id : null);
    if (!url) {
      delete settings.last_url;
      delete settings.last_time;
      delete settings.last_title;
      save();
      location.href = '/playlist?list=' + id;
      return;
    }
    settings.last_url = url;
    settings.last_time = pos ? pos.time || 0 : 0;
    settings.last_title = pos ? pos.title || '' : '';
    save();
    const r = resumeTarget();
    navigate(r.url, r.time);
  });
  refreshBtn.addEventListener('click', refresh);
  foldBtn.addEventListener('click', () => { settings.collapsed = true; save(); applyFold(); });
  openBtn.addEventListener('click', () => { settings.collapsed = false; save(); applyFold(); });
  prevBtn.addEventListener('click', () => { log('⏮ を押した'); step(-1); });
  nextBtn.addEventListener('click', () => { log('⏭ を押した'); step(1); });
  playBtn.addEventListener('click', () => {
    const p = player();
    if (!location.pathname.startsWith('/watch') || !p) {
      const r = resumeTarget();
      if (r) { markAutoplay(r.time); location.href = r.url; }
      return;
    }
    log(p.getPlayerState() === 1 ? '⏸ を押した' : '▶ を押した');
    if (p.getPlayerState() === 1) p.pauseVideo(); else { p.playVideo(); setTimeout(safe(checkStarted, 'checkStarted'), 2500); }
    setTimeout(tick, 300);
  });
  shuffleBtn.addEventListener('click', () => { settings.shuffle = !settings.shuffle; save(); paintMode(); });
  repeatBtn.addEventListener('click', () => {
    settings.repeat = ({off: 'all', all: 'one', one: 'off'})[repeatMode()];
    save();
    paintMode();
  });
  diagBtn.addEventListener('click', async () => {
    if (diagEl.style.display !== 'none') { diagEl.style.display = 'none'; return; }
    diagEl.replaceChildren(document.createTextNode('確かめています…'));
    diagEl.style.display = 'block';
    const lines = await diagnose();
    diagEl.replaceChildren();
    for (const [name, ok, text] of lines) {
      const line = el('div');
      line.append(el('span', {textContent: ok === true ? '✓ ' : ok === false ? '✗ ' : '– '},
                     {color: ok === true ? '#7d7' : ok === false ? '#f88' : '#aaa'}),
                  el('b', {textContent: name + '  '}),
                  el('span', {textContent: text || ''}, {color: ok === false ? '#f88' : '#ccc'}));
      diagEl.append(line);
    }
  });
  bgBox.addEventListener('change', () => { settings.bg = bgBox.checked; save(); });
  pcBox.addEventListener('change', () => {
    settings.pc = pcBox.checked;
    save();
    log('PC 版で開く を' + (settings.pc ? 'オン' : 'オフ') + 'にした');
    if (!settings.pc) return;
    const u = new URL(location.href);
    u.hostname = 'www.youtube.com';
    u.searchParams.set('app', 'desktop');
    location.href = u.href;
  });
  mobileBtn.addEventListener('click', () => { location.href = 'https://m.youtube.com/?app=m'; });
  // オフライン優先の切り替え。再生リストを流している最中なら、その曲のまま保存分の側 / 通信する側へ開き直す
  offBox.addEventListener('change', () => {
    const p = player(), vt = virtual(), id = currentList(), v = currentVideo();
    if (p) rememberLists(p);  // 再生がまだ始まっていなくても、曲順はここで覚える
    settings.offline = offBox.checked;
    save();
    log('オフライン優先を' + (settings.offline ? 'オン' : 'オフ') + 'にした');
    if (!p || !v || !location.pathname.startsWith('/watch')) return;
    const list = settings.offline ? id : (vt ? vt.list : null);
    if (!list || list === 'PPSV' || (settings.offline && !(settings.orders || {})[id])) {
      if (settings.offline && id && id !== 'PPSV') showMessage('曲順を覚えたら（数秒後）、もう一度オンにしてください');
      return;
    }
    settings.last_url = location.origin + '/watch?v=' + v + '&list=' + list;
    settings.last_time = Math.floor(p.getCurrentTime());
    save();
    const r = resumeTarget(true);
    navigate(r.url, r.time);
  });
  // 再生リストの一覧（ytd-playlist-panel-video-renderer）の各曲のメニューにある「オフライン」を順に押す。
  // 曲を開かずに保存できる。メニューには「再生リストから削除」なども並ぶので、オフラインの項目
  // （ytd-menu-service-item-download-renderer）だけを種類で見分け、動画 ID も確かめてから押す。
  // 保存済みの曲は項目名が「オフラインから削除」になっているので押さない。
  let saving = false;
  async function saveAll() {
    if (saving) { saving = false; return; }
    const rows = [...document.querySelectorAll('ytd-playlist-panel-video-renderer')];
    const id = currentList();
    if (!rows.length || !id || id === 'PPSV') {
      showMessage('再生リストを（通信して）再生しているときに使えます', true);
      return;
    }
    const wait = ms => new Promise(r => setTimeout(r, ms));
    const shown = () => [...document.querySelectorAll('ytd-popup-container ytd-menu-service-item-download-renderer')]
      .find(e => e.offsetParent !== null);
    const closeMenu = () => document.body.click();
    saving = true;
    saveBtn.textContent = '保存を中止';
    // YouTube が出した画面（画質の選択など）。出たら、そこで止めて利用者に任せる
    const dialog = () => [...document.querySelectorAll('ytd-popup-container tp-yt-paper-dialog')].find(e => e.offsetParent !== null);
    let why = '', asked = '';
    let added = 0, already = 0, failed = 0;
    const kept = new Set(settings.saved || []);
    for (let i = 0; i < rows.length && saving; i++) {
      showMessage('保存中 ' + (i + 1) + ' / ' + rows.length + '（もう一度押すと中止）');
      const row = rows[i], link = row.querySelector('a[href*="/watch"]');
      const vid = link ? new URL(link.href, location.href).searchParams.get('v') : null;
      for (let k = 0; k < 10 && shown(); k++) { closeMenu(); await wait(200); }  // 前のメニューが閉じるのを待つ
      let btn = row.querySelector('ytd-menu-renderer button');
      if (!btn) { row.scrollIntoView({block: 'nearest'}); await wait(500); btn = row.querySelector('ytd-menu-renderer button'); }
      if (!btn || !vid) { failed++; why = why || 'メニューのボタンがない'; continue; }
      btn.click();
      let item = null;
      for (let k = 0; k < 15 && !item; k++) { await wait(200); item = shown(); }
      let other = false;  // 別の曲のメニューが出ていないか
      try {
        const m = item && JSON.stringify(pageObj(item).data || {}).match(/"videoId":"([\w-]{11})"/);
        if (m && m[1] !== vid) other = true;
      } catch (e) {}
      if (!item || other) {
        failed++;
        why = why || (other ? '別の曲のメニューが出た' : 'メニューに「オフライン」の項目が出ない');
        closeMenu();
        await wait(300);
        continue;
      }
      // 見えている文字で判断する（textContent には、隠れているもう一方の項目名も入っている）。
      // 「オフライン」とはっきり分かるときだけ押す。保存済みの曲では同じ項目が「オフラインから削除」になっていて、押すと消えるため
      const label = item.innerText.trim().replace(/\s+/g, ' ');
      if (/削除|Remove/i.test(label)) { already++; kept.add(vid); closeMenu(); }
      else if (/^(オフライン|ダウンロード|Download)$/i.test(label)) {
        (item.querySelector('tp-yt-paper-item') || item).click();
        added++;
        kept.add(vid);
        await wait(900);
        const d = dialog();
        if (d) { asked = d.innerText.trim().replace(/\s+/g, ' ').slice(0, 80); break; }
      } else {
        failed++;
        why = why || '項目名が想定と違う「' + label.slice(0, 30) + '」';
        closeMenu();
      }
      await wait(700);
    }
    const stopped = !saving;
    saving = false;
    settings.saved = [...kept];
    save();
    saveBtn.textContent = 'このリストを保存';
    log('このリストを保存: 追加 ' + added + ' / 保存済み ' + already + ' / 失敗 ' + failed + ' / 全 ' + rows.length +
        (asked ? '（YouTube の画面が出たので止めた: ' + asked + '）' : stopped ? '（中止）' : '') + (why ? ' 失敗の理由: ' + why : ''));
    if (asked) {
      showMessage('YouTube の画面が出ました。画質を選び、「設定を保存」にチェックして進めてから、もう一度「このリストを保存」を押してください', true);
      return;
    }
    showMessage((stopped ? '中止しました。' : '') + added + ' 曲の保存を始めました（保存済み ' + already + '、失敗 ' + failed +
                '）。終わるまでこのページを開いたままにしてください', failed > 0);
  }
  saveBtn.addEventListener('click', saveAll);
  logBtn.addEventListener('click', async () => {
    let lines = [];
    try { lines = JSON.parse(localStorage.getItem('ytp-log') || '[]'); } catch (e) {}
    const p = player(), u = new URL(location.href);
    const head = [
      'YT Player v' + VERSION + ' · ' + MODE + ' · ' + location.hostname,
      'ページ: ' + u.pathname + ' v=' + (u.searchParams.get('v') || '-') + ' list=' + (u.searchParams.get('list') || '-'),
      'プレイヤー: ' + (p ? '状態 ' + p.getPlayerState() + ' / ' + fmt(p.getCurrentTime()) + ' / ' + fmt(p.getDuration()) +
                       ' / 一覧 ' + ((typeof p.getPlaylist === 'function' && p.getPlaylist()) || []).length + ' 曲' : 'なし') +
        (playerError() ? ' / エラー: ' + playerError() : ''),
      'プレイヤーの詳細: ' + playerDetail(),
      '動画のデータ（このページを開いてから）: ' + mediaText(),
      '設定: 優先=' + !!settings.offline + ' 元のリスト=' + (settings.offline_list || '-') + ' 保存済みの控え=' + (settings.saved || []).length +
        ' 曲順の控え=' + Object.keys(settings.orders || {}).map(k => k + ':' + settings.orders[k].length).join(',') +
        ' シャッフル=' + !!settings.shuffle + ' リピート=' + repeatMode() + ' 裏で再生=' + !!settings.bg + ' 続きから=' + (settings.autoresume !== false),
      '前回: ' + (settings.last_url || '-') + ' ' + (settings.last_time || 0) + ' 秒'
    ];
    const text = head.concat(lines).join('\n');
    let ok = false;
    try { await navigator.clipboard.writeText(text); ok = true; } catch (e) {}
    if (!ok) {
      // クリップボードに書けないとき：選択した状態の入力欄を出す（長押しでコピーできる）
      const area = el('textarea', {value: text, readOnly: true}, {width: '100%', height: '120px', fontSize: '11px'});
      logEl.before(area);
      area.select();
      try { ok = document.execCommand('copy'); } catch (e) {}
      if (ok) area.remove();
    }
    showMessage(ok ? '記録をコピーしました（' + lines.length + ' 件）。チャットに貼り付けてください' : 'コピーできませんでした。下の欄を長押しでコピーしてください', !ok);
  });
  resumeBox.addEventListener('change', () => { settings.autoresume = resumeBox.checked; save(); });
  optBtn.addEventListener('click', () => { settings.showopts = !settings.showopts; save(); applyOpts(); });
  function applyOpts() { row3.style.display = settings.showopts ? 'flex' : 'none'; showLog(); }
  function showLog() {
    if (!settings.showopts) return;
    let lines = [];
    try { lines = JSON.parse(localStorage.getItem('ytp-log') || '[]'); } catch (e) {}
    const text = lines.length ? '記録:\n' + lines.slice(-20).join('\n') : '';
    if (logEl.textContent !== text) logEl.textContent = text;
  }

  // 開いたページで再生を始め（wantPlay）、前回の位置まで進める（resumeSeek）。
  // 進めるのは再生が始まってから（始まる前に進めても、Firefox では再生開始で先頭に戻ることがある）。広告の間は待つ。
  // 利用者の一時停止とぶつからないよう、再生を試すのは 2 秒おきに 5 回まで。全体で 60 秒まで。
  function startPlayback() {
    if (!wantPlay && !resumeSeek) return;
    // 開いた曲が流れ始めるかも見張る（読み込み中のまま止まったら、やり直す・開き直す）
    if (wantPlay && location.pathname.startsWith('/watch')) watchMove(currentVideo(), currentList(), 20000);
    const started = Date.now();
    let plays = 0, seeks = 0, last = 0, gaveUp = false;
    const timer = setInterval(() => {
      const done = () => { clearInterval(timer); wantPlay = false; resumeSeek = 0; };
      if (Date.now() - started > 60000) { log('再生が始まらないまま 60 秒たった: ' + playerDetail()); return done(); }
      const p = player();
      if (!p || !p.getDuration || !(p.getDuration() > 0)) return;
      if (adShowing()) return;  // 広告の再生中
      if (Date.now() - last < 2000) return;  // 直前に操作した
      const state = p.getPlayerState();
      if (state === 1) {
        if (resumeSeek && p.getCurrentTime() < resumeSeek - 5 && seeks < 5) {
          last = Date.now();
          seeks++;
          log('前回の位置（' + fmt(resumeSeek) + '）へ進める');
          p.seekTo(resumeSeek, true);
          return;  // 2 秒後に、進んだか確かめる
        }
        return done();
      }
      if (plays === 5 && !gaveUp && Date.now() - last > 2000) {
        gaveUp = true;  // 5 回頼んでも始まらない。理由を記録に残す
        checkStarted();
      }
      if (!wantPlay || state === 3 || plays >= 5) return;  // 読み込み中など
      last = Date.now();
      plays++;
      log('再生を始める（' + plays + ' 回目）');
      p.playVideo();
    }, 500);
  }

  // ロック画面・通知の「前へ」「次へ」も再生リストの曲送りにする
  function setMediaSession() {
    const ms = pageObj(navigator).mediaSession;
    if (!ms) return;
    try {
      ms.setActionHandler('previoustrack', pageFn(() => { log('通知の ⏮'); step(-1); }));
      ms.setActionHandler('nexttrack', pageFn(() => { log('通知の ⏭'); step(1); }));
    } catch (e) {}
  }

  // 1 秒ごと：ボタンの表示、再生リストの選択、バーが消されていないか
  // プレイヤーに出ているエラーの文（「この動画は再生できません」など）
  function playerError() {
    const e = document.querySelector('#movie_player .ytp-error');
    return e && e.offsetParent !== null ? e.innerText.trim().replace(/\s+/g, ' ').slice(0, 60) : '';
  }
  // 再生が始まらないときの手がかり：動画のデータ、video 要素の状態、プレイヤーの状態の印、出ている画面
  function playerDetail() {
    const parts = [];
    try {
      const p = player(), box = document.getElementById('movie_player'), v = document.querySelector('#movie_player video');
      const d = p && p.getVideoData ? p.getVideoData() : null;
      if (d) parts.push('再生可=' + d.isPlayable + (d.errorCode ? ' errorCode=' + d.errorCode : ''));
      if (v) {
        parts.push('video ready=' + v.readyState + ' net=' + v.networkState + ' paused=' + v.paused + ' muted=' + v.muted +
                   ' src=' + (v.currentSrc ? v.currentSrc.slice(0, 5) : 'なし') +
                   (v.error ? ' error=' + v.error.code + ' ' + String(v.error.message || '').slice(0, 40) : ''));
      } else parts.push('video 要素なし');
      if (box) parts.push('印=' + [...box.classList].filter(c => /^(ad-|unstarted|playing|paused|buffering|ended|ytp-error|ytp-offline)/.test(c)).join(','));
      const dlg = [...document.querySelectorAll('ytd-popup-container tp-yt-paper-dialog, ytd-popup-container yt-confirm-dialog-renderer')]
        .find(e => e.offsetParent !== null);
      if (dlg) parts.push('画面=' + dlg.innerText.trim().replace(/\s+/g, ' ').slice(0, 50));
      if (playerError()) parts.push('エラー=' + playerError());
      parts.push('online=' + navigator.onLine);
    } catch (e) { parts.push('調べられない: ' + ((e && e.message) || e)); }
    return parts.join(' / ');
  }
  // ▶ を押しても始まらないとき：手がかりを残し、video 要素に直接頼んでみる（断られた理由が分かる）
  function checkStarted() {
    const p = player();
    if (!p || p.getPlayerState() === 1) return;
    log('再生が始まらない: ' + playerDetail());
    const v = document.querySelector('#movie_player video');
    if (!v) return;
    try {
      const r = v.play();
      if (r && r.then) r.then(() => log('video.play() は通った'), e => {
        log('video.play() が断られた: ' + e.name + ' ' + String(e.message).slice(0, 60));
        // Firefox がこのサイトの自動再生を止めている（許可はサイトごと。m.youtube.com で許可していても www には効かない）
        if (e.name === 'NotAllowedError') {
          showMessage('Firefox が自動再生を止めています。▶ を押すか、アドレスバーの鍵のアイコン → 自動再生 →「音声と動画を許可」にしてください', true);
        }
      });
    } catch (e) { log('video.play() でエラー: ' + ((e && e.message) || e)); }
  }
  let lastSave = 0, ensured = false, lastSig = '', whyLogged = false, lastRemember = 0;
  let startedAt = Date.now();  // ページ内で移り終わったときにも数え直す（checkNav）
  function tick() { safe(tickBody, 'tick')(); }
  function tickBody() {
    applyZoom();
    if (!bar.isConnected) document.documentElement.append(bar, openBtn);
    tryStep();
    showLog();
    const p = player();
    const watching = location.pathname.startsWith('/watch') && p;
    setIcon(playBtn, watching && p.getPlayerState() === 1 ? 'pause' : 'play');
    prevBtn.disabled = nextBtn.disabled = !watching;
    prevBtn.style.opacity = nextBtn.style.opacity = watching ? '1' : '.4';
    const id = currentList(), shownId = shownList();
    if (shownId && sel.value !== shownId && [...sel.options].some(o => o.value === shownId)) sel.value = shownId;
    // 保存分で流している間：保存済みの数を出す。開いた曲が保存済みでなければ、保存済みの曲へ移る（開いたときに 1 回だけ）
    const vt = watching ? virtual() : null;
    const sc = watching && !vt ? streamCtx() : null;
    // 「保存分 54/56」＝保存分で再生中、56 曲のうち 54 曲が保存済み。「通信 54/56」＝通信して再生中
    const offText = vt ? '保存分 ' + vt.avail.length + '/' + vt.order.length
      : sc ? '通信 ' + sc.order.filter(v => sc.saved.includes(v)).length + '/' + sc.order.length : '';
    offEl.style.color = vt ? OFFLINE_COLOR : '#aaa';
    if (offEl.textContent !== offText) offEl.textContent = offText;
    if (vt && !ensured && !pendingNav && !adShowing()) {
      ensured = true;
      const cur = currentVideo(), here = vt.saved.includes(cur);
      log('保存分で流す: 保存済み ' + vt.avail.length + ' / ' + vt.order.length + '（保存分の一覧 ' + vt.saved.length + ' 曲）');
      // 開いた曲が保存済みでなかった（控えが古かった）ときは、控えを直して通信する側へ
      if (!here && vt.order.includes(cur)) {
        settings.saved = vt.saved;
        openSide(vt.list, cur, false);
        return;
      }
    }
    // 曲順（通信する側）と保存済みの一覧（保存分の側）を覚える。再生が始まっていなくても覚える
    if (watching && !onMobile() && Date.now() - lastRemember > 5000) {
      lastRemember = Date.now();
      if (rememberLists(p)) {
        save();
        log((id === 'PPSV' ? '保存済みの一覧' : '曲順') + 'を覚えた（' + p.getPlaylist().length + ' 曲）');
      }
    }
    // 保存分の側にいるのに流せる曲がないとき（保存済みが 1 曲もない・この再生リストの曲がない）は、通信する側へ戻す。
    // そのままだと次の曲へ進まないため。保存済みの控えを実際の一覧に合わせるので、次からは保存分の側へ行かない
    if (watching && !whyLogged && !pendingNav && listReady(p) && !onMobile() && settings.offline && id === 'PPSV' && settings.offline_list &&
        Date.now() - startedAt > 8000 && (!vt || !vt.avail.length) &&
        (p.getPlayerState() === 1 || p.getPlayerState() === 2)) {
      // ↑ 再生できている（再生中・停止中）ときだけ判断する。読み込みが終わっていない間はプレイヤーの一覧がまだ空で、
      //   「保存済みの曲がない」と誤って判断して控えを消してしまう（0.24 の実機の記録）
      whyLogged = true;
      const ids = typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
      const order = (settings.orders || {})[settings.offline_list];
      log('保存分で流せない: ' + (!order ? '曲順の控えがない' : !ids || !ids.length ? '保存済みの曲がない' : 'この再生リストの曲が保存されていない') +
          ' → 通信する側へ戻す');
      if (ids) settings.saved = Array.from(ids);  // 一覧が読めたときだけ、控えを実際の一覧に合わせる
      save();
      navigate('/watch?v=' + currentVideo() + '&list=' + settings.offline_list, Math.floor(p.getCurrentTime()));
      return;
    }
    // 動画・再生状態・エラーが変わったら残す
    const err = watching ? playerError() : '';
    const sig = watching ? currentVideo() + ':' + p.getPlayerState() + ':' + err : '';
    if (sig !== lastSig) {
      lastSig = sig;
      if (watching) log('v=' + currentVideo() + (id ? ' list=' + (id === 'PPSV' ? id : id.slice(0, 6) + '…') : '') + (err ? ' エラー: ' + err : '') + ' [' + mediaText() + ']');
    }
    let title = '', time = '';
    if (watching) {
      // getVideoData() は曲送りの直後など、まだ空のことがある。そのときはページのタイトル（「… - YouTube」）を使う
      const d = p.getVideoData ? p.getVideoData() : null;
      title = (d && d.title) || document.title.replace(/ - YouTube$/, '');
      const dur = p.getDuration ? p.getDuration() : 0, t = p.getCurrentTime ? p.getCurrentTime() : 0;
      time = dur > 0 ? fmt(t) + ' / ' + fmt(dur) : (t ? fmt(t) : '');
      titleEl.style.color = id === 'PPSV' ? OFFLINE_COLOR : '#fff';
      titleEl.title = (id === 'PPSV' ? '保存分で再生中（通信なし）: ' : '通信して再生中: ') + title;
    } else if (settings.last_url) {
      title = settings.last_title || '前回の続き';
      time = settings.last_time ? fmt(settings.last_time) + ' から' : '';
      titleEl.style.color = '#aaa';
    }
    rowTitle.style.display = title ? 'flex' : 'none';
    setTitle(title);
    timeEl.textContent = time;
    // 再生中の URL と位置を覚える（「続きから」で使う）。YouTube は曲送りでページを読み直さないので URL を毎回見る。
    // 再生中のときだけ記録する。開いた直後（前回の位置へ進む前・自動再生が止められて始まっていないとき）に 0 秒で上書きしないため
    if (watching && id && !resumeSeek && !adShowing() && p.getPlayerState() === 1 && Date.now() - lastSave > 5000) {
      lastSave = Date.now();
      // 保存分で流している間（list=PPSV）は、元の再生リストの曲として覚える
      const key = vt ? vt.list : id;
      settings.last_url = vt ? location.origin + '/watch?v=' + currentVideo() + '&list=' + vt.list : location.href;
      const whole = p.getDuration ? p.getDuration() : 0, now = p.getCurrentTime();
      settings.last_time = whole > 0 && whole - now < 10 ? 0 : Math.floor(now);
      if (title && title !== 'YouTube') settings.last_title = title;
      // 再生リストごとにも覚える（別の再生リストから戻ってきたときに続きから流す）。古いものから捨てる
      const positions = settings.positions = settings.positions || {};
      positions[key] = {url: settings.last_url, time: settings.last_time, title: settings.last_title || '', at: Date.now()};
      const keys = Object.keys(positions);
      if (keys.length > 100) {
        keys.sort((a, b) => (positions[a].at || 0) - (positions[b].at || 0));
        for (const k of keys.slice(0, keys.length - 100)) delete positions[k];
      }
      save();
      setMediaSession();
    }
  }

  // ---- アプリの画面（0.27。Windows 版 0.3 と同じ作り）----
  // YouTube のページを自前の画面（#ytp-view）で覆い、動画だけを枠（slot）に重ねて見せる。操作は今のバーをそのまま中に入れる。
  // プレイヤー要素（#movie_player）はページから動かさない。position: fixed で枠の位置・大きさにし、resize の知らせを送ると、
  // プレイヤーが動画をその大きさで描き直す。パソコン版の表示（www）のときだけ（スマホ版はプレイヤーの作りが違う）。
  // 「デスクトップ サイト」ではページが縮小表示されているので、画面は見えている範囲（visualViewport）に合わせ、
  // 中のバーと曲の一覧はバーと同じ倍率で拡大する。動画の枠は同じページの座標で測るので、縮小されていてもずれない。
  let viewShown = false, placed = '', seeking = false, listSig = '', shownCur = '', lastAppZoom = 0;
  const view = el('div', {id: 'ytp-view'}, {
    position: 'fixed', zIndex: '2147483000', background: '#0f0f0f', color: '#fff', display: 'none',
    boxSizing: 'border-box', overflow: 'hidden', font: (phone ? '14px' : '13px') + ' Roboto, "Segoe UI", sans-serif'
  });
  const vMain = el('div', {}, {display: 'flex', flexDirection: 'column', minWidth: '0', minHeight: '0'});
  const slot = el('div', {}, {background: '#000', flex: 'none'});
  const ctlBox = el('div', {}, {flex: 'none'});
  vMain.append(slot, ctlBox);
  const side = el('div', {}, {display: 'flex', flexDirection: 'column', minWidth: '0', minHeight: '0', background: '#181818'});
  const sideHead = el('div', {}, {padding: '8px 10px', color: '#aaa', fontSize: '12px', borderBottom: '1px solid #2a2a2a',
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', flex: 'none'});
  const listBox = el('div', {}, {flex: '1', overflowY: 'auto', minHeight: '0', overscrollBehavior: 'contain'});
  side.append(sideHead, listBox);
  view.append(vMain, side);
  // 覆っている間の CSS。プレイヤーの親（#player-container）には YouTube が view-transition-name を付けていて
  // （曲送りのたびに付け直す）、そのままだとプレイヤーが覆いの下に隠れる。:has で親すべてから外す（Windows 版で確認）。
  const viewCss = el('style', {id: 'ytp-view-css', textContent:
    'html.ytp-appview :has(#movie_player), html.ytp-appview #movie_player { view-transition-name: none !important; }' +
    'html.ytp-appview, html.ytp-appview body { overflow: hidden !important; background: #0f0f0f !important; }'});
  // ↑ 背景も黒にする。覆いきれていない隙間（横向きの右端など）に YouTube のページの白い背景が見えていた（0.27 の実機）
  // YouTube は曲送りで画面切り替えのアニメーション（startViewTransition）を使う。その間は画面全体が写真に置き換わって
  // ちらつくので、覆っている間はアニメーションせず中身だけ書き換える。ページの中で動いているときだけ（content では入れ替えられない）
  if (!IN_CONTENT && typeof document.startViewTransition === 'function') {
    const origTransition = document.startViewTransition;
    document.startViewTransition = function (arg) {
      if (!viewShown) return origTransition.apply(document, arguments);
      const update = typeof arg === 'function' ? arg : arg && arg.update;
      const after = Promise.resolve().then(() => update && update()).then(() => undefined);
      return {updateCallbackDone: after, ready: after, finished: after, skipTransition() {}, types: new Set()};
    };
  }
  function wantView() { return !isMobile && settings.view === 'app' && location.pathname.startsWith('/watch') && !!player(); }
  // 画面の表示・バーの置き場所・動画の位置を今の状態に合わせる。表示していたら true
  function placeView(z) {
    const show = wantView();
    if (show !== viewShown) {
      viewShown = show;
      document.documentElement.classList.toggle('ytp-appview', show);
      if (show) {
        if (!viewCss.isConnected) document.documentElement.append(viewCss);
        ctlBox.append(bar);
        bar.style.cssText = barCss;
        Object.assign(bar.style, {position: 'static', left: '', right: '', bottom: '', width: 'auto', zoom: String(z),
                                  boxShadow: 'none', border: 'none', borderRadius: '0', background: 'transparent'});
        log('アプリの画面にした');
      } else {
        bar.style.cssText = barCss;
        document.documentElement.append(bar, openBtn);
        lastAppZoom = 0;
        log('YouTube の画面に戻した');
      }
      seekEl.style.display = show ? 'block' : 'none';
      closeBtn.style.display = fullBtn.style.display = show ? '' : 'none';
      refreshBtn.style.display = show ? 'none' : '';  // 縦向きで上の行が窮屈になるため。一覧はページを開くたびに取り直している
      if (!show && document.fullscreenElement) document.exitFullscreen().catch(() => {});
      appBtn.textContent = show ? 'YouTube' : 'アプリ';
      appBtn.title = show ? 'YouTube のページの表示に戻す' : '動画と曲の一覧だけのアプリの画面にする';
      applyFold();
    }
    if (!view.isConnected) document.documentElement.append(view);
    view.style.display = show ? 'flex' : 'none';
    const mp = document.getElementById('movie_player');
    if (!show) {
      if (settings.view !== 'app' || !location.pathname.startsWith('/watch')) dropCover();
      if (placed && mp) {
        placed = '';
        for (const k of ['position', 'left', 'top', 'width', 'height', 'zIndex']) mp.style[k] = '';
        window.dispatchEvent(new Event('resize'));
      }
      return false;
    }
    // 見えている範囲に合わせる（デスクトップ サイトでは、ページの一部が縮小表示されている）
    const vv = window.visualViewport;
    const L = vv ? vv.offsetLeft : 0, T = vv ? vv.offsetTop : 0;
    const W = vv ? vv.width : window.innerWidth, H = vv ? vv.height : window.innerHeight;
    Object.assign(view.style, {left: L + 'px', top: T + 'px', width: W + 'px', height: H + 'px'});
    if (bar.style.zoom !== String(z)) bar.style.zoom = String(z);
    side.style.zoom = String(z);
    // 縦長：動画 → 操作 → 曲の一覧。横長：左に動画と操作、右に曲の一覧
    // ⚙ で記録などを出すと操作の部分が縦に長くなる。そのままだと横長では動画の枠が潰れ（高さ 19px まで。0.29 の実機で
    // 「大きくずれた」）、縦長では曲の一覧が消える。動画の枠と一覧に最低限の高さを持たせ、操作の部分は中でスクロールさせる。
    const portrait = W < H * 0.9;
    view.style.flexDirection = portrait ? 'column' : 'row';
    vMain.style.flex = portrait ? '0 1 auto' : '1 1 0';
    side.style.flex = portrait ? '1 1 0' : 'none';
    side.style.minHeight = portrait ? Math.round(H * 0.2 / z) + 'px' : '0';
    side.style.width = portrait ? 'auto' : Math.round(Math.min(W * 0.4, 420 * z)) / z + 'px';
    slot.style.height = portrait ? Math.round(W * 9 / 16) + 'px' : '';
    slot.style.minHeight = portrait ? '' : Math.round(H * 0.45) + 'px';
    slot.style.flex = portrait ? 'none' : '1 1 0';
    Object.assign(ctlBox.style, {flex: '0 1 auto', minHeight: '0', overflowY: 'auto', overscrollBehavior: 'contain'});
    if (!mp) return true;
    const r = slot.getBoundingClientRect();
    const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
    if (r.width > 0 && r.height > 0 && (key !== placed || mp.style.position !== 'fixed')) {
      placed = key;
      Object.assign(mp.style, {position: 'fixed', left: r.left + 'px', top: r.top + 'px',
                               width: r.width + 'px', height: r.height + 'px', zIndex: '2147483001'});
      window.dispatchEvent(new Event('resize'));
    }
    if (z !== lastAppZoom) { lastAppZoom = z; log('アプリの画面 ' + Math.round(W) + 'x' + Math.round(H) + ' 拡大 ' + z + (portrait ? ' 縦' : ' 横')); }
    if (cover && placed) dropCover();  // 動画を枠に置いたので目隠しを外す
    return true;
  }
  // 曲名。ページの一覧（ytd-playlist-panel-video-renderer）から取って localStorage にも覚える
  // （保存分の側の一覧には保存済みの曲しか出ず、ページを開き直すと消えるため）
  const TITLES = 'ytp-titles';
  let titleCache = {};
  try { titleCache = JSON.parse(localStorage.getItem(TITLES) || '{}'); } catch (e) {}
  function learnTitles() {
    let added = 0;
    for (const r of document.querySelectorAll('ytd-playlist-panel-video-renderer')) {
      const a = r.querySelector('a[href*="/watch"]'), t = r.querySelector('#video-title');
      if (!a || !t) continue;
      let v = null;
      try { v = new URL(a.href, location.href).searchParams.get('v'); } catch (e) {}
      const text = t.textContent.trim();
      if (v && text && titleCache[v] !== text) { delete titleCache[v]; titleCache[v] = text; added++; }
    }
    if (!added) return;
    const keys = Object.keys(titleCache);
    for (const k of keys.slice(0, Math.max(0, keys.length - 1000))) delete titleCache[k];
    try { localStorage.setItem(TITLES, JSON.stringify(titleCache)); } catch (e) {}
  }
  // 一覧で押した曲へ。オフライン優先のときは、保存済みなら保存分の側、保存していない曲なら通信する側で流す
  function jumpTo(v) {
    log('一覧で ' + v + ' を押した');
    const vt = virtual();
    if (vt) { if (vt.saved.includes(v)) vt.go(v); else openSide(vt.list, v, false); return; }
    const sc = streamCtx();
    if (sc && sc.saved.includes(v)) { openSide(sc.list, v, true); return; }
    const it = items(), i = it.ids.indexOf(v);
    if (i >= 0) go(it, i);
  }
  // 曲の一覧。オフライン優先で流しているときも、元の再生リストの曲順で出す（保存済みの曲は緑）
  function paintViewList(p) {
    if (listSig && (pendingNav || !listReady(p))) return;  // ページ内で移っている途中は、前の一覧のまま
    learnTitles();
    const vt = virtual(), sc = vt ? null : streamCtx();
    const ids = vt ? vt.order : sc ? sc.order : (p.getPlaylist ? Array.from(p.getPlaylist() || []) : []);
    const saved = vt ? vt.saved : sc ? sc.saved : [];
    if (!ids.length && listSig) return;  // 曲送りの直後などで一瞬空になる。作り直さない
    const sig = ids.join(',') + '|' + saved.length;
    const cur = currentVideo();
    if (sig !== listSig) {
      listSig = sig;
      shownCur = '';
      listBox.replaceChildren(...ids.map((v, i) => {
        const item = el('div', {}, {display: 'flex', gap: '10px', alignItems: 'center', padding: '6px 8px', cursor: 'pointer'});
        item.dataset.v = v;
        const img = el('img', {src: 'https://i.ytimg.com/vi/' + v + '/mqdefault.jpg', loading: 'lazy'},
                       {width: '96px', height: '54px', objectFit: 'cover', borderRadius: '4px', flex: 'none', background: '#222'});
        const name = el('div', {textContent: titleCache[v] || v},
                        {fontSize: '13px', lineHeight: '1.35', overflow: 'hidden', display: '-webkit-box',
                         webkitLineClamp: '2', webkitBoxOrient: 'vertical', color: saved.includes(v) ? OFFLINE_COLOR : '#fff'});
        item.append(el('span', {textContent: String(i + 1)}, {color: '#777', fontSize: '12px', width: '22px', textAlign: 'right', flex: 'none'}), img, name);
        item.addEventListener('click', safe(() => jumpTo(v), 'jumpTo'));
        return item;
      }));
    } else {
      for (const item of listBox.children) {
        const t = titleCache[item.dataset.v];
        if (t && item.lastChild.textContent !== t) item.lastChild.textContent = t;
      }
    }
    if (cur !== shownCur) {
      shownCur = cur;
      for (const item of listBox.children) {
        const on = item.dataset.v === cur;
        item.style.background = on ? '#3a3a3a' : '';
        if (on) item.scrollIntoView({block: 'nearest'});
      }
    }
    const opt = sel.selectedOptions[0];
    const n = ids.indexOf(cur) + 1;
    sideHead.textContent = (opt && opt.value ? opt.textContent : '再生リスト') + (ids.length ? '  ·  ' + (n || '-') + ' / ' + ids.length : '') +
      (vt ? '  ·  保存分で再生中' : sc ? '  ·  通信して再生中' : '');
  }
  function paintView() {
    if (!viewShown) return;
    const p = player();
    if (!p) return;
    const dur = p.getDuration ? p.getDuration() : 0, t = p.getCurrentTime ? p.getCurrentTime() : 0;
    if (!seeking) seekEl.value = dur > 0 ? String(Math.round(t / dur * 1000)) : '0';
    paintViewList(p);
  }
  seekEl.addEventListener('input', () => { seeking = true; });
  seekEl.addEventListener('change', safe(() => {
    const p = player();
    if (p && p.getDuration() > 0) p.seekTo(Number(seekEl.value) / 1000 * p.getDuration(), true);
    seeking = false;
  }, 'seek'));
  appBtn.addEventListener('click', safe(() => {
    settings.view = settings.view === 'app' ? 'youtube' : 'app';
    save();
    if (settings.view === 'app' && !location.pathname.startsWith('/watch')) showMessage('動画を再生しているときにアプリの画面になります');
    applyZoom();
    paintView();
  }, 'appBtn'));
  fullBtn.addEventListener('click', safe(() => {
    if (document.fullscreenElement) { document.exitFullscreen().catch(() => {}); return; }
    const req = document.documentElement.requestFullscreen;
    if (!req) { showMessage('この Firefox では全画面にできません', true); return; }
    // Firefox は動画を含むものを全画面にすると、向きを横に固定することがある（0.28 の実機：縦で押しても横の全画面になった）。
    // 全画面になったら、押したときの向きに固定し直す。少したったら固定を外し、端末の向きに合わせて回るようにする
    // （0.29 の実機で、開き直して固定が消えたときの「回すと向きが変わる」動きが使いやすかったため）。
    const vv = window.visualViewport;
    const want = (vv ? vv.width < vv.height : innerWidth < innerHeight) ? 'portrait' : 'landscape';
    document.documentElement.requestFullscreen({navigationUI: 'hide'})
      .then(() => {
        const o = screen.orientation;
        if (!o || typeof o.lock !== 'function') { log('全画面にした（向きは固定できない）'); return; }
        return o.lock(want).then(() => {
          log('全画面にした（' + (want === 'portrait' ? '縦' : '横') + 'に固定）');
          setTimeout(() => {
            try { if (document.fullscreenElement) { o.unlock(); log('向きの固定を外した'); } } catch (e) {}
          }, 1500);
        }, e => log('全画面にした（向きを固定できない: ' + e.name + ' ' + e.message + '）'));
      }, e => { log('全画面にできない: ' + e.name + ' ' + e.message); showMessage('全画面にできませんでした', true); });
  }, 'full'));
  document.addEventListener('fullscreenchange', () => {
    fullBtn.title = document.fullscreenElement ? '全画面をやめる' : '全画面';
    setTimeout(() => applyZoom(), 300);  // 見えている範囲が変わる
  });
  // ×：位置を覚えて止め、空のページ（about:blank）へ移る。YouTube のページがなくなるので、音も通知も消える。
  // 0.27 はタブを閉じていた（@grant window.close）が、タブが 1 つだけのとき Firefox が固まった（実機）。タブは残す。
  closeBtn.addEventListener('click', safe(() => {
    const p = player();
    log('× を押した');
    if (p && location.pathname.startsWith('/watch')) {
      const vt = virtual(), id = currentList();
      const key = vt ? vt.list : id;
      if (key) {
        settings.last_url = vt ? location.origin + '/watch?v=' + currentVideo() + '&list=' + vt.list : location.href;
        settings.last_time = Math.floor(p.getCurrentTime());
        const positions = settings.positions = settings.positions || {};
        positions[key] = {url: settings.last_url, time: settings.last_time, title: settings.last_title || '', at: Date.now()};
        save();
      }
      p.pauseVideo();
    }
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    location.href = 'about:blank';
  }, 'close'));
  if (window.visualViewport) {
    window.visualViewport.addEventListener('resize', () => applyZoom());
    window.visualViewport.addEventListener('scroll', () => applyZoom());
  }
  // 動画の枠の大きさが変わったら（記録が増えた・回転したなど）すぐ動画を置き直す。1 秒ごとの見直しを待たない
  if (window.ResizeObserver) {
    let queued = false;
    new ResizeObserver(() => {
      if (queued) return;
      queued = true;
      requestAnimationFrame(() => { queued = false; safe(applyZoom, 'applyZoom')(); });
      setTimeout(() => { if (queued) { queued = false; safe(applyZoom, 'applyZoom')(); } }, 300);  // 描画が止まっているとき
    }).observe(slot);
  }
  // 回転・裏から表に戻ったときは、画面の大きさが何度か変わってから落ち着く。少し間をおいて何度か置き直す
  const settle = () => { for (const ms of [150, 500, 1200]) setTimeout(safe(applyZoom, 'applyZoom'), ms); };
  window.addEventListener('orientationchange', settle);
  window.addEventListener('focus', settle);
  document.addEventListener('visibilitychange', () => { if (!realHidden.call(document)) settle(); });
  setInterval(safe(paintView, 'paintView'), 500);

  function start() {
    bgBox.checked = !!settings.bg;
    resumeBox.checked = settings.autoresume !== false;
    offBox.checked = !!settings.offline;
    pcBox.checked = !!settings.pc;
    paintMode();
    applyZoom();
    window.addEventListener('resize', applyZoom);
    log('開始 v' + VERSION + ' ' + location.hostname.split('.')[0] + location.pathname + ' list=' + (currentList() || '-') +
        ' 優先=' + (settings.offline ? 'オン' : 'オフ') + ' 控え=' + (settings.saved || []).length +
        (wantPlay ? ' 再生する' : '') + (resumeSeek ? ' 位置=' + resumeSeek : '') + ' 拡大=' + (bar.style.zoom || '1'));
    fill(settings.playlists, shownList() || settings.last_playlist);
    // アプリの画面のときは、バーはもう画面の中にある（applyZoom → placeView）
    if (viewShown) document.documentElement.append(openBtn);
    else document.documentElement.append(bar, openBtn);
    if (cover) document.documentElement.append(cover);  // 目隠しはバーより上に（同じ重なり順なので後ろに置く）
    applyFold();
    applyOpts();
    startPlayback();
    tick();
    setInterval(tick, 1000);
    // 前回の一覧をすぐ出し、裏で取り直して新しく作った・保存した再生リストも反映する
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
