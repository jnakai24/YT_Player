"""YT Player - Chrome を使わずに自分の YouTube 再生リストを流す小さなプレイヤー。

- WebView2（pywebview）で youtube.com をそのまま開く。ログインは data/webview に残る。
- 画面右下のバーで自分の再生リストを選べる（YouTube Data API v3、要 client_secret.json）。
- 最後に選んだ再生リストとウィンドウ位置を settings.json に覚える。
- プレイヤー画面を最小化すると再生を続けたままミニプレイヤー（再生リスト・前/一時停止/次・タイトル）になる。
  ミニプレイヤーの「画面」で戻る。どちらの × でも終了し、次回はその時の画面（プレイヤー / ミニ）で起動する。
"""
import json
import os
import sys
import threading
import time
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

import webview

APP_DIR = Path(sys.executable).parent if getattr(sys, "frozen", False) else Path(__file__).parent
DATA_DIR = APP_DIR / "data"
WEBVIEW_DIR = DATA_DIR / "webview"
SETTINGS_FILE = DATA_DIR / "settings.json"
TOKEN_FILE = DATA_DIR / "token.json"
CLIENT_SECRET_FILE = APP_DIR / "client_secret.json"

SCOPES = ["https://www.googleapis.com/auth/youtube.readonly"]
VERSION = "0.1"  # YouTube のページの作りに頼っているので、どの版で動いていたか分かるようにタイトルに出す
MAIN_TITLE = f"YT Player v{VERSION}"
MINI_TITLE = f"YT Player mini v{VERSION}"
ICON_FILE = APP_DIR / "ytplayer.ico"
HOME_URL = "https://www.youtube.com/"
OFFSCREEN = -20000  # ミニ起動時にプレイヤー画面を一時的に置く座標
LIKED_ID = "LL"

# 音あり自動再生を許可（起動時に前回の再生リストを流すため）
os.environ.setdefault(
    "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS",
    "--autoplay-policy=no-user-gesture-required --disable-features=ElasticOverscroll",
)


def load_settings():
    try:
        return json.loads(SETTINGS_FILE.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_settings(settings):
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    SETTINGS_FILE.write_text(json.dumps(settings, ensure_ascii=False, indent=2), encoding="utf-8")


def resume_url(settings):
    """前回の動画を、止めた位置（t=秒）から開く URL。"""
    url = settings.get("last_url")
    if not url:
        return None
    parts = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k not in ("t", "pp")]
    seconds = int(settings.get("last_time") or 0)
    if seconds > 5:
        query.append(("t", f"{seconds}s"))
    return urlunparse(parts._replace(query=urlencode(query)))


def playlist_page_url(playlist_id):
    return f"https://www.youtube.com/playlist?list={playlist_id}"


def first_video_id(playlist_id):
    """再生リストの先頭の動画 ID。watch?list=ID だけでは YouTube が再生しないため。"""
    from google.auth.transport.requests import AuthorizedSession

    session = AuthorizedSession(get_credentials())
    r = session.get(
        "https://www.googleapis.com/youtube/v3/playlistItems",
        params={"part": "contentDetails", "playlistId": playlist_id, "maxResults": 1},
        timeout=15,
    )
    r.raise_for_status()
    items = r.json().get("items", [])
    return items[0]["contentDetails"]["videoId"] if items else None


def playlist_start_url(playlist_id):
    """先頭から再生する URL。取れなければ再生リストのページ。"""
    if not TOKEN_FILE.exists():  # 起動時に許可画面を出さない
        return playlist_page_url(playlist_id)
    try:
        vid = first_video_id(playlist_id)
    except Exception:
        vid = None
    if vid:
        return f"https://www.youtube.com/watch?v={vid}&list={playlist_id}"
    return playlist_page_url(playlist_id)


def get_credentials():
    """保存済みトークンを使い、なければブラウザで一度だけ許可を取る。"""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if TOKEN_FILE.exists():
        try:
            creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
        except Exception:
            creds = None
    if creds and creds.valid:
        return creds
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
            TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
            return creds
        except Exception:
            creds = None
    if not CLIENT_SECRET_FILE.exists():
        raise RuntimeError("client_secret.json がありません（README の手順を参照）")
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRET_FILE), SCOPES)
    creds = flow.run_local_server(port=0, open_browser=True)
    DATA_DIR.mkdir(parents=True, exist_ok=True)
    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return creds


