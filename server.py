import http.server
import socketserver
import os
import ssl
import threading
import socket

PORT_HTTP = 8080
PORT_HTTPS = 8443

class CustomHandler(http.server.SimpleHTTPRequestHandler):
    extensions_map = http.server.SimpleHTTPRequestHandler.extensions_map.copy()
    extensions_map.update({
        '.wasm': 'application/wasm',
        '.task': 'application/octet-stream',
        '.mind': 'application/octet-stream',
        '.glb': 'model/gltf-binary',
    })
    def do_POST(self):
        if self.path == '/upload_mind' or self.path.startswith('/upload_mind'):
            content_length = int(self.headers['Content-Length'])
            post_data = self.rfile.read(content_length)
            assets_dir = os.path.join(os.getcwd(), 'assets')
            os.makedirs(assets_dir, exist_ok=True)
            filename = 'monster_tshirt.mind'
            if '?' in self.path and 'file=' in self.path:
                filename = self.path.split('file=')[1].split('&')[0]
            mind_path = os.path.join(assets_dir, filename)
            with open(mind_path, 'wb') as f:
                f.write(post_data)
            print(f"[SERVER] Successfully saved {len(post_data)} bytes to {mind_path}")
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'OK')
    def do_GET(self):
        if self.path.startswith('/log?'):
            from urllib.parse import unquote
            print(f"[CLIENT LOG] {unquote(self.path[5:])}")
            self.send_response(200)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Content-Type', 'text/plain')
            self.end_headers()
            self.wfile.write(b'OK')
            return
        super().do_GET()


    def end_headers(self):
        self.send_header('Cache-Control', 'no-cache, no-store, must-revalidate')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        self.send_header('Access-Control-Allow-Origin', '*')
        super().end_headers()

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header('Access-Control-Allow-Origin', '*')
        self.send_header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
        self.send_header('Access-Control-Allow-Headers', 'Content-Type')
        self.end_headers()

def get_lan_ips():
    ips = []
    try:
        for _, _, addrlist in [socket.gethostbyname_ex(socket.gethostname())]:
            for ip in addrlist:
                if not ip.startswith("127."):
                    ips.append(ip)
    except Exception:
        pass
    return ips

def run_https():
    try:
        ctx = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        ctx.load_cert_chain(certfile="cert.pem", keyfile="key.pem")
        http.server.ThreadingHTTPServer.allow_reuse_address = True
        httpsd = http.server.ThreadingHTTPServer(("", PORT_HTTPS), CustomHandler)
        httpsd.socket = ctx.wrap_socket(httpsd.socket, server_side=True)
        print(f"[HTTPS] Serving at https://localhost:{PORT_HTTPS}")
        for ip in get_lan_ips():
            print(f"[HTTPS] LAN access: https://{ip}:{PORT_HTTPS}")
        httpsd.serve_forever()
    except Exception as e:
        print(f"[HTTPS] Error starting HTTPS server: {e}")

if __name__ == "__main__":
    http.server.ThreadingHTTPServer.allow_reuse_address = True

    if os.path.exists("cert.pem") and os.path.exists("key.pem"):
        threading.Thread(target=run_https, daemon=True).start()

    server_address = ("", PORT_HTTP)
    httpd = http.server.ThreadingHTTPServer(server_address, CustomHandler)
    print(f"[HTTP] Serving at http://localhost:{PORT_HTTP}")
    for ip in get_lan_ips():
        print(f"[HTTP] LAN access: http://{ip}:{PORT_HTTP}")

    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()
