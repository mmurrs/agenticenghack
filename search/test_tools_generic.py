"""
Unit tests for search/tools.py generic product support.

All tests mock _nimble_agent_run so no real API keys are required.
Run with: python -m pytest search/test_tools_generic.py -v
"""
from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, patch

import pytest

from search.tools import (
    ProductSpec,
    SizeSpec,
    _amazon_query,
    _validate_product_spec,
    build_product_spec,
)


# ---------------------------------------------------------------------------
# build_product_spec tests
# ---------------------------------------------------------------------------


class TestBuildProductSpecGeneric:
    """Test that build_product_spec works for non-shoe products (no size)."""

    def test_sony_headphones_no_size(self):
        """build_product_spec succeeds for an electronics product without size."""
        spec = build_product_spec(brand="Sony", model="WH-1000XM5")
        assert spec.brand == "Sony"
        assert spec.model == "WH-1000XM5"
        assert spec.size is None
        assert spec.category == "general"

    def test_sony_headphones_with_category(self):
        """Category can be set to any string for non-shoe products."""
        spec = build_product_spec(
            brand="Sony",
            model="WH-1000XM5",
            category="electronics",
        )
        assert spec.category == "electronics"
        assert spec.size is None

    def test_sony_headphones_with_color(self):
        """Color is still accepted for non-shoe products."""
        spec = build_product_spec(
            brand="Sony",
            model="WH-1000XM5",
            color="Black",
        )
        assert spec.color == "Black"
        assert spec.size is None

    def test_apple_airpods_no_size(self):
        """Another electronics product without size."""
        spec = build_product_spec(brand="Apple", model="AirPods Pro 2")
        assert spec.brand == "Apple"
        assert spec.model == "AirPods Pro 2"
        assert spec.size is None


class TestBuildProductSpecShoes:
    """Test that shoe queries with size still work (backward compat)."""

    def test_nike_killshot_with_size(self):
        """build_product_spec still works when size dict is provided."""
        spec = build_product_spec(
            brand="Nike",
            model="Killshot 2",
            size={"value": 11},
            category="shoes",
        )
        assert spec.brand == "Nike"
        assert spec.model == "Killshot 2"
        assert spec.size is not None
        assert spec.size.value == 11.0
        assert spec.size.gender == "men"
        assert spec.size.system == "US"

    def test_crocs_with_float_size(self):
        """Float size value (legacy path) still works."""
        spec = build_product_spec(
            brand="Crocs",
            model="Classic Clog",
            size=10.0,
            category="shoes",
        )
        assert spec.size is not None
        assert spec.size.value == 10.0

    def test_shoe_with_size_us_men(self):
        """size_us_men kwarg still works for backward compat."""
        spec = build_product_spec(
            brand="Nike",
            model="Air Force 1",
            size_us_men=9.5,
            category="shoes",
        )
        assert spec.size is not None
        assert spec.size.value == 9.5
        assert spec.size.gender == "men"

    def test_shoe_with_full_size_spec(self):
        """Passing a SizeSpec object directly still works."""
        size = SizeSpec(system="US", gender="women", value=8.0)
        spec = build_product_spec(
            brand="Nike",
            model="Killshot 2",
            size=size,
            category="shoes",
        )
        assert spec.size is size


# ---------------------------------------------------------------------------
# _validate_product_spec tests
# ---------------------------------------------------------------------------