# YouTube の「再生リスト」ページ（/feed/playlists）をログイン中のページから裏で読み、画面と同じ一覧を返す。
# Data API には「保存した再生リスト」「後で見る」「ミックスリスト」などを取る手段がないため。
# 各項目の先頭の動画 ID（vid）も取れるので、再生開始に API が要らない。
PAGE_PLAYLISTS_JS = r"""
(async () => {
  const html = await (await fetch('/feed/playlists', {credentials: 'include'})).text();
  const m = html.match(/var ytInitialData = (\{.*?\});<\/script>/s);
  if (!m) throw new Error('再生リストのページを読めませんでした');
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
  })(JSON.parse(m[1]));
  return out;
})()
"""


def eval_js_async(window, script, timeout=20):
    """Promise を返す JS を実行して結果を待つ（pywebview は callback 経由でしか受け取れない）。"""
    done = threading.Event()
    box = {}

    def callback(result):
        box["result"] = result
        done.set()

    window.evaluate_js(script, callback=callback)
    if not done.wait(timeout):
        raise TimeoutError("ページからの応答がありません")
    result = box.get("result")
    if isinstance(result, str):
        result = json.loads(result)
    return result


def fetch_playlists_from_page(window):
    url = window.get_current_url() or ""
    if "youtube.com" not in url:
        raise RuntimeError("YouTube のページが開いていません")
    items = eval_js_async(window, PAGE_PLAYLISTS_JS)
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"再生リストを読み取れませんでした: {items!r}"[:200])
    return items


def fetch_playlists():
    """Data API で自分の再生リストを取る（ページから読めないときの予備）。"""
    from google.auth.transport.requests import AuthorizedSession

    session = AuthorizedSession(get_credentials())
    items = [{"id": LIKED_ID, "title": "高く評価した動画", "count": None}]
    page_token = None
    while True:
        params = {"part": "snippet,contentDetails", "mine": "true", "maxResults": 50}
        if page_token:
            params["pageToken"] = page_token
        r = session.get("https://www.googleapis.com/youtube/v3/playlists", params=params, timeout=15)
        r.raise_for_status()
        data = r.json()
        for it in data.get("items", []):
            items.append({
                "id": it["id"],
                "title": it["snippet"]["title"],
                "count": it.get("contentDetails", {}).get("itemCount"),
            })
        page_token = data.get("nextPageToken")
        if not page_token:
            break
    return items


