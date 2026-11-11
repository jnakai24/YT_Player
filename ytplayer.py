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
VERSION = "0.3"  # YouTube のページの作りに頼っているので、どの版で動いていたか分かるようにタイトルに出す
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


def resume_url(url, seconds):
    """動画を、止めた位置（t=秒）から開く URL。"""
    if not url:
        return None
    parts = urlparse(url)
    query = [(k, v) for k, v in parse_qsl(parts.query) if k not in ("t", "pp")]
    seconds = int(seconds or 0)
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
  const out = [], seen = new Set();
  // 再生リスト（lockupViewModel）を out に集め、続きを読むための合言葉（continuationItemRenderer の token）を返す
  function collect(root) {
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
  // 続きは YouTube の内部 API（/youtubei/v1/browse）に、ログイン中の Cookie と SAPISIDHASH を付けて問い合わせる
  async function more(token) {
    const cfg = window.ytcfg && window.ytcfg.get ? window.ytcfg : null;
    const context = (cfg && cfg.get('INNERTUBE_CONTEXT')) || {client: {
      clientName: 'WEB', clientVersion: (html.match(/"INNERTUBE_CLIENT_VERSION":"([^"]+)"/) || [])[1], hl: 'ja', gl: 'JP'}};
    const sid = (document.cookie.match(/(?:^|; )SAPISID=([^;]+)/) || document.cookie.match(/(?:^|; )__Secure-3PAPISID=([^;]+)/) || [])[1];
    if (!sid) throw new Error('ログイン情報を読めません');
    const ts = Math.floor(Date.now() / 1000);
    const buf = await crypto.subtle.digest('SHA-1', new TextEncoder().encode(ts + ' ' + sid + ' ' + location.origin));
    const hash = [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');
    const r = await fetch('/youtubei/v1/browse?prettyPrint=false', {
      method: 'POST', credentials: 'include',
      headers: {'Content-Type': 'application/json', 'Authorization': 'SAPISIDHASH ' + ts + '_' + hash,
                'X-Origin': location.origin, 'X-Goog-AuthUser': String((cfg && cfg.get('SESSION_INDEX')) || 0)},
      body: JSON.stringify({context: context, continuation: token})
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    return r.json();
  }
  let token = collect(JSON.parse(m[1])), pages = 0, warn = null;
  try {
    while (token && pages < 30) {
      const before = out.length;
      token = collect(await more(token));
      pages++;
      if (out.length === before) break;
    }
  } catch (e) {
    warn = String((e && e.message) || e);  // 続きが読めなくても、読めたところまでは使う
  }
  return {items: out, pages: pages, warn: warn};
})()
"""

# 自己診断：YouTube のページに頼っている部分が今も使えるかをページの中で確かめる。
# [項目, 結果(true / false / null = 確かめられない), 説明] の一覧を JSON で返す。
DIAG_JS = r"""
(() => {
  const out = [];
  const p = document.getElementById('movie_player');
  const watch = location.pathname.startsWith('/watch');
  let list = null;
  try { list = new URL(location.href).searchParams.get('list'); } catch (e) {}
  const login = /(^|; )(SAPISID|__Secure-3PAPISID)=/.test(document.cookie);
  out.push(['ログイン', login, login ? 'ログイン中' : 'YouTube にログインしていません']);
  if (!watch) {
    out.push(['プレイヤー', null, '動画を開いていないので確かめられません']);
  } else {
    const need = ['playVideo', 'pauseVideo', 'nextVideo', 'previousVideo', 'seekTo', 'getPlayerState',
                  'getCurrentTime', 'getDuration', 'getVideoData', 'getPlaylist', 'playVideoAt'];
    const miss = need.filter(n => !p || typeof p[n] !== 'function');
    out.push(['プレイヤー', !miss.length,
              !p ? '#movie_player が見つかりません' : miss.length ? '使えない操作: ' + miss.join(', ') : '操作 ' + need.length + ' 種類すべて使えます']);
    const d = p && p.getVideoData ? p.getVideoData() : null;
    out.push(['曲名', !!(d && d.title), d && d.title ? '取得できます' : 'getVideoData() から曲名を取れません']);
    if (!list) {
      out.push(['曲の一覧', null, '再生リストを再生していないので確かめられません']);
    } else if (!window.__ytp) {
      out.push(['曲の一覧', false, 'バーが動いていません']);
    } else {
      const it = window.__ytp.items();
      out.push(['曲の一覧', it.ids.length > 0,
                it.ids.length ? it.ids.length + ' 曲（' + (it.source === 'player' ? 'プレイヤーから' : 'ページの一覧から') + '）'
                              : '読めません（シャッフル・全曲リピートが効きません）']);
    }
  }
  return JSON.stringify(out);
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
    result = eval_js_async(window, PAGE_PLAYLISTS_JS, timeout=45)
    items = result.get("items") if isinstance(result, dict) else None
    if not isinstance(items, list) or not items:
        raise RuntimeError(f"再生リストを読み取れませんでした: {result!r}"[:200])
    return items, {"pages": result.get("pages") or 0, "warn": result.get("warn")}


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
        self._list_info = {}  # 一覧をどう取ったか（自己診断で出す）

    def get_state(self):
        return {
            "playlists": self._settings.get("playlists", []),
            "last": self._settings.get("last_playlist"),
            "on_top": bool(self._settings.get("on_top")),
            "has_secret": CLIENT_SECRET_FILE.exists(),
            "shuffle": bool(self._settings.get("shuffle")),
            "repeat": self._repeat(),
            "view": "app" if self._settings.get("view") == "app" else "youtube",
        }

    def set_view(self, view):
        """プレイヤー画面の見た目：'app'（自前の画面に動画を埋め込む）か 'youtube'（YouTube のページのまま）。"""
        self._settings["view"] = "app" if view == "app" else "youtube"
        save_settings(self._settings)

    def _repeat(self):
        r = self._settings.get("repeat")
        return r if r in ("all", "one") else "off"

    def refresh_playlists(self):
        with self._lock:
            warn = None
            try:
                # YouTube の画面と同じ一覧（保存した再生リスト等を含む）。だめなら Data API
                items, info = fetch_playlists_from_page(self._window)
                self._list_info = {"source": "page", "count": len(items), **info}
                if info["warn"]:
                    warn = f"一覧の続きを読めませんでした（{len(items)} 件まで）"
            except Exception as page_error:
                print("page playlists failed:", page_error, flush=True)
                try:
                    items = fetch_playlists()
                except Exception as e:
                    self._list_info = {"source": None, "page_error": str(page_error), "error": str(e)}
                    return {"ok": False, "error": str(e)}
                self._list_info = {"source": "api", "count": len(items), "page_error": str(page_error)}
                warn = "YouTube のページから一覧を読めず、Data API に切り替えました"
            self._settings["playlists"] = items
            self._pl_ver += 1
            save_settings(self._settings)
            return {"ok": True, "playlists": items, "warn": warn}

    def diagnose(self):
        """YouTube のページに頼っている部分が今も動くかを確かめる。lines は [項目, 結果(True/False/None), 説明]。"""
        lines = [["版", None, f"v{VERSION}"]]
        self.refresh_playlists()
        info = self._list_info
        if info.get("source") == "page":
            text = f"ページから {info['count']} 件（続きを {info['pages']} 回読み込み）"
            if info.get("warn"):
                lines.append(["再生リストの一覧", False, f"{text}。続きを読めません: {info['warn']}"])
            else:
                lines.append(["再生リストの一覧", True, text])
        elif info.get("source") == "api":
            lines.append(["再生リストの一覧", False,
                          f"ページから読めず Data API で {info['count']} 件（保存した再生リストなどは出ません）: {info['page_error']}"])
        else:
            lines.append(["再生リストの一覧", False, f"{info.get('page_error')} / Data API: {info.get('error')}"])
        try:
            page = self._window.evaluate_js(DIAG_JS)
            lines += json.loads(page) if isinstance(page, str) else page
        except Exception as e:
            lines.append(["ページ", False, f"ページの中を調べられません: {e}"])
        lines.append(["Data API（予備）", None,
                      ("client_secret.json あり" if CLIENT_SECRET_FILE.exists() else "client_secret.json なし")
                      + (" / 許可済み" if TOKEN_FILE.exists() else " / 未許可")])
        return {"ok": all(line[1] is not False for line in lines), "lines": lines}

    def select_playlist(self, playlist_id):
        """選んだ再生リストを覚え、前に聴いた位置（なければ先頭）から再生する URL を返す。"""
        self._settings["last_playlist"] = playlist_id
        pos = self._settings.get("positions", {}).get(playlist_id)
        if pos and pos.get("url"):
            self._settings["last_url"] = pos["url"]
            self._settings["last_time"] = pos.get("time", 0)
            save_settings(self._settings)
            return resume_url(pos["url"], pos.get("time"))
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
        # 再生リストごとにも覚える（別の再生リストから戻ってきたときに続きから流す）
        list_id = dict(parse_qsl(urlparse(url).query)).get("list")
        if list_id:
            positions = self._settings.setdefault("positions", {})
            positions[list_id] = {"url": url, "time": int(seconds or 0), "at": int(time.time())}
            if len(positions) > 200:  # 古いものから捨てる
                for old in sorted(positions, key=lambda k: positions[k].get("at", 0))[:len(positions) - 200]:
                    del positions[old]
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
            # シャッフル中はバー側（window.__ytp）が次の曲を選ぶ
            "prev": "if (window.__ytp) window.__ytp.step(-1); else p.previousVideo(); return true;",
            "next": "if (window.__ytp) window.__ytp.step(1); else p.nextVideo(); return true;",
            "toggle": "if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo(); return true;",
        }.get(action)
        return self._player_js(body) if body else None

    def player_status(self):
        s = self._player_status()
        if isinstance(s, dict):
            s["pl_ver"] = self._pl_ver  # 一覧が更新されたらミニプレイヤーが取り直す
            s["shuffle"] = bool(self._settings.get("shuffle"))
            s["repeat"] = self._repeat()
        return s

    def _player_status(self):
        # state: -1 未開始, 0 終了, 1 再生中, 2 一時停止, 3 読み込み中, 5 頭出し
        return self._player_js(
            "const d = p.getVideoData() || {}; let list = null;"
            " try { list = new URL(location.href).searchParams.get('list'); } catch (e) {}"
            " return {title: d.title || '', state: p.getPlayerState(), list: list,"
            " time: p.getCurrentTime ? p.getCurrentTime() : 0, duration: p.getDuration ? p.getDuration() : 0};")

    def set_play_mode(self, shuffle, repeat):
        """シャッフルとリピート（off / all / one）。実際に曲を選ぶのはページ内のバー（BAR_JS）。"""
        self._settings["shuffle"] = bool(shuffle)
        self._settings["repeat"] = repeat if repeat in ("all", "one") else "off"
        save_settings(self._settings)
        mode = {"shuffle": self._settings["shuffle"], "repeat": self._settings["repeat"]}
        if self._window:
            try:
                self._window.evaluate_js(f"window.__ytp && window.__ytp.setMode({json.dumps(mode)})")
            except Exception:
                pass
        return mode

    def play_playlist(self, playlist_id):
        if self._window:
            url = self.select_playlist(playlist_id)
            # ページ内のバーがあれば、ページを読み直さずに移る（BAR_JS の openWatch）
            try:
                if self._window.evaluate_js(f"!!(window.__ytp && window.__ytp.open && (window.__ytp.open({json.dumps(url)}), true))"):
                    return
            except Exception:
                pass
            self._window.load_url(url)

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
  const barCss = bar.style.cssText;
  bar.addEventListener('mouseenter', () => bar.style.opacity = '1');
  bar.addEventListener('mouseleave', () => { if (!viewOn) bar.style.opacity = '.8'; });
  const ctrl = {background: '#272727', color: '#fff', border: '1px solid #444',
                borderRadius: '4px', padding: '3px 6px', font: 'inherit'};
  const sel = el('select', {title: '再生リスト'}, Object.assign({maxWidth: '280px'}, ctrl));
  const btn = el('button', {textContent: '⟳', title: '再生リストを取得し直す'},
                 Object.assign({cursor: 'pointer'}, ctrl));
  const shuffleBtn = el('button', {textContent: '🔀︎'}, Object.assign({cursor: 'pointer'}, ctrl));
  const repeatBtn = el('button', {textContent: '🔁︎'}, Object.assign({cursor: 'pointer'}, ctrl));
  const diagBtn = el('button', {textContent: '診断', title: 'YouTube のページに頼っている部分が動いているか確かめる'},
                     Object.assign({cursor: 'pointer'}, ctrl));
  const topLabel = el('label', {title: '常に最前面'}, {display: 'flex', gap: '3px', alignItems: 'center', cursor: 'pointer'});
  const topBox = el('input', {type: 'checkbox'});
  topLabel.append(topBox, document.createTextNode('最前面'));
  const viewBtn = el('button', {}, Object.assign({cursor: 'pointer'}, ctrl));
  const msg = el('span', {}, {color: '#f88', maxWidth: '260px', overflow: 'hidden',
                              textOverflow: 'ellipsis', whiteSpace: 'nowrap'});
  bar.append(sel, btn, shuffleBtn, repeatBtn, topLabel, diagBtn, viewBtn, msg);
  document.documentElement.appendChild(bar);
  // 診断の結果（バーの上に出す）
  const diagBox = el('div', {id: 'ytp-diag'}, {
    position: 'fixed', right: '12px', bottom: '56px', zIndex: '2147483647', display: 'none',
    background: 'rgba(15,15,15,.95)', color: '#fff', padding: '8px 10px', borderRadius: '8px',
    font: '13px "Segoe UI", sans-serif', border: '1px solid #555', maxWidth: '520px', lineHeight: '1.6',
    boxShadow: '0 2px 8px rgba(0,0,0,.5)'
  });
  document.documentElement.appendChild(diagBox);

  function currentList() {
    try { return new URL(location.href).searchParams.get('list'); } catch (e) { return null; }
  }
  let playlists = [];
  function fill(list, selected) {
    playlists = list || [];
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
    if (r.ok) {
      fill(r.playlists, currentList() || sel.value);
      msg.textContent = r.warn ? '⚠ ' + r.warn : '';
      msg.title = r.warn || '';
      msg.style.color = '#fc6';
    } else { msg.textContent = r.error; msg.title = r.error; msg.style.color = '#f88'; }
  }

  // ---- シャッフル・リピート ----
  // YouTube のページのボタンには頼らず、曲の終わり（残り約 1 秒）で自分で次の曲へ移す。
  // 曲の一覧はプレイヤーが持っている（getPlaylist / playVideoAt）。なければページの一覧（ytd-playlist-panel-video-renderer）のリンクを押す。
  let mode = {shuffle: false, repeat: 'off'};
  let played = [], history = [], playedList = null, jumpedAt = 0;
  function player() {
    const p = document.getElementById('movie_player');
    return p && p.getPlayerState ? p : null;
  }
  function adShowing() {
    const b = document.getElementById('movie_player');
    return !!b && b.classList.contains('ad-showing');
  }
  function currentVideo() {
    try { return new URL(location.href).searchParams.get('v'); } catch (e) { return null; }
  }
  function items() {
    const p = player();
    const ids = p && p.getPlaylist ? p.getPlaylist() : null;
    if (ids && ids.length) return {source: 'player', ids: [...ids], go: i => p.playVideoAt(i)};
    const links = [...document.querySelectorAll('ytd-playlist-panel-video-renderer')]
      .map(item => item.querySelector('a[href*="/watch"]')).filter(Boolean);
    return {source: 'page', ids: links.map(a => new URL(a.href, location.href).searchParams.get('v')),
            go: i => links[i].click()};
  }
  function go(it, i) { jumpedAt = Date.now(); it.go(i); }
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
  function step(delta) {
    const p = player();
    if (!p) return;
    if (mode.shuffle && currentList()) {
      if (delta > 0) { if (jumpRandom()) return; }
      else if (history.length) {
        const it = items(), i = it.ids.indexOf(history.pop());
        if (i >= 0) { go(it, i); return; }
      }
    }
    if (delta > 0) p.nextVideo(); else p.previousVideo();
  }
  function checkEnd() {
    if (!mode.shuffle && mode.repeat === 'off') return;
    const p = player();
    if (!p || !location.pathname.startsWith('/watch') || adShowing() || Date.now() - jumpedAt < 3000) return;
    const d = p.getDuration(), t = p.getCurrentTime();
    if (!(d > 0) || p.getPlayerState() !== 1 || d - t > 1.2) return;
    if ((p.getVideoData() || {}).isLive) return;  // ライブ配信はいつも「終わりの直前」に見える
    if (mode.repeat === 'one') { jumpedAt = Date.now(); p.seekTo(0, true); return; }
    if (!currentList()) return;
    if (mode.shuffle) { jumpRandom(); return; }
    // 全曲リピート：最後の曲なら先頭へ。長い再生リストは一覧が途中までしか読み込まれていないことがあるので、本数と比べる
    const it = items(), i = it.ids.indexOf(currentVideo());
    const pl = playlists.find(x => x.id === currentList());
    const total = pl ? Number(String(pl.count).replace(/,/g, '')) : NaN;
    if (i >= 0 && i === it.ids.length - 1 && !(total > it.ids.length)) go(it, 0);
  }
  document.addEventListener('timeupdate', checkEnd, true);
  setInterval(checkEnd, 250);
  function paintMode() {
    const on = {background: '#3d5a80', borderColor: '#7fb2ff'}, off = {background: '#272727', borderColor: '#444'};
    Object.assign(shuffleBtn.style, mode.shuffle ? on : off);
    Object.assign(repeatBtn.style, mode.repeat !== 'off' ? on : off);
    shuffleBtn.title = 'シャッフル: ' + (mode.shuffle ? 'オン' : 'オフ');
    repeatBtn.textContent = mode.repeat === 'one' ? '🔂︎' : '🔁︎';
    repeatBtn.title = 'リピート: ' + ({off: 'オフ', all: '再生リスト全体', one: '1 曲'})[mode.repeat];
  }
  function setMode(m) { mode = {shuffle: !!m.shuffle, repeat: m.repeat || 'off'}; paintMode(); }
  window.__ytp = {step: step, items: items, setMode: setMode, open: url => openWatch(url)};
  shuffleBtn.addEventListener('click', () => {
    setMode({shuffle: !mode.shuffle, repeat: mode.repeat});
    window.pywebview.api.set_play_mode(mode.shuffle, mode.repeat);
  });
  repeatBtn.addEventListener('click', () => {
    setMode({shuffle: mode.shuffle, repeat: ({off: 'all', all: 'one', one: 'off'})[mode.repeat]});
    window.pywebview.api.set_play_mode(mode.shuffle, mode.repeat);
  });
  paintMode();
  diagBtn.addEventListener('click', async () => {
    if (diagBox.style.display !== 'none') { diagBox.style.display = 'none'; return; }
    diagBox.replaceChildren(document.createTextNode('確かめています…'));
    diagBox.style.display = 'block';
    const r = await window.pywebview.api.diagnose();
    diagBox.replaceChildren();
    for (const [name, ok, text] of r.lines) {
      const line = el('div');
      line.append(el('span', {textContent: ok === true ? '✓ ' : ok === false ? '✗ ' : '– '},
                     {color: ok === true ? '#7d7' : ok === false ? '#f88' : '#aaa'}),
                  el('b', {textContent: name + '  '}),
                  el('span', {textContent: text || ''}, {color: ok === false ? '#f88' : '#ccc'}));
      diagBox.append(line);
    }
    if (r.ok) msg.textContent = '';
  });
  // 再生リストの切り替えは、ページを読み直さず YouTube のページ内の移動（ytd-app に yt-navigate）で行う。
  // 読み直すと、その間 YouTube のページが見えて、アプリの画面がちらつくため。プレイヤーの要素もそのまま残る。
  // 動画のページにいないとき・3 秒たっても移れていないときは、今までどおり読み直す。
  function openWatch(url) {
    try {
      const u = new URL(url, location.href);
      const v = u.searchParams.get('v'), list = u.searchParams.get('list');
      const app = document.querySelector('ytd-app');
      if (u.pathname === '/watch' && v && app && location.pathname === '/watch') {
        const t = parseInt(u.searchParams.get('t') || '0', 10);
        const we = {videoId: v};
        if (list) we.playlistId = list;
        if (t > 0) we.startTimeSeconds = t;
        app.dispatchEvent(new CustomEvent('yt-navigate', {bubbles: true, composed: true, detail: {endpoint: {
          commandMetadata: {webCommandMetadata: {url: u.pathname + u.search, webPageType: 'WEB_PAGE_TYPE_WATCH', rootVe: 3832}},
          watchEndpoint: we}}}));
        setTimeout(() => { if (currentList() !== list || currentVideo() !== v) location.href = url; }, 3000);
        return;
      }
    } catch (e) {}
    location.href = url;
  }
  sel.addEventListener('change', async () => {
    if (!sel.value) return;
    msg.textContent = '';
    openWatch(await window.pywebview.api.select_playlist(sel.value));
  });
  btn.addEventListener('click', refresh);
  topBox.addEventListener('change', () => window.pywebview.api.set_on_top(topBox.checked));
  // 再生中の URL と位置を Python に送る（次回起動時にここから再開）
  setInterval(() => {
    const p = document.getElementById('movie_player');
    if (!location.pathname.startsWith('/watch') || !p || !p.getCurrentTime || adShowing()) return;
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

  // ---- アプリの画面（v0.3）----
  // YouTube のページを自前の画面（#ytp-view）で覆い、動画だけを枠（slot）に重ねて見せる。
  // プレイヤー要素（#movie_player）はページから動かさない（動かすと YouTube 側が壊れやすい）。
  // position: fixed で枠の位置・大きさにし、resize の知らせを送ると、プレイヤーが動画をその大きさで描き直す（実機で確認）。
  // YouTube のページに戻すときは、付けた style を外して resize を送る。動画のページ（/watch）以外では覆わない。
  const view = el('div', {id: 'ytp-view'}, {
    position: 'fixed', inset: '0', zIndex: '2147483000', background: '#0f0f0f', color: '#fff',
    display: 'none', flexDirection: 'column', font: '14px "Segoe UI", "Yu Gothic UI", sans-serif', userSelect: 'none'
  });
  const vMain = el('div', {}, {flex: '1', display: 'flex', gap: '12px', minHeight: '0', padding: '12px 12px 0'});
  const slot = el('div', {}, {flex: '1', minWidth: '0', background: '#000', borderRadius: '8px'});
  const side = el('div', {}, {width: '360px', display: 'flex', flexDirection: 'column', minHeight: '0',
                              background: '#181818', borderRadius: '8px', overflow: 'hidden'});
  const sideHead = el('div', {}, {padding: '10px 12px', color: '#aaa', fontSize: '12px', borderBottom: '1px solid #2a2a2a',
                                  whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'});
  const listBox = el('div', {}, {flex: '1', overflowY: 'auto'});
  side.append(sideHead, listBox);
  vMain.append(slot, side);
  const vFoot = el('div', {}, {padding: '10px 16px 12px', display: 'flex', flexDirection: 'column', gap: '6px'});
  const vTitle = el('div', {}, {fontSize: '18px', fontWeight: '600', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'});
  const seek = el('input', {type: 'range', min: '0', max: '1000', value: '0', title: '再生位置'},
                  {width: '100%', margin: '0', accentColor: '#f33', cursor: 'pointer'});
  const vRow = el('div', {}, {display: 'flex', alignItems: 'center', gap: '8px', minWidth: '0'});
  const bigBtn = Object.assign({}, ctrl, {cursor: 'pointer', fontSize: '18px', width: '44px', height: '36px', padding: '0'});
  const vPrev = el('button', {textContent: '⏮︎', title: '前の曲'}, bigBtn);
  const vPlay = el('button', {textContent: '▶︎', title: '再生 / 一時停止'}, bigBtn);
  const vNext = el('button', {textContent: '⏭︎', title: '次の曲'}, bigBtn);
  const vTime = el('span', {}, {color: '#aaa', fontVariantNumeric: 'tabular-nums', minWidth: '110px', marginLeft: '4px'});
  const barSlot = el('div', {}, {marginLeft: 'auto', display: 'flex', minWidth: '0'});
  vRow.append(vPrev, vPlay, vNext, vTime, barSlot);
  vFoot.append(vTitle, seek, vRow);
  view.append(vMain, vFoot);
  document.documentElement.appendChild(view);

  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = String(sec % 60).padStart(2, '0');
    return h ? h + ':' + String(m).padStart(2, '0') + ':' + s : m + ':' + s;
  }
  let viewOn = false, placed = '', seeking = false, listSig = '', shownCur = '';
  function paintViewBtn() {
    viewBtn.textContent = viewOn ? 'YouTube' : 'アプリ';
    viewBtn.title = viewOn ? 'YouTube のページの表示に戻す' : '動画と曲の一覧だけのアプリの画面にする';
  }
  // 覆いの表示・バーの置き場所・動画の位置を今の状態に合わせる（大きさが変わったとき・0.5 秒ごと）
  function place() {
    const mp = document.getElementById('movie_player');
    const show = viewOn && location.pathname.startsWith('/watch') && !!player();
    view.style.display = show ? 'flex' : 'none';
    side.style.display = innerWidth < 760 ? 'none' : 'flex';  // 狭いときは曲の一覧を出さない
    if (show && bar.parentNode !== barSlot) {
      barSlot.append(bar);
      Object.assign(bar.style, {position: 'static', opacity: '1', boxShadow: 'none', border: 'none',
                                background: 'transparent', padding: '0', minWidth: '0', flexWrap: 'wrap', justifyContent: 'flex-end'});
    } else if (!show && bar.parentNode === barSlot) {
      document.documentElement.appendChild(bar);
      bar.style.cssText = barCss;
    }
    // 覆っている間の CSS（下の viewCss）を効かせる
    document.documentElement.classList.toggle('ytp-app-view', show);
    if (!mp) return;
    if (show) {
      const r = slot.getBoundingClientRect();
      const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
      if (key !== placed || mp.style.position !== 'fixed') {
        placed = key;
        Object.assign(mp.style, {position: 'fixed', left: r.left + 'px', top: r.top + 'px',
                                 width: r.width + 'px', height: r.height + 'px', zIndex: '2147483001'});
        window.dispatchEvent(new Event('resize'));
      }
    } else if (placed) {
      placed = '';
      for (const k of ['position', 'left', 'top', 'width', 'height', 'zIndex']) mp.style[k] = '';
      window.dispatchEvent(new Event('resize'));
    }
  }
  // 覆っている間の CSS。
  // ・プレイヤーの親（#player-container）には YouTube が view-transition-name を付けている（曲送りのたびに名前を付け直す）。
  //   これがあるとその中が別の重なりの層になり、プレイヤーをいくら上にしても覆いの下に隠れる（実機で確認）。
  //   プレイヤーとその親すべて（:has）で外す。要素の style に書くと付け直されるたびに隠れるので CSS で、important 付きで。
  // ・ページをスクロールさせない（スクロールバーが残る・ホイールでページが動くため）
  const viewCss = el('style', {id: 'ytp-view-css', textContent:
    'html.ytp-app-view :has(#movie_player), html.ytp-app-view #movie_player { view-transition-name: none !important; }' +
    'html.ytp-app-view { overflow: hidden !important; }'});
  document.documentElement.appendChild(viewCss);
  // YouTube は曲送りで画面切り替えのアニメーション（document.startViewTransition）を使う。その間は画面全体が
  // 写真に置き換わって動画と曲の一覧がちらつくので、覆っている間はアニメーションせず、中身の書き換えだけをする。
  const origTransition = document.startViewTransition;
  if (typeof origTransition === 'function') {
    document.startViewTransition = function (arg) {
      if (!viewOn) return origTransition.apply(document, arguments);
      const update = typeof arg === 'function' ? arg : arg && arg.update;
      const done = Promise.resolve().then(() => update && update());
      const after = done.then(() => undefined);
      return {updateCallbackDone: after, ready: after, finished: after, skipTransition() {}, types: new Set()};
    };
  }
  // 曲名はページの一覧（ytd-playlist-panel-video-renderer）から取る。プレイヤーの一覧（getPlaylist）は ID だけ
  function panelTitles() {
    const titles = {};
    for (const r of document.querySelectorAll('ytd-playlist-panel-video-renderer')) {
      const a = r.querySelector('a[href*="/watch"]'), t = r.querySelector('#video-title');
      if (!a || !t) continue;
      try { titles[new URL(a.href, location.href).searchParams.get('v')] = t.textContent.trim(); } catch (e) {}
    }
    return titles;
  }
  // 曲送りの間は、ページの一覧が作り直されて曲名が取れない・プレイヤーの一覧が一瞬空になる。
  // 一覧を作り直すのは曲の並びが変わったときだけにし、曲名は覚えておいて、新しく分かったものだけ書き換える。
  const titleCache = {};
  function paintList(p, cur) {
    const ids = p.getPlaylist ? [...(p.getPlaylist() || [])] : [];
    if (!ids.length && listSig) return;
    const titles = Object.assign(titleCache, panelTitles());
    const sig = ids.join(',');
    if (sig === listSig) {
      for (const item of listBox.children) {
        const t = titles[item.dataset.v];
        if (t && item.title !== t) { item.title = t; item.lastChild.textContent = t; }
      }
    } else {
      listSig = sig;
      shownCur = '';
      listBox.replaceChildren(...ids.map((v, i) => {
        const item = el('div', {title: titles[v] || v}, {display: 'flex', gap: '10px', alignItems: 'center',
                                                          padding: '6px 10px', cursor: 'pointer'});
        item.dataset.v = v;
        const img = el('img', {src: 'https://i.ytimg.com/vi/' + v + '/mqdefault.jpg', loading: 'lazy'},
                       {width: '96px', height: '54px', objectFit: 'cover', borderRadius: '4px', flex: 'none', background: '#222'});
        const name = el('div', {textContent: titles[v] || v}, {fontSize: '13px', lineHeight: '1.35', overflow: 'hidden',
                                                               display: '-webkit-box', webkitLineClamp: '2', webkitBoxOrient: 'vertical'});
        item.append(el('span', {textContent: String(i + 1)}, {color: '#777', fontSize: '12px', width: '22px', textAlign: 'right', flex: 'none'}), img, name);
        item.addEventListener('mouseenter', () => { if (item.dataset.v !== shownCur) item.style.background = '#262626'; });
        item.addEventListener('mouseleave', () => { if (item.dataset.v !== shownCur) item.style.background = ''; });
        item.addEventListener('click', () => go({go: j => p.playVideoAt(j)}, i));
        return item;
      }));
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
    sideHead.textContent = (opt && opt.value ? opt.textContent : '再生リスト') + (ids.length ? '  ·  ' + (ids.indexOf(cur) + 1) + ' / ' + ids.length : '');
  }
  function paintView() {
    place();
    if (view.style.display === 'none') return;
    const p = player();
    const d = p.getVideoData() || {};
    vTitle.textContent = d.title || document.title.replace(/ - YouTube$/, '');
    const dur = p.getDuration() || 0, t = p.getCurrentTime() || 0;
    vTime.textContent = dur > 0 ? fmt(t) + ' / ' + fmt(dur) : fmt(t);
    if (!seeking) seek.value = dur > 0 ? String(Math.round(t / dur * 1000)) : '0';
    vPlay.textContent = p.getPlayerState() === 1 ? '⏸︎' : '▶︎';
    paintList(p, d.video_id || currentVideo());
  }
  seek.addEventListener('input', () => { seeking = true; });
  seek.addEventListener('change', () => {
    const p = player();
    if (p && p.getDuration() > 0) p.seekTo(Number(seek.value) / 1000 * p.getDuration(), true);
    seeking = false;
  });
  vPrev.addEventListener('click', () => step(-1));
  vNext.addEventListener('click', () => step(1));
  vPlay.addEventListener('click', () => {
    const p = player();
    if (p) { if (p.getPlayerState() === 1) p.pauseVideo(); else p.playVideo(); setTimeout(paintView, 200); }
  });
  viewBtn.addEventListener('click', () => {
    viewOn = !viewOn;
    paintViewBtn();
    paintView();
    window.pywebview.api.set_view(viewOn ? 'app' : 'youtube');
  });
  window.addEventListener('resize', place);
  setInterval(paintView, 500);
  paintViewBtn();

  async function init() {
    const s = await window.pywebview.api.get_state();
    topBox.checked = s.on_top;
    setMode(s);
    viewOn = s.view === 'app';
    paintViewBtn();
    paintView();
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
  .ctl button { font-size: 15px; width: 38px; padding: 4px 0; }
  button.on { background: #3d5a80; border-color: #7fb2ff; }
  .spacer { flex: 1; }
  #title { flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; color: #ddd; }
  #time { color: #aaa; font-variant-numeric: tabular-nums; white-space: nowrap; }
  #msg { color: #f88; font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
</style></head>
<body><div class="wrap">
  <div class="row">
    <select id="sel" title="再生リスト"></select>
    <button id="ref" title="再生リストを取得し直す">⟳</button>
    <button id="diag" title="YouTube のページに頼っている部分が動いているか確かめる">診断</button>
  </div>
  <div class="row ctl">
    <button id="prev" title="前の動画">⏮&#xFE0E;</button>
    <button id="play" title="再生 / 一時停止">⏯&#xFE0E;</button>
    <button id="next" title="次の動画">⏭&#xFE0E;</button>
    <button id="shuffle">🔀&#xFE0E;</button>
    <button id="repeat">🔁&#xFE0E;</button>
    <span class="spacer"></span>
    <button id="show" title="プレイヤー画面に戻す" style="width:auto">画面</button>
  </div>
  <div class="row"><div id="title">—</div><div id="time"></div></div>
  <div id="msg"></div>
</div>
<script>
  const $ = id => document.getElementById(id);
  let api, plVer = null, mode = {shuffle: false, repeat: 'off'};
  function paintMode(m) {
    mode = {shuffle: !!m.shuffle, repeat: m.repeat || 'off'};
    $('shuffle').classList.toggle('on', mode.shuffle);
    $('shuffle').title = 'シャッフル: ' + (mode.shuffle ? 'オン' : 'オフ');
    $('repeat').classList.toggle('on', mode.repeat !== 'off');
    $('repeat').textContent = mode.repeat === 'one' ? '🔂︎' : '🔁︎';
    $('repeat').title = 'リピート: ' + ({off: 'オフ', all: '再生リスト全体', one: '1 曲'})[mode.repeat];
  }
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
    if (s.shuffle !== mode.shuffle || s.repeat !== mode.repeat) paintMode(s);
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
    paintMode(st);
    $('shuffle').onclick = async () => paintMode(await api.set_play_mode(!mode.shuffle, mode.repeat));
    $('repeat').onclick = async () =>
      paintMode(await api.set_play_mode(mode.shuffle, ({off: 'all', all: 'one', one: 'off'})[mode.repeat]));
    $('diag').onclick = async () => {
      const msg = $('msg');
      msg.style.color = '#aaa';
      msg.textContent = '確かめています…';
      const r = await api.diagnose();
      const bad = r.lines.filter(l => l[1] === false);
      msg.style.color = bad.length ? '#f88' : '#7d7';
      msg.textContent = bad.length ? bad.map(l => '✗ ' + l[0] + ': ' + l[2]).join(' / ') : '✓ 診断: 問題は見つかりませんでした';
      msg.title = r.lines.map(l => (l[1] === true ? '✓ ' : l[1] === false ? '✗ ' : '– ') + l[0] + ': ' + l[2]).join('\n');
    };
    $('prev').onclick = () => api.player('prev').then(poll);
    $('next').onclick = () => api.player('next').then(poll);
    $('play').onclick = () => api.player('toggle').then(() => setTimeout(poll, 300));
    $('show').onclick = () => api.show_player();
    $('sel').onchange = () => { if ($('sel').value) { $('title').textContent = '読み込み中…'; api.play_playlist($('sel').value); } };
    $('ref').onclick = async () => {
      $('msg').textContent = '';
      const r = await api.refresh_playlists();
      $('msg').style.color = '#f88';
      if (r.ok) { fill(r.playlists, $('sel').value); $('msg').textContent = r.warn ? '⚠ ' + r.warn : ''; }
      else $('msg').textContent = r.error;
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
    start_url = resume_url(settings.get("last_url"), settings.get("last_time")) or (playlist_start_url(last) if last else HOME_URL)
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
