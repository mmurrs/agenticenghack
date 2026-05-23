import re
from dataclasses import dataclass


@dataclass
class Intent:
    action: str          # "track" | "history" | "status" | "unknown"
    url: str | None
    threshold: float | None


_URL_RE = re.compile(r"https?://\S+")


def parse_intent(message: str) -> Intent:
    text = message.lower().strip()
    url_match = _URL_RE.search(message)
    url = url_match.group(0).rstrip(".,)") if url_match else None

    # Track intent: URL present + tracking keyword
    if url and any(w in text for w in ["track", "monitor", "watch", "alert"]):
        threshold = None
        under_match = re.search(
            r"(?:under|below|less than|cheaper than)\s*\$?(\d+(?:\.\d{1,2})?)", text
        )
        if under_match:
            threshold = float(under_match.group(1))
        return Intent(action="track", url=url, threshold=threshold)

    # History intent
    if any(w in text for w in ["history", "historical", "trend", "chart", "price over"]):
        return Intent(action="history", url=url, threshold=None)

    # Status intent
    if any(w in text for w in ["tracking", "watching", "what am i", "list", "status", "show me"]):
        return Intent(action="status", url=None, threshold=None)

    return Intent(action="unknown", url=None, threshold=None)
