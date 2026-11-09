# YT Player プロジェクト ルール

Chrome を使わずに、自分の YouTube アカウントで再生リストを流す Windows 用プレイヤー（pywebview + WebView2）。
使い方は README.md。ここには作業するときに知っておくべきことを書く。

## 会話

- ユーザーとのやりとりは**すべて日本語**。返事、作業途中の短い報告、最後のまとめ欄（recap・質問・ボタン）、タスクの各項目も日本語にする。

## ファイル

- `ytplayer.py` — 本体。プレイヤー画面（youtube.com をそのまま表示）とミニプレイヤー（`MINI_HTML`）の 2 つのウィンドウ。
  ページ内のバーは `BAR_JS` を読み込み完了のたびに注入している。
- `playlist_tools/add_titles.py` — URL 一覧に oEmbed でタイトルを追記する。
- `playlist_tools/add_playlist.py` — テキストから Data API で再生リストを作る。
- `android/ytplayer.user.js` — Firefox（Android）用のユーザースクリプト版。youtube.com にバーを足す。使い方は `android/README.md`。
  一覧の取り方（内部 API）以外は本体と同じページの作りに頼っているので、本体側を直したらこちらも合わせる。バージョンは別（`@version` と `VERSION`）。
- `tools/cdp.py`, `tools/win.ps1` — 動作確認用（下の「動作確認」）。
- `make_icon.py` → `ytplayer.ico` / `ytplayer.png`。

## 秘密情報（絶対にコミットしない）

`client_secret*.json`、`token*.json`、`data/`（WebView2 のログイン情報・settings.json）、`playlist_tools/*.txt`（ユーザーの再生リスト）。
`.gitignore` 済みだが、コミット前に `git status --short --ignored` で確認する。

## バージョン

- `ytplayer.py` の `VERSION`（現在 0.1）がウィンドウタイトルに出る（`YT Player v0.1` / `YT Player mini v0.1`）。
- **YouTube のページに頼っている部分を変えたら VERSION を上げる。** 壊れたときにどの版で動いていたか分かるようにするため。
- タイトルを変えると `already_running()` と `tools/win.ps1` のウィンドウ検索に影響する（どちらも VERSION から作っている）。

## YouTube のページに頼っている部分（壊れやすい）

- **再生リストの一覧**は `/feed/playlists` を `fetch` して `ytInitialData` の `lockupViewModel` を読んでいる（`PAGE_PLAYLISTS_JS`）。
  Data API には「保存した再生リスト」「後で見る」「ミックスリスト」などを取る手段がない（`mine=true` / `channelId` では取れない）。
  読めないときは Data API の `playlists.list?mine=true` に切り替わる。最初の約 30 件しか読んでいない（続きは未対応）。
- **プレイヤー操作**は youtube.com の `#movie_player` 要素のメソッド（`playVideo` / `pauseVideo` / `nextVideo` / `previousVideo` / `getPlayerState` / `getCurrentTime` / `getDuration` / `getVideoData`）。
  公式 IFrame Player API と同じ名前だが、youtube.com 上で呼ぶのは文書化されていない使い方。`getVideoData` は IFrame API でも非公開。
- `watch?list=ID` だけ（`v=` なし）で開くと「この端末では利用できません」になる。必ず `watch?v=<先頭の動画>&list=ID` で開く。
  先頭の動画 ID はページの一覧（`vid`）から取る。なければ Data API の `playlistItems.list`。
- YouTube は曲送りでページを読み直さない（URL だけ書き換える）ので、pywebview の `get_current_url()` は 1 曲目のまま。
  再生位置はページから 5 秒ごとに `report_position` で受け取って保存している。
- youtube.com は Trusted Types を使うので、注入する JS で `innerHTML` は使えない。DOM を組み立てる。

## pywebview / WebView2 の注意点（実機で確認済み）

- `webview.start(private_mode=False, storage_path=...)` にしないとログインが残らない。
- **一度も表示していないページは動画の再生が保留される**（`hidden=True` でも `minimized=True` でも再生されない）。
  ミニプレイヤーの状態で起動するときは、プレイヤー画面を画面外（`OFFSCREEN`）に普通に表示し、再生が始まってから隠して元の位置へ戻している。
  一度表示したあとなら、隠しても再生は続く。
- `window.move()` は内部で `SWP_SHOWWINDOW` を使うので、隠したウィンドウが表示されてしまう。**移動してから隠す。**
- `create_window(maximized=True)` は位置指定と一緒だと効かない。表示後（`events.shown`）に `maximize()` する。
- `events.closing` のハンドラが `False` を返すと閉じるのを取り消せる。closing は UI スレッドで同期実行されるので、中で `evaluate_js` などを待つと固まる。重い処理はスレッドに出す。
- `evaluate_js` で Promise の結果を受け取るには `callback` が要る（`eval_js_async()`）。
- 同じユーザーデータフォルダで二重に起動すると、後から起動した側の WebView2 が初期化に失敗して固まる（0x8007139F）。`already_running()` で防いでいる。
- 音ありの自動再生は環境変数 `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--autoplay-policy=no-user-gesture-required` で許可している。
- タスクバーで python.exe と別扱いにするため `SetCurrentProcessExplicitAppUserModelID("jnaka.YTPlayer")` を呼んでいる。

## Data API / OAuth

- OAuth クライアントは「デスクトップ アプリ」、同意画面は「テスト」のまま。ユーザー本人をテストユーザーに追加しないと 403 access_denied。
- テスト状態の許可は 7 日ほどで切れることがある。
- プレイヤーは `youtube.readonly`（`data/token.json`）、`add_playlist.py` は `youtube`（`playlist_tools/token_playlist.json`）。
- 1 日 10,000 ユニット。`playlists.insert` / `playlistItems.insert` は 1 回 50。

## 動作確認

GUI アプリなので、調査用ポート付きで起動し、`tools/cdp.py` でページの中を、`tools/win.ps1` でウィンドウを操作して確かめる。
`pip install websocket-client` が要る。

```
# 起動（バックグラウンドで実行する）
cd C:/work/YT_Player && WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS="--autoplay-policy=no-user-gesture-required --remote-debugging-port=9333" python -u ytplayer.py

# 再生状態（プレイヤー画面）
python -I -X utf8 tools/cdp.py youtube "(()=>{const p=document.getElementById('movie_player'); return {state:p.getPlayerState(), t:p.getCurrentTime(), title:p.getVideoData().title}})()"

# ミニプレイヤーのボタンを押す
python -I -X utf8 tools/cdp.py about:blank "document.getElementById('next').click()"

# ウィンドウ操作と状態（status / minimize / maximize / restore / close、対象 main / mini）
powershell -NoProfile -ExecutionPolicy Bypass -File tools/win.ps1 minimize
```

- **ユーザーが YT Player を使っている最中のことが多い。** 起動中か確かめ（`Get-CimInstance Win32_Process` で `ytplayer` を含むもの）、閉じたり再生リストを切り替えたりするときはユーザーに伝える。
  再生リストを切り替えると前回の再生位置が失われる。テストのあとは元の再生リストに戻す。
- 動画が流れて音が出るテストをするときは、先にユーザーに伝える。
- 画面の見た目は PowerShell の `CopyFromScreen` でウィンドウを撮って確かめる（`SetProcessDPIAware()` を先に呼ぶ）。
- `python -I` は `PYTHON*` 環境変数を無視するので、日本語の出力には `-X utf8` を付ける。
- PowerShell 5.1 用スクリプトに日本語を含めるときは UTF-8（BOM 付き）で保存する。
