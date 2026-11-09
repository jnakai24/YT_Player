// ==UserScript==
// @name         YT Player (Firefox)
// @namespace    jnaka.ytplayer
// @version      0.1
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
  const VERSION = '0.1';
  // 一覧の取得は、スマホ版（MWEB）として問い合わせると空が返るので、パソコン版（WEB）として問い合わせる。
  // 古すぎると断られることがあるので、壊れたらパソコン版のページの ytcfg INNERTUBE_CLIENT_VERSION に合わせる。
  const WEB_CLIENT_VERSION = '2.20261105.05.01';
  const STORE = 'ytp-settings';

  // ---- 設定（youtube.com の localStorage に保存。この端末・このブラウザだけ） ----
  function load() {
    try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch (e) { return {}; }
  }
  const settings = load();
  function save() {
    try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (e) {}
  }

  // ---- 画面を消しても再生を続ける（「裏で再生」がオンのときだけ） ----
  // YouTube はページが見えなくなったこと（document.hidden / visibilitychange）を見て再生を止めるので、
  // ずっと見えていることにする。Premium の機能を回避する使い方なので、既定はオフ。
  // ページより先に仕込む必要があるため @run-at document-start。
  (function installBackground() {
    for (const type of ['visibilitychange', 'webkitvisibilitychange']) {
      window.addEventListener(type, e => { if (settings.bg) e.stopImmediatePropagation(); }, true);
      document.addEventListener(type, e => { if (settings.bg) e.stopImmediatePropagation(); }, true);
    }
    const proto = Document.prototype;
    for (const [prop, fake] of [['hidden', false], ['webkitHidden', false],
                                ['visibilityState', 'visible'], ['webkitVisibilityState', 'visible']]) {
      const orig = Object.getOwnPropertyDescriptor(proto, prop);
      if (!orig || !orig.get) continue;
      try {
        Object.defineProperty(document, prop, {
          configurable: true,
          get() { return settings.bg ? fake : orig.get.call(this); }
        });
      } catch (e) {}
    }
  })();

  function player() {
    const p = document.getElementById('movie_player');
    return p && p.getPlayerState ? p : null;
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
  const prevBtn = el('button', {textContent: '⏮︎', title: '前の動画'}, ctrl);
  const playBtn = el('button', {textContent: '▶︎', title: '再生 / 一時停止'}, ctrl);
  const nextBtn = el('button', {textContent: '⏭︎', title: '次の動画'}, ctrl);
  const resumeBtn = el('button', {textContent: '続きから', title: '前回の動画の続きから再生'}, ctrl);
  const bgLabel = el('label', {title: '画面を消したり別のアプリに切り替えたりしても再生を続ける'},
                     {display: 'flex', gap: '3px', alignItems: 'center', cursor: 'pointer', whiteSpace: 'nowrap'});
  const bgBox = el('input', {type: 'checkbox'});
  bgLabel.append(bgBox, document.createTextNode('裏で再生'));
  const info = el('span', {}, {flex: '1', minWidth: '0', overflow: 'hidden', textOverflow: 'ellipsis',
                               whiteSpace: 'nowrap', color: '#aaa', fontSize: '12px', textAlign: 'right'});
  row1.append(sel, refreshBtn, foldBtn);
  row2.append(prevBtn, playBtn, nextBtn, resumeBtn, info, bgLabel);
  bar.append(row1, row2);
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
  function resumeUrl() {
    if (!settings.last_url) return null;
    const u = new URL(settings.last_url);
    u.searchParams.delete('pp');
    u.searchParams.delete('t');
    if ((settings.last_time || 0) > 5) u.searchParams.set('t', settings.last_time + 's');
    return u.href;
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
  prevBtn.addEventListener('click', () => { const p = player(); if (p) p.previousVideo(); });
  nextBtn.addEventListener('click', () => { const p = player(); if (p) p.nextVideo(); });
  playBtn.addEventListener('click', () => {
    const p = player();
    if (!p) return;
    if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo();
    setTimeout(tick, 300);
  });
  resumeBtn.addEventListener('click', () => { const u = resumeUrl(); if (u) location.href = u; });
  bgBox.addEventListener('change', () => { settings.bg = bgBox.checked; save(); });

  // ロック画面・通知の「前へ」「次へ」も再生リストの曲送りにする
  function setMediaSession() {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.setActionHandler('previoustrack', () => { const p = player(); if (p) p.previousVideo(); });
      navigator.mediaSession.setActionHandler('nexttrack', () => { const p = player(); if (p) p.nextVideo(); });
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
    // 再生中の URL と位置を覚える（「続きから」で使う）。YouTube は曲送りでページを読み直さないので URL を毎回見る
    if (watching && id && Date.now() - lastSave > 5000) {
      lastSave = Date.now();
      settings.last_url = location.href;
      settings.last_time = Math.floor(p.getCurrentTime());
      save();
      setMediaSession();
    }
  }

  function start() {
    bgBox.checked = !!settings.bg;
    fill(settings.playlists, currentList() || settings.last_playlist);
    document.documentElement.append(bar, openBtn);
    applyFold();
    tick();
    setInterval(tick, 1000);
    // 前回の一覧をすぐ出し、裏で取り直して新しく作った・保存した再生リストも反映する
    refresh();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once: true});
  else start();
})();
