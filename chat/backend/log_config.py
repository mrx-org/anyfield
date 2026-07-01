"""Logging setup for the chat backend."""

from __future__ import annotations

import logging
import os
from logging.handlers import RotatingFileHandler
from pathlib import Path

_CONFIGURED = False
LOG_DIR = Path(__file__).resolve().parent / "logs"


def setup_logging() -> logging.Logger:
    global _CONFIGURED
    logger = logging.getLogger("anyfield.chat")
    if _CONFIGURED:
        return logger

    level_name = os.getenv("LOG_LEVEL", "INFO").upper()
    level = getattr(logging, level_name, logging.INFO)
    logger.setLevel(level)

    fmt = logging.Formatter(
        "%(asctime)s %(levelname)s [%(name)s] %(message)s",
        datefmt="%Y-%m-%d %H:%M:%S",
    )

    stream = logging.StreamHandler()
    stream.setFormatter(fmt)
    logger.addHandler(stream)

    log_file = os.getenv("LOG_FILE", str(LOG_DIR / "chat.log"))
    log_path = Path(log_file)
    log_path.parent.mkdir(parents=True, exist_ok=True)
    file_handler = RotatingFileHandler(
        log_path,
        maxBytes=int(os.getenv("LOG_MAX_BYTES", str(2 * 1024 * 1024))),
        backupCount=int(os.getenv("LOG_BACKUP_COUNT", "3")),
        encoding="utf-8",
    )
    file_handler.setFormatter(fmt)
    logger.addHandler(file_handler)

    logger.propagate = False
    _CONFIGURED = True
    logger.info("chat backend logging ready (file=%s level=%s)", log_path, level_name)
    return logger
