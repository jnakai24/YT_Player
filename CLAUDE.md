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
**GitHub のリポジトリ（jnakai24/YT_Player）は公開**（スマホに URL からスクリプトを入れるため）。push したものは誰でも見られる。

## バージョン

- `ytplayer.py` の `VERSION`（現在 0.3）がウィンドウタイトルに出る（`YT Player v0.3` / `YT Player mini v0.3`）。
- **YouTube のページに頼っている部分を変えたら VERSION を上げる。** 壊れたときにどの版で動いていたか分かるようにするため。
- タイトルを変えると `already_running()` と `tools/win.ps1` のウィンドウ検索に影響する（どちらも VERSION から作っている）。
- Firefox 版は `android/ytplayer.user.js` の `@version` と `VERSION`（現在 0.27）を**両方**上げる。
  Violentmonkey は `@version` が上がったときだけ更新を取り込む。版は ⚙ の行に `v0.27 · page` と出る。

## 今の状況（2026-11-11 時点。変わったら書き直す）

Windows 版 0.3、Firefox 版 0.27。どちらも main に push 済み（0.27 のアプリの画面と × は実機で未確認）。細かい仕組みと経緯は、下のそれぞれの節にある。

### 実機で確かめたこと

- **Windows 版 0.2**（YT Player）：再生リストごとの位置、シャッフル・リピート（1 曲 / 全体）、自己診断（すべて ✓）。
- **Firefox 版 0.25**（ユーザーの Android、Firefox の www.youtube.com）：
  - 「このリストを保存」で 56 曲中 54 曲を保存（残り 2 曲はメニューに「オフライン」が出ない曲）。
  - 「オフライン優先」で保存分の側へ開き直し、「保存分 54/56」と出る。タイトルは保存分で緑、通信で白。
  - **通信量**：オフライン優先オンは 4 分以上流して動画データの通信 0、オフは約 6 分・3 曲で約 41 MB（目的の「通信量の節約」は達成）。
  - 自動再生（www.youtube.com の自動再生を Firefox で「音声と動画を許可」にしたあと）、「続きから」、通知からの ⏮ ⏯ ⏭。
  - バーの大きさと位置（縦・横とも「ばっちり」とのこと）、線の絵のボタン。

### まだ確かめられていないこと

- **画面を消したまま、曲が次へ続くか**（0.25 の直し。PC では再現できない）。止まると Firefox の再生まわりが固まることがあり、
  そのときは Firefox を完全に終了して開き直すと戻る（実機で確認）。
- **0.26 の見張り**：0.25 の実機で、保存分の側・ページが見えない間に曲の終わりで `playVideoAt` したら、前の曲の最後（4:02）のまま
  状態 3（video に src なし）で止まり、画面を点けても戻らなかった。前面でも保存分の曲が読み込み中のまま始まらないことがあった。
  移ってから（開いた直後は 20 秒、曲送りは 10 秒）流れ始めなければ、もう一度移る → ページを開き直す（タブで 3 回まで。`checkMove()`）。
  PC で曲送りを空振りさせて開き直しまで動くことは確認。実機の、裏での止まり方に効くか（開き直した先が裏で鳴るか）は未確認。
- **保存していない曲のところで通信する側へ開き直す流れ**（0.21）は PC の YT Player で確認したが、スマホでは未確認。
- **「PC 版で開く」**（0.17）で、Firefox の「デスクトップ サイト」なしでもパソコン版に移れるか・そこでオフライン保存が使えるか。
- **一覧の 30 件より先**：ユーザーの再生リストは 19 件で、続きを読む処理が一度も動いていない（内部 API への問い合わせ自体は通る）。

### 気になっている点・やり残し

- **曲の切り替わりがスムーズでないことがある**（ユーザーの指摘。未対応）。心当たりは、終わりの約 1 秒（裏では最大 5 秒）を切っていること、
  保存分 ↔ 通信の切り替わりでページを開き直すこと、2 周目以降に一瞬途中から鳴ってから頭出しすること。どの場面かを聞いてから直す。
