# YT Player（Firefox / Android 版）

Windows 版 YT Player の機能を、スマホの Firefox で youtube.com を開いたときに使えるようにするユーザースクリプト（`ytplayer.user.js`）。
アプリではなく、YouTube のページの下に操作バーを足すだけなので、ログインも Premium などの特典も Firefox の YouTube のまま使える。

## バーでできること

| | |
|---|---|
| 再生リストのプルダウン | YouTube の「再生リスト」ページと同じ一覧（保存した再生リスト・後で見る・ミックスリストも）。選ぶと先頭から再生 |
| ⟳ | 一覧を取得し直す（ページを開くたびにも裏で取り直す） |
| ▾ / ♪ | バーをたたむ / 開く |
| ⏮ ⏯ ⏭ | 前の動画・再生/一時停止・次の動画。ロック画面や通知の「前へ」「次へ」も曲送りになる |
| 続きから | 再生ページ以外で表示。前回の動画を止めた位置から再生（位置は 5 秒ごとに記録） |
| 裏で再生 | オンにすると、画面を消したり別のアプリに切り替えたりしても再生が続く（既定はオフ） |

設定と一覧は、その端末の Firefox の youtube.com に保存される（Windows 版とは共有しない）。

## 入れ方（スマホ）

1. Google Play で **Firefox** を入れる（既定のブラウザにする必要はない）。
2. Firefox で `https://m.youtube.com/` を開き、Google アカウントでログインする。
3. Firefox のメニュー →「拡張機能」→ **Violentmonkey** を追加する。
4. スクリプトを入れる。どちらかで：
   - **URL から**：Firefox で次の URL を開くと Violentmonkey のインストール画面が出るので「インストール」。
     `https://raw.githubusercontent.com/jnakai24/YT_Player/main/android/ytplayer.user.js`
     （GitHub のリポジトリが公開されている場合。非公開なら下の方法で）
   - **貼り付けて**：Violentmonkey のダッシュボード →「＋」→ 新しいスクリプトの中身を全部消し、`ytplayer.user.js` の中身を貼り付けて保存。
5. YouTube を開き直すと、画面の下にバーが出る。

## 裏で再生について

- YouTube は、ページが見えなくなると Premium 以外の再生を止める。「裏で再生」はページがずっと見えていることにして、これを止めさせない。
  **Premium の機能を回避する使い方で、YouTube の利用規約に触れ得る**ので、自分の判断でオンにする。
- 長時間でも止まりにくくするには、Android の設定 → アプリ → Firefox →「電池」で制限なし（最適化しない）にする。
- 切り替えは、ページを開いた時点から効く。オンにしても止まるときは、ページを開き直す。

## 壊れたとき

YouTube のページの作りに頼っているので、YouTube 側の変更で動かなくなることがある（Windows 版と同じ。ルートの CLAUDE.md を参照）。

- 一覧が「読めませんでした」になる：スクリプト先頭の `WEB_CLIENT_VERSION` が古すぎる可能性がある。
  パソコンの youtube.com で開発者ツールのコンソールに `ytcfg.get('INNERTUBE_CLIENT_VERSION')` と入れた値に書き換える。
- 直したら `@version` と `VERSION` を上げる（Violentmonkey が更新として扱う）。

## 仕組み（メモ）

- 一覧は YouTube 自身が使っている内部 API `/youtubei/v1/browse`（`browseId: FEplaylist_aggregation`）に、ログイン中の Cookie と
  `SAPISIDHASH` の Authorization ヘッダーを付けて問い合わせている。スマホ版の名乗り（`MWEB`）だと中身が空なので、パソコン版（`WEB`）で問い合わせる。
  結果の `lockupViewModel` の読み方は Windows 版の `PAGE_PLAYLISTS_JS` と同じ（2026-11-10 に両方の結果が一致することを確認）。
- プレイヤー操作は Windows 版と同じ `#movie_player` のメソッド。m.youtube.com にも同じものがある。
- 「裏で再生」は `document.hidden` / `visibilityState` を上書きし、`visibilitychange` を止めている。ページより先に仕込むため `@run-at document-start`。
