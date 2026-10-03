"""本机静态预览：支持 VitePress clean URL，未知路由返回真正的404。"""
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlsplit, unquote
import argparse
import re

parser = argparse.ArgumentParser()
parser.add_argument('--port', type=int, default=4318)
parser.add_argument('--directory', default=str(Path(__file__).resolve().parents[1] / 'dist'))
args = parser.parse_args()
root = Path(args.directory).resolve()

class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args_, **kwargs):
        super().__init__(*args_, directory=str(root), **kwargs)

    def translate_path(self, path):
        translated = Path(super().translate_path(path))
        clean_path = unquote(urlsplit(path).path)
        if clean_path.startswith('/docs/') and not clean_path.endswith('/') and not translated.suffix:
            article = translated.with_suffix('.html')
            if article.is_file():
                return str(article)
        # 静态通用详情用于构建后新发布的 appId，不增加账号或后台服务。
        if not translated.exists():
            match = re.fullmatch(r'/(en/)?apps/([a-z0-9]+(?:[.-][a-z0-9]+)+)(/changelog)?/?', clean_path)
            if match:
                template = '_changelog' if match.group(3) else '_detail'
                return str(root / ('en' if match.group(1) else '.') / 'apps' / template / 'index.html')
        return str(translated)

    def send_error(self, code, message=None, explain=None):
        page = root / ('en' if self.path.startswith(('/en/','/docs/en/')) else '.') / '404.html'
        if code == 404 and page.is_file():
            body = page.read_bytes()
            self.send_response(404)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            if self.command != 'HEAD':
                self.wfile.write(body)
            return
        super().send_error(code, message, explain)

    def list_directory(self, path):
        self.send_error(404)
        return None

print(f'ReAI Open preview: http://127.0.0.1:{args.port}/ ({root})', flush=True)
ThreadingHTTPServer(('127.0.0.1', args.port), Handler).serve_forever()