- **記録（`log()`）がかなり細かい**。調査用に増やしたもの。落ち着いたら減らしてよい（減らすときも、曲の移動・開き直し・エラーは残す）。
- **Windows 版にはオフライン保存の機能がない**（YT Player でも保存と保存分の再生ができることは確認済み）。頼まれたら入れる。
- Data API を使う案（再生リストのバックアップ、高評価ボタンなど）は話しただけで、作っていない。Firefox 版は OAuth を持たないので Windows 版だけの話。
- 圏外・機内モードで聴き始めることは**目標にしない**（ユーザーの判断。ページ自体が開けないため）。

### 進め方で分かったこと

- **Firefox 版は、push する前に PC の YT Player で動かして確かめる**（やり方は「オフライン保存」の節）。0.14 は構文と起動だけ確かめて push し、
  保存済みの曲を消してしまった。構文チェック（Edge のヘッドレス実行で `new Function`）と、空のページでの起動確認だけでは、ページの作りに頼る部分の誤りは見つからない。
  見た目（バーの大きさなど）とスマホだけの動き（自動再生、画面を消したとき）は PC では確かめられないので、そう伝えたうえで実機で見てもらう。
- **実機の調査は「記録をコピー」を貼ってもらう**（ユーザーの提案で入れた）。スクリーンショットより確実で、原因がほぼ毎回これで分かった。
- スマホで試してもらうには main への push が要る（Violentmonkey が main の raw を取りに行く）。**push はユーザーに頼まれてから**。
  `@version` を上げないと更新が取り込まれない。
- スマホ版（m.youtube.com）とパソコン版の表示（www.youtube.com）は、Firefox の中では別のサイト。localStorage も、自動再生などの許可も別。

## YouTube のページに頼っている部分（壊れやすい）

- **再生リストの一覧**は `/feed/playlists` を `fetch` して `ytInitialData` の `lockupViewModel` を読んでいる（`PAGE_PLAYLISTS_JS`）。
  Data API には「保存した再生リスト」「後で見る」「ミックスリスト」などを取る手段がない（`mine=true` / `channelId` では取れない）。
  読めないときは Data API の `playlists.list?mine=true` に切り替わる。
- **一覧の続き**（最初の約 30 件より先）は、一覧の末尾の `continuationItemRenderer` にある token を、内部 API `/youtubei/v1/browse` に
  `{context, continuation: token}` で POST して読む（`Authorization: SAPISIDHASH …` が要る。context は `ytcfg.get('INNERTUBE_CONTEXT')`）。
  絞り込みのボタンにも `continuationCommand` があるので、`continuationItemRenderer` の中だけを見る。続きが読めなくても読めたところまでは使う（バーに ⚠ が出る）。
- **シャッフル・リピート**は YouTube のページのボタンを使わず、自前でやる（`checkEnd()`）。曲の終わりの 1.2 秒前（`timeupdate` と 250ms のタイマー）に、
  `seekTo(0)`（1 曲リピート）か、別の曲へ移る。曲の一覧は `#movie_player` の `getPlaylist()`、移動は `playVideoAt(i)`。
  プレイヤーが一覧を持たないとき（スマホ版）はページの一覧（`ytm-` / `ytd-playlist-panel-video-renderer`）のリンクを押す。
  広告の間（`ad-showing`）とライブ配信（`getVideoData().isLive`）では何もしない。モードは Python の settings（`shuffle` / `repeat`）にあり、
  ミニプレイヤーからは `set_play_mode` → `window.__ytp.setMode()` でページに伝える。ミニの ⏮ ⏭ も `window.__ytp.step()` を通る。
- **自己診断**（バー・ミニの「診断」、Firefox 版は ⚙ の中）：上の頼っている部分が使えるかを確かめる（`Api.diagnose()` / `DIAG_JS`、Firefox 版は `diagnose()`）。
  頼る部分を増やしたら、診断の項目にも足す。
