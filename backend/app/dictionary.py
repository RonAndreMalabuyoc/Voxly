import re
from pathlib import Path

from app.schemas import DiscoveredWord, VocabularyItem

COMMON_WORDS = {
    "about",
    "after",
    "again",
    "also",
    "and",
    "another",
    "are",
    "around",
    "because",
    "been",
    "before",
    "build",
    "can",
    "clash",
    "context",
    "correct",
    "could",
    "down",
    "each",
    "engine",
    "every",
    "final",
    "first",
    "for",
    "from",
    "going",
    "great",
    "hand",
    "have",
    "here",
    "into",
    "like",
    "long",
    "mention",
    "mentions",
    "more",
    "most",
    "not",
    "now",
    "one",
    "only",
    "over",
    "project",
    "raw",
    "really",
    "record",
    "recording",
    "run",
    "said",
    "saying",
    "section",
    "seen",
    "should",
    "simple",
    "since",
    "some",
    "spectacular",
    "style",
    "text",
    "than",
    "that",
    "the",
    "their",
    "them",
    "then",
    "they",
    "this",
    "through",
    "transcript",
    "using",
    "want",
    "what",
    "when",
    "where",
    "with",
    "word",
    "words",
    "would",
    "you",
    "your",
}

TOKEN_RE = re.compile(r"[A-Za-z][A-Za-z0-9'_-]{2,}")


class MarkdownDictionary:
    def __init__(self, path: Path) -> None:
        self.path = path

    def init(self, seed_items: list[tuple[str, str]]) -> None:
        if self.path.exists():
            return

        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._write(seed_items, [])

    def list_terms(self) -> list[VocabularyItem]:
        terms, _ = self._read()
        return [VocabularyItem(id=index + 1, term=term, notes=notes) for index, (term, notes) in enumerate(terms)]

    def list_term_names(self) -> list[str]:
        terms, _ = self._read()
        return [term for term, _ in terms]

    def list_transcription_keyterms(self) -> list[str]:
        terms, _ = self._read()
        return [term for term, notes in terms if is_transcription_keyterm(notes)]

    def add_term(self, term: str, notes: str = "") -> VocabularyItem:
        clean_term = normalize_display_term(term)
        clean_notes = " ".join(notes.strip().split())
        if not clean_term:
            raise ValueError("Term is required.")

        terms, pending = self._read()
        if any(existing.lower() == clean_term.lower() for existing, _ in terms):
            raise ValueError("Term already exists.")

        terms.append((clean_term, clean_notes))
        pending = [candidate for candidate in pending if candidate.lower() != clean_term.lower()]
        self._write(sort_terms(terms), pending)
        return self._find_term(clean_term)

    def update_term(self, item_id: int, term: str, notes: str = "") -> VocabularyItem:
        terms, pending = self._read()
        index = item_id - 1
        if index < 0 or index >= len(terms):
            raise KeyError("Term not found.")

        clean_term = normalize_display_term(term)
        clean_notes = " ".join(notes.strip().split())
        if not clean_term:
            raise ValueError("Term is required.")

        for existing_index, (existing, _) in enumerate(terms):
            if existing_index != index and existing.lower() == clean_term.lower():
                raise ValueError("Term already exists.")

        terms[index] = (clean_term, clean_notes)
        self._write(sort_terms(terms), pending)
        return self._find_term(clean_term)

    def delete_term(self, item_id: int) -> None:
        terms, pending = self._read()
        index = item_id - 1
        if index < 0 or index >= len(terms):
            raise KeyError("Term not found.")

        del terms[index]
        self._write(terms, pending)

    def discover(self, text: str) -> list[DiscoveredWord]:
        terms, pending = self._read()
        known = {term.lower() for term, _ in terms}
        known.update(candidate.lower() for candidate in pending)

        discovered = []
        for token in TOKEN_RE.findall(text):
            candidate = normalize_display_term(token)
            key = candidate.lower()
            if key in known or key in COMMON_WORDS or not should_discover(candidate):
                continue
            known.add(key)
            pending.append(candidate)
            discovered.append(candidate)

        if discovered:
            self._write(terms, sorted(pending, key=str.lower))

        return self.list_pending()

    def list_pending(self) -> list[DiscoveredWord]:
        _, pending = self._read()
        return [DiscoveredWord(id=index + 1, term=term) for index, term in enumerate(pending)]

    def accept_pending(self, item_id: int, term: str | None = None, notes: str = "") -> VocabularyItem:
        terms, pending = self._read()
        index = item_id - 1
        if index < 0 or index >= len(pending):
            raise KeyError("Discovered word not found.")

        clean_term = normalize_display_term(term or pending[index])
        clean_notes = " ".join(notes.strip().split())
        if not clean_term:
            raise ValueError("Term is required.")
        if any(existing.lower() == clean_term.lower() for existing, _ in terms):
            raise ValueError("Term already exists.")

        pending.pop(index)
        terms.append((clean_term, clean_notes))
        self._write(sort_terms(terms), pending)
        return self._find_term(clean_term)

    def dismiss_pending(self, item_id: int) -> None:
        terms, pending = self._read()
        index = item_id - 1
        if index < 0 or index >= len(pending):
            raise KeyError("Discovered word not found.")

        del pending[index]
        self._write(terms, pending)

    def _find_term(self, term: str) -> VocabularyItem:
        for item in self.list_terms():
            if item.term.lower() == term.lower():
                return item
        raise KeyError("Term not found.")

    def _read(self) -> tuple[list[tuple[str, str]], list[str]]:
        if not self.path.exists():
            return [], []

        terms: list[tuple[str, str]] = []
        pending: list[str] = []
        section = ""
        for line in self.path.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped == "## Terms":
                section = "terms"
                continue
            if stripped == "## Discovered":
                section = "discovered"
                continue
            if not stripped.startswith("- "):
                continue

            value = stripped[2:].strip()
            if section == "terms":
                term, notes = parse_term_line(value)
                if term:
                    terms.append((term, notes))
            elif section == "discovered":
                pending.append(value)

        return sort_terms(dedupe_terms(terms)), sorted(dedupe_values(pending), key=str.lower)

    def _write(self, terms: list[tuple[str, str]], pending: list[str]) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        lines = [
            "# Voxly Personal Dictionary",
            "",
            "## Terms",
        ]
        if terms:
            lines.extend(format_term_line(term, notes) for term, notes in sort_terms(dedupe_terms(terms)))
        else:
            lines.append("-")

        lines.extend(["", "## Discovered"])
        if pending:
            lines.extend(f"- {value}" for value in sorted(dedupe_values(pending), key=str.lower))
        else:
            lines.append("-")

        self.path.write_text("\n".join(lines) + "\n", encoding="utf-8")


