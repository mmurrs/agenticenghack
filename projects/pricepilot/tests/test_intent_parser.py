import pytest
from agent.intent_parser import parse_intent, Intent


def test_parse_track_with_amazon_url_and_threshold():
    result = parse_intent(
        "Track https://www.amazon.com/dp/B09XS7JWHH alert me when under $89"
    )
    assert result.action == "track"
    assert "amazon.com" in result.url
    assert result.threshold == 89.0


def test_parse_track_with_no_threshold_defaults_to_none():
    result = parse_intent("Track https://www.amazon.com/dp/B09XS7JWHH")
    assert result.action == "track"
    assert result.threshold is None


def test_parse_history_query():
    result = parse_intent("What's the price history for my items?")
    assert result.action == "history"
    assert result.url is None


def test_parse_status_query():
    result = parse_intent("What am I tracking?")
    assert result.action == "status"


def test_parse_unknown_falls_back_to_unknown():
    result = parse_intent("Hello there!")
    assert result.action == "unknown"