- **再生リストごとの位置**：settings の `positions[再生リスト ID] = {url, time, at}`（Firefox 版は localStorage `ytp-settings` の同じ名前）。
  再生リストを選ぶと、あればその続きから開く。200 件（Firefox 版は 100 件）を超えたら古いものから捨てる。
- **プレイヤー操作**は youtube.com の `#movie_player` 要素のメソッド（`playVideo` / `pauseVideo` / `nextVideo` / `previousVideo` / `getPlayerState` / `getCurrentTime` / `getDuration` / `getVideoData`）。
  公式 IFrame Player API と同じ名前だが、youtube.com 上で呼ぶのは文書化されていない使い方。`getVideoData` は IFrame API でも非公開。
- `watch?list=ID` だけ（`v=` なし）で開くと「この端末では利用できません」になる。必ず `watch?v=<先頭の動画>&list=ID` で開く。
  先頭の動画 ID はページの一覧（`vid`）から取る。なければ Data API の `playlistItems.list`。
- YouTube は曲送りでページを読み直さない（URL だけ書き換える）ので、pywebview の `get_current_url()` は 1 曲目のまま。
  再生位置はページから 5 秒ごとに `report_position` で受け取って保存している。
- youtube.com は Trusted Types を使うので、注入する JS で `innerHTML` は使えない。DOM を組み立てる。

- **アプリの画面**（Windows 版 0.3。バーの「アプリ」/「YouTube」で切り替え、settings の `view`）：YouTube のページを `#ytp-view` で覆い、
  `#movie_player` を `position: fixed` で枠（slot）の位置・大きさにして `resize` を送る（プレイヤーが動画をその大きさで描き直す）。要素は動かさない。
  **`#player-container` に YouTube が `view-transition-name` を付けていて、そのままだとプレイヤーが覆いの下に隠れる**。曲送りのたびに名前を付け直すので、
  要素の style ではなく CSS（`html.ytp-app-view :has(#movie_player)` に `none !important`）で外す。
  また YouTube は曲送りで `document.startViewTransition` を使い、その間は画面全体が写真に置き換わってちらつくので、覆っている間はアニメーションなしで中身だけ書き換える。
  曲の一覧は、曲送りの間に曲名が取れない・`getPlaylist()` が一瞬空になるので、並びが変わったときだけ作り直す（曲名は覚えておく）。曲名はページの一覧（`ytd-playlist-panel-video-renderer`）、サムネイルは `i.ytimg.com/vi/ID/mqdefault.jpg`。
  **再生リストの切り替え**（バー・ミニとも）はページを読み直さず、`ytd-app` に `yt-navigate`（`watchEndpoint` に videoId / playlistId / startTimeSeconds）を送る（`openWatch()`）。
  読み直すと YouTube のページが見えてちらつくため。3 秒たっても移れていなければ読み直す。ミニからは `window.__ytp.open(url)`、なければ `load_url`。
  覆っている間は本体のバーを画面の下に組み込み、ページのスクロールを止める。動画のページ以外では覆わない。Firefox 版にはまだない。

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

## Firefox（Android）版の注意点（実機で確認済み）

スマホの Firefox ＋ Violentmonkey で m.youtube.com に入れるユーザースクリプト。インストール URL は
`https://raw.githubusercontent.com/jnakai24/YT_Player/main/android/ytplayer.user.js`（push 後、反映に数分かかることがある）。

- **再生リストの一覧**：m.youtube.com からは www の `/feed/playlists` を読めない（別オリジン）。
  YouTube の内部 API `/youtubei/v1/browse`（`browseId: FEplaylist_aggregation`）に Cookie と `Authorization: SAPISIDHASH …` を付けて POST する。
  `clientName` は **`WEB`** にする（`MWEB` だと中身が空）。`WEB_CLIENT_VERSION` が古すぎると断られるので、そのときは www の `ytcfg.get('INNERTUBE_CLIENT_VERSION')` に合わせる。
  結果の `lockupViewModel` の読み方は本体の `PAGE_PLAYLISTS_JS` と同じ（結果が一致することを確認済み）。
