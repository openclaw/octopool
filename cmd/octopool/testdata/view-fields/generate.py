"""Capture native gh v2.102.0 exports against synthetic local GraphQL responses.

Run manually with Python 3, openssl, and GH_NATIVE (defaults to Homebrew gh).
No real credentials or GitHub requests are used.
"""

import json
import os
from pathlib import Path
import ssl
import subprocess
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = Path(__file__).resolve().parent
GH = os.environ.get("GH_NATIVE", "/opt/homebrew/bin/gh")
assert subprocess.check_output([GH, "--version"], text=True).startswith("gh version 2.102.0 ")


class Handler(BaseHTTPRequestHandler):
    payload = {}

    def do_POST(self):
        self.rfile.read(int(self.headers["Content-Length"]))
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps({"data": {"repository": {
            "pullRequest": self.payload, "issue": self.payload, "hasIssuesEnabled": True,
        }}}).encode())

    def log_message(self, *args):
        pass


def capture(name, kind, fields, payload, env, host):
    Handler.payload = payload
    args = [GH, kind, "view", "7", "-R", host + "/synthetic/repo", "--json", fields]
    output = subprocess.check_output(args, env=env)
    (ROOT / (name + ".native.txt")).write_bytes(output)
    (ROOT / (name + ".graphql.json")).write_text(json.dumps(payload, indent=2) + "\n")
    jq = ".mergeStateStatus" if kind == "pr" else "{stateReason,assignees}"
    (ROOT / (name + ".jq.txt")).write_bytes(subprocess.check_output(args + ["--jq", jq], env=env))
    if name == "issue-open":
        (ROOT / "numbers.jq.txt").write_bytes(subprocess.check_output(args + ["--jq", '1/3,1.0,1e20,-0.5,true,null,"a\\nb"'], env=env))


with tempfile.TemporaryDirectory() as directory:
    subprocess.run([
        "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
        "-keyout", directory + "/key", "-out", directory + "/cert", "-days", "1",
        "-subj", "/CN=localhost", "-addext", "subjectAltName=DNS:localhost,IP:127.0.0.1",
    ], capture_output=True, check=True)
    server = HTTPServer(("127.0.0.1", 0), Handler)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(directory + "/cert", directory + "/key")
    server.socket = context.wrap_socket(server.socket, server_side=True)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    host = "127.0.0.1:" + str(server.server_port)
    env = {**os.environ, "GH_HOST": host, "GH_ENTERPRISE_TOKEN": "synthetic-fixture-token",
           "GH_TOKEN": "synthetic-fixture-token", "SSL_CERT_FILE": directory + "/cert",
           "NO_PROXY": "127.0.0.1", "GH_CONFIG_DIR": directory + "/config"}
    capture("merge-state", "pr", "additions,author,deletions,isDraft,maintainerCanModify,mergeStateStatus,number,state,title", {
        "id": "PR_synthetic", "headRefOid": "0123456789abcdef0123456789abcdef01234567",
        "additions": 4, "deletions": 2, "author": {"id": "U_alice", "login": "alice", "name": "Alice"},
        "isDraft": True, "maintainerCanModify": False, "mergeStateStatus": "BLOCKED",
        "number": 7, "state": "OPEN", "title": "Synthetic <PR>",
    }, env, host)
    for name, state, reason in [
        ("open", "OPEN", None), ("completed", "CLOSED", "COMPLETED"),
        ("not-planned", "CLOSED", "NOT_PLANNED"), ("reopened", "OPEN", "REOPENED"),
    ]:
        capture("issue-" + name, "issue", "stateReason,assignees,state,title", {
            "state": state, "stateReason": reason, "title": "Synthetic <issue>",
            "assignees": {"nodes": [{"id": "U_alice", "login": "alice", "name": "Alice", "databaseId": 12}]},
        }, env, host)
    server.shutdown()
