"""動いている YT Player のページで JavaScript を実行して結果を表示する（動作確認用）。

YT Player を調査用ポート 9333 付きで起動しておくこと（CLAUDE.md の「動作確認」）。

    python -I -X utf8 tools/cdp.py youtube "location.href"
    python -I -X utf8 tools/cdp.py about:blank "document.getElementById('title').textContent"

第1引数はページの URL に含まれる文字列。プレイヤー画面は youtube、ミニプレイヤーは about:blank。
Promise を返す式は結果を待つ。要: pip install websocket-client
"""
import json
import sys
import urllib.request

import websocket

PORT = 9333


def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    url_part, expression = sys.argv[1], sys.argv[2]
    targets = json.load(urllib.request.urlopen(f"http://localhost:{PORT}/json"))
    page = next((t for t in targets if t["type"] == "page" and url_part in t["url"]), None)
    if not page:
        sys.exit("ページが見つかりません: " + ", ".join(t["url"] for t in targets if t["type"] == "page"))
    ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True)
    ws.send(json.dumps({"id": 1, "method": "Runtime.evaluate",
                        "params": {"expression": expression, "returnByValue": True, "awaitPromise": True}}))
    result = json.loads(ws.recv())["result"]
    if "exceptionDetails" in result:
        print("例外:", result["exceptionDetails"].get("exception", {}).get("description"))
    else:
        print(result.get("result", {}).get("value"))


if __name__ == "__main__":
    main()
