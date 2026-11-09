"""テキストの YouTube URL を一行ずつ読み、動画タイトルを行末に追記する。

    python add_titles.py               # 同じフォルダの video.txt
    python add_titles.py list.txt      # ファイルを指定
    python add_titles.py --dry-run     # 書き込まずに結果だけ表示

- 書式は「URL<TAB>タイトル」。すでにタイトルが付いている行、URL でない行（見出し・空行）はそのまま。
- タイトルは YouTube の oEmbed（APIキー不要）で取得する。非公開・削除済みの動画は取得できないので、その行は変えずに報告する。
- 書き込む前に元のファイルを .bak として残す。
"""
import argparse
import json
import re
import shutil
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

URL_RE = re.compile(r"^(https?://(?:www\.|m\.|music\.)?(?:youtube\.com|youtu\.be)/\S+)$")
OEMBED = "https://www.youtube.com/oembed?format=json&url="


def fetch_title(url):
    req = urllib.request.Request(OEMBED + urllib.parse.quote(url, safe=""),
                                 headers={"User-Agent": "add_titles/1.0"})
    with urllib.request.urlopen(req, timeout=15) as r:
        return json.load(r)["title"]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("file", nargs="?", default=str(Path(__file__).with_name("video.txt")))
    ap.add_argument("--dry-run", action="store_true", help="書き込まずに結果だけ表示")
    args = ap.parse_args()
    sys.stdout.reconfigure(encoding="utf-8")

    path = Path(args.file)
    raw = path.read_bytes()
    bom = raw.startswith(b"\xef\xbb\xbf")
    text = raw.decode("utf-8-sig")
    newline = "\r\n" if "\r\n" in text else "\n"
    lines = text.splitlines()

    added = failed = 0
    for i, line in enumerate(lines):
        m = URL_RE.match(line.strip())
        if not m:  # 見出し・空行・タイトル付きの行
            continue
        url = m.group(1)
        try:
            title = fetch_title(url)
        except urllib.error.HTTPError as e:
            print(f"{i + 1}行目: 取得できません（HTTP {e.code}）: {url}")
            failed += 1
            continue
        except Exception as e:
            print(f"{i + 1}行目: 取得できません（{e}）: {url}")
            failed += 1
            continue
        # タイトル内のタブ・改行は書式が崩れるので空白にする
        title = " ".join(title.split())
        lines[i] = f"{url}\t{title}"
        print(f"{i + 1}行目: {title}")
        added += 1
        time.sleep(0.2)

    print(f"\n追記 {added} 件、取得できず {failed} 件")
    if args.dry_run or not added:
        return

    shutil.copy2(path, path.with_suffix(path.suffix + ".bak"))
    out = newline.join(lines) + (newline if text.endswith(("\n", "\r")) else "")
    path.write_bytes(("﻿" if bom else "").encode("utf-8") + out.encode("utf-8"))
    print(f"書き込みました: {path}（元のファイルは {path.name}.bak）")


if __name__ == "__main__":
    main()
