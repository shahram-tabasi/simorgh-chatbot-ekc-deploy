"""
soft_extractor_validators.py — Post-extraction validators for proposals.

The architectural pivot Phase B asks for: instead of regex/normalisers
on RAW source text (which grabs "60" from any column happening to
contain that number), regex/normalisers run on the LLM's STRUCTURED
JSON output. By that point the LLM has semantically tagged the value
to a specific field — the validator just enforces format and
plausibility.

How the gate decisions chain:
  Phase A (relevance gate): inventory/invoice docs → SKIP entirely
  Phase B (this module):    bad-format / impossible values → DROP
  Phase D (UI category):    surviving proposals → human approval

What each validator does:
  1. UNIT CANONICALISATION ("6.6 kV"/"6600 V"/"6.6kV" → "6.6")
  2. FORMAT NORMALISATION ("ipx4" / "IP-X4" → "IP4X")
  3. ALLOWED-VALUE ENFORCEMENT (standard ∈ {IEC, IEEE, ANSI, DIN, GOST, GB})
  4. PLAUSIBILITY RANGES (frequency ∈ {50, 60}; design temp ∈ -40..+60)
  5. DATE NORMALISATION (Jalali OR Gregorian → ISO 8601)

A validator returns ``(cleaned_value, reason)`` on success or
``(None, reason)`` to drop. The caller (extract_one_document) drops
the proposal entirely on reject — these aren't "tweak the value"
silent fixes, they're "this is wrong, don't propose it".

Conservative by design: every unrecognised field passes through
unchanged, so adding new fields to CONFIRMABLE_FIELDS doesn't require
touching this file. Adding validation is then opt-in per field.
"""
from __future__ import annotations

import logging
import re
from datetime import date
from typing import Any, Callable, Optional, Tuple

logger = logging.getLogger(__name__)


# ---------------------------------------------------------------------------
# Allowed-value sets
# ---------------------------------------------------------------------------
# Mirror the simorgh-soft frontend dropdowns. When the LLM emits a near-
# but-not-exact match, normalise to canonical; when it emits an entirely
# unknown value, drop the proposal (the user can add a custom value
# manually from the chat).

STANDARDS = {
    "IEC": {"IEC", "I.E.C", "I.E.C.", "INTERNATIONAL ELECTROTECHNICAL COMMISSION"},
    "IEEE": {"IEEE", "I.E.E.E", "I.E.E.E."},
    "ANSI": {"ANSI", "A.N.S.I", "A.N.S.I."},
    "DIN": {"DIN", "DIN VDE"},
    "GOST": {"GOST", "ГОСТ"},
    "GB": {"GB", "GUOBIAO"},
}

COUNTRIES = {
    "Iran":        {"Iran", "I.R. Iran", "Islamic Republic of Iran", "ایران"},
    "Germany":     {"Germany", "Deutschland", "آلمان"},
    "USA":         {"USA", "United States", "U.S.A.", "United States of America"},
    "France":      {"France", "فرانسه"},
    "China":       {"China", "P.R. China", "PRC", "چین"},
    "Russia":      {"Russia", "Russian Federation", "روسیه"},
    "UK":          {"UK", "United Kingdom", "Great Britain", "Britain"},
    "Italy":       {"Italy", "Italia"},
    "Turkey":      {"Turkey", "Türkiye", "ترکیه"},
    "UAE":         {"UAE", "United Arab Emirates", "امارات"},
}

LANGUAGES = {
    "English":  {"English", "EN", "Eng", "انگلیسی"},
    "Persian":  {"Persian", "Farsi", "Iranian", "FA", "فارسی"},
    "Arabic":   {"Arabic", "AR", "عربی"},
    "German":   {"German", "Deutsch", "DE"},
    "French":   {"French", "Français", "FR"},
    "Russian":  {"Russian", "Русский", "RU"},
    "Chinese":  {"Chinese", "Mandarin", "中文", "ZH"},
}


def _normalise_against(value: str, mapping: dict) -> Optional[str]:
    """Find the canonical key whose alias-set contains `value` (case- and
    whitespace-insensitive). Returns the canonical key or None."""
    if value is None:
        return None
    needle = re.sub(r"\s+", " ", str(value).strip())
    needle_norm = needle.casefold()
    for canonical, aliases in mapping.items():
        for a in aliases:
            if a.casefold() == needle_norm:
                return canonical
    return None


