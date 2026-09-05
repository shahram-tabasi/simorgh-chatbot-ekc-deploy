"""
soft_important_items.py — the canonical checklist of "important specification
items" for a switchgear project (from the operator's reference list).

Why this exists
===============
The response-miner names parameters however the LLM phrased them that run, so
the same concept ("service voltage" / "rated voltage" / "operating voltage")
produced DIFFERENT field keys on each pass — the proposal set grew on its own
and filled with near-duplicates.

This module pins each important concept to ONE stable canonical key, grouped
by the operator's subjects. `match_item(name)` deterministically maps a
free-form parameter name to its canonical item (longest-keyword-wins, so
"rated insulation voltage" beats "rated voltage"). Mapped params share a
stable key → no growth, no repeats, and the missing items become meaningful
gaps. Unmatched params keep their free-form slug under "Other".

Pure data + string matching; no IO.
"""
from __future__ import annotations

import re
from typing import Dict, List, Optional, Tuple

# subject_id, subject_label, [ (item_key, item_label, [keywords...]) ]
# keywords are matched as substrings of the normalized parameter name; list
# the most specific phrasing so it out-ranks shorter generic ones.
TAXONOMY: List[Tuple[str, str, List[Tuple[str, str, List[str]]]]] = [
    ("main_characteristic", "Switchgear — Main Characteristic", [
        ("rated_short_time_withstand_current", "Rated Short-Time Withstand Current",
         ["short time withstand", "short-time current", "short time current",
          "icw", "karms", "ka rms", "withstand current"]),
        ("main_busbar_rated_current", "Main Busbar Rated Current",
         ["main bus bar current", "main busbar current", "main busbar rated",
          "busbar current", "bus bar current", "rated current of busbar"]),
        ("switchboard_color", "Switchboard Color",
         ["switchboard color", "switchboard colour", "panel color", "ral"]),
        ("frequency", "Frequency", ["frequency", "rated frequency", " hz"]),
        ("service_voltage", "Service Voltage",
         ["service voltage", "working voltage", "operating voltage",
          "nominal voltage", "rated voltage"]),
        ("rated_insulation_voltage", "Rated Insulation Voltage",
         ["insulation voltage", "insulating level", "insulation level"]),
        ("rated_impulse_withstand_voltage", "Rated Impulse Withstand Voltage",
         ["impulse withstand", "impulse test voltage", "impulse voltage",
          "lightning impulse", "bil"]),
        ("rated_power_frequency_withstand_voltage", "Rated Power-Frequency Withstand Voltage",
         ["power frequency withstand", "power-frequency withstand",
          "test voltage at", "1 min withstand", "one minute withstand"]),
        ("degree_of_protection", "Degree of Protection",
         ["degree of protection", "ip rating", "ip class", "ip4", "ip5", "ik0", "ik1"]),
        ("design_temperature", "Design Temperature (°C)",
         ["design temperature", "ambient temperature", "design ambient"]),
        ("switchgear_access", "Switchgear Access",
         ["switchgear access", "front and rear access", "access type",
          "rear access", "front access"]),
        ("altitude", "Altitude Above Sea Level",
         ["altitude", "above sea level", "a.s.l", "sea level"]),
        ("painting_thickness", "Thickness of Painting",
         ["thickness of painting", "paint thickness", "coating thickness"]),
        ("type_of_entrance", "Type of Entrance",
         ["type of entrance", "cable entry", "entrance type", "incoming entry"]),
        ("sheet_thickness", "Sheet Thickness",
         ["sheet thickness", "plate thickness", "steel thickness"]),
        ("type_of_separation", "Type of Separation",
         ["type of separation", "loss of service continuity", "partition class",
          "lsc", "separation class"]),
        ("internal_arc_fault_duration", "Internal Arc Fault Duration",
         ["internal arc", "arc fault duration", "iac", "arc classification"]),
        ("rear_cover_interlock", "Rear Cover Interlock",
         ["rear cover interlock", "rear cover"]),
        ("chassis", "Chassis (10 or 20 cm)", ["chassis"]),
        ("lifting_lugs", "Lifting Lugs", ["lifting lug", "lifting eye"]),
        ("ambient_humidity", "Ambient Humidity Level (%)",
         ["humidity", "relative humidity"]),
    ]),
    ("busbar", "Busbar Specifications", [
        ("main_busbar_configuration", "Main Busbar Configuration",
         ["busbar configuration", "bus bar configuration", "busbar arrangement"]),
        ("main_earth_bus", "Main Earth Bus",
         ["earth bus", "earthing bus", "grounding bus", "ground bus",
          "earth busbar", "grounding busbar"]),
        ("busbar_coating", "Busbar Coating",
         ["busbar coating", "bus bar coating", "tin plated", "silver plated", "plating"]),
        ("thermofit_cover", "Thermofit Cover (Black)",
         ["thermofit", "heat shrink", "busbar sleeve", "busbar insulation cover"]),
        ("busbar_type", "Busbar Type", ["busbar type", "bus bar type", "busbar material"]),
        ("busbar_color_coding", "Busbar Color Coding",
         ["color coding", "colour coding", "phase color"]),
        ("neutral_busbar_ratio", "Neutral Busbar Cross-Section Ratio (%)",
         ["neutral busbar", "neutral bus bar", "neutral cross"]),
        ("earthing_busbar_ratio", "Earthing Busbar Cross-Section Ratio (%)",
         ["earthing busbar ratio", "earth busbar ratio"]),
        ("min_earthing_busbar_xsec", "Minimum Earthing Busbar Cross-Section (mm²)",
         ["minimum cross section", "min cross section", "cross-section",
          "cross section", "250 mm", "300 mm"]),
    ]),
    ("wire_size", "Wire Size", [
        ("wire_size_control", "Control Circuit Wire Size",
         ["control circuit wire", "control wire size", "control wiring"]),
        ("wire_size_ct", "CT Secondary Wire Size",
         ["ct secondary", "ct connection", "ct wire", "2.5 mm"]),
        ("wire_size_pt", "PT Secondary Wire Size", ["pt secondary", "vt secondary"]),
        ("wire_size_plc", "PLC Power Supply Wire Size", ["plc power"]),
    ]),
    ("wire_color", "Wire Color", [
        ("wire_color_ac_phase", "AC Phase Wire Color", ["ac phase"]),
        ("wire_color_ac_neutral", "AC Neutral Wire Color", ["ac neutral"]),
        ("wire_color_plc_input", "PLC Input Wire Color", ["plc input"]),
        ("wire_color_plc_output", "PLC Output Wire Color", ["plc output"]),
        ("wire_color_dc", "DC ± Wire Color", ["dc +", "dc -", "dc +/-"]),
    ]),
    ("wire_spec", "Wire Specifications", [
        ("wire_insulation_type", "Wire Insulation Type",
         ["insulation type", "pvc", "hfls", "halogen free"]),
        ("wire_fire_resistance", "Wire Fire Resistance",
         ["fire resistance", "fire proof", "fire-proof", "flame retardant"]),
        ("wire_flexibility", "Wire Flexibility / Class",
         ["extra flexible", "stranded copper", "cu5", "conductor class"]),
    ]),
    ("label_color", "Label Color", [
        ("writing_color", "Writing Color", ["writing color", "lettering color"]),
        ("background_color", "Background Color", ["background color"]),
        ("name_plate", "Name Plate (Steel or Plastic)",
         ["name plate", "nameplate", "name-plate"]),
    ]),
    ("auxiliary_voltage", "Auxiliary Voltage", [
        ("aux_control_voltage", "Control / Protection / Closing / Tripping / Signalling Voltage",
         ["auxiliary voltage", "control voltage", "closing", "tripping",
          "protecting relay supply", "signalling", "110 dc", "110dc", "110 v dc"]),
        ("spring_charging_motor", "Spring Charging Motor Supply", ["spring charging"]),
        ("panel_lighting_heater", "Panel Lighting & Space Heater",
         ["panel lighting", "space heater", "heating resistor", "internal lighting", "socket"]),
        ("motor_space_heater", "Motors Space Heater", ["motor space heater"]),
    ]),
    ("ct_pt", "CT & PT", [
        ("ct_accuracy_class", "CT/PT Accuracy Class",
         ["accuracy class", "5p", "0.5 class", "cl 0.5", "class 0.5"]),
        ("ct_ratio", "CT/PT Ratio", ["ct ratio", "transformer ratio", "current ratio"]),
        ("ct_thermal_class", "Thermal Class", ["thermal class", "class e", "class f"]),
    ]),
    ("cb", "Circuit Breaker", [
        ("cb_operating_sequence", "Rated Operating Sequence",
         ["operating sequence", "operating cycle", "o-co"]),
        ("cb_breaking_capacity", "Ics / Icw / Icu",
         ["ics", "icu", "breaking capacity", "interrupting capacity"]),
        ("cb_coordination", "Coordination Type", ["coordination type", "discrimination"]),
    ]),
    ("protection", "Protection & Relays", [
        ("overcurrent_relay", "Overcurrent Protection",
         ["overcurrent", "idmt", "dmt", "i>", "i>>"]),
        ("earth_fault_relay", "Earth Fault / Over-Under Voltage Protection",
         ["earth fault", "over voltage", "overvoltage", "under voltage", "undervoltage"]),
        ("ansi_code", "ANSI Code", ["ansi code", "ansi function"]),
    ]),
    ("interlocks", "Interlocks & Safety", [
        ("mechanical_interlock", "Mechanical Interlocks",
         ["interlock", "shutter", "earthing switch", "withdrawable", "isolated position"]),
        ("key_interlock", "Key / Padlock Interlock", ["key interlock", "padlock"]),
    ]),
]