- **曲送り**：m.youtube.com のプレイヤーは再生リストを持たない（`getPlaylist()` が空で `nextVideo()` が空振りする）。
  ページ側の一覧 `ytm-playlist-panel-video-renderer` から今の動画（`v=`）の前後を探してリンクをクリックする（`step()`）。
  一覧は開いた直後や広告の間はまだないので、押された操作を覚えて最大 10 秒待つ（`tryStep()`）。www ではプレイヤーが再生リストを持つので `nextVideo()` を使う。
- **自動再生**：スマホ版 YouTube は、Firefox で自動再生を許可していても開いただけでは再生しない。
  スクリプトが開くページ（開いたら続きから・動画を見ていないときの ▶・再生リストを選んだとき）は、開く前に sessionStorage `ytp-play` に進める秒数を入れ、開いた先で `startPlayback()` が `playVideo()` する。
- **前回の位置へ進める**：Firefox では URL の `t=` が効く前に再生が始まって先頭から流れることがある。**再生が始まってから**（state 1）`seekTo()` する。広告の間（`#movie_player` に `ad-showing`）は待つ。
- **裏に回したとき**：Firefox は再生中のページを、裏に回しても画面を消しても「見えている」扱いのまま（`visibilitychange` が来ない）。
  そのため YouTube 自身もあまり止めない。来るのは `blur` と描画の停止（requestAnimationFrame が来ない）だけで、裏に回す・画面を消す・Firefox を一覧から消すの区別がつかない。
  Firefox を最近のアプリ一覧から消しても、ページは動き続けて何も届かない（`pagehide` も来ない）。**「Firefox を閉じたら止める」はスクリプトからはできない**（0.7〜0.9 で試して外した）。
  ユーザーは**画面を消しても裏で再生を続けたい**ので、裏に回ったことを理由に止める処理は入れない。
- 「裏で再生」は `document.hidden` などの上書きと `visibilitychange` の握りつぶし（Premium の機能を回避する使い方なので既定はオフ）。
- ⚙ の下の「記録」は、Firefox から届いた知らせ（見える / 見えない、フォーカス、pagehide、描画の停止 / 再開）と再生状態を localStorage `ytp-log` に残す。
  0.13 からは**スクリプト自身の動き**（開いた先、移った曲、再生を試した回数、プレイヤーのエラー文、スクリプトの例外）も残す。80 件まで、画面には新しい 20 件。
  実機での調査は、⚙ →「記録をコピー」で記録と今の状態をコピーして貼ってもらう（ユーザーの提案。スクリーンショットより確実）。
  新しい仕組みを足したら、要所で `log()` を呼ぶ。記録を外へ送る仕組みは入れていない（https のページから家の PC へは送れず、外のサービスに送るのは避けたい）。
- Violentmonkey がスクリプトをコンテンツスクリプトとして動かすことがある。そのときはページ側のメソッドが見えないので `wrappedJSObject` / `exportFunction` を通す（`pageObj()` / `pageFn()`）。実機は `page` だった。
- アニメーションの終了の知らせ（`onfinish`）は画面が描かれていないと届かない。タイトルを流す処理の終わりは `setTimeout` で受ける。
- 保存先：localStorage `ytp-settings`（一覧・前回の URL と位置・スイッチ・`orders`・`saved`）、`ytp-log`。sessionStorage `ytp-resumed`（タブで 1 回だけ続きから）、`ytp-play`。

### オフライン保存（Premium。Firefox 版 0.12〜。目的は通信量の節約）

