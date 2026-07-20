import importlib.util
import pathlib

p = pathlib.Path.home() / ".claude" / "tg-bridge" / "stop-notify.py"
spec = importlib.util.spec_from_file_location("sn", p)
sn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sn)


def asst(*blocks):
    return {"type": "assistant", "message": {"content": list(blocks)}}


def user():
    return {"type": "user", "message": {"content": "prompt"}}


def T(s):
    return {"type": "text", "text": s}


BASH = {"type": "tool_use", "name": "Bash", "input": {}}
SEND_BTN = {"type": "tool_use", "name": "mcp__tg-bridge__send",
            "input": {"text": "выбор", "buttons": [{"key": "a", "label": "A"}]}}
SEND_PLAIN = {"type": "tool_use", "name": "mcp__tg-bridge__send",
              "input": {"text": "взял в работу"}}
# The answer itself, sent by hand — not a status ping.
SEND_ANSWER = {"type": "tool_use", "name": "mcp__tg-bridge__send",
               "input": {"text": "Переделал. Ты прав был по сути: " + "и" * 900}}
SEND_PHOTOS = {"type": "tool_use", "name": "mcp__tg-bridge__send_album",
               "input": {"paths": ["a.png", "b.png"], "caption": "скрины"}}


def _run(recs):
    start = sn._turn_start(recs)
    a = sn._last_answer_index(recs, start)
    return sn._ended_with_ping(recs, start, a)


def test_bug_button_send_before_text_suppresses():
    # THE BUG: an interactive send (buttons) precedes a wrap-up text -> mirror was
    # double-posting on top of it. Must suppress.
    recs = [user(), asst(SEND_BTN), asst(BASH), asst(T("Ответил в Telegram: ..."))]
    assert _run(recs) is True, "button-send before text must suppress mirror"


def test_plain_ping_before_text_still_mirrors():
    # «взял в работу» (no buttons) then a real result text -> the result must still
    # reach Telegram, so DON'T suppress.
    recs = [user(), asst(SEND_PLAIN), asst(BASH), asst(T("Реальный результат."))]
    assert _run(recs) is False, "plain ping before text must NOT suppress the result mirror"


def test_text_and_send_same_message_suppresses():
    recs = [user(), asst(T("взял в работу"), SEND_BTN), asst(BASH), asst(T("результат"), SEND_BTN)]
    assert _run(recs) is True


def test_early_plain_ping_only_mirrors():
    recs = [user(), asst(T("взял в работу"), SEND_PLAIN), asst(BASH), asst(T("результат"))]
    assert _run(recs) is False


def test_send_after_text_suppresses():
    recs = [user(), asst(T("результат")), asst(SEND_PLAIN)]
    assert _run(recs) is True


def test_bug_full_answer_sent_by_hand_then_pointer_text_suppresses():
    # THE BUG (2026-07-20): the answer went out via an explicit plain `send`, then
    # the wrap-up line in the terminal was «Переделал, скрины в тг.» — a pointer,
    # not a result. Mirroring it posted the turn twice.
    recs = [user(), asst(SEND_ANSWER), asst(BASH), asst(T("Переделал, скрины в тг."))]
    assert _run(recs) is True, "a substantial hand-sent answer must suppress the mirror"


def test_photo_album_with_short_caption_still_mirrors():
    # Screenshots + a real text answer are not a duplicate: the caption is not the
    # answer, so the text must still reach Telegram.
    recs = [user(), asst(SEND_PHOTOS), asst(T("Вот что изменилось: " + "и" * 500))]
    assert _run(recs) is False, "a short caption must not suppress the result mirror"


for t in (
    test_bug_full_answer_sent_by_hand_then_pointer_text_suppresses,
    test_photo_album_with_short_caption_still_mirrors,
    test_bug_button_send_before_text_suppresses,
    test_plain_ping_before_text_still_mirrors,
    test_text_and_send_same_message_suppresses,
    test_early_plain_ping_only_mirrors,
    test_send_after_text_suppresses,
):
    t()
    print("ok", t.__name__)