# Flat lookup of all keywords → (subject_id, item_key, item_label), sorted so
# the LONGEST keyword is tried first (specificity wins).
_FLAT: List[Tuple[str, str, str, str]] = []
for _sid, _slabel, _items in TAXONOMY:
    for _ikey, _ilabel, _kws in _items:
        for _kw in _kws:
            _FLAT.append((_kw.lower().strip(), _sid, _ikey, _ilabel))
_FLAT.sort(key=lambda t: len(t[0]), reverse=True)

SUBJECT_LABELS: Dict[str, str] = {sid: slabel for sid, slabel, _ in TAXONOMY}


def _norm(s: str) -> str:
    return re.sub(r"\s+", " ", str(s or "")).strip().lower()


def match_item(name: str) -> Optional[Dict[str, str]]:
    """Map a free-form parameter name to its canonical important item.
    Returns {"subject", "item_key", "item_label", "field"} or None when the
    name doesn't correspond to a tracked important item."""
    n = _norm(name)
    if not n:
        return None
    for kw, sid, ikey, ilabel in _FLAT:
        if kw in n:
            return {
                "subject": sid,
                "item_key": ikey,
                "item_label": ilabel,
                "field": f"important.{sid}.{ikey}",
            }
    return None


def all_items() -> List[Dict[str, str]]:
    """Every canonical item (for gap computation / a fixed checklist view)."""
    out: List[Dict[str, str]] = []
    for sid, _slabel, items in TAXONOMY:
        for ikey, ilabel, _kws in items:
            out.append({"subject": sid, "item_key": ikey, "item_label": ilabel,
                        "field": f"important.{sid}.{ikey}"})
    return out
