"""Stop hook: push my final answer to Telegram, every turn, without my help.

Relying on me to remember the «claude — готово» ping failed often enough that the
user asked for it to be automatic. A Stop hook fires on every natural turn end, so
the notification no longer depends on my memory.

Sends through the daemon's `/notify` (addressed by label — a `handle` lives only
inside that tab's session-mcp process). The daemon owns the one connection that
actually reaches Telegram here; a direct Bot API send is kept as the fallback
for when no daemon is running. See `bridge_client` for why.

Never blocks: any failure exits 0 quietly — a broken notifier must not wedge the
session.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # hooks run with the project as cwd
import bridge_client  # noqa: E402

HOME = Path.home()
TG_DIR = HOME / ".claude" / "channels" / "telegram"
LOG = HOME / ".claude" / "tg-bridge" / "state" / "stop-notify.log"
FULL_AUTO = HOME / ".claude" / "state" / "full-auto.json"  # armed by the my-full-auto skill
ATTEMPTS = 3  # the VPN drops TLS at random; one shot silently loses the ping
THREADS_FILE = HOME / ".claude" / "tg-bridge" / "state" / "threads.json"
PLAIN_LIMIT = 4096  # Telegram plain-send hard cap (a native Rich Message holds 32768)
SUMMARY_SHORT = 600  # answers at most this long show whole; longer -> summary + <details>
PING_MAX = 400  # a plain send longer than this is the answer itself, not a status ping
_TG_MARKER = re.compile(r"<!--\s*tg:\s*(.*?)\s*-->", re.S)


def _token() -> str:
    for line in (TG_DIR / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("TELEGRAM_BOT_TOKEN"):
            return line.split("=", 1)[1].strip()
    return ""


def _chats() -> list[str]:
    access = json.loads((TG_DIR / "access.json").read_text(encoding="utf-8"))
    return [str(c) for c in access.get("allowFrom") or []]


def _blocks(rec: dict) -> list[dict]:
    content = (rec.get("message") or {}).get("content")
    return [b for b in content if isinstance(b, dict)] if isinstance(content, list) else []


def _label(payload: dict) -> str:
    """This tab's stable key — same rule session-mcp uses, so they agree on a thread."""
    env = (os.environ.get("TG_BRIDGE_LABEL") or "").strip()
    return env or Path(payload.get("cwd") or ".").name


