"""Send Telegram notifications through the local tg-bridge daemon.

The hooks used to open their OWN connection to api.telegram.org — a second
transport with its own token, retry loop, thread lookup and rich/plain fallback
ladder. It is also the one that fails here: DPI kills the Python TLS handshake
(`_ssl.c:1063: handshake operation timed out`) while the daemon's long-lived
connection keeps working, so every hook notification was silently lost.

Going through the daemon means one transport, one place that knows how to reach
Telegram, and rich formatting identical to the `send` MCP tool. Returns None
when the daemon is unreachable so the caller can fall back to its direct send —
a hook may fire in a session that never started one.
"""
from __future__ import annotations

import json
import os
import urllib.error
import urllib.request
from pathlib import Path

PORT = os.environ.get("TG_BRIDGE_PORT", "8787")
NOTIFY_URL = f"http://127.0.0.1:{PORT}/notify"
SECRET_FILE = Path.home() / ".claude" / "tg-bridge" / "state" / "daemon.secret"


def notify(**body) -> dict | None:
    """POST /notify. create: label+text -> {'ids': {chat: message_id}};
    edit: label+text+ids; delete: ids+delete=True. None = daemon unreachable."""
    try:
        secret = SECRET_FILE.read_text(encoding="utf-8").strip()
    except OSError:
        return None
    req = urllib.request.Request(
        NOTIFY_URL,
        data=json.dumps(body).encode("utf-8"),
        headers={"content-type": "application/json", "x-bridge-secret": secret},
    )
    try:
        return json.loads(urllib.request.urlopen(req, timeout=15).read() or b"{}")
    except (urllib.error.HTTPError, urllib.error.URLError, OSError):
        return None