# ---------------------------------------------------------------------------
# Unit-canonicalisation parsers
# ---------------------------------------------------------------------------
_NUM = r"-?\d+(?:[.,]\d+)?"


def _to_float(s: str) -> float:
    """Accept '6.6' or '6,6'."""
    return float(str(s).replace(",", "."))


def parse_voltage_kv(v: Any) -> float:
    """'6.6 kV' / '6600 V' / '6.6kV' / '6.6' → 6.6 (canonical kV)."""
    m = re.search(rf"({_NUM})\s*(kV|V|MV)?", str(v), re.I)
    if not m:
        raise ValueError(f"unparseable voltage: {v!r}")
    val = _to_float(m.group(1))
    unit = (m.group(2) or "kV").upper()
    if unit == "V":  return val / 1000
    if unit == "KV": return val
    if unit == "MV": return val * 1000
    raise ValueError(f"unknown voltage unit: {unit}")


def parse_current_ka(v: Any) -> float:
    """'40 kA' / '40000 A' / '40' → 40 (canonical kA)."""
    m = re.search(rf"({_NUM})\s*(kA|A|mA)?", str(v), re.I)
    if not m:
        raise ValueError(f"unparseable current: {v!r}")
    val = _to_float(m.group(1))
    unit = (m.group(2) or "kA").upper()
    if unit == "MA": return val / 1_000_000
    if unit == "A":  return val / 1000
    if unit == "KA": return val
    raise ValueError(f"unknown current unit: {unit}")


def parse_frequency_hz(v: Any) -> int:
    """'50 Hz' / '50Hz' / '50' → 50 (canonical Hz, integer)."""
    m = re.search(rf"({_NUM})\s*(Hz|kHz)?", str(v), re.I)
    if not m:
        raise ValueError(f"unparseable frequency: {v!r}")
    val = _to_float(m.group(1))
    unit = (m.group(2) or "Hz").upper()
    if unit == "KHZ":
        val *= 1000
    return int(round(val))


def parse_temperature_c(v: Any) -> float:
    """'50 °C' / '50C' / '50 deg' / '50' → 50.0 (canonical °C)."""
    s = str(v).strip()
    m = re.search(rf"({_NUM})", s)
    if not m:
        raise ValueError(f"unparseable temperature: {v!r}")
    val = _to_float(m.group(1))
    # Reject Kelvin / Fahrenheit when explicitly tagged (we don't
    # silent-convert; that's a behaviour ambiguity).
    if re.search(r"\b(K|°?F)\b", s):
        raise ValueError(f"unsupported temperature unit in: {v!r}")
    return val


def parse_altitude_m(v: Any) -> int:
    """'1800 m' / '1800m a.s.l.' / '1800' → 1800 (canonical m)."""
    m = re.search(rf"({_NUM})\s*(m|km|ft)?", str(v), re.I)
    if not m:
        raise ValueError(f"unparseable altitude: {v!r}")
    val = _to_float(m.group(1))
    unit = (m.group(2) or "m").lower()
    if unit == "km": val *= 1000
    if unit == "ft": val *= 0.3048
    return int(round(val))


# ---------------------------------------------------------------------------
# Format normalisers
# ---------------------------------------------------------------------------
def normalise_ip_rating(v: Any) -> str:
    """'ip54' / 'IP-54' / 'IPx4' → 'IP54'."""
    s = re.sub(r"[\s\-_.]+", "", str(v)).upper()
    m = re.fullmatch(r"IP([0-9X]{2})", s)
    if not m:
        raise ValueError(f"unparseable IP rating: {v!r}")
    return f"IP{m.group(1)}"


def normalise_oe_number(v: Any) -> str:
    """'04A12065' / 'OE-04A12065' / 'OE 04A12065' → '04A12065'.

    Conservative: accepts only the YYAXXXXX pattern that real TPMS OEs
    follow. Doc-numbers like '347180ETS802' get rejected — those go in
    projectNumber via a separate path, not as an OE.
    """
    s = re.sub(r"[\s\-_]+", "", str(v)).upper()
    s = re.sub(r"^OE", "", s)
    if not re.fullmatch(r"\d{2}[A-Z]\d{4,6}", s):
        raise ValueError(f"not OE number format YYAXXXXX: {v!r}")
    return s


