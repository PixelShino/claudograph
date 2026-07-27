import importlib.util
import pathlib

p = pathlib.Path.home() / ".claude" / "claph" / "stop-notify.py"
spec = importlib.util.spec_from_file_location("sn", p)
sn = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sn)


def test_marker():
    s, d = sn._split_summary("<!-- tg: Готово: X. Дальше Y -->\n## Заголовок\nтело тело")
    assert s == "Готово: X. Дальше Y", s
    assert d and "тело тело" in d, d


def test_short_no_details():
    s, d = sn._split_summary("Короткий ответ.")
    assert s == "Короткий ответ." and d is None, (s, d)


def test_long_first_para_skips_heading():
    # Must exceed SUMMARY_SHORT (600) so the split rule engages, not the short path.
    body = "## Итог\nПервый абзац суть.\n\n" + ("Второй абзац детали. " * 40)
    s, d = sn._split_summary(body)
    assert s == "Первый абзац суть.", s
    assert d and "Второй абзац детали." in d, d


for t in (test_marker, test_short_no_details, test_long_first_para_skips_heading):
    t()
    print("ok", t.__name__)