YouTube のオフライン保存は**パソコン版のページ（www）にしかない**（m.youtube.com にはない）。スマホでは Firefox の「デスクトップ サイト」で www を開いて使う。
Windows 版の YT Player（WebView2）でも保存と保存分の再生ができることを確認済み（本体には未実装）。Data API にオフライン関連の操作はない。

- **保存のボタン**は動画の下には出ず、「その他の操作」（…）メニューと、再生リストの一覧（`ytd-playlist-panel-video-renderer`）の各曲のメニューの中にある
  `ytd-menu-service-item-download-renderer`。中の `tp-yt-paper-item` を押すと保存が始まる。保存済みだと項目名が「オフラインから削除」になる（押すと確認なしで消える）。
  保存済みかどうかは **`innerText`** で見る（`textContent` には隠れているもう一方の項目名も入っていて、いつも「削除」を含む）。
  同じメニューに「再生リストから削除」も並ぶので、**必ずこの要素の種類で見分ける**。`.data` の `videoId` で曲も確かめる（`saveAll()`）。
- **`watch?v=ID&list=PPSV`** で開くと、通信せず保存分で再生される（アドレスを直接開いてもよい。詳細統計情報の Network Activity が 0 KB のまま）。
  `list=再生リストID` で開くと、保存済みの曲でも通信する。`PPSV` は「オフライン保存」の並びの ID。
- `list=PPSV` のとき `getPlaylist()` は**保存済みの曲の ID（新しく保存した順）**。`playVideoAt(i)` で移れる。この一覧の曲にはメニューがない（ここからは消せない）。
- **オフライン優先**（`virtual()` / `virtualStep()`、通信する側は `streamCtx()` / `streamStep()`）：元の再生リストの順（`pickNext()`）で次の曲を選び、
  **保存済みなら保存分の側（`list=PPSV`）、保存していない曲なら通信する側（`list=再生リストID`）で流す**（0.21。それまでは飛ばしていた。ユーザーの要望）。
  同じ側の中は `playVideoAt` で移り、側が変わるときはページを開き直す（`openSide()`、`ytp-play` の印で再生を始める）。
  通信する側で次も保存していない曲のときは、YouTube に任せる（終わりを切らない）。
  元の曲順は、通信して流したときの `getPlaylist()` を `settings.orders[再生リストID]` に覚える（10 件まで）。保存済みの控えは `settings.saved`。
  どの再生リストとして流しているかは `settings.offline_list`。位置（`positions` / `last_url`）は元の再生リストの URL の形で覚え、開くときに `resumeTarget()` が `PPSV` に書き換える。
- `list=PPSV` では、YouTube が曲を**前回やめた位置から**始める。このスクリプトは曲の終わりの直前で次へ移るので、一度流した曲の位置は**いつも終わりの直前**になる。
  そのまま始まると、すぐ終わる → YouTube が保存した順（元の順の逆）で次へ → それも終わりの直前、と曲が行ったり来たりする（0.19 の実機の記録）。
  移ってから 6 秒間は見張り、プレイヤーの動画（`getVideoData().video_id`）がその曲で「移ってからたった時間 + 3 秒」より先なら `seekTo(0)` する（`restartFor`）。
  （ただの「3 秒より先」だと、普通に 3 秒流れたところでもう一度頭出ししてしまう。）
  位置は再生開始の少しあとに反映されることがあるので、1 回見て終わりにしない。見張りの間は曲の終わりの判定をしない。
- **保存分で流れていることの確かめ方**：`PerformanceObserver` で `videoplayback` の `transferSize` を数える（`mediaText()`、記録に出る）。
  実機で、オフライン優先オンは 4 分以上流して 0 増、オフは 1 曲あたり 6〜10 MB 増えた。保存そのものは 1 曲あたり約 10 MB。
  終わりの直前から始まって曲が終わってしまったとき（state 0）も次の曲へ移す。保存していない動画を `list=PPSV` で開くと、通信して再生される（一覧は保存済みのもの）。