# ---------------------------------------------------------------------------
# Date normalisation — Jalali → Gregorian → ISO 8601
# ---------------------------------------------------------------------------
def normalise_date(v: Any) -> str:
    """Accept ISO 8601, Jalali (`1403/12/24`), DD/MM/YYYY, MM/DD/YYYY.
    Output: ISO 8601 'YYYY-MM-DD'. Rejects implausible years."""
    if isinstance(v, date):
        return v.isoformat()
    s = str(v).strip()
    # Persian digits → Latin
    s = s.translate(str.maketrans("۰۱۲۳۴۵۶۷۸۹", "0123456789"))
    s = re.sub(r"[./]", "-", s)
    parts = re.split(r"[-T ]", s)
    if len(parts) < 3:
        raise ValueError(f"date doesn't have 3 components: {v!r}")
    try:
        a, b, c = int(parts[0]), int(parts[1]), int(parts[2])
    except ValueError as e:
        raise ValueError(f"non-numeric date component: {v!r}") from e

    # Heuristic year placement: 4-digit goes first; otherwise assume
    # the LARGEST is year. Jalali years look like 1380-1430; Gregorian
    # 1990-2050.
    if a >= 1000:
        y, m, d = a, b, c
    elif c >= 1000:
        y, m, d = c, b, a   # DD-MM-YYYY
    else:
        raise ValueError(f"ambiguous year in date: {v!r}")

    # Jalali → Gregorian
    if 1300 <= y <= 1500:
        try:
            import jdatetime  # type: ignore
            jd = jdatetime.date(y, m, d)
            g = jd.togregorian()
            return g.isoformat()
        except Exception as e:  # noqa: BLE001
            raise ValueError(f"jdatetime conversion failed: {e}") from e

    # Gregorian sanity
    if not (1990 <= y <= 2099):
        raise ValueError(f"year out of plausible range: {y}")
    if not (1 <= m <= 12 and 1 <= d <= 31):
        raise ValueError(f"month/day out of range: {v!r}")
    return f"{y:04d}-{m:02d}-{d:02d}"


# ---------------------------------------------------------------------------
# Plausibility-bounded validators
# ---------------------------------------------------------------------------
def validate_frequency(v: Any) -> str:
    hz = parse_frequency_hz(v)
    if hz not in (50, 60):
        raise ValueError(f"frequency {hz} Hz is not a grid frequency (50/60)")
    return str(hz)


def validate_design_temperature(v: Any) -> str:
    t = parse_temperature_c(v)
    if not -40 <= t <= 60:
        raise ValueError(
            f"design temperature {t}°C outside IEC 62271-1 envelope (-40..+60)"
        )
    return str(int(t) if t.is_integer() else t)


def validate_altitude(v: Any) -> str:
    m_ = parse_altitude_m(v)
    if not 0 <= m_ <= 5000:
        raise ValueError(f"altitude {m_} m implausible (0..5000)")
    return str(m_)


def validate_voltage_mv(v: Any) -> str:
    kv = parse_voltage_kv(v)
    if not 1 <= kv <= 800:
        raise ValueError(f"MV nominal {kv} kV outside plausible range (1..800)")
    return f"{kv:g}"


def validate_voltage_lv(v: Any) -> str:
    kv = parse_voltage_kv(v)
    v_ = kv * 1000
    if not 100 <= v_ <= 1000:
        raise ValueError(f"LV nominal {v_} V outside plausible range (100..1000)")
    return f"{int(v_)}" if v_.is_integer() else f"{v_:g}"


def validate_short_circuit_ka(v: Any) -> str:
    ka = parse_current_ka(v)
    if not 1 <= ka <= 100:
        raise ValueError(f"short-circuit {ka} kA outside plausible range (1..100)")
    return f"{ka:g}"


def validate_bil_kv(v: Any) -> str:
    kv = parse_voltage_kv(v)
    if not 5 <= kv <= 1200:
        raise ValueError(f"BIL {kv} kV implausible (5..1200)")
    return f"{kv:g}"