class TestValidateProductSpec:
    """Test _validate_product_spec accepts any category and only validates size when present."""

    def test_passes_for_electronics_category(self):
        """Non-shoe category no longer raises ValueError."""
        spec = ProductSpec(brand="Sony", model="WH-1000XM5", category="electronics")
        # Must not raise
        _validate_product_spec(spec)

    def test_passes_for_general_category(self):
        """'general' category is accepted."""
        spec = ProductSpec(brand="Bose", model="QuietComfort 45", category="general")
        _validate_product_spec(spec)

    def test_passes_for_shoes_with_size(self):
        """Shoes with a valid size still pass."""
        spec = ProductSpec(
            brand="Nike",
            model="Killshot 2",
            size=SizeSpec(system="US", gender="men", value=11.0),
            category="shoes",
        )
        _validate_product_spec(spec)

    def test_passes_for_no_size(self):
        """No size provided (generic product) passes validation."""
        spec = ProductSpec(brand="Sony", model="WH-1000XM5")
        _validate_product_spec(spec)  # must not raise

    def test_raises_for_invalid_size_value(self):
        """A size with out-of-range value still raises even for non-shoe category."""
        spec = ProductSpec(
            brand="Nike",
            model="Killshot 2",
            size=SizeSpec(system="US", gender="men", value=99.0),
            category="electronics",  # category doesn't matter; size value is invalid
        )
        with pytest.raises(ValueError, match="shoe size"):
            _validate_product_spec(spec)

    def test_raises_for_bad_condition(self):
        """Invalid condition still raises."""
        spec = ProductSpec(brand="Sony", model="WH-1000XM5", condition="refurbished")  # type: ignore[arg-type]
        with pytest.raises(ValueError, match="condition"):
            _validate_product_spec(spec)


# ---------------------------------------------------------------------------
# _amazon_query tests
# ---------------------------------------------------------------------------


class TestAmazonQuery:
    """Test that _amazon_query builds correct search strings."""

    def test_no_size_returns_brand_model_only(self):
        """Sony WH-1000XM5 without size returns just 'Sony WH-1000XM5'."""
        spec = ProductSpec(brand="Sony", model="WH-1000XM5")
        result = _amazon_query(spec)
        assert result == "Sony WH-1000XM5"

    def test_no_size_with_color(self):
        """Color is appended when provided, even without size."""
        spec = ProductSpec(brand="Sony", model="WH-1000XM5", color="Black")
        result = _amazon_query(spec)
        assert result == "Sony WH-1000XM5 Black"

    def test_with_size_appends_size_and_gender(self):
        """Shoe spec appends gender label and size."""
        spec = ProductSpec(
            brand="Nike",
            model="Killshot 2",
            size=SizeSpec(system="US", gender="men", value=11.0),
        )
        result = _amazon_query(spec)
        assert "Nike" in result
        assert "Killshot 2" in result
        assert "mens" in result
        assert "size 11" in result

    def test_no_size_suffix_in_electronics_query(self):
        """Size suffix must NOT appear in query for a no-size spec."""
        spec = ProductSpec(brand="Sony", model="WH-1000XM5")
        result = _amazon_query(spec)
        assert "size" not in result
        assert "mens" not in result
        assert "womens" not in result

    def test_women_shoe_size(self):
        """Women's shoe appends 'womens' and size."""
        spec = ProductSpec(
            brand="Nike",
            model="Air Max",
            size=SizeSpec(system="US", gender="women", value=8.0),
        )
        result = _amazon_query(spec)
        assert "womens" in result
        assert "size 8" in result

    def test_kids_shoe_size(self):
        """Kids' shoe appends 'kids' and size."""
        spec = ProductSpec(
            brand="Nike",
            model="Revolution",
            size=SizeSpec(system="US", gender="kids", value=4.0),
        )
        result = _amazon_query(spec)
        assert "kids" in result
        assert "size 4" in result


# ---------------------------------------------------------------------------
# Integration-style: build + query consistency
# ---------------------------------------------------------------------------


class TestBuildAndQuery:
    """End-to-end: build a spec and confirm the query is sensible."""

    def test_generic_product_build_and_query(self):
        """A non-shoe product builds cleanly and produces a compact query."""
        spec = build_product_spec(brand="Sony", model="WH-1000XM5")
        query = _amazon_query(spec)
        assert query == "Sony WH-1000XM5"
        assert spec.size is None

    def test_shoe_build_and_query(self):
        """A shoe with size builds cleanly and produces a query with size."""
        spec = build_product_spec(
            brand="Nike",
            model="Killshot 2",
            size={"value": 11, "gender": "men"},
            category="shoes",
        )
        query = _amazon_query(spec)
        assert "size 11" in query
        assert "mens" in query