- 確認は Windows の YT Player でできる：調査用ポート付きで起動し、プレイヤー画面で `android/ytplayer.user.js` を CDP の `Runtime.evaluate` で実行する
  （Trusted Types に掛からない。ページを読み直すたびに入れ直す。本体のバーと id が同じなので、スクリプトのバーは後ろのほう）。
  本体のシャッフルは先にオフにする。試したあとは保存した曲を消し、スクリプトを入れずに読み直してから localStorage の `ytp-*` を消す。
- スマホの「デスクトップ サイト」では、開いただけでは再生が始まらない（未開始のまま）ことがある。**曲順や保存済みの一覧を覚える処理を「再生中だけ」にしない**
  （0.12・0.13 はそうなっていて、オフライン優先をオンにしても何も覚えていなかった。0.14 で 5 秒ごとに再生状態と関係なく覚えるようにした）。
- 保存済みの控え（`settings.saved`）が空のときは保存分の側へ行かない。保存分の側で流せる曲がないとき（保存済みが 0・その再生リストの曲がない）は、
  控えを実際の一覧に合わせてから通信する側（`list=再生リストID`）へ戻す。そのままだと次の曲へ進まずに止まるため。
  控えは、保存分の側を開いたとき・「このリストを保存」をしたとき・スイッチをオンにした直後（`resumeTarget(true)` で確かめに行く）にできる。
- 曲の終わりの 10 秒以内で覚えた位置は 0 秒にする（次に開いたとき、終わりの数秒だけ流れて止まるのを避ける）。
- スマホでパソコン版の表示を開くと、**開いただけでは再生が始まらない**（▶ を押すまで「未開始」。実機の記録で確認）。0.17 から、タッチ端末の www の動画ページでは
  スクリプトが再生を始める（`wantPlay`）。**Firefox の自動再生の許可はサイトごと**で、m.youtube.com で通っていても www.youtube.com では
  `NotAllowedError` で断られる（実機の記録で確認）。www でも「音声と動画を許可」にしてもらう必要がある（断られたらバーに案内を出す）。5 回頼んでも始まらなければ、理由（`playerDetail()`、`video.play()` が断られた理由）を記録に残す。
- **「PC 版で開く」**（0.17）：m.youtube.com を開いたら `www.youtube.com/…?app=desktop` へ移る。設定は m の側の localStorage（`pc`）。
  URL に `app=` があるときは移らない（www から戻されたとき・「スマホ版へ」（`?app=m`）で戻ったときに、行ったり来たりしないため）。
  m と www は localStorage が別なので、位置・曲順・スイッチはそれぞれに持つ。
- **画面を消している間は、タイマーが数秒おきにしか動かないことがある**（実機の記録）。「終わりの 1.2 秒前」を逃して曲が最後まで行くと、
  音が止まったページとして Firefox に止められ、画面を点けるまでスクリプトも動かない（14 分止まっていた）。対策（0.25）：前回の確認から間が空いていたら
  その分だけ早めに終わりとみなす（最大 5 秒前）、`ended` の知らせでその場で次へ移る。裏で確実に続くかは実機でしか分からない。
- 「保存済みの曲がないので通信する側へ戻す」は、**再生できているとき（状態 1・2）だけ**判断する。読み込み中はプレイヤーの一覧がまだ空で、
  誤って控え（`settings.saved`）を消してしまう（0.24）。控えを消すのは一覧が実際に読めたときだけ。
- 機内モードではページ自体が開けないので、**圏外から聴き始めることはできない**（ユーザーの実機で確認）。
- **見た目**：ボタンの絵は SVG で描く（`ICONS` / `setIcon()`）。絵文字（⏯ 🔀 🔁）は Android で色付きの四角い絵になり、押されたまま・モード中に見えるため。
  シャッフル・リピートは、オンが黄色の絵と枠、オフが灰色（塗りつぶさない）。タイトルは保存分で流しているとき緑（`OFFLINE_COLOR`）、通信しているとき白。