def validate_standard(v: Any) -> str:
    norm = _normalise_against(v, STANDARDS)
    if norm is None:
        raise ValueError(f"unknown standard: {v!r} (allowed: {sorted(STANDARDS)})")
    return norm


def validate_country(v: Any) -> str:
    norm = _normalise_against(v, COUNTRIES)
    if norm is None:
        # Accept unknown countries verbatim — frontend has free-text
        # input for those. Just trim and title-case.
        s = re.sub(r"\s+", " ", str(v).strip()).title()
        if len(s) < 2 or len(s) > 60:
            raise ValueError(f"country string implausible: {v!r}")
        return s
    return norm


def validate_language(v: Any) -> str:
    norm = _normalise_against(v, LANGUAGES)
    if norm is None:
        raise ValueError(f"unknown language: {v!r} (allowed: {sorted(LANGUAGES)})")
    return norm


# ---------------------------------------------------------------------------
# Registry — field name → validator function
# ---------------------------------------------------------------------------
_VALIDATORS: dict[str, Callable[[Any], str]] = {
    # Identity
    "projectNumber":                                   normalise_oe_number,
    # Regional
    "standard":                                        validate_standard,
    "country":                                         validate_country,
    "language":                                        validate_language,
    # Dates
    "noticeToProceedDate":                             normalise_date,
    "deliveryDate":                                    normalise_date,
    # Site / environmental
    "techSettings.general.designTemperature":          validate_design_temperature,
    "techSettings.general.altitudeAboveSeaLevel":      validate_altitude,
    # Network
    "techSettings.general.nominalVoltage":             validate_voltage_mv,
    "techSettings.general.ratedFrequency":             validate_frequency,
    "techSettings.general.shortCircuitCurrent":        validate_short_circuit_ka,
    "techSettings.general.bil":                        validate_bil_kv,
    "techSettings.general.ipRating":                   normalise_ip_rating,
    "technicalSettings.mediumVoltage.nominalVoltage":  validate_voltage_mv,
    "technicalSettings.lowVoltage.nominalVoltage":     validate_voltage_lv,
    "technicalSettings.lowVoltage.frequency":          validate_frequency,
}


def validate_proposal(field: str, value: Any) -> Tuple[Optional[str], str]:
    """Public entry: returns (cleaned_value, reason).
    `cleaned_value=None` ⇒ DROP this proposal.
    `cleaned_value=str`  ⇒ ACCEPT with that string as the value.
    `reason` is human-readable; logged at INFO level by the caller.
    """
    if value is None:
        return None, "value is None"
    if isinstance(value, (dict, list)):
        # Nested values (equipments[], techSettings.general object) are
        # validated structurally by the consumer; no per-field rule
        # here would make sense.
        return str(value) if not isinstance(value, str) else value, "nested object (passthrough)"
    if field not in _VALIDATORS:
        # Conservative passthrough — string-cast and trim.
        s = re.sub(r"\s+", " ", str(value).strip())
        return (s or None), ("passthrough" if s else "empty after trim")
    try:
        cleaned = _VALIDATORS[field](value)
        cleaned_s = str(cleaned).strip()
        if not cleaned_s:
            return None, "validator returned empty"
        return cleaned_s, "validated"
    except (ValueError, AssertionError, TypeError) as e:
        return None, f"reject: {e}"


# ---------------------------------------------------------------------------
# Bulk helper — used by the whole-doc extractor
# ---------------------------------------------------------------------------
def validate_extracted_dict(
    extracted: dict, *, on_reject: Optional[Callable[[str, Any, str], None]] = None,
) -> dict:
    """Walk the LLM's per-field record dict, validate each present value,
    drop or accept. Returns a NEW dict with the same shape as input but
    with cleaned values; rejected entries have present=False, reason set.
    """
    out: dict = {}
    for k, rec in (extracted or {}).items():
        if not isinstance(rec, dict):
            out[k] = rec
            continue
        if not rec.get("present"):
            out[k] = rec
            continue
        raw = rec.get("value")
        cleaned, reason = validate_proposal(k, raw)
        if cleaned is None:
            if on_reject:
                on_reject(k, raw, reason)
            out[k] = {
                **rec, "present": False, "value": None,
                "reason": (rec.get("reason") or "") + f" [validator: {reason}]",
            }
            continue
        out[k] = {**rec, "value": cleaned}
    return out