class Api:
    """ページ内のバーから window.pywebview.api.* で呼ばれる。"""

    def __init__(self, settings):
        self._settings = settings
        self._window = None
        self._mini = None
        self._show_player = None  # main() が設定する（ミニ → プレイヤー画面）
        self._lock = threading.Lock()
        self._last_save = 0.0
        self._pl_ver = 0

    def get_state(self):
        return {
            "playlists": self._settings.get("playlists", []),
            "last": self._settings.get("last_playlist"),
            "on_top": bool(self._settings.get("on_top")),
            "has_secret": CLIENT_SECRET_FILE.exists(),
        }

    def refresh_playlists(self):
        with self._lock:
            try:
                # YouTube の画面と同じ一覧（保存した再生リスト等を含む）。だめなら Data API
                items = fetch_playlists_from_page(self._window)
            except Exception as page_error:
                print("page playlists failed:", page_error, flush=True)
                try:
                    items = fetch_playlists()
                except Exception as e:
                    return {"ok": False, "error": str(e)}
            self._settings["playlists"] = items
            self._pl_ver += 1
            save_settings(self._settings)
            return {"ok": True, "playlists": items}

    def select_playlist(self, playlist_id):
        """選んだ再生リストを覚え、先頭から再生する URL を返す。"""
        self._settings["last_playlist"] = playlist_id
        self._settings.pop("last_url", None)
        self._settings.pop("last_time", None)
        save_settings(self._settings)
        # ページから読んだ一覧には先頭の動画 ID があるので API なしで開ける（ミックス・後で見るも）
        for p in self._settings.get("playlists", []):
            if p.get("id") == playlist_id and p.get("vid"):
                return f"https://www.youtube.com/watch?v={p['vid']}&list={playlist_id}"
        return playlist_start_url(playlist_id)

    def report_position(self, url, seconds):
        """ページから数秒おきに届く再生中の URL と位置。次回起動時にここから再開する。
        YouTube は曲送りでページを読み直さないので、pywebview 側の URL は 1 曲目のまま変わらない。"""
        if "/watch?" not in (url or "") or "list=" not in url:
            return
        self._settings["last_url"] = url
        self._settings["last_time"] = int(seconds or 0)
        now = time.monotonic()
        if now - self._last_save > 30:
            self._last_save = now
            save_settings(self._settings)

    def set_on_top(self, on):
        self._settings["on_top"] = bool(on)
        save_settings(self._settings)
        if self._window:
            self._window.on_top = bool(on)

    # ---- ミニプレイヤーから使う（YouTube のプレイヤー #movie_player を JS で操作する） ----

    def _player_js(self, body):
        if not self._window:
            return None
        js = ("(() => { const p = document.getElementById('movie_player');"
              " if (!p || !p.getPlayerState) return null; " + body + " })()")
        try:
            return self._window.evaluate_js(js)
        except Exception:
            return None

    def player(self, action):
        body = {
            "prev": "p.previousVideo(); return true;",
            "next": "p.nextVideo(); return true;",
            "toggle": "if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo(); return true;",
        }.get(action)
        return self._player_js(body) if body else None

    def player_status(self):
        s = self._player_status()
        if isinstance(s, dict):
            s["pl_ver"] = self._pl_ver  # 一覧が更新されたらミニプレイヤーが取り直す
        return s

    def _player_status(self):
        # state: -1 未開始, 0 終了, 1 再生中, 2 一時停止, 3 読み込み中, 5 頭出し
        return self._player_js(
            "const d = p.getVideoData() || {}; let list = null;"
            " try { list = new URL(location.href).searchParams.get('list'); } catch (e) {}"
            " return {title: d.title || '', state: p.getPlayerState(), list: list,"
            " time: p.getCurrentTime ? p.getCurrentTime() : 0, duration: p.getDuration ? p.getDuration() : 0};")

    def play_playlist(self, playlist_id):
        if self._window:
            self._window.load_url(self.select_playlist(playlist_id))

    def show_player(self):
        if self._show_player:
            self._show_player()


# YouTube は Trusted Types を使うので innerHTML は使わず DOM を組み立てる
BAR_JS = r"""
(function () {
  if (document.getElementById('ytp-bar')) return;
  function el(tag, props, style) {
    const e = document.createElement(tag);
    Object.assign(e, props || {});
    Object.assign(e.style, style || {});
    return e;
  }
  const bar = el('div', {id: 'ytp-bar'}, {
    position: 'fixed', right: '12px', bottom: '12px', zIndex: '2147483647',
    display: 'flex', gap: '6px', alignItems: 'center',
    background: 'rgba(15,15,15,.88)', color: '#fff', padding: '6px 8px',
    borderRadius: '8px', font: '13px "Segoe UI", sans-serif',
    boxShadow: '0 2px 8px rgba(0,0,0,.5)', border: '1px solid #555',
    opacity: '.8', transition: 'opacity .2s'
  });
  bar.addEventListener('mouseenter', () => bar.style.opacity = '1');
  bar.addEventListener('mouseleave', () => bar.style.opacity = '.8');
  const ctrl = {background: '#272727', color: '#fff', border: '1px solid #444',
                borderRadius: '4px', padding: '3px 6px', font: 'inherit'};
  const sel = el('select', {title: '再生リスト'}, Object.assign({maxWidth: '280px'}, ctrl));
  const btn = el('button', {textContent: '⟳', title: '再生リストを取得し直す'},
                 Object.assign({cursor: 'pointer'}, ctrl));
  const topLabel = el('label', {title: '常に最前面'}, {display: 'flex', gap: '3px', alignItems: 'center', cursor: 'pointer'});
  const topBox = el('input', {type: 'checkbox'});
  topLabel.append(topBox, document.createTextNode('最前面'));
  const msg = el('span', {}, {color: '#f88', maxWidth: '260px', overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap'});
  bar.append(sel, btn, topLabel, msg);
  document.documentElement.appendChild(bar);

  function currentList() {
    try { return new URL(location.href).searchParams.get('list'); } catch (e) { return null; }
  }
  function fill(list, selected) {
    sel.replaceChildren(el('option', {value: '', textContent: '— 再生リスト —'}));
    for (const p of list || []) {
      const label = p.count == null ? p.title : p.title + ' (' + p.count + ')';
      sel.append(el('option', {value: p.id, textContent: label}));
    }
    sel.value = selected || '';
    if (sel.value !== (selected || '')) sel.value = '';
  }
  async function refresh() {
    msg.textContent = '取得中…';
    msg.style.color = '#aaa';
    const r = await window.pywebview.api.refresh_playlists();
    if (r.ok) { fill(r.playlists, currentList() || sel.value); msg.textContent = ''; }
    else { msg.textContent = r.error; msg.title = r.error; msg.style.color = '#f88'; }
  }
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    msg.textContent = '';
    location.href = await window.pywebview.api.select_playlist(sel.value);
  });
  btn.addEventListener('click', refresh);
  topBox.addEventListener('change', () => window.pywebview.api.set_on_top(topBox.checked));
  // 再生中の URL と位置を Python に送る（次回起動時にここから再開）
  setInterval(() => {
    const p = document.getElementById('movie_player');
    if (!location.pathname.startsWith('/watch') || !p || !p.getCurrentTime) return;
    window.pywebview.api.report_position(location.href, Math.floor(p.getCurrentTime()));
  }, 5000);
  // YouTube はページ内遷移なので URL の変化を見て選択を合わせる
  let lastUrl = location.href;
  setInterval(() => {
    if (location.href === lastUrl) return;
    lastUrl = location.href;
    const id = currentList();
    if (id && [...sel.options].some(o => o.value === id)) sel.value = id;
  }, 1000);

  async function init() {
    const s = await window.pywebview.api.get_state();
    topBox.checked = s.on_top;
    fill(s.playlists, currentList());
    // 前回の一覧をすぐ出し、裏で取り直して新しく作った・保存した再生リストも反映する
    refresh();
  }
  if (window.pywebview && window.pywebview.api) init();
  else window.addEventListener('pywebviewready', init, {once: true});
})();
"""