- 「デスクトップ サイト」のときは UA がパソコンのものになるので、スマホかどうかは `(pointer: coarse)` で見分け、バーを `zoom` で拡大する（`applyZoom()`）。
  倍率は**ページが縮小表示されている分**（`1 / visualViewport.scale`）で決め、毎秒測り直す。画面の幅のまま描かれているときは縦でも横でも等倍。
  経緯：`innerWidth / screen.width` を起動時に 1 回だけ → ページの幅があとから変わると古い倍率が残ってはみ出した（0.21）。
  ページの幅 ÷ 400 → 横向きにしただけで巨大になった（0.22）。ユーザーの希望は「横向きでも縦と同じ大きさで、幅だけ広く」。
  Firefox の上のバーが出ている間はバーの下が切れることがあるので、下端が `visualViewport` の見えている範囲からはみ出した分だけ上げる（`bottomFix`）。
  横も同じで、YouTube のパソコン版は狭い画面だとページが画面より少し広く描かれ（右上のアイコンが切れる）、ページの幅いっぱいのバーは右が切れる。
  バーの左端と幅は `visualViewport` の `offsetLeft` / `width` に合わせる（0.24）。

### アプリの画面（Firefox 版 0.27。www のときだけ）

- Windows 版 0.3 と同じ作り（`#ytp-view` で覆い、`#movie_player` を枠に固定、`:has` の CSS で view-transition-name を外す、
  ページの中で動いているときは `startViewTransition` をアニメーションなしにする）。クラス名は `ytp-appview`（Windows 版と別）。
- 操作は今のバーをそのまま画面の中（`ctlBox`）に入れる。覆いは `visualViewport` の範囲に合わせ、バーと曲の一覧は applyZoom と同じ倍率で拡大。
  縦長は「動画 → 操作 → 一覧」、横長は「左に動画と操作、右に一覧」。設定は `settings.view`（`app` / `youtube`）。
- 曲の一覧はオフライン優先のときも元の再生リストの順（保存済みは緑）。押すと `jumpTo()`（保存分 / 通信のどちらの側で流すかも選ぶ）。
  曲名はページの一覧から取って localStorage `ytp-titles` に 1000 件まで覚える。
- × はタブを閉じる（`@grant window.close`。Violentmonkey の機能。0.26 までは `@grant none`）。閉じる前に位置を覚えて止める。
- PC の YT Player では、CDP の `Emulation.setDeviceMetricsOverride`（mobile, 432x900）と `setTouchEmulationEnabled` でスマホの縦横の並びは確かめられる。
  ただし Chromium では「幅 980 で描いて縮小表示」（visualViewport.scale 0.44）にはならないので、その倍率での見え方は実機でしか分からない。

### Firefox 版の動作確認

ユーザーのスマホは触れないので、アプリ内のブラウザ（Claude Browser）でスマホ版を開いて確かめ、最後は実機で試してもらう。

- `resize_window` を `mobile` にしてから m.youtube.com を開く（パソコンの大きさだと www の `?app=desktop` に飛ばされる）。終わったら `desktop` に戻す。ログインはしていない（一覧の取得は試せない）。
- スクリプトは `@run-at document-start` なので本来の読み込み時には入れられない。**一時ブランチ（`tmp-userscript-test`）に push し、ページで raw の URL（コミットのハッシュ指定）を fetch して eval する。**
  youtube.com は Trusted Types なので `eval(trustedTypes.createPolicy('ytp-test-' + Date.now(), {createScript: s => s}).createScript(code))`。終わったらブランチはリモートも含めて消す。
- 音が出るので、試すときは `#movie_player` の `mute()` を先に呼ぶ。試したあとは localStorage / sessionStorage の `ytp-*` を消す。
- アプリ内のブラウザの画面が隠れていると、requestAnimationFrame やアニメーションが止まり、タイマーも間引かれる（`tabs_context` で分かる）。

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
