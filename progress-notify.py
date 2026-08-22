"""PostToolUse + Stop hook: a live «what I'm doing now» line in Telegram.

The Stop hook (`stop-notify.py`) pings the final answer once per turn. The user
wanted to see the process *moving* during a long turn, not just its end — so this
hook keeps ONE message per TAB and edits it as tools run, a throttled sitrep.

The line itself lives in the daemon (`/notify` bar mode). This hook fires in the
tab, in every subagent and in every workflow agent — separate processes with
separate session ids — and while each kept its own state file it painted its own
bar, so a tab running subagents showed several live lines side by side. The daemon
is the one process that talks to Telegram, so keying the line by tab label there
is what actually guarantees a single bar. Warm-up, throttling and the step counter
moved with it; all this hook still does is report what tool just ran.

Never blocks: any failure exits 0 quietly.
"""
from __future__ import annotations

import datetime as dt
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))  # hooks run with the project as cwd
import bridge_client  # noqa: E402

HOME = Path.home()
STATE_DIR = HOME / ".claude" / "claph" / "state"
LOG = STATE_DIR / "progress-notify.log"
FULL_AUTO = HOME / ".claude" / "state" / "full-auto.json"  # armed by the my-full-auto skill


def _log(msg: str) -> None:
    try:
        with LOG.open("a", encoding="utf-8") as fh:
            fh.write(f"{dt.datetime.now().isoformat(timespec='seconds')} {msg}\n")
    except OSError:
        pass


def _job_id() -> str | None:
    """This session's IMMUTABLE id — its job directory's name. Claude Code runs
    many named sessions out of ONE directory, so the cwd basename no longer
    identifies a tab; the session's `name` is no good either, since the harness
    rewrites it (none -> auto-generated -> the user's own) and a moving routing
    key forks a Telegram topic every time it moves. Mirrors shared.ts jobId()."""
    d = os.environ.get("CLAUDE_JOB_DIR")
    return (Path(d).name or None) if d else None


def _job_title() -> str | None:
    """The session's display name — it names the topic, it never routes."""
    d = os.environ.get("CLAUDE_JOB_DIR")
    if not d:
        return None
    try:
        st = json.loads((Path(d) / "state.json").read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None  # unreadable or mid-write; the topic just keeps its name
    return (st.get("name") or "").strip() or None


def _label(payload: dict) -> str:
    """This tab's key — same rule as shared.ts labelKey, so they share a thread."""
    # TG_BRIDGE_LABEL: pre-rename name still exported by existing launchers.
    env = (os.environ.get("CLAPH_LABEL") or os.environ.get("TG_BRIDGE_LABEL") or "").strip()
    return env or _job_id() or Path(payload.get("cwd") or ".").name


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


def main() -> None:
    raw = sys.stdin.buffer.read().decode("utf-8", errors="replace")
    payload = json.loads(raw or "{}")
    label = _label(payload)
    if payload.get("hook_event_name") == "Stop":
        # In my-full-auto the «turn» is artificial — keep-going.py blocks and
        # re-enters non-stop, so clearing per pseudo-turn would make the line
        # flicker and jump to the chat bottom. There stop-notify also stays
        # silent, so this bar is the run's only live pulse: leave it accumulating.
        if FULL_AUTO.exists():
            _log(f"stop: full-auto armed — keeping live line for {label}")
            return
        bridge_client.notify(bar=label, clear=True)
        return
    tool = payload.get("tool_name") or "?"
    bridge_client.notify(bar=label, title=_job_title(), tool=tool,
                         hint=_hint(tool, payload.get("tool_input") or {}))


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:  # noqa: BLE001 — a notifier must never block the session
        _log(f"FAILED {type(exc).__name__}: {exc}")