# プレイヤー画面を閉じたときに出す小さな操作ウィンドウ
MINI_HTML = r"""<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #0f0f0f; color: #fff;
               font: 13px "Segoe UI", "Yu Gothic UI", sans-serif; user-select: none; overflow: hidden; }
  .wrap { padding: 10px 12px; display: flex; flex-direction: column; gap: 8px; }
  .row { display: flex; gap: 6px; align-items: center; }
  select, button { background: #272727; color: #fff; border: 1px solid #444; border-radius: 4px;
                   font: inherit; padding: 4px 6px; }
  select { flex: 1; min-width: 0; }
  button { cursor: pointer; }
  button:hover { background: #3a3a3a; }
  .ctl button { font-size: 15px; width: 44px; }
  .spacer { flex: 1; }
  #title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ddd; }
  #time { color: #aaa; font-variant-numeric: tabular-nums; white-space: nowrap; }
  #msg { color: #f88; font-size: 12px; }
</style></head>
<body><div class="wrap">
  <div class="row">
    <select id="sel" title="再生リスト"></select>
    <button id="ref" title="再生リストを取得し直す">⟳</button>
  </div>
  <div class="row ctl">
    <button id="prev" title="前の動画">⏮&#xFE0E;</button>
    <button id="play" title="再生 / 一時停止">⏯&#xFE0E;</button>
    <button id="next" title="次の動画">⏭&#xFE0E;</button>
    <span class="spacer"></span>
    <button id="show" title="プレイヤー画面に戻す" style="width:auto">画面</button>
  </div>
  <div class="row"><div id="title">—</div><div id="time"></div></div>
  <div id="msg"></div>
</div>
<script>
  const $ = id => document.getElementById(id);
  let api, plVer = null;
  function fill(list, selected) {
    const sel = $('sel');
    sel.replaceChildren(new Option('— 再生リスト —', ''));
    for (const p of list || []) {
      sel.append(new Option(p.count == null ? p.title : p.title + ' (' + p.count + ')', p.id));
    }
    sel.value = selected || '';
    if (sel.value !== (selected || '')) sel.value = '';
  }
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }
  async function poll() {
    if (document.hidden) return;
    const s = await api.player_status();
    if (!s) { $('title').textContent = '—'; $('time').textContent = ''; $('play').textContent = '▶︎'; return; }
    // ライブ配信などは長さが 0 なので現在位置だけ出す
    $('time').textContent = s.duration > 0 ? fmt(s.time) + ' / ' + fmt(s.duration) : (s.time ? fmt(s.time) : '');
    $('title').textContent = s.title || '—';
    $('title').title = s.title || '';
    $('play').textContent = s.state === 1 ? '⏸︎' : '▶︎';
    if (s.pl_ver !== plVer) {
      plVer = s.pl_ver;
      fill((await api.get_state()).playlists, $('sel').value);
    }
    if (s.list && [...$('sel').options].some(o => o.value === s.list)) $('sel').value = s.list;
  }
  async function init() {
    api = window.pywebview.api;
    const st = await api.get_state();
    fill(st.playlists, st.last);
    $('prev').onclick = () => api.player('prev').then(poll);
    $('next').onclick = () => api.player('next').then(poll);
    $('play').onclick = () => api.player('toggle').then(() => setTimeout(poll, 300));
    $('show').onclick = () => api.show_player();
    $('sel').onchange = () => { if ($('sel').value) { $('title').textContent = '読み込み中…'; api.play_playlist($('sel').value); } };
    $('ref').onclick = async () => {
      $('msg').textContent = '';
      const r = await api.refresh_playlists();
      if (r.ok) fill(r.playlists, $('sel').value); else $('msg').textContent = r.error;
    };
    document.addEventListener('visibilitychange', poll);
    setInterval(poll, 1000);
    poll();
  }
  if (window.pywebview && window.pywebview.api) init();
  else window.addEventListener('pywebviewready', init, {once: true});
</script>
</body></html>
"""


