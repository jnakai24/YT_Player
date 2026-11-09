// ==UserScript==
// @name         YT Player (Firefox)
// @namespace    jnaka.ytplayer
// @version      0.3
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
  const VERSION = '0.3';
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
  // タブごとに 1 回だけ。YouTube のロゴでトップに戻ったときや、開き直したときにまた飛ばないようにする。
  let resumeSeek = 0;  // 前回の動画のページがそのまま開かれたとき、この位置まで進める
  (function autoResume() {
    if (settings.autoresume === false || !settings.last_url) return;
    try {
      if (sessionStorage.getItem('ytp-resumed')) return;
      sessionStorage.setItem('ytp-resumed', '1');
    } catch (e) { return; }
    if (location.pathname === '/') {
      // トップページで開いたら、前回の動画へ（ページを読み込む前に飛ぶ）
      location.replace(resumeUrl());
    } else if (location.pathname === '/watch') {
      // Firefox が前回のタブを開き直したときなど。同じ動画で位置の指定がなければ、前回の位置まで進める
      const here = new URL(location.href).searchParams, last = new URL(settings.last_url).searchParams;
      if (here.get('v') === last.get('v') && !here.get('t') && (settings.last_time || 0) > 5) resumeSeek = settings.last_time;
    }
  })();

  // ---- 画面を消しても再生を続ける（「裏で再生」がオンのときだけ） ----
  // YouTube はページが見えなくなったこと（document.hidden / visibilitychange）を見て再生を止めるので、
  // ずっと見えていることにする。Premium の機能を回避する使い方なので、既定はオフ。
  // ページより先に仕込む必要があるため @run-at document-start。
  (function installBackground() {
    for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
      window.addEventListener(type, e => { if (settings.bg) e.stopImmediatePropagation(); }, true);
      document.addEventListener(type, e => { if (settings.bg) e.stopImmediatePropagation(); }, true);
    }
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
  function step(delta) {
    const p = player();
    const list = p && typeof p.getPlaylist === 'function' ? p.getPlaylist() : null;
    if (list && list.length) {
      if (delta > 0) p.nextVideo(); else p.previousVideo();
      return;
    }
    const v = new URL(location.href).searchParams.get('v');
    const links = [...document.querySelectorAll('ytm-playlist-panel-video-renderer')]
      .map(item => item.querySelector('a[href*="/watch"]')).filter(Boolean);
    const i = links.findIndex(a => new URL(a.href, location.href).searchParams.get('v') === v);
    const target = i >= 0 ? links[i + delta] : null;
    if (target) target.click();
    else if (p) { if (delta > 0) p.nextVideo(); else p.previousVideo(); }
  }
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
  function collect(root) {
    const out = [];
    (function walk(o) {
      if (!o || typeof o !== 'object') return;
      if (o.lockupViewModel) {
        const l = o.lockupViewModel, s = JSON.stringify(l);
        const title = l.metadata && l.metadata.lockupMetadataViewModel
                      && l.metadata.lockupMetadataViewModel.title.content;
        const badge = (s.match(/"text":"([^"]*?(?:本の動画|エピソード|レッスン|ミックスリスト|videos?|episodes?|lessons?|Mix)[^"]*)"/) || [])[1];
        const vid = (s.match(/"watchEndpoint":\{"videoId":"([\w-]{11})"/) || [])[1];
        const n = badge && badge.match(/^([\d,]+) 本の動画$/);
        if (l.contentId && title) out.push({id: l.contentId, title: title, count: n ? n[1] : (badge || null), vid: vid || null});
        return;
      }
      for (const k in o) walk(o[k]);
    })(root);
    return out;
  }
  async function sha1(text) {
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(text));
    return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
  }
  async function fetchPlaylists() {
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
      body: JSON.stringify({
        context: {client: {clientName: 'WEB', clientVersion: WEB_CLIENT_VERSION, hl: 'ja', gl: 'JP'}},
        browseId: 'FEplaylist_aggregation'
      })
    });
    if (!r.ok) throw new Error('再生リストを読めませんでした（' + r.status + '）');
    const items = collect(await r.json());
    if (!items.length) throw new Error('再生リストが見つかりませんでした');
    return items;
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
  const sel = el('select', {title: '再生リスト'}, Object.assign({}, ctrl, {flex: '1', minWidth: '0', maxWidth: isMobile ? 'none' : '280px'}));
  const refreshBtn = el('button', {textContent: '⟳', title: '再生リストを取得し直す'}, ctrl);
  const foldBtn = el('button', {textContent: '▾', title: 'たたむ'}, ctrl);
  const optBtn = el('button', {textContent: '⚙', title: '設定'}, ctrl);
  const prevBtn = el('button', {textContent: '⏮︎', title: '前の動画'}, ctrl);
  const playBtn = el('button', {textContent: '▶︎', title: '再生 / 一時停止'}, ctrl);
  const nextBtn = el('button', {textContent: '⏭︎', title: '次の動画'}, ctrl);
  const resumeBtn = el('button', {textContent: '続きから', title: '前回の動画の続きから再生'}, ctrl);
  function checkbox(text, title) {
    const label = el('label', {title: title},
                     {display: 'flex', gap: '4px', alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap'});
    const box = el('input', {type: 'checkbox'});
    label.append(box, document.createTextNode(text));
    return [label, box];
  }
  const [resumeLabel, resumeBox] = checkbox('開いたら続きから', 'YouTube のトップを開いたら、前回の動画の続きから再生する');
  const [bgLabel, bgBox] = checkbox('裏で再生', '画面を消したり別のアプリに切り替えたりしても再生を続ける');
  const info = el('span', {}, {flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis',
                               whiteSpace: 'nowrap', color: '#aaa', fontSize: '12px', textAlign: 'right'});
  // 設定（⚙ で開く）
  const row3 = el('div', {}, {display: 'flex', gap: '14px', alignItems: 'center', flexWrap: 'wrap'});
  row1.append(sel, refreshBtn, optBtn, foldBtn);
  row2.append(prevBtn, playBtn, nextBtn, resumeBtn, info);
  // 版と、スクリプトが動いている場所（page / content）。うまく動かないときの手がかり
  const about = el('span', {textContent: 'v' + VERSION + ' · ' + MODE}, {color: '#888', fontSize: '12px', marginLeft: 'auto'});
  row3.append(resumeLabel, bgLabel, about);
  bar.append(row1, row2, row3);
  // たたんだときに出す小さなボタン
  const openBtn = el('button', {id: 'ytp-open', textContent: '♪', title: 'YT Player のバーを開く'},
                     Object.assign({}, ctrl, {position: 'fixed', zIndex: '2147483647', right: '10px',
                                              bottom: isMobile ? '60px' : '14px', opacity: '.85',
                                              boxShadow: '0 2px 8px rgba(0,0,0,.5)'}));

  let message = '';
  function showMessage(text, isError) {
    message = text || '';
    info.textContent = message;
    info.title = message;
    info.style.color = isError ? '#f88' : '#aaa';
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
      showMessage('');
    } catch (e) {
      showMessage(e.message, true);
    }
  }
  sel.addEventListener('change', () => {
    const id = sel.value;
    if (!id) return;
    settings.last_playlist = id;
    delete settings.last_url;
    delete settings.last_time;
    save();
    // watch?list=ID だけ（v= なし）だと再生されないので、先頭の動画から開く
    const p = (settings.playlists || []).find(x => x.id === id);
    location.href = p && p.vid ? '/watch?v=' + p.vid + '&list=' + id : '/playlist?list=' + id;
  });
  refreshBtn.addEventListener('click', refresh);
  foldBtn.addEventListener('click', () => { settings.collapsed = true; save(); applyFold(); });
  openBtn.addEventListener('click', () => { settings.collapsed = false; save(); applyFold(); });
  prevBtn.addEventListener('click', () => step(-1));
  nextBtn.addEventListener('click', () => step(1));
  playBtn.addEventListener('click', () => {
    const p = player();
    if (!p) return;
    if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
    setTimeout(tick, 300);
  });
  resumeBtn.addEventListener('click', () => { const u = resumeUrl(); if (u) location.href = u; });
  bgBox.addEventListener('change', () => { settings.bg = bgBox.checked; save(); });
  resumeBox.addEventListener('change', () => { settings.autoresume = resumeBox.checked; save(); });
  optBtn.addEventListener('click', () => { settings.showopts = !settings.showopts; save(); applyOpts(); });
  function applyOpts() { row3.style.display = settings.showopts ? 'flex' : 'none'; }

  // 前回の動画のページがそのまま開かれたとき、プレイヤーの準備ができたら前回の位置まで進める
  function seekToLast() {
    if (!resumeSeek) return;
    const started = Date.now();
    const timer = setInterval(() => {
      const p = player();
      if (Date.now() - started > 20000) { clearInterval(timer); resumeSeek = 0; return; }
      if (!p || !p.getDuration || !(p.getDuration() > 0)) return;
      if (p.getCurrentTime() < resumeSeek - 5) p.seekTo(resumeSeek, true);
      clearInterval(timer);
      resumeSeek = 0;
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
    const p = player();
    const watching = location.pathname.startsWith('/watch') && p;
    playBtn.textContent = watching && p.getPlayerState() === 1 ? '⏸︎' : '▶︎';
    resumeBtn.style.display = !watching && settings.last_url ? 'block' : 'none';
    const id = currentList();
    if (id && sel.value !== id && [...sel.options].some(o => o.value === id)) sel.value = id;
    if (!message) {
      if (watching) {
        const d = p.getDuration ? p.getDuration() : 0, t = p.getCurrentTime ? p.getCurrentTime() : 0;
        info.textContent = d > 0 ? fmt(t) + ' / ' + fmt(d) : (t ? fmt(t) : '');
      } else {
        info.textContent = 'v' + VERSION;
      }
    }
    // 再生中の URL と位置を覚える（「続きから」で使う）。YouTube は曲送りでページを読み直さないので URL を毎回見る。
    // 再生中のときだけ記録する。開いた直後（前回の位置へ進む前・自動再生が止められて始まっていないとき）に 0 秒で上書きしないため
    if (watching && id && !resumeSeek && p.getPlayerState() === 1 && Date.now() - lastSave > 5000) {
      lastSave = Date.now();
      settings.last_url = location.href;
      settings.last_time = Math.floor(p.getCurrentTime());
      save();
      setMediaSession();
    }
  }

  function start() {
    bgBox.checked = !!settings.bg;
    resumeBox.checked = settings.autoresume !== false;
    fill(settings.playlists, currentList() || settings.last_playlist);
    document.documentElement.append(bar, openBtn);
    applyFold();
    applyOpts();
    seekToLast();
    tick();
    setInterval(tick, 1000);
    // 前回の一覧をすぐ出し、裏で取り直して新しく作った・保存した再生リストも反映する
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
