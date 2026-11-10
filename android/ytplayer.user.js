// ==UserScript==
// @name         YT Player (Firefox)
// @namespace    jnaka.ytplayer
// @version      0.11
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
  const VERSION = '0.11';
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

  // ---- 開いたら前回の続きから流す（「開いたら続きから」がオンのとき。既定はオン） ----
  // 前回の動画を止めた位置から開く URL。開いているサイト（m. / www.）のまま開く。
  function resumeUrl() {
    if (!settings.last_url) return null;
    const u = new URL(settings.last_url);
    u.searchParams.delete('pp');
    u.searchParams.delete('t');
    if ((settings.last_time || 0) > 5) u.searchParams.set('t', settings.last_time + 's');
    return u.pathname + u.search;
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
      markAutoplay(settings.last_time);
      location.replace(resumeUrl());
    } else if (location.pathname === '/watch') {
      // Firefox が前回のタブを開き直したときなど。同じ動画で位置の指定がなければ、前回の位置まで進める
      const here = new URL(location.href).searchParams, last = new URL(settings.last_url).searchParams;
      if (here.get('v') === last.get('v') && !here.get('t') && (settings.last_time || 0) > 5) {
        resumeSeek = settings.last_time;
        wantPlay = true;
      }
    }
  })();

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
  function log(text) {
    const d = new Date(), hms = [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, '0')).join(':');
    const p = player();
    const state = p ? ({'-1': '未開始', 0: '終了', 1: '再生中', 2: '停止中', 3: '読込中', 5: '待機'})[p.getPlayerState()] || '' : '';
    try {
      const lines = JSON.parse(localStorage.getItem('ytp-log') || '[]');
      lines.push(hms + ' ' + text + (state ? '（' + state + '）' : ''));
      localStorage.setItem('ytp-log', JSON.stringify(lines.slice(-12)));
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
  let played = [], history = [], playedList = null, jumpedAt = 0;
  function items() {
    const p = player();
    const ids = p && typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
    if (ids && ids.length) return {source: 'player', ids: Array.from(ids), go: i => p.playVideoAt(i)};
    const links = panelLinks();
    return {source: 'page', ids: links.map(a => new URL(a.href, location.href).searchParams.get('v')),
            go: i => links[i].click()};
  }
  function go(it, i) { jumpedAt = Date.now(); pendingStep = null; it.go(i); }
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
  function repeatMode() { return settings.repeat === 'all' || settings.repeat === 'one' ? settings.repeat : 'off'; }
  function checkEnd() {
    const repeat = repeatMode();
    if (!settings.shuffle && repeat === 'off') return;
    const p = player();
    if (!p || !location.pathname.startsWith('/watch') || adShowing() || Date.now() - jumpedAt < 3000) return;
    const d = p.getDuration(), t = p.getCurrentTime();
    if (!(d > 0) || p.getPlayerState() !== 1 || d - t > 1.2) return;
    const data = p.getVideoData ? p.getVideoData() : null;
    if (data && data.isLive) return;  // ライブ配信はいつも「終わりの直前」に見える
    if (repeat === 'one') { jumpedAt = Date.now(); p.seekTo(0, true); return; }
    if (!currentList()) return;
    if (settings.shuffle) { jumpRandom(); return; }
    // 全曲リピート：最後の曲なら先頭へ。一覧が途中までしか読み込まれていないことがあるので、本数と比べる
    const it = items(), i = it.ids.indexOf(currentVideo());
    const pl = (settings.playlists || []).find(x => x.id === currentList());
    const total = pl ? Number(String(pl.count).replace(/,/g, '')) : NaN;
    if (i >= 0 && i === it.ids.length - 1 && !(total > it.ids.length)) go(it, 0);
  }
  document.addEventListener('timeupdate', checkEnd, true);
  setInterval(checkEnd, 250);
  function currentList() {
    try { return new URL(location.href).searchParams.get('list'); } catch (e) { return null; }
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }

  // ---- 再生リストの一覧 ----
  // YouTube の「再生リスト」ページと同じ一覧（保存した再生リスト・後で見る・ミックスリストも）。
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
        if (l.contentId && title && !seen.has(l.contentId)) {
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
  const ctrl = {background: '#272727', color: '#fff', border: '1px solid #444', borderRadius: '6px',
                font: 'inherit', padding: isMobile ? '6px 8px' : '3px 6px', minWidth: isMobile ? '40px' : '0',
                cursor: 'pointer'};
  // スマホでは押しやすいよう大きくする。⏮ ⏯ ⏭ はさらに大きく
  const tool = isMobile ? Object.assign({}, ctrl, {padding: '10px 0', minWidth: '52px', fontSize: '20px', lineHeight: '1'}) : ctrl;
  const big = isMobile ? Object.assign({}, ctrl, {padding: '12px 0', minWidth: '64px', fontSize: '26px', lineHeight: '1'}) : ctrl;
  const bar = el('div', {id: 'ytp-bar'}, {
    position: 'fixed', zIndex: '2147483647', boxSizing: 'border-box',
    // スマホ版は画面下に YouTube のメニューがあるので、その上に置く
    left: isMobile ? '6px' : 'auto', right: isMobile ? '6px' : '12px', bottom: isMobile ? '56px' : '12px',
    display: 'flex', flexDirection: 'column', gap: '6px',
    background: 'rgba(15,15,15,.92)', color: '#fff', padding: '6px 8px', borderRadius: '10px',
    font: (isMobile ? '14px' : '13px') + ' Roboto, "Segoe UI", sans-serif',
    boxShadow: '0 2px 8px rgba(0,0,0,.5)', border: '1px solid #555'
  });
  const row1 = el('div', {}, {display: 'flex', gap: '6px', alignItems: 'center'});
  const row2 = el('div', {}, {display: 'flex', gap: '6px', alignItems: 'center'});
  const sel = el('select', {title: '再生リスト'}, Object.assign({}, ctrl, {flex: '1', minWidth: '0', maxWidth: isMobile ? 'none' : '280px',
                                                             padding: isMobile ? '12px 8px' : ctrl.padding}));
  const refreshBtn = el('button', {textContent: '⟳', title: '再生リストを取得し直す'}, tool);
  const foldBtn = el('button', {textContent: '▾', title: 'たたむ'}, tool);
  const optBtn = el('button', {textContent: '⚙', title: '設定'}, tool);
  const prevBtn = el('button', {textContent: '⏮︎', title: '前の動画'}, big);
  // 動画を見ていないとき（トップ・検索・再生リストのページなど）は、前回の動画を止めた位置から再生する
  const playBtn = el('button', {textContent: '▶︎', title: '再生 / 一時停止（動画を見ていないときは前回の続きから）'}, big);
  const nextBtn = el('button', {textContent: '⏭︎', title: '次の動画'}, big);
  const shuffleBtn = el('button', {textContent: '🔀︎'}, tool);
  const repeatBtn = el('button', {textContent: '🔁︎'}, tool);
  function paintMode() {
    const on = {background: '#3d5a80', borderColor: '#7fb2ff'}, off = {background: '#272727', borderColor: '#444'};
    const repeat = repeatMode();
    Object.assign(shuffleBtn.style, settings.shuffle ? on : off);
    Object.assign(repeatBtn.style, repeat !== 'off' ? on : off);
    shuffleBtn.title = 'シャッフル: ' + (settings.shuffle ? 'オン' : 'オフ');
    repeatBtn.textContent = repeat === 'one' ? '🔂︎' : '🔁︎';
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
  row1.append(sel, refreshBtn, optBtn, foldBtn);
  row2.append(prevBtn, playBtn, nextBtn, el('span', {}, {flex: '1'}), shuffleBtn, repeatBtn);
  // 版と、スクリプトが動いている場所（page / content）。うまく動かないときの手がかり
  const about = el('span', {textContent: 'v' + VERSION + ' · ' + MODE}, {color: '#888', fontSize: '12px', marginLeft: 'auto'});
  // 裏に回ったときに何が届いたかの記録（新しいものが下）
  const logEl = el('div', {}, {width: '100%', color: '#888', fontSize: '11px', whiteSpace: 'pre-wrap', lineHeight: '1.4'});
  const diagBtn = el('button', {textContent: '診断', title: 'YouTube のページに頼っている部分が動いているか確かめる'},
                     Object.assign({}, ctrl, {fontSize: '12px'}));
  const diagEl = el('div', {}, {width: '100%', fontSize: '12px', lineHeight: '1.5', display: 'none'});
  row3.append(resumeLabel, bgLabel, diagBtn, about, diagEl, logEl);
  bar.append(row1, rowTitle, row2, info, row3);
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
  function applyFold() {
    bar.style.display = settings.collapsed ? 'none' : 'flex';
    openBtn.style.display = settings.collapsed ? 'block' : 'none';
  }
  async function refresh() {
    showMessage('取得中…');
    try {
      settings.playlists = await fetchPlaylists();
      save();
      fill(settings.playlists, currentList() || sel.value);
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
    // 前にこの再生リストを聴いていたら、その続きから
    const pos = (settings.positions || {})[id];
    if (pos && pos.url) {
      settings.last_url = pos.url;
      settings.last_time = pos.time || 0;
      settings.last_title = pos.title || '';
      save();
      markAutoplay(settings.last_time);
      location.href = resumeUrl();
      return;
    }
    delete settings.last_url;
    delete settings.last_time;
    delete settings.last_title;
    save();
    // watch?list=ID だけ（v= なし）だと再生されないので、先頭の動画から開く
    const p = (settings.playlists || []).find(x => x.id === id);
    if (p && p.vid) markAutoplay(0);
    location.href = p && p.vid ? '/watch?v=' + p.vid + '&list=' + id : '/playlist?list=' + id;
  });
  refreshBtn.addEventListener('click', refresh);
  foldBtn.addEventListener('click', () => { settings.collapsed = true; save(); applyFold(); });
  openBtn.addEventListener('click', () => { settings.collapsed = false; save(); applyFold(); });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  playBtn.addEventListener('click', () => {
    const p = player();
    if (!location.pathname.startsWith('/watch') || !p) {
      const u = resumeUrl();
      if (u) { markAutoplay(settings.last_time); location.href = u; }
      return;
    }
    if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
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
  resumeBox.addEventListener('change', () => { settings.autoresume = resumeBox.checked; save(); });
  optBtn.addEventListener('click', () => { settings.showopts = !settings.showopts; save(); applyOpts(); });
  function applyOpts() { row3.style.display = settings.showopts ? 'flex' : 'none'; showLog(); }
  function showLog() {
    if (!settings.showopts) return;
    let lines = [];
    try { lines = JSON.parse(localStorage.getItem('ytp-log') || '[]'); } catch (e) {}
    const text = lines.length ? '記録:\n' + lines.join('\n') : '';
    if (logEl.textContent !== text) logEl.textContent = text;
  }

  // 開いたページで再生を始め（wantPlay）、前回の位置まで進める（resumeSeek）。
  // 進めるのは再生が始まってから（始まる前に進めても、Firefox では再生開始で先頭に戻ることがある）。広告の間は待つ。
  // 利用者の一時停止とぶつからないよう、再生を試すのは 2 秒おきに 5 回まで。全体で 60 秒まで。
  function startPlayback() {
    if (!wantPlay && !resumeSeek) return;
    const started = Date.now();
    let plays = 0, seeks = 0, last = 0;
    const timer = setInterval(() => {
      const done = () => { clearInterval(timer); wantPlay = false; resumeSeek = 0; };
      if (Date.now() - started > 60000) return done();
      const p = player();
      if (!p || !p.getDuration || !(p.getDuration() > 0)) return;
      if (adShowing()) return;  // 広告の再生中
      if (Date.now() - last < 2000) return;  // 直前に操作した
      const state = p.getPlayerState();
      if (state === 1) {
        if (resumeSeek && p.getCurrentTime() < resumeSeek - 5 && seeks < 5) {
          last = Date.now();
          seeks++;
          p.seekTo(resumeSeek, true);
          return;  // 2 秒後に、進んだか確かめる
        }
        return done();
      }
      if (!wantPlay || state === 3 || plays >= 5) return;  // 読み込み中など
      last = Date.now();
      plays++;
      p.playVideo();
    }, 500);
  }

  // ロック画面・通知の「前へ」「次へ」も再生リストの曲送りにする
  function setMediaSession() {
    const ms = pageObj(navigator).mediaSession;
    if (!ms) return;
    try {
      ms.setActionHandler('previoustrack', pageFn(() => step(-1)));
      ms.setActionHandler('nexttrack', pageFn(() => step(1)));
    } catch (e) {}
  }

  // 1 秒ごと：ボタンの表示、再生リストの選択、バーが消されていないか
  let lastSave = 0;
  function tick() {
    if (!bar.isConnected) document.documentElement.append(bar, openBtn);
    tryStep();
    showLog();
    const p = player();
    const watching = location.pathname.startsWith('/watch') && p;
    playBtn.textContent = watching && p.getPlayerState() === 1 ? '⏸︎' : '▶︎';
    prevBtn.disabled = nextBtn.disabled = !watching;
    prevBtn.style.opacity = nextBtn.style.opacity = watching ? '1' : '.4';
    const id = currentList();
    if (id && sel.value !== id && [...sel.options].some(o => o.value === id)) sel.value = id;
    let title = '', time = '';
    if (watching) {
      // getVideoData() は曲送りの直後など、まだ空のことがある。そのときはページのタイトル（「… - YouTube」）を使う
      const d = p.getVideoData ? p.getVideoData() : null;
      title = (d && d.title) || document.title.replace(/ - YouTube$/, '');
      const dur = p.getDuration ? p.getDuration() : 0, t = p.getCurrentTime ? p.getCurrentTime() : 0;
      time = dur > 0 ? fmt(t) + ' / ' + fmt(dur) : (t ? fmt(t) : '');
      titleEl.style.color = '#fff';
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
      settings.last_url = location.href;
      settings.last_time = Math.floor(p.getCurrentTime());
      if (title && title !== 'YouTube') settings.last_title = title;
      // 再生リストごとにも覚える（別の再生リストから戻ってきたときに続きから流す）。古いものから捨てる
      const positions = settings.positions = settings.positions || {};
      positions[id] = {url: settings.last_url, time: settings.last_time, title: settings.last_title || '', at: Date.now()};
      const keys = Object.keys(positions);
      if (keys.length > 100) {
        keys.sort((a, b) => (positions[a].at || 0) - (positions[b].at || 0));
        for (const k of keys.slice(0, keys.length - 100)) delete positions[k];
      }
      save();
      setMediaSession();
    }
  }

  function start() {
    bgBox.checked = !!settings.bg;
    resumeBox.checked = settings.autoresume !== false;
    paintMode();
    fill(settings.playlists, currentList() || settings.last_playlist);
    document.documentElement.append(bar, openBtn);
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
