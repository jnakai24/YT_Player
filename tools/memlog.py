"""動いている YT Player のプレイヤー画面のメモリを一定の間隔で記録する（調査用）。

YT Player を調査用ポート 9333 付きで起動しておくこと（CLAUDE.md の「動作確認」）。

    python -I -X utf8 tools/memlog.py [間隔の秒数（既定 300）] [出力先（既定 data/memlog.csv）]

1 行ごとに、時刻・JS のメモリ（使用 / 確保）・DOM の要素数・イベントリスナー数・document 数・iframe 数・
WebView2 の描画プロセスのメモリ（いちばん大きいもの）・再生状態・曲 ID・URL を CSV に追記する。
ページが落ちていても止まらずに記録を続ける（そのときは error の欄に理由を書く）。要: pip install websocket-client
"""
import csv
import datetime
import json
import os
import subprocess
import sys
import time
import urllib.request

import websocket

PORT = 9333
FIELDS = ["time", "js_used_mb", "js_total_mb", "nodes", "listeners", "documents", "frames",
          "renderer_mb", "renderers", "state", "video", "url", "error"]
PAGE_JS = """(() => {
  const p = document.getElementById('movie_player');
  let state = null, video = null;
  try { state = p.getPlayerState(); video = (p.getVideoData() || {}).video_id; } catch (e) {}
  return {state, video, url: location.href};
})()"""
PS = ("Get-CimInstance Win32_Process -Filter \"Name='msedgewebview2.exe'\" | "
      "Where-Object { $_.CommandLine -match 'YT_Player' -and $_.CommandLine -match '--type=renderer' } | "
      "ForEach-Object { [math]::Round($_.PrivatePageCount / 1MB) }")


def renderers():
    try:
        out = subprocess.run(["powershell", "-NoProfile", "-Command", PS],
                             capture_output=True, text=True, timeout=60).stdout
        sizes = [int(x) for x in out.split() if x.strip().isdigit()]
        return (max(sizes) if sizes else "", len(sizes))
    except Exception:
        return ("", "")


def sample():
    row = {"time": datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")}
    row["renderer_mb"], row["renderers"] = renderers()
    try:
        targets = json.load(urllib.request.urlopen(f"http://localhost:{PORT}/json", timeout=10))
        page = next((t for t in targets if t["type"] == "page" and "youtube" in t["url"]), None)
        if not page:
            row["error"] = "page not found: " + " ".join(t["url"] for t in targets if t["type"] == "page")
            return row
        ws = websocket.create_connection(page["webSocketDebuggerUrl"], suppress_origin=True, timeout=30)
        try:
            def call(i, method, params=None):
                ws.send(json.dumps({"id": i, "method": method, "params": params or {}}))
                while True:
                    msg = json.loads(ws.recv())
                    if msg.get("id") == i:
                        return msg.get("result", {})
            call(1, "Performance.enable")
            metrics = {m["name"]: m["value"] for m in call(2, "Performance.getMetrics").get("metrics", [])}
            call(3, "Performance.disable")
            row["js_used_mb"] = round(metrics.get("JSHeapUsedSize", 0) / 2**20)
            row["js_total_mb"] = round(metrics.get("JSHeapTotalSize", 0) / 2**20)
            row["nodes"] = int(metrics.get("Nodes", 0))
            row["listeners"] = int(metrics.get("JSEventListeners", 0))
            row["documents"] = int(metrics.get("Documents", 0))
            row["frames"] = int(metrics.get("Frames", 0))
            r = call(4, "Runtime.evaluate", {"expression": PAGE_JS, "returnByValue": True})
            v = r.get("result", {}).get("value") or {}
            row.update(state=v.get("state"), video=v.get("video"), url=v.get("url"))
        finally:
            ws.close()
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {e}"
    return row


def main():
    interval = int(sys.argv[1]) if len(sys.argv) > 1 else 300
    path = sys.argv[2] if len(sys.argv) > 2 else os.path.join("data", "memlog.csv")
    new = not os.path.exists(path)
    while True:
        row = sample()
        with open(path, "a", newline="", encoding="utf-8") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS)
            if new:
                w.writeheader()
                new = False
            w.writerow(row)
        print(", ".join(f"{k}={row.get(k, '')}" for k in FIELDS if k != "url"), flush=True)
        time.sleep(interval)


if __name__ == "__main__":
    main()
