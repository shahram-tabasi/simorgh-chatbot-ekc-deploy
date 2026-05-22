"""Tests for the shared simorgh_artifacts module."""

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(HERE))

import simorgh_artifacts as sa  # noqa: E402


def test_classify_text_files():
    for ext in [".py", ".md", ".txt", ".json", ".yaml", ".sh", ".tsx"]:
        assert sa.classify(f"a/b/c{ext}") == "text", ext


def test_classify_images():
    for ext in [".png", ".jpg", ".jpeg", ".tiff", ".webp"]:
        assert sa.classify(f"img/x{ext}") == "image", ext


def test_classify_office_and_pdf():
    for ext in [".pdf", ".docx", ".xlsx", ".pptx"]:
        assert sa.classify(f"docs/x{ext}") == "doc", ext


def test_classify_skip():
    for ext in [".zip", ".tar.gz", ".exe", ".pyc", ".mp3"]:
        # tar.gz suffix detection is just on the final ".gz" — fine.
        assert sa.classify(f"x{ext}") == "skip", ext


def test_classify_dotfiles_and_no_ext():
    assert sa.classify("Dockerfile") == "text"
    assert sa.classify("Makefile") == "text"
    assert sa.classify("README") == "text"
    assert sa.classify("LICENSE") == "text"
    assert sa.classify(".gitignore") == "text"
    assert sa.classify("path/without/ext") == "text"


def test_classify_case_insensitive():
    assert sa.classify("Report.PDF") == "doc"
    assert sa.classify("photo.JPG") == "image"


def test_needs_extraction_only_for_non_text():
    assert sa.needs_extraction("a.pdf") is True
    assert sa.needs_extraction("a.png") is True
    assert sa.needs_extraction("a.py") is False
    assert sa.needs_extraction("a.zip") is False


def test_extracted_path_for_relative():
    assert sa.extracted_path_for("reports/q1.pdf") == ".simorgh/extracted/reports/q1.pdf.md"


def test_extracted_path_for_absolute():
    out = sa.extracted_path_for("/work/gitlab/a/b.xlsx")
    assert out == ".simorgh/extracted/work/gitlab/a/b.xlsx.md"


def test_extracted_path_for_bare_filename():
    assert sa.extracted_path_for("image.png") == ".simorgh/extracted/image.png.md"


def test_iter_extractable_filters_correctly():
    inputs = [
        "src/main.py",      # text — skip
        "docs/report.pdf",  # doc — keep
        "img/diagram.png",  # image — keep
        "build/a.exe",      # skip
        "Dockerfile",       # text — skip
        "weird.xyz",        # unknown — keep (caller will decide)
    ]
    out = dict(sa.iter_extractable(inputs))
    assert "docs/report.pdf" in out and out["docs/report.pdf"] == "doc"
    assert "img/diagram.png" in out and out["img/diagram.png"] == "image"
    assert "weird.xyz" in out and out["weird.xyz"] == "unknown"
    assert "src/main.py" not in out
    assert "build/a.exe" not in out
    assert "Dockerfile" not in out


def test_doc_processor_client_uses_env(monkeypatch):
    monkeypatch.setenv("DOC_PROCESSOR_URL", "http://custom-doc-proc:9999/")
    c = sa.DocProcessorClient()
    assert c.base_url == "http://custom-doc-proc:9999"


def test_doc_processor_client_explicit_arg_wins():
    c = sa.DocProcessorClient(base_url="http://override:1234")
    assert c.base_url == "http://override:1234"