def _thread_id(label: str):
    """The tab's message_thread_id from threads.json (daemon-written), or None."""
    try:
        t = json.loads(THREADS_FILE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    rec = t.get(label)
    return rec.get("thread_id") if isinstance(rec, dict) else None


def _split_summary(answer: str):
    """Return (visible_summary, details_or_None).

    An explicit `<!-- tg: … -->` marker is the summary (details = everything else).
    Without a marker: short answers show whole (no details); long answers show the
    first paragraph (skipping a leading heading) as the summary and the full body
    under <details>. Never truncates mid-word.
    """
    m = _TG_MARKER.search(answer)
    body = _TG_MARKER.sub("", answer).strip()
    if m:
        return m.group(1).strip(), (body or None)
    if len(body) <= SUMMARY_SHORT:
        return body, None
    lines = body.split("\n")
    i = 0
    while i < len(lines) and lines[i].lstrip().startswith("#"):
        i += 1  # skip a leading markdown heading line
    para = []
    while i < len(lines) and lines[i].strip():
        para.append(lines[i].strip())
        i += 1
    summary = " ".join(para).strip() or body[:SUMMARY_SHORT]
    return summary, body


def _turn_start(records: list[dict]) -> int:
    """Index of the user prompt that opened this turn.

    A `user` record is also how tool results come back, so a real prompt is one
    whose content is a bare string or carries a text block.
    """
    for i in range(len(records) - 1, -1, -1):
        rec = records[i]
        if rec.get("type") != "user" or rec.get("isSidechain"):
            continue
        content = (rec.get("message") or {}).get("content")
        if isinstance(content, str):
            return i
        if any(b.get("type") == "text" for b in _blocks(rec)):
            return i
    return 0


def _last_answer_index(records: list[dict], start: int) -> int:
    """Index of my last user-facing text this turn, or -1.

    Subagent chatter (`isSidechain`) is not mine to report, and `thinking` blocks
    are not for the user.
    """
    for i in range(len(records) - 1, start - 1, -1):
        rec = records[i]
        if rec.get("type") != "assistant" or rec.get("isSidechain"):
            continue
        if any(b.get("type") == "text" and (b.get("text") or "").strip() for b in _blocks(rec)):
            return i
    return -1


def _is_bridge_send(b: dict) -> bool:
    """A tg-bridge `send` tool call (a NEW Telegram message). react/edit/rename
    don't create a message, so they never cause a duplicate."""
    return b.get("type") == "tool_use" and "tg-bridge__send" in (b.get("name") or "")


def _send_body(b: dict) -> str:
    """What a send tool call actually puts in Telegram (photos carry a caption)."""
    inp = b.get("input") or {}
    return str(inp.get("text") or inp.get("caption") or "")


def _ended_with_ping(records: list[dict], start: int, answer_at: int) -> bool:
    """True if I already delivered this turn's content to Telegram myself, so
    mirroring the final text would double-post. Three triggers:

    (a) a `send` AT-OR-AFTER my final text — I closed the turn by messaging TG
        (incl. a send in the SAME assistant message as the wrap-up text);
    (b) an INTERACTIVE `send` (buttons) ANYWHERE this turn — a button prompt is a
        self-contained message the user must tap; it usually precedes the wrap-up
        text, and mirroring on top of it is the duplicate the user hit;
    (c) a SUBSTANTIAL plain `send` (over PING_MAX) anywhere this turn — that was
        the answer itself, and the trailing terminal text is only a pointer to it
        («Переделал, скрины в тг.»). Mirroring it posted the same turn twice.

    A SHORT plain `send` before the final text is a «взял в работу» status ping
    and does NOT suppress — the real result still needs to reach Telegram.
    """
    for rec in records[answer_at:]:                       # (a)
        if any(_is_bridge_send(b) for b in _blocks(rec)):
            return True
    for rec in records[start + 1:]:                       # (b), (c)
        for b in _blocks(rec):
            if not _is_bridge_send(b):
                continue
            if (b.get("input") or {}).get("buttons"):
                return True
            if len(_send_body(b)) > PING_MAX:
                return True
    return False


def _text_at(records: list[dict], index: int) -> str:
    texts = [b.get("text") or "" for b in _blocks(records[index]) if b.get("type") == "text"]
    return "\n".join(t for t in texts if t.strip()).strip()


def _log(msg: str) -> None:
    """One line per invocation. Without it, «no ping arrived» is ambiguous: hook
    never called, called and skipped, or called and failed all look identical."""
    try:
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except OSError:
        pass


def main() -> None:
    # Read stdin as BYTES: Python on Windows decodes stdin with the console
    # codepage (cp1251 here), which mangles the UTF-8 payload — the Cyrillic
    # username in `transcript_path` came through as «РђРґРјРёРЅРёСЃ» and every
    # run died on FileNotFoundError, silently.
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    payload = json.loads(raw or "{}")
    _log(f"fired event={payload.get('hook_event_name')} active={payload.get('stop_hook_active')}")
    if payload.get("stop_hook_active"):  # already in a forced continuation → no loop
        _log("skip: stop_hook_active")
        return
    if FULL_AUTO.exists():
        # my-full-auto turns don't «end» — its Stop hook sends me back for another.
        # Pinging each one would buzz the phone all night; there, milestone reports
        # are mine to send deliberately.
        _log("skip: my-full-auto armed")
        return

    records = []
    for line in Path(payload["transcript_path"]).read_text(encoding="utf-8").splitlines():
        try:
            records.append(json.loads(line))
        except json.JSONDecodeError:
            continue  # a partially flushed tail line is not worth dying over

    start = _turn_start(records)
    answer_at = _last_answer_index(records, start)
    if answer_at < 0:
        _log("skip: no answer found")
        return
    if _ended_with_ping(records, start, answer_at):
        _log("skip: already delivered to Telegram this turn (explicit send)")
        return

    answer = _text_at(records, answer_at)
    if not answer:
        _log("skip: empty answer")
        return

    tab = _label(payload)
    tid = _thread_id(tab)
    summary, details = _split_summary(answer)
    body = summary
    if details:
        body = f"{summary}\n\n<details><summary>Подробнее</summary>\n\n{details}\n</details>"
    text = f"claude · {tab}\n\n{body}"

    # Preferred path: the daemon's connection (see bridge_client). The direct
    # send below stays as the fallback for when no daemon is running.
    if bridge_client.notify(label=tab, text=text) is not None:
        _log(f"sent via daemon to thread={tid} ({len(text)} chars)")
        return
    _log("daemon unreachable → direct send")
    token = _token()
    for chat in _chats():
        _send(token, chat, text, tid)
    _log(f"sent to thread={tid} ({len(_chats())} chat(s), {len(text)} chars)")


def _send(token: str, chat: str, text: str, thread_id=None) -> None:
    """Deliver one message, retrying transient network failures.

    «В 100% случаев» is the whole point of this hook, and a single attempt does not
    meet it: the local VPN drops TLS mid-handshake at random (a real ping was lost
    to `handshake timed out` on 2026-07-16). Telegram rejects a malformed request
    deterministically, so only retry connection-level errors — retrying an HTTPError
    would just spam the same 400 three times.
    """
    # Deliver as a native Rich Message (`sendRichMessage` + `markdown`) so my GFM
    # answer renders with real headings/tables in Telegram. If the Bot API rejects
    # the rich payload (bad markdown / old server → HTTPError), fall back to a plain
    # `sendMessage` so delivery still hits «в 100% случаев». Connection errors are
    # retried; a deterministic 400 moves straight to the next method.
    # `thread_id` (when set) puts the message in this tab's native topic.
    thread_extra = {"message_thread_id": thread_id} if thread_id else {}
    plain_text = text if len(text) <= PLAIN_LIMIT else text[:PLAIN_LIMIT].rstrip() + " […]"
    methods = [
        ("sendRichMessage", {"chat_id": chat, "rich_message": {"markdown": text},
                             "disable_notification": False, **thread_extra}),
        ("sendMessage", {"chat_id": chat, "text": plain_text,
                         "disable_notification": False, **thread_extra}),
    ]
    if thread_id:
        # A deleted/stale topic 400s every threaded attempt; a final flat-chat send
        # guarantees the answer still reaches the user instead of vanishing silently.
        methods.append(("sendMessage", {"chat_id": chat, "text": plain_text,
                                        "disable_notification": False}))
    for i, (method, body) in enumerate(methods):
        last = i == len(methods) - 1
        req = urllib.request.Request(
            f"https://api.telegram.org/bot{token}/{method}",
            data=json.dumps(body).encode("utf-8"),
            headers={"content-type": "application/json"},
        )
        for attempt in range(1, ATTEMPTS + 1):
            try:
                urllib.request.urlopen(req, timeout=10).read()
                if attempt > 1:
                    _log(f"delivered on attempt {attempt} via {method}")
                return
            except urllib.error.HTTPError:
                if last:
                    raise  # plain also rejected — genuinely our bad request
                _log(f"{method} rejected (HTTPError) → falling back to plain")
                break  # try the next (plain) method
            except (urllib.error.URLError, OSError) as exc:
                if attempt == ATTEMPTS:
                    if last:
                        raise
                    break  # exhausted on rich → try plain (net may have recovered)
                _log(f"attempt {attempt} failed ({type(exc).__name__}), retrying")
                time.sleep(attempt)  # 1s, 2s — the VPN's drops are brief


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — a notifier must never block the session
        _log(f"FAILED {type(exc).__name__}: {exc}")
