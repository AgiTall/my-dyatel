"""
Медицинский портал 'My Dyatel'
Сервер HTTP и REST API (backend/server.py)
Работает на стандартной библиотеке Python.
"""

import http.server
import socketserver
import json
import os
import ssl
import urllib.parse
from typing import Dict, Any

from backend import portal
from backend.database.db_manager import DatabaseManager


HOST = os.environ.get("PORTAL_HOST", "127.0.0.1")
PORT = int(os.environ.get("PORTAL_PORT", "8000"))
FRONTEND_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "frontend"))
db = DatabaseManager()
portal.migrate(db)


class MedPortalHandler(http.server.SimpleHTTPRequestHandler):
    """HTTP-обработчик для ролевого REST API (/api/v2/*) и статики фронтенда"""

    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=FRONTEND_DIR, **kwargs)

    def _send_json(self, data: Any, status: int = 200):
        body = json.dumps(data, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()
        self.wfile.write(body)

    def _read_json_body(self) -> Dict[str, Any]:
        content_length = int(self.headers.get("Content-Length", 0))
        if content_length > 0:
            raw_body = self.rfile.read(content_length).decode("utf-8")
            try:
                return json.loads(raw_body)
            except Exception:
                return {}
        return {}

    def _handle_v2(self, method: str, parsed, body: Dict[str, Any]):
        token = self.headers.get("Authorization", "").replace("Bearer ", "").strip()
        status, data = portal.handle(
            db, method, parsed.path[len("/api/v2"):],
            urllib.parse.parse_qs(parsed.query), body, token
        )
        self._send_json(data, status)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/v2/"):
            return self._handle_v2("GET", parsed, {})
        if parsed.path == "/":
            self.path = "/index.html"
        return super().do_GET()

    def do_POST(self):
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith("/api/v2/"):
            return self._handle_v2("POST", parsed, self._read_json_body())
        self._send_json({"success": False, "error": "Маршрут не найден"}, 404)


def run_server():
    socketserver.ThreadingTCPServer.allow_reuse_address = True
    socketserver.ThreadingTCPServer.daemon_threads = True
    cert = os.environ.get("PORTAL_SSL_CERT")
    key = os.environ.get("PORTAL_SSL_KEY")
    with socketserver.ThreadingTCPServer((HOST, PORT), MedPortalHandler) as httpd:
        proto = "http"
        if cert and key:
            ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            ctx.load_cert_chain(certfile=cert, keyfile=key)
            httpd.socket = ctx.wrap_socket(httpd.socket, server_side=True)
            proto = "https"
        print("=====================================================")
        print(" МЕДИЦИНСКИЙ ПОРТАЛ 'MY DYATEL' ЗАПУЩЕН")
        print(f" Адрес в браузере: {proto}://{HOST}:{PORT}")
        print(f" База данных: SQLite ({db.db_path})")
        print("=====================================================")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nОстановка сервера.")


if __name__ == "__main__":
    run_server()
