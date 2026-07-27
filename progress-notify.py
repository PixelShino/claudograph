"""PostToolUse + Stop hook: a live «what I'm doing now» line in Telegram.

The Stop hook (`stop-notify.py`) pings the final answer once per turn. The user
wanted to see the process *moving* during a long turn, not just its end — so this
hook keeps ONE message per turn and edits it as tools run, a throttled sitrep.

Same delivery as stop-notify: straight to the Bot API, no tab `handle` needed, so
it survives a dead daemon and needs no permission prompt. Keyed by `session_id`,
so two tabs sharing a repo keep separate progress lines.

Noise control, by design:
  - the line is created SILENTLY (disable_notification) — only stop-notify buzzes;
  - it appears only once a turn has some heft (>=3 tools OR >=10s), so a quick
    two-tool answer never flashes a progress message;
  - edits are throttled to one per THROTTLE seconds;
  - on Stop the live message is deleted, leaving only the final answer.

Never blocks: any failure exits 0 quietly.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # hooks run with the project as cwd
import bridge_client  # noqa: E402

HOME = Path.home()
TG_DIR = HOME / ".claude" / "channels" / "telegram"
STATE_DIR = HOME / ".claude" / "tg-bridge" / "state"
LOG = STATE_DIR / "progress-notify.log"
FULL_AUTO = HOME / ".claude" / "state" / "full-auto.json"  # armed by the my-full-auto skill

THROTTLE = 3.0        # seconds between edits — Telegram throttles editMessageText below this
WARMUP_TOOLS = 3      # don't show a line before this many tools…
WARMUP_SECS = 10.0    # …unless the turn has already run this long
ATTEMPTS = 3          # the VPN drops TLS at random; one shot silently loses it


def _log(msg: str) -> None:
    try:
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except OSError:
        pass


THREADS_FILE = STATE_DIR / "threads.json"


def _label(payload: dict) -> str:
    """This tab's key — same rule as session-mcp/stop-notify, so they share a thread."""
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


def _token() -> str:
    for line in (TG_DIR / ".env").read_text(encoding="utf-8").splitlines():
        if line.startswith("TELEGRAM_BOT_TOKEN"):
            return line.split("=", 1)[1].strip()
    return ""


def _chats() -> list[str]:
    access = json.loads((TG_DIR / "access.json").read_text(encoding="utf-8"))
    return [str(c) for c in access.get("allowFrom") or []]


def _state_path(sid: str) -> Path:
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in sid) or "default"
    return STATE_DIR / f"progress-{safe}.json"


