"""テキストの YouTube URL を一行ずつ読み、自分のアカウントに再生リストを作って追加する。

    python add_playlist.py                     # 同じフォルダの video.txt
    python add_playlist.py list.txt            # ファイルを指定
    python add_playlist.py --dry-run           # API を呼ばず、読み取り結果だけ表示
    python add_playlist.py --privacy unlisted  # 公開範囲（private / unlisted / public、既定は private）
    python add_playlist.py --title "名前"      # 再生リスト名を指定（既定はファイルの最初の URL でない行）

テキストの書式（add_titles.py で付けたタイトルはあってもなくてもよい）：
    作業用BGMプレイリスト2026
    https://www.youtube.com/watch?v=xxxxxxxxxxx<TAB>タイトル
    https://youtu.be/yyyyyyyyyyy

- 同じ名前の再生リストがすでに自分のアカウントにあれば、新しく作らずにそこへ「まだ入っていない動画だけ」を足す。
  途中で止まっても、もう一度実行すれば続きから入る。
- 同じ動画が複数行あっても 1 回だけ追加する。
- 認証は YT Player と同じ client_secret.json を使う（このフォルダ → リポジトリ直下の順に探す）。
  再生リストを書き換える権限が要るので、初回だけブラウザで許可する。許可は token_playlist.json に保存される。
- API の 1 日の上限（10,000）に対し、作成 50 + 動画 1 本につき 50 を使う。約 190 本で上限になる。
"""
import argparse
import re
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
SECRET_CANDIDATES = [HERE / "client_secret.json", HERE.parent / "client_secret.json"]
TOKEN_FILE = HERE / "token_playlist.json"
SCOPES = ["https://www.googleapis.com/auth/youtube"]
API = "https://www.googleapis.com/youtube/v3"

VIDEO_ID_RE = [
    re.compile(r"youtube\.com/watch\?(?:.*&)?v=([\w-]{11})"),
    re.compile(r"youtu\.be/([\w-]{11})"),
    re.compile(r"youtube\.com/(?:shorts|live|embed)/([\w-]{11})"),
]


def parse_file(path):
    """(再生リスト名, [(行番号, 動画ID, 表示名)], [警告]) を返す。"""
    title = None
    videos, warnings, seen = [], [], {}
    for no, line in enumerate(path.read_text(encoding="utf-8-sig").splitlines(), 1):
        line = line.strip()
        if not line:
            continue
        url, _, label = line.partition("\t")
        if not url.startswith("http"):
            if title is None:
                title = line
            else:
                warnings.append(f"{no}行目: URL ではないので無視しました: {line}")
            continue
        vid = next((m.group(1) for r in VIDEO_ID_RE if (m := r.search(url))), None)
        if not vid:
            warnings.append(f"{no}行目: 動画 ID が読み取れません: {url}")
            continue
        if vid in seen:
            warnings.append(f"{no}行目: {seen[vid]}行目と同じ動画なので 1 回だけ追加します")
            continue
        seen[vid] = no
        videos.append((no, vid, label.strip() or url))
    return title, videos, warnings


def get_session():
    from google.auth.transport.requests import AuthorizedSession, Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow

    creds = None
    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)
    if creds and creds.expired and creds.refresh_token:
        try:
            creds.refresh(Request())
        except Exception:
            creds = None
    if not creds or not creds.valid:
        secret = next((p for p in SECRET_CANDIDATES if p.exists()), None)
        if not secret:
            sys.exit("client_secret.json が見つかりません: " + " / ".join(map(str, SECRET_CANDIDATES)))
        print("ブラウザで Google の許可画面を開きます（再生リストの管理を許可してください）…")
        creds = InstalledAppFlow.from_client_secrets_file(str(secret), SCOPES).run_local_server(port=0)
    TOKEN_FILE.write_text(creds.to_json(), encoding="utf-8")
    return AuthorizedSession(creds)


class ApiError(Exception):
    def __init__(self, status, reason, message):
        super().__init__(f"HTTP {status} {reason}: {message}")
        self.status, self.reason = status, reason


