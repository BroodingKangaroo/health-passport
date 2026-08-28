"""Unit tests for the deterministic OCR-markdown cleaner (input-token
compression before any LLM sees the document)."""

from app.services.extractor import _clean_ocr_markdown

HEADER = "INVITRO\nГОЛОВАТЫЙ М.А.\nДата взятия образца: 26.05.2026"


def test_drops_table_separator_rows_and_page_furniture():
    md = (
        "|  Гемоглобин | **14.7** | г/дл | 13.2 - 17.3 |\n"
        "| --- | --- | --- | --- |\n"
        "| --- |\n"
        "стр.1 из 2\n"
        "Продолжение на следующей странице\n"
        "-----\n"
        "Page 2\n"
    )
    out = _clean_ocr_markdown(md)
    assert "Гемоглобин" in out
    assert "---" not in out
    assert "стр.1" not in out
    assert "Продолжение" not in out
    assert "Page 2" not in out


def test_dedupes_repeated_header_keep_first_protects_tabular_rows():
    md = (
        f"{HEADER}\n"
        "|  Гемоглобин | **14.7** |\n"
        f"{HEADER}\n"  # page 2 repeats the header verbatim
        "|  Гемоглобин | **14.7** |\n"  # identical TABULAR row must survive
    )
    out = _clean_ocr_markdown(md)
    assert out.count("ГОЛОВАТЫЙ") == 1  # header kept once
    assert out.count("|  Гемоглобин | **14.7** |") == 2  # rows untouched


def test_drops_standalone_urls_and_collapses_blank_runs():
    md = "Клинический анализ крови\n\n\n\nwww.invitro.by\nhttps://lab.example/x\n\n\n\nСОЭ **8**"
    out = _clean_ocr_markdown(md)
    assert "invitro" not in out and "lab.example" not in out
    assert "\n\n\n" not in out
    assert "Клинический анализ крови" in out and "СОЭ **8**" in out


def test_long_and_tabular_lines_are_never_deduped():
    long_line = "Длинная клиническая заметка " * 8  # >120 chars
    md = f"{long_line}\n{long_line}\n"
    out = _clean_ocr_markdown(md)
    assert out.count(long_line.strip()) == 2


def test_realistic_page_pair_shrinks_but_keeps_all_table_rows():
    sep = "| --- | --- | --- | --- | --- | --- |"
    row = "|  Гематокрит | **42.8** | 42.3 16.05.26 | % | 39 - 49 |   |"
    md = (
        f"{HEADER}\n{sep}\n{row}\n{sep}\nстр.1 из 2\n"
        f"{HEADER}\n{sep}\n{row}\n{sep}\nстр.2 из 2\n"
    )
    out = _clean_ocr_markdown(md)
    assert out.count(row) == 2
    assert sep not in out
    assert out.count("Дата взятия образца") == 1
    assert len(out) < len(md)