def already_running():
    """二重起動すると後から起動した側の WebView2 が初期化に失敗して固まるので防ぐ。"""
    import ctypes

    kernel32 = ctypes.windll.kernel32
    kernel32.CreateMutexW(None, False, "Local\\YTPlayer_single_instance")
    if kernel32.GetLastError() == 183:  # ERROR_ALREADY_EXISTS
        user32 = ctypes.windll.user32
        # 表示中のほう（プレイヤー画面かミニプレイヤー）を前面に出す
        for title in (MAIN_TITLE, MINI_TITLE):
            hwnd = user32.FindWindowW(None, title)
            if hwnd and user32.IsWindowVisible(hwnd):
                user32.ShowWindow(hwnd, 9)  # SW_RESTORE
                user32.SetForegroundWindow(hwnd)
                break
        return True
    return False


def main():
    if already_running():
        return
    settings = load_settings()
    WEBVIEW_DIR.mkdir(parents=True, exist_ok=True)
    api = Api(settings)

    # 前回見ていた動画の続きから再開。なければ前回の再生リストの先頭、それもなければトップ
    last = settings.get("last_playlist")
    start_url = resume_url(settings) or (playlist_start_url(last) if last else HOME_URL)
    # 前回の画面状態で起動する: プレイヤー画面（通常 / 最大化）か、ミニプレイヤーか
    geom = dict(settings.get("window", {}))
    state = {
        "mode": "mini" if settings.get("mode") == "mini" else "player",
        "maximized": bool(geom.get("maximized")),
        "quitting": False,
    }
    window = webview.create_window(
        MAIN_TITLE,
        start_url,
        js_api=api,
        width=geom.get("width", 1100),
        height=geom.get("height", 700),
        # 一度も表示していないページは動画の再生が保留される（隠す・最小化で起動でもだめ）。
        # ミニ起動では画面外に普通に表示しておき、再生が始まってから隠して元の位置へ戻す。
        x=OFFSCREEN if state["mode"] == "mini" else geom.get("x"),
        y=OFFSCREEN if state["mode"] == "mini" else geom.get("y"),
        on_top=bool(settings.get("on_top")),
        background_color="#0F0F0F",
        text_select=True,
    )
    api._window = window

    def on_loaded():
        # Google のログイン画面などには出さない
        url = window.get_current_url() or ""
        print("loaded:", url, flush=True)
        if "youtube.com" in url:
            try:
                window.evaluate_js(BAR_JS)
            except Exception as e:
                print("bar inject failed:", e, flush=True)

    mini_geom = settings.get("mini", {})
    mini = webview.create_window(
        MINI_TITLE,
        html=MINI_HTML,
        js_api=api,
        width=mini_geom.get("width", 400),
        height=mini_geom.get("height", 170),
        x=mini_geom.get("x"),
        y=mini_geom.get("y"),
        min_size=(300, 150),
        hidden=state["mode"] != "mini",
        background_color="#0F0F0F",
    )
    api._mini = mini

    def win_state(w):
        """'Normal' / 'Maximized' / 'Minimized'（WinForms の WindowState）。"""
        try:
            return str(w.native.WindowState)
        except Exception:
            return ""

    # ---- 画面の切り替え: 最小化 → ミニプレイヤー、「画面」→ プレイヤー画面 ----

    def to_mini():
        state["mode"] = "mini"
        window.hide()
        mini.show()

    def to_player():
        state["mode"] = "player"
        mini.hide()
        window.show()
        # 最小化のまま隠していたので元の状態に戻す
        if state["maximized"]:
            window.maximize()
        else:
            window.restore()

    api._show_player = to_player

    def on_shown():
        # create_window(maximized=True) は位置指定と一緒だと効かないので、表示後に最大化する
        if state["mode"] == "mini":
            threading.Thread(target=hide_when_playing, daemon=True).start()
        elif state["maximized"]:
            window.maximize()

    def hide_when_playing():
        for _ in range(60):  # 最大 30 秒待つ
            s = api.player_status()
            if s and s.get("state") == 1:
                break
            time.sleep(0.5)
        # move() は内部で SWP_SHOWWINDOW を使い表示してしまうので、先に戻してから隠す
        window.move(geom.get("x", 100), geom.get("y", 100))
        if state["mode"] == "mini":
            window.hide()

    def on_minimized():
        if not state["quitting"] and state["mode"] == "player":
            to_mini()

    def on_maximized():
        state["maximized"] = True

    def on_restored():
        state["maximized"] = False

    # 通常表示のときの位置・大きさだけを覚える（最大化・最小化中の値は使わない）
    def on_resized(width, height):
        if win_state(window) == "Normal":
            geom["width"], geom["height"] = width, height

    def on_moved(x, y):
        if win_state(window) == "Normal" and x > OFFSCREEN / 2:
            geom["x"], geom["y"] = x, y

    def on_mini_maximized():
        # ミニプレイヤーの最大化ボタン → ミニは元の大きさに戻して隠し、プレイヤー画面に切り替える
        if state["quitting"]:
            return
        mini.restore()
        to_player()

    def on_mini_moved(x, y):
        if win_state(mini) == "Normal":
            settings["mini"] = dict(settings.get("mini", {}), x=x, y=y)

    def on_mini_resized(width, height):
        if win_state(mini) == "Normal":
            settings["mini"] = dict(settings.get("mini", {}), width=width, height=height)

    # ---- 終了: どちらの × でもアプリを終了し、その時の画面状態を保存する ----

    def quit_app(closing, other):
        if state["quitting"]:
            return
        state["quitting"] = True
        settings["mode"] = state["mode"]
        settings["window"] = {k: geom[k] for k in ("width", "height", "x", "y") if k in geom}
        settings["window"]["maximized"] = state["maximized"]
        save_settings(settings)  # 再生位置は report_position が随時 settings に入れている
        threading.Thread(target=other.destroy, daemon=True).start()

    window.events.loaded += on_loaded
    window.events.shown += on_shown
    window.events.minimized += on_minimized
    window.events.maximized += on_maximized
    window.events.restored += on_restored
    window.events.resized += on_resized
    window.events.moved += on_moved
    window.events.closing += lambda: quit_app(window, mini)
    mini.events.maximized += on_mini_maximized
    mini.events.moved += on_mini_moved
    mini.events.resized += on_mini_resized
    mini.events.closing += lambda: quit_app(mini, window)

    # python.exe のアイコン・グループにまとめられないよう、タスクバー用に独自の ID を付ける
    try:
        import ctypes
        ctypes.windll.shell32.SetCurrentProcessExplicitAppUserModelID("jnaka.YTPlayer")
    except Exception:
        pass

    webview.start(private_mode=False, storage_path=str(WEBVIEW_DIR), gui="edgechromium",
                  icon=str(ICON_FILE) if ICON_FILE.exists() else None)


if __name__ == "__main__":
    main()
