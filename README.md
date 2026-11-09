# YT Player

Chrome を起動せずに、自分の YouTube アカウントで再生リストを流す Windows 用の小さなプレイヤー。
中身は WebView2（Edge のエンジン）で youtube.com をそのまま開いているだけなので、ログイン状態や Premium などのアカウント特典もそのまま使える。

![icon](ytplayer.png)

## 必要なもの

- Windows 10 / 11（WebView2 ランタイム。Windows 11 には最初から入っている）
- Python 3.10 以上

## 起動

```
pip install -r requirements.txt
python ytplayer.py
```

- 初回はウィンドウ内の YouTube で普通にログインする。ログインは `data/webview/` に残る。
- 右下の半透明のバー（マウスを乗せると濃くなる）：再生リストのプルダウン、⟳（取得し直す）、最前面。
- 最後に選んだ再生リスト、再生中の動画と位置（5 秒ごとに記録）、ウィンドウの位置は `data/settings.json` に保存され、次回起動時に前回の曲の続きから流れる。
- プレイヤー画面を**最小化**すると、再生を続けたまま**ミニプレイヤー**（再生リスト選択・前/再生・一時停止/次・再生中のタイトルと再生位置）になる。
  ミニプレイヤーの「画面」か最大化ボタンでプレイヤー画面に戻る。
- プレイヤー画面・ミニプレイヤーのどちらの × でもアプリが終了する。次回は終了した時の画面（プレイヤー画面なら最大化かどうかも）で起動する。
- 二重に起動すると、すでに開いているウィンドウが前面に出るだけ。

## 再生リストの一覧

プルダウンの一覧は、ログイン中のプレイヤーが YouTube の「再生リスト」ページ（`/feed/playlists`）を裏で読んで作る。
YouTube の画面と同じ並びで、保存した他の人の再生リスト・後で見る・ミックスリスト・ポッドキャスト・コースも入る
（YouTube Data API にはこれらを取る手段がない）。

ページの作りが変わって読めなくなったときは、YouTube Data API（自分が作った再生リストだけ）に切り替わる。これには下の設定が要る。

## バージョンとアイコン

- バージョンは `ytplayer.py` の `VERSION`。ウィンドウのタイトル（`YT Player v0.1` / `YT Player mini v0.1`）に出る。
  YouTube のページの作りに頼っている部分（一覧の読み取り、`#movie_player` の操作）が壊れたとき、どの版で動いていたか分かるようにするため。
- アイコンは `ytplayer.ico`（`python make_icon.py` で作り直せる）。タスクバーでは python.exe とは別のアプリとして表示される。

## playlist_tools/ — テキストから再生リストを作る

| スクリプト | 内容 |
|---|---|
| `add_titles.py` | テキストの YouTube URL を一行ずつ読み、動画タイトルをタブ区切りで行末に追記する（oEmbed を使うので設定不要） |
| `add_playlist.py` | テキストから自分のアカウントに再生リストを作る（Data API。下の設定が要る） |

テキストの書式（1 行目が再生リスト名）：

```
作業用BGMプレイリスト2026
https://www.youtube.com/watch?v=xxxxxxxxxxx	タイトル
https://youtu.be/yyyyyyyyyyy
```

```
python playlist_tools/add_titles.py  video.txt
python playlist_tools/add_playlist.py video.txt --dry-run
python playlist_tools/add_playlist.py video.txt               # 非公開で作成（--privacy unlisted / public）
```

- ファイルを省くと `playlist_tools/video.txt` を読む（`playlist_tools/*.txt` はコミットされない）。
- `add_playlist.py` は同じ名前の再生リストがすでにあれば、まだ入っていない動画だけを足す。途中で止まっても再実行で続きから入る。
- API の 1 日の上限（10,000）に対し、作成 50 + 動画 1 本につき 50 を使う。

## YouTube Data API の設定（Google Cloud・一度だけ）

`add_playlist.py` と、プレイヤーの一覧取得の予備で使う。

1. https://console.cloud.google.com/ でプロジェクトを作る（名前は何でもよい）。
2. 「API とサービス」→「ライブラリ」で **YouTube Data API v3** を有効にする。
3. Google Auth Platform（OAuth 同意画面）
   - ユーザーの種類：**外部**
   - アプリ名・メールアドレスを入れる
   - 「対象」→ テストユーザーに**自分の Google アカウント**を追加する（公開ステータスは「テスト」のままでよい。追加しないと「エラー 403: access_denied」になる）
4. 「クライアント」→ クライアントを作成 → 種類は **デスクトップ アプリ**（「AI 搭載エージェントに使用する」はチェックしない）。
5. JSON をダウンロードし、`client_secret.json` という名前でリポジトリ直下（`ytplayer.py` の隣）に置く。
6. 初回だけ既定のブラウザで許可画面が開く。「このアプリは Google で確認されていません」と出たら「続行」。
   許可はプレイヤーが `data/token.json`、`add_playlist.py` が `playlist_tools/token_playlist.json` に保存する。

- テスト状態のアプリは、許可が 7 日ほどで切れることがある。切れたらもう一度許可する。

## 秘密情報

`client_secret*.json`、`token*.json`、`data/`（ログイン情報・設定）はコミットしない（`.gitignore` 済み）。
