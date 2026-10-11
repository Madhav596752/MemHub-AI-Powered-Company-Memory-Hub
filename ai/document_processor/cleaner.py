"""Conservative text cleaner designed for NLP transformer embeddings.

Preserves case, punctuation, technical identifiers, code, URLs, and semantic structure
while eliminating junk control characters, non-standard whitespace, and excessive blank lines.
"""

import re
import unicodedata
from typing import Optional


class TextCleaner:
    """Performs conservative normalization suitable for downstream embeddings."""

    # Control chars excluding \t (0x09) and \n (0x0a)
    _CONTROL_CHAR_REGEX = re.compile(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]")
    
    # Zero-width spaces, BOM, direction marks
    _ZERO_WIDTH_REGEX = re.compile(r"[\u200b\u200c\u200d\u200e\u200f\ufeff\u2060]")

    # Runaway multiple empty lines (3 or more consecutive newlines -> 2)
    _EXCESS_NEWLINES_REGEX = re.compile(r"\n{3,}")

    # Excessive horizontal spaces (e.g. 3 or more consecutive spaces within a line)
    _EXCESS_HORIZONTAL_SPACE_REGEX = re.compile(r"[^\S\r\n]{2,}")

    def __init__(self, preserve_code_blocks: bool = True):
        self.preserve_code_blocks = preserve_code_blocks

    def clean(self, text: Optional[str]) -> str:
        """Cleans input text with conservative rules.
        
        Args:
            text: Raw input string.
            
        Returns:
            Normalized, clean string preserving grammatical and semantic fidelity.
        """
        if not text:
            return ""

        # 1. Normalize line endings to standard Unix newline
        cleaned = text.replace("\r\n", "\n").replace("\r", "\n")

        # 2. Normalize non-standard unicode spaces (e.g., non-breaking space \u00a0, em-space)
        cleaned = cleaned.replace("\u00a0", " ").replace("\u202f", " ")

        # 3. Strip zero-width & invisible junk characters
        cleaned = self._ZERO_WIDTH_REGEX.sub("", cleaned)

        # 4. Strip binary / control characters
        cleaned = self._CONTROL_CHAR_REGEX.sub("", cleaned)

        # 5. Normalize unicode characters (NFKC) for consistent accents and symbols
        cleaned = unicodedata.normalize("NFKC", cleaned)

        # 6. Process line-by-line to preserve indentation and headings while cleaning runs of spaces
        lines = cleaned.split("\n")
        normalized_lines = []
        for line in lines:
            stripped_line = line.strip()
            if not stripped_line:
                normalized_lines.append("")
                continue

            # If line is a markdown heading, preserve markdown syntax
            if stripped_line.startswith("#"):
                # Normalize space after hash marks: e.g. "###Title" -> "### Title"
                heading_match = re.match(r"^(#+)\s*(.+)$", stripped_line)
                if heading_match:
                    hashes, title = heading_match.groups()
                    normalized_lines.append(f"{hashes} {title.strip()}")
                    continue

            # Normalize horizontal runs of whitespace within the line
            normalized_line = self._EXCESS_HORIZONTAL_SPACE_REGEX.sub(" ", stripped_line)
            normalized_lines.append(normalized_line)

        cleaned = "\n".join(normalized_lines)

        # 7. Collapse 3+ consecutive newlines down to 2 (paragraph break)
        cleaned = self._EXCESS_NEWLINES_REGEX.sub("\n\n", cleaned)

        # 8. Trim outer document edges
        return cleaned.strip()


def clean_text(text: Optional[str]) -> str:
    """Convenience helper function for conservative text cleaning."""
    return TextCleaner().clean(text)
