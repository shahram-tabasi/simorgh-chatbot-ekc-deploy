"""
Property Resolver Service
=========================
Resolves integer property codes to human-readable values
using the TechnicalProperty lookup table from TPMS.

Author: Simorgh Industrial Assistant
"""

import logging
import os
from typing import Optional, Dict, Any, List
from functools import lru_cache
import pymysql
import pymysql.cursors
from pymysql import Error as MySQLError

from models.tpms_project_models import (
    TechnicalPropertyType,
    TechnicalProperty,
    ResolvedProperty,
)

logger = logging.getLogger(__name__)


class PropertyResolver:
    """
    Resolves TPMS property codes to their string values.

    Uses the TechnicalProperty table for lookups.
    Caches results to minimize database queries.
    """

    def __init__(
        self,
        host: str = None,
        port: int = None,
        user: str = None,
        password: str = None,
        database: str = None
    ):
        """Initialize with TPMS database connection parameters."""
        self.host = host or os.getenv("MYSQL_HOST", "localhost")
        self.port = port or int(os.getenv("MYSQL_PORT", "3306"))
        self.user = user or os.getenv("MYSQL_USER", "root")
        self.password = password or os.getenv("MYSQL_PASSWORD", "")
        self.database = database or os.getenv("MYSQL_DATABASE", "TPMS")

        # Local cache of property mappings
        self._property_cache: Dict[int, Dict[int, str]] = {}
        self._cache_loaded = False

        logger.info("PropertyResolver initialized")

    def _get_connection(self):
        """Create database connection."""
        try:
            connection = pymysql.connect(
                host=self.host,
                port=self.port,
                user=self.user,
                password=self.password,
                database=self.database,
                charset='utf8mb4',
                connect_timeout=10,
                read_timeout=30,
                write_timeout=30,
                cursorclass=pymysql.cursors.DictCursor
            )
            return connection
        except pymysql.Error as e:
            logger.error(f"Failed to connect to TPMS database: {e}")
            raise

    def load_property_cache(self) -> bool:
        """
        Load all properties into cache for fast lookups.
        Call this once during application startup.

        Returns:
            True if successful, False otherwise
        """
        if self._cache_loaded:
            return True

        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            # Fetch all technical properties
            query = """
                SELECT Id, CategoryId, Type, Title
                FROM TechnicalProperty
                WHERE Title IS NOT NULL AND Title != ''
            """
            cursor.execute(query)
            rows = cursor.fetchall()

            # Build cache: {type: {category_id: title}}
            for row in rows:
                prop_type = row.get('Type')
                category_id = row.get('CategoryId')
                title = row.get('Title')

                if prop_type is not None:
                    if prop_type not in self._property_cache:
                        self._property_cache[prop_type] = {}
                    self._property_cache[prop_type][category_id] = title

            cursor.close()
            connection.close()

            self._cache_loaded = True
            logger.info(f"PropertyResolver cache loaded: {len(self._property_cache)} property types")

            return True

        except MySQLError as e:
            logger.error(f"Failed to load property cache: {e}")
            return False

    def resolve(
        self,
        property_type: int,
        code: Optional[int],
        remark: Optional[str] = None
    ) -> ResolvedProperty:
        """
        Resolve a property code to its value.

        Args:
            property_type: The TechnicalPropertyType enum value
            code: The integer code to resolve
            remark: Optional remark/override value

        Returns:
            ResolvedProperty with code, value, and resolved flag
        """
        result = ResolvedProperty(
            code=code,
            remark=remark,
            resolved=False
        )

        # If remark is provided, use it as the value
        if remark and remark.strip():
            result.value = remark.strip()
            result.resolved = True
            return result

        # If no code, return unresolved
        if code is None:
            return result

        # Ensure cache is loaded
        if not self._cache_loaded:
            self.load_property_cache()

        # Look up in cache
        if property_type in self._property_cache:
            if code in self._property_cache[property_type]:
                result.value = self._property_cache[property_type][code]
                result.resolved = True

        # If not found in cache, try database lookup
        if not result.resolved:
            try:
                value = self._lookup_property(property_type, code)
                if value:
                    result.value = value
                    result.resolved = True
                    # Update cache
                    if property_type not in self._property_cache:
                        self._property_cache[property_type] = {}
                    self._property_cache[property_type][code] = value
            except Exception as e:
                logger.warning(f"Property lookup failed for type={property_type}, code={code}: {e}")

        return result

    def _lookup_property(self, property_type: int, code: int) -> Optional[str]:
        """Direct database lookup for a property value."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT Title
                FROM TechnicalProperty
                WHERE Type = %s AND CategoryId = %s
                LIMIT 1
            """
            cursor.execute(query, (property_type, code))
            row = cursor.fetchone()

            cursor.close()
            connection.close()

            return row.get('Title') if row else None

        except MySQLError as e:
            logger.error(f"Property lookup query failed: {e}")
            return None

    def resolve_multiple(
        self,
        properties: List[Dict[str, Any]]
    ) -> List[ResolvedProperty]:
        """
        Resolve multiple properties at once.

        Args:
            properties: List of dicts with 'type', 'code', and optional 'remark'

        Returns:
            List of ResolvedProperty objects
        """
        return [
            self.resolve(
                property_type=p.get('type'),
                code=p.get('code'),
                remark=p.get('remark')
            )
            for p in properties
        ]

    def get_all_values_for_type(self, property_type: int) -> Dict[int, str]:
        """
        Get all possible values for a property type.
        Useful for dropdowns/selection lists.

        Args:
            property_type: The TechnicalPropertyType enum value

        Returns:
            Dict mapping code to title
        """
        if not self._cache_loaded:
            self.load_property_cache()

        return self._property_cache.get(property_type, {})

    # ==========================================================================
    # CONVENIENCE METHODS FOR COMMON PROPERTY TYPES
    # ==========================================================================

    def resolve_ip_protection(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve IP protection rating (e.g., IP54)."""
        return self.resolve(TechnicalPropertyType.IP_PROTECTION, code, remark)

    def resolve_isolation(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve isolation class."""
        return self.resolve(TechnicalPropertyType.ISOLATION, code, remark)

    def resolve_isolation_type(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve isolation type."""
        return self.resolve(TechnicalPropertyType.ISOLATION_TYPE, code, remark)

    def resolve_plating_type(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve plating type."""
        return self.resolve(TechnicalPropertyType.PLATING_TYPE, code, remark)

    def resolve_color_type(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve color type."""
        return self.resolve(TechnicalPropertyType.COLOR_TYPE, code, remark)

    def resolve_color_real(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve actual color (e.g., RAL 7035)."""
        return self.resolve(TechnicalPropertyType.COLOR_REAL, code, remark)

    def resolve_wire_size(
        self,
        wire_type: str,
        code: Optional[int],
        remark: Optional[str] = None
    ) -> ResolvedProperty:
        """
        Resolve wire size based on wire type.

        Args:
            wire_type: One of 'control', 'ct', 'pt', 'plc_feeding', 'inlet', 'outlet'
            code: Size code
            remark: Optional override
        """
        type_map = {
            'control': TechnicalPropertyType.CONTROL_WIRE_SIZE,
            'ct': TechnicalPropertyType.CT_WIRE_SIZE,
            'pt': TechnicalPropertyType.PT_WIRE_SIZE,
            'plc_feeding': TechnicalPropertyType.PLC_FEEDING_WIRE_SIZE,
            'inlet': TechnicalPropertyType.INLET_WIRE_SIZE,
            'outlet': TechnicalPropertyType.OUTLET_WIRE_SIZE,
        }
        prop_type = type_map.get(wire_type.lower(), TechnicalPropertyType.CONTROL_WIRE_SIZE)
        return self.resolve(prop_type, code, remark)

    def resolve_wire_color(
        self,
        wire_type: str,
        code: Optional[int],
        remark: Optional[str] = None
    ) -> ResolvedProperty:
        """
        Resolve wire color based on wire type.

        Args:
            wire_type: One of 'phase_ac', 'neutral_ac', 'dc_plus', 'dc_minus',
                       'digital_inlet', 'digital_outlet', 'three_phase', etc.
            code: Color code
            remark: Optional override
        """
        type_map = {
            'phase_ac': TechnicalPropertyType.PHASE_WIRE_COLOR_AC,
            'neutral_ac': TechnicalPropertyType.NEUTRAL_WIRE_COLOR_AC,
            'dc_plus': TechnicalPropertyType.DC_PLUS_WIRE_COLOR,
            'dc_minus': TechnicalPropertyType.DC_MINUS_WIRE_COLOR,
            'digital_inlet': TechnicalPropertyType.DIGITAL_INLET_WIRE_COLOR,
            'digital_outlet': TechnicalPropertyType.DIGITAL_OUTLET_WIRE_COLOR,
            'three_phase': TechnicalPropertyType.THREE_PHASE_WIRE_COLOR,
            'dc_plus_phase': TechnicalPropertyType.DC_PLUS_PHASE_WIRE_COLOR,
            'dc_minus_neutral': TechnicalPropertyType.DC_MINUS_NEUTRAL_WIRE_COLOR,
            'ac_plus_phase': TechnicalPropertyType.AC_PLUS_PHASE_WIRE_COLOR,
            'ac_plus_neutral': TechnicalPropertyType.AC_PLUS_NEUTRAL_WIRE_COLOR,
        }
        prop_type = type_map.get(wire_type.lower(), TechnicalPropertyType.PHASE_WIRE_COLOR_AC)
        return self.resolve(prop_type, code, remark)

    def resolve_panel_type(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve panel type."""
        return self.resolve(TechnicalPropertyType.PANEL_TYPE, code, remark)

    def resolve_inlet_contact(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve inlet contact type."""
        return self.resolve(TechnicalPropertyType.INLET_CONTACT, code, remark)

    def resolve_outlet_contact(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve outlet contact type."""
        return self.resolve(TechnicalPropertyType.OUTLET_CONTACT, code, remark)

    def resolve_access_from(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve access direction."""
        return self.resolve(TechnicalPropertyType.ACCESS_FROM, code, remark)

    def resolve_layout_type(self, code: Optional[int], remark: Optional[str] = None) -> ResolvedProperty:
        """Resolve layout type."""
        return self.resolve(TechnicalPropertyType.MV_PANEL_LAYOUT, code, remark)


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_property_resolver: Optional[PropertyResolver] = None


def get_property_resolver() -> PropertyResolver:
    """Get or create PropertyResolver singleton."""
    global _property_resolver

    if _property_resolver is None:
        _property_resolver = PropertyResolver()
        # Pre-load cache
        _property_resolver.load_property_cache()

    return _property_resolver


def initialize_property_resolver(
    host: str = None,
    port: int = None,
    user: str = None,
    password: str = None,
    database: str = None
) -> PropertyResolver:
    """
    Initialize PropertyResolver with custom settings.
    Call this during application startup.
    """
    global _property_resolver

    _property_resolver = PropertyResolver(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database
    )
    _property_resolver.load_property_cache()

    return _property_resolver
