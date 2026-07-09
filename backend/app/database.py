import sqlite3
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

DEFAULT_VOCABULARY = [
    ("Wispr Flow", "Dictation app name often misheard as whisper flow or wisper flow."),
    ("ROCm", "AMD open software stack often misheard as rock em."),
    ("Fireworks AI", "AI platform name often misheard as fireworks ay eye."),
    ("Gemma", "Google open model family, often misheard as jemma."),
    ("AMD Developer Cloud", "AMD cloud compute environment."),
    ("Codex", "AI coding agent."),
    ("FastAPI", "Python web framework."),
    ("SQLite", "Embedded database."),
]


class Database:
    def __init__(self, path: Path) -> None:
        self.path = path

    def init(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connect() as conn:
            conn.executescript(
                """
                CREATE TABLE IF NOT EXISTS vocabulary (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    term TEXT NOT NULL UNIQUE,
                    notes TEXT NOT NULL DEFAULT '',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );

                CREATE TABLE IF NOT EXISTS corrections (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    raw_text TEXT NOT NULL,
                    corrected_text TEXT NOT NULL,
                    context TEXT NOT NULL DEFAULT '',
                    provider TEXT NOT NULL DEFAULT 'mock',
                    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
                );
                """
            )

            count = conn.execute("SELECT COUNT(*) FROM vocabulary").fetchone()[0]
            if count == 0:
                conn.executemany(
                    "INSERT INTO vocabulary (term, notes) VALUES (?, ?)",
                    DEFAULT_VOCABULARY,
                )

    @contextmanager
    def connect(self) -> Iterator[sqlite3.Connection]:
        conn = sqlite3.connect(self.path)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()