def parse_term_line(value: str) -> tuple[str, str]:
    if not value or value == "-":
        return "", ""
    term, separator, notes = value.partition(" | ")
    return normalize_display_term(term), notes.strip() if separator else ""


def format_term_line(term: str, notes: str) -> str:
    return f"- {term} | {notes}" if notes else f"- {term}"


def normalize_display_term(value: str) -> str:
    return " ".join(value.replace("|", " ").strip(".,!?;:\"'()[]{}").split())


def should_discover(candidate: str) -> bool:
    if len(candidate) < 4:
        return False
    if any(char.isdigit() for char in candidate):
        return True
    if any(char.isupper() for char in candidate[1:]):
        return True
    return candidate.lower() not in COMMON_WORDS and len(candidate) >= 6


def is_transcription_keyterm(notes: str) -> bool:
    normalized = notes.lower()
    return "#stt" in normalized or "deepgram" in normalized or "transcription" in normalized


def sort_terms(terms: list[tuple[str, str]]) -> list[tuple[str, str]]:
    return sorted(terms, key=lambda item: item[0].lower())


def dedupe_terms(terms: list[tuple[str, str]]) -> list[tuple[str, str]]:
    seen = set()
    deduped = []
    for term, notes in terms:
        key = term.lower()
        if not term or key in seen:
            continue
        seen.add(key)
        deduped.append((term, notes))
    return deduped


def dedupe_values(values: list[str]) -> list[str]:
    seen = set()
    deduped = []
    for value in values:
        clean = normalize_display_term(value)
        key = clean.lower()
        if not clean or clean == "-" or key in seen:
            continue
        seen.add(key)
        deduped.append(clean)
    return deduped
