#!/usr/bin/env python3
"""serve_no_cache.py — python -m http.server と同じ使い方だが、キャッシュを一切許可しない。

ブラウザ側でJS/HTMLの古いキャッシュを掴んだまま「直したのに直っていないように見える」事象を
切り分けるためのデバッグ用サーバー。使い方は既存のREADME記載の起動方法と同じ:

    python3 scripts/serve_no_cache.py 8000

リポジトリ直下で実行すること（http.serverと同じくカレントディレクトリを配信する）。
"""
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer


class NoCacheHandler(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    server = ThreadingHTTPServer(('0.0.0.0', port), NoCacheHandler)
    print(f'Serving HTTP on 0.0.0.0 port {port} (キャッシュ無効) ...')
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == '__main__':
    main()