def call(session, method, path, **kw):
    """API を呼ぶ。一時的なエラー（409 / 5xx）は少し待って最大 4 回やり直す。"""
    for attempt in range(4):
        r = session.request(method, API + path, timeout=30, **kw)
        if r.ok:
            return r.json()
        try:
            err = r.json()["error"]
            reason = (err.get("errors") or [{}])[0].get("reason", "")
            message = err.get("message", "")
        except Exception:
            reason, message = "", r.text[:200]
        if (r.status_code == 409 or r.status_code >= 500) and attempt < 3:
            time.sleep(2 ** attempt)
            continue
        raise ApiError(r.status_code, reason, message)


def find_playlist(session, title):
    page = None
    while True:
        params = {"part": "snippet", "mine": "true", "maxResults": 50}
        if page:
            params["pageToken"] = page
        data = call(session, "GET", "/playlists", params=params)
        for it in data.get("items", []):
            if it["snippet"]["title"] == title:
                return it["id"]
        page = data.get("nextPageToken")
        if not page:
            return None


def playlist_video_ids(session, playlist_id):
    ids, page = set(), None
    while True:
        params = {"part": "contentDetails", "playlistId": playlist_id, "maxResults": 50}
        if page:
            params["pageToken"] = page
        data = call(session, "GET", "/playlistItems", params=params)
        ids.update(it["contentDetails"]["videoId"] for it in data.get("items", []))
        page = data.get("nextPageToken")
        if not page:
            return ids


def main():
    ap = argparse.ArgumentParser(description="テキストの URL から YouTube の再生リストを作る")
    ap.add_argument("file", nargs="?", default=str(HERE / "video.txt"))
    ap.add_argument("--title", help="再生リスト名（既定はファイルの最初の URL でない行）")
    ap.add_argument("--privacy", choices=["private", "unlisted", "public"], default="private")
    ap.add_argument("--dry-run", action="store_true", help="API を呼ばず、読み取り結果だけ表示")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    title, videos, warnings = parse_file(Path(args.file))
    title = args.title or title
    for w in warnings:
        print("注意:", w)
    if not title:
        sys.exit("再生リスト名がありません。ファイルの 1 行目に書くか --title で指定してください。")
    if not videos:
        sys.exit("追加する動画がありません。")
    print(f"再生リスト「{title}」（{args.privacy}）に {len(videos)} 本")
    if args.dry_run:
        for no, vid, label in videos:
            print(f"  {no:>3}行目 {vid}  {label}")
        print("（--dry-run なので何もしていません）")
        return

    session = get_session()
    playlist_id = find_playlist(session, title)
    if playlist_id:
        existing = playlist_video_ids(session, playlist_id)
        print(f"同じ名前の再生リストがあるので、そこに足します（入っている動画 {len(existing)} 本）")
    else:
        body = {"snippet": {"title": title, "description": f"{Path(args.file).name} から作成"},
                "status": {"privacyStatus": args.privacy}}
        playlist_id = call(session, "POST", "/playlists", params={"part": "snippet,status"}, json=body)["id"]
        existing = set()
        print("再生リストを作りました")

    added = skipped = failed = 0
    for no, vid, label in videos:
        if vid in existing:
            skipped += 1
            continue
        body = {"snippet": {"playlistId": playlist_id,
                            "resourceId": {"kind": "youtube#video", "videoId": vid}}}
        try:
            call(session, "POST", "/playlistItems", params={"part": "snippet"}, json=body)
        except ApiError as e:
            if e.reason in ("quotaExceeded", "dailyLimitExceeded"):
                print(f"API の 1 日の上限に達しました。明日もう一度実行すると {no}行目から続きを追加します。")
                break
            print(f"  {no:>3}行目 追加できません（{e}）: {label}")
            failed += 1
            continue
        added += 1
        print(f"  {no:>3}行目 追加: {label}")

    print(f"\n追加 {added} 本、既にあった {skipped} 本、追加できず {failed} 本")
    print(f"https://www.youtube.com/playlist?list={playlist_id}")


if __name__ == "__main__":
    main()
