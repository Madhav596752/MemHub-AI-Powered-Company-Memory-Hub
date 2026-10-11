"""Unit tests for conservative text cleaner."""

from ai.document_processor.cleaner import TextCleaner, clean_text


def test_preserves_case_and_punctuation():
    cleaner = TextCleaner()
    raw = "The Quick Brown Fox jumped over the Lazy Dog! Does it cost $59.99? (Yes, it does)."
    cleaned = cleaner.clean(raw)
    assert cleaned == raw
    assert "Quick" in cleaned
    assert "$" in cleaned
    assert "?" in cleaned
    assert "!" in cleaned


def test_preserves_technical_identifiers_and_urls():
    cleaner = TextCleaner()
    raw = (
        "Check endpoint https://api.memhub.ai/v2/users/auth_verify.\n"
        "Set JWT_SECRET_KEY=prod_xyz123 and run verifyUserToken(req)."
    )
    cleaned = cleaner.clean(raw)
    assert "https://api.memhub.ai/v2/users/auth_verify" in cleaned
    assert "JWT_SECRET_KEY=prod_xyz123" in cleaned
    assert "verifyUserToken(req)" in cleaned


def test_normalizes_whitespace_and_excess_newlines():
    cleaner = TextCleaner()
    raw = "Paragraph One.\n\n\n\n\nParagraph Two with    lots    of   spaces.\n\n\nParagraph Three."
    cleaned = cleaner.clean(raw)
    assert "Paragraph One.\n\nParagraph Two with lots of spaces.\n\nParagraph Three." == cleaned


def test_strips_control_characters_and_zero_width():
    cleaner = TextCleaner()
    # \x00 null byte, \u200b zero width space, \u00a0 non-breaking space
    raw = "Hello\x00 World\u200b! Special\u00a0value."
    cleaned = cleaner.clean(raw)
    assert "\x00" not in cleaned
    assert "\u200b" not in cleaned
    assert cleaned == "Hello World! Special value."


def test_does_not_remove_stopwords_or_stem():
    cleaner = TextCleaner()
    raw = "This is a document about running, walking, and being an engineer."
    cleaned = cleaner.clean(raw)
    # Stopwords like "is", "a", "and" are intact
    assert "is a document" in cleaned
    assert "and being" in cleaned
    # Not stemmed (running is not run, walking is not walk)
    assert "running" in cleaned
    assert "walking" in cleaned