def _api(token: str, method: str, payload: dict) -> dict:
    """One Bot API call, retrying only transient connection failures."""
    req = urllib.request.Request(
        f"https://api.telegram.org/bot{token}/{method}",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    for attempt in range(1, ATTEMPTS + 1):
        try:
            return json.loads(urllib.request.urlopen(req, timeout=10).read() or b"{}")
        except urllib.error.HTTPError:
            raise  # our own bad request — retrying cannot help
        except (urllib.error.URLError, OSError):
            if attempt == ATTEMPTS:
                raise
            time.sleep(attempt)
    return {}


def _create_rich(token: str, chat: str, text: str, thread_id=None) -> dict:
    """Create the live line as a native Rich Message; fall back to plain on a
    Bot API reject so the progress line still appears. thread_id (when set) puts
    the line in this tab's topic; edits inherit the thread from that message id."""
    thread_extra = {"message_thread_id": thread_id} if thread_id else {}
    try:
        return _api(token, "sendRichMessage",
                    {"chat_id": chat, "rich_message": {"markdown": text},
                     "disable_notification": True, **thread_extra})
    except urllib.error.HTTPError:
        try:
            return _api(token, "sendMessage",
                        {"chat_id": chat, "text": text, "disable_notification": True, **thread_extra})
        except urllib.error.HTTPError:
            # dead/stale topic -> flat chat, so the progress line never vanishes silently
            return _api(token, "sendMessage",
                        {"chat_id": chat, "text": text, "disable_notification": True})


def _edit_rich(token: str, chat: str, mid: int, text: str) -> None:
    """Edit the live line as Rich; fall back to plain; swallow «not modified»."""
    for body in ({"chat_id": chat, "message_id": mid, "rich_message": {"markdown": text}},
                 {"chat_id": chat, "message_id": mid, "text": text}):
        try:
            _api(token, "editMessageText", body)
            return
        except urllib.error.HTTPError:
            continue  # rich rejected → try plain; plain «not modified» → give up


def _hint(tool: str, inp: dict) -> str:
    """A short, human line for what a tool call is doing."""
    if tool == "Bash":
        return inp.get("description") or inp.get("command", "")
    if tool in ("Read", "Edit", "Write", "NotebookEdit"):
        return Path(str(inp.get("file_path", ""))).name or tool
    if tool in ("Grep", "Glob"):
        return str(inp.get("pattern", "")) or tool
    if tool in ("Task", "Agent"):
        return str(inp.get("description", "")) or tool
    if tool.startswith("mcp__"):
        return tool.split("__")[-1]
    return tool


BAR_CELLS = 10  # the bar is a PULSE, not a percentage: total steps are unknowable


def _compose(tab: str, tool: str, hint: str, started: float, count: int) -> str:
    """The live line, user-chosen layout (2026-07-27): a bar instead of per-tool
    emoji, which read as clutter. The bar cycles every BAR_CELLS steps — it shows
    that work is MOVING, and deliberately doesn't pretend to know how far along we
    are. Monospace keeps the cells from jittering as the text around them changes;
    the wall-clock stamp makes a frozen line obvious at a glance."""
    elapsed = int(max(0.0, time.time() - started))
    hint = hint.strip().replace("\n", " ")
    if len(hint) > 70:
        hint = hint[:70].rstrip() + "…"
    filled = (count - 1) % BAR_CELLS + 1
    bar = "▰" * filled + "▱" * (BAR_CELLS - filled)
    return (f"### {tab}\n\n"
            f"`{bar}`\n\n"
            f"> `{tool}` · {hint}\n\n"
            f"**шаг {count}**\n"
            f"таймер {elapsed // 60}:{elapsed % 60:02d}\n"
            f"обновлено {dt.datetime.now():%H:%M:%S}")


def _handle_stop(sid: str) -> None:
    """Turn ended: delete the live line (final answer comes from stop-notify) and
    reset state so the next turn starts fresh.

    In my-full-auto the «turn» is artificial — keep-going.py blocks and re-enters
    non-stop, so deleting per pseudo-turn would make the line flicker and jump to
    the chat bottom. There `stop-notify` also stays silent, so this progress line
    is the run's only live pulse: leave it intact so ONE message keeps updating and
    accumulating `⏱ time · step N` for the whole autonomous run. Real cleanup
    happens on the first normal Stop once full-auto is disarmed."""
    if FULL_AUTO.exists():
        _log(f"stop: full-auto armed — keeping live line for {sid}")
        return
    path = _state_path(sid)
    if not path.exists():
        return
    try:
        st = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        st = {}
    ids = st.get("message_ids") or {}
    if ids and bridge_client.notify(ids=ids, delete=True) is None:
        token = _token()
        for chat, mid in ids.items():
            try:
                _api(token, "deleteMessage", {"chat_id": chat, "message_id": mid})
            except Exception:  # noqa: BLE001 — best-effort cleanup
                pass
    try:
        path.unlink()
    except OSError:
        pass
    _log(f"stop: cleared {sid}")


def _handle_tool(payload: dict) -> None:
    sid = payload.get("session_id") or "default"
    tool = payload.get("tool_name") or "?"
    inp = payload.get("tool_input") or {}
    tab = Path(payload.get("cwd") or ".").name
    path = _state_path(sid)
    now = time.time()

    try:
        st = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        st = {"started": now, "last_edit": 0.0, "count": 0, "message_ids": {}}

    st["count"] = int(st.get("count", 0)) + 1
    st.setdefault("started", now)
    st.setdefault("message_ids", {})

    live = bool(st["message_ids"])
    warm = st["count"] >= WARMUP_TOOLS or (now - st["started"]) >= WARMUP_SECS
    # Not warm yet and nothing on screen → just remember we ticked, no network.
    if not live and not warm:
        path.write_text(json.dumps(st), encoding="utf-8")
        return
    # Live but inside the throttle window → count it, skip the edit.
    if live and (now - float(st.get("last_edit", 0))) < THROTTLE:
        path.write_text(json.dumps(st), encoding="utf-8")
        return

    text = _compose(tab, tool, _hint(tool, inp), st["started"], st["count"])
    tab_label = _label(payload)
    # Through the daemon first (see bridge_client); direct Bot API is the fallback.
    res = bridge_client.notify(
        label=tab_label, text=text, silent=True,
        **({"ids": st["message_ids"]} if live else {}),
    )
    if res is not None:
        if not live:
            st["message_ids"] = {c: int(m) for c, m in (res.get("ids") or {}).items()}
            _log(f"created {sid} at step {st['count']} via daemon")
        st["last_edit"] = now
        path.write_text(json.dumps(st), encoding="utf-8")
        return

    token = _token()
    tid = _thread_id(tab_label)
    if not live:
        for chat in _chats():
            res = _create_rich(token, chat, text, tid)
            mid = (res.get("result") or {}).get("message_id")
            if mid:
                st["message_ids"][chat] = mid
        _log(f"created {sid} at step {st['count']}")
    else:
        for chat, mid in st["message_ids"].items():
            _edit_rich(token, chat, mid, text)
    st["last_edit"] = now
    path.write_text(json.dumps(st), encoding="utf-8")


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    payload = json.loads(raw or "{}")
    event = payload.get("hook_event_name") or ""
    if event == "Stop":
        _handle_stop(payload.get("session_id") or "default")
    else:  # PostToolUse
        _handle_tool(payload)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — a notifier must never block the session
        _log(f"FAILED {type(exc).__name__}: {exc}")
