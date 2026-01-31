"""
TPMS Project Data Service
=========================
Fetches comprehensive project data from TPMS database.

Extends the existing TPMS auth service to include:
- ViewProjectMain
- TechnicalProjectIdentity
- TechnicalPanelIdentity
- ViewDraft (feeders)
- ViewDraftEquipment
- TechnicalProperty (for resolution)

Author: Simorgh Industrial Assistant
"""

import logging
import os
from typing import Optional, Dict, Any, List
from datetime import datetime

import pymysql
import pymysql.cursors
from pymysql import Error as MySQLError

from models.tpms_project_models import (
    ViewProjectMain,
    TechnicalProjectIdentity,
    TechnicalProjectIdentityAdditionalField,
    TechnicalPanelIdentity,
    TechnicalPanelIdentityAdditionalField,
    TechnicalProperty,
    ViewDraft,
    ViewDraftEquipment,
    ViewDraftColumn,
    TPMSProjectData,
)

logger = logging.getLogger(__name__)


class TPMSProjectDataService:
    """
    Fetches comprehensive project data from TPMS MySQL database.

    Uses the same connection parameters as TPMSAuthService.
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

        logger.info(f"TPMSProjectDataService initialized for {self.host}:{self.port}/{self.database}")

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

    # ==========================================================================
    # PROJECT MAIN DATA
    # ==========================================================================

    def get_project_by_oenum(self, oenum: str) -> Optional[ViewProjectMain]:
        """
        Get project main info by OENUM.

        Args:
            oenum: Full OENUM or last 5 digits

        Returns:
            ViewProjectMain or None
        """
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            # Try exact match first
            query = """
                SELECT
                    IDProjectMain as IdprojectMain,
                    OENUM as Oenum,
                    IFNULL(Project_Name, '') as ProjectName
                FROM View_Project_Main
                WHERE OENUM = %s
                LIMIT 1
            """
            cursor.execute(query, (oenum,))
            row = cursor.fetchone()

            # If not found, try suffix match (last 5 digits like auth service)
            if not row:
                # Extract last 5 digits for suffix match
                oenum_suffix = oenum[-5:] if len(oenum) >= 5 else oenum
                query = """
                    SELECT
                        IDProjectMain as IdprojectMain,
                        OENUM as Oenum,
                        IFNULL(Project_Name, '') as ProjectName
                    FROM View_Project_Main
                    WHERE RIGHT(OENUM, 5) = %s
                    ORDER BY IDProjectMain DESC
                    LIMIT 1
                """
                cursor.execute(query, (oenum_suffix,))
                row = cursor.fetchone()

            cursor.close()
            connection.close()

            if row:
                logger.info(f"Found project: {row}")
                # Create ViewProjectMain with available fields
                return ViewProjectMain(
                    id_project_main=row['IdprojectMain'],
                    oenum=row['Oenum'],
                    project_name=row['ProjectName'],
                    # Set defaults for fields not in View_Project_Main
                    order_category='',
                    oe_date='',
                    project_name_fa='',
                    project_expert_label='',
                    technical_supervisor_label='',
                    technical_expert_label=''
                )
            return None

        except MySQLError as e:
            logger.error(f"Error fetching project by OENUM: {e}")
            return None

    def get_project_by_id(self, id_project_main: int) -> Optional[ViewProjectMain]:
        """Get project main info by IdprojectMain."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    IDProjectMain as IdprojectMain,
                    OENUM as Oenum,
                    IFNULL(Project_Name, '') as ProjectName
                FROM View_Project_Main
                WHERE IDProjectMain = %s
                LIMIT 1
            """
            cursor.execute(query, (id_project_main,))
            row = cursor.fetchone()

            cursor.close()
            connection.close()

            if row:
                return ViewProjectMain(
                    id_project_main=row['IdprojectMain'],
                    oenum=row['Oenum'],
                    project_name=row['ProjectName'],
                    order_category='',
                    oe_date='',
                    project_name_fa='',
                    project_expert_label='',
                    technical_supervisor_label='',
                    technical_expert_label=''
                )
            return None

        except MySQLError as e:
            logger.error(f"Error fetching project by ID: {e}")
            return None

    # ==========================================================================
    # TECHNICAL PROJECT IDENTITY
    # ==========================================================================

    def get_project_identity(self, id_project_main: int) -> Optional[TechnicalProjectIdentity]:
        """Get technical project identity for a project."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    Id, IdprojectMain, ProjectGroup, DeliveryDate,
                    AboveSeaLevel, AverageTemperature, AverageTemperatureRemarkDescription,
                    PackingType, PackingTypeRemarkDescription,
                    Revision, Isolation, IsolationRemarkDescription,
                    IsolationType, IsolationTypeRemarkDescription,
                    PlatingType, PlatingTypeRemarkDescription,
                    HowToPlating, HowToPlatingRemarkDescription,
                    ColorThickness, ColorThicknessRemarkDescription,
                    ColorType, ColorTypeRemarkDescription,
                    ControlWireSize, ControlWireSizeRemarkDescription,
                    CtWireSize, CtWireSizeRemarkDescription,
                    PtWireSize, PtWireSizeRemarkDescription,
                    PhaseWireColor, PhaseWireColorRemarkDescription,
                    NaturalWireColor, NaturalWireColorRemarkDescription,
                    DcPlusWireColor, DcPlusWireColorRemarkDescription,
                    DcMinesWireColor, DcMinesWireColorRemarkDescription,
                    DigitalInletWireColor, DigitalInletWireColorRemarkDescription,
                    DigitalOutletWireColor, DigitalOutletWireColorRemarkDescription,
                    ThreePhaseWireColor, ThreePhaseWireColorRemarkDescription,
                    PlcFeedingWireSize, PlcFeedingWireSizeRemarkDescription,
                    InletWireSize, InletWireSizeRemarkDescription,
                    OutletWireSize, OutletWireSizeRemarkDescription,
                    DcPlusPhaseWireColor, DcPlusPhaseWireColorRemarkDescription,
                    DcMinesNaturalWireColor, DcMinesNaturalWireColorRemarkDescription,
                    AcPlusPhaseWireColor, AcPlusPhaseWireColorRemarkDescription,
                    AcPlusNaturalWireColor, AcPlusNaturalWireColorRemarkDescription,
                    LabelWritingColor, LabelWritingColorRemarkDescription,
                    LabelBackgroundColor, LabelBackgroundColorRemarkDescription,
                    WireBrand, ControlWireBrand,
                    Type, Finished, UsrUsername, DateCreated
                FROM TechnicalProjectIdentity
                WHERE IdprojectMain = %s
                ORDER BY Id DESC
                LIMIT 1
            """
            cursor.execute(query, (id_project_main,))
            row = cursor.fetchone()

            cursor.close()
            connection.close()

            if row:
                return TechnicalProjectIdentity(**row)
            return None

        except MySQLError as e:
            logger.error(f"Error fetching project identity: {e}")
            return None

    def get_project_identity_additional_fields(
        self,
        id_project_main: int
    ) -> List[TechnicalProjectIdentityAdditionalField]:
        """Get additional fields for project identity."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    Id, IdtechnicalProjectIdentity, IdprojectMain,
                    FieldTitle, FieldDescriptions, DateU, Status
                FROM TechnicalProjectIdentityAdditionalField
                WHERE IdprojectMain = %s AND Status = 1
            """
            cursor.execute(query, (id_project_main,))
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [TechnicalProjectIdentityAdditionalField(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching project identity additional fields: {e}")
            return []

    # ==========================================================================
    # TECHNICAL PANEL IDENTITY
    # ==========================================================================

    def get_panels(self, id_project_main: int) -> List[TechnicalPanelIdentity]:
        """Get all panels for a project."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    Id, IdprojectMain, IdprojectScope, ProductTypeLabel,
                    PlaneName1 as PlaneName1, PlaneType, PlaneTypeRemarkDescription,
                    CellCount, PadLockKeyContactor, PadlockKeyTest, PadlockSwitchTest,
                    LayoutType, LayoutTypeRemarkDescription,
                    HowToPlating, HowToPlatingRemarkDescription,
                    PackingTypeRemarkDescription,
                    IsolationType, IsolationTypeRemarkDescription,
                    PlatingType, PlatingTypeRemarkDescription,
                    Isolation, IsolationRemarkDescription,
                    Height, Width, Depth,
                    VoltageRate, VoltageRateRemarkDescription,
                    SwitchAmperage, RatedVoltage, RatedVoltageRemarkDescription,
                    Frequency, FrequencyRemarkDescription,
                    Kabus, Abus, MainBusbarSize, EarthSize, NeutralSize, TypeBusbar,
                    InletContact, InletContactRemarkDescription,
                    OutletContact, OutletContactRemarkDescription,
                    AccessFrom, AccessFromRemarkDescription,
                    Ip, IpRemarkDescription,
                    ColorReal, ColorRealRemarkDescription,
                    Cpcts, Scm, Plsh, Msh, Mbc, MbcRemarkDescription,
                    Rpfwv, Riwv,
                    ProjectIdentityid, Revision, UsrUsername, DateCreated
                FROM TechnicalPanelIdentity
                WHERE IdprojectMain = %s
                ORDER BY Id
            """
            cursor.execute(query, (id_project_main,))
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [TechnicalPanelIdentity(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching panels: {e}")
            return []

    def get_panel_additional_fields(
        self,
        id_project_main: int
    ) -> List[TechnicalPanelIdentityAdditionalField]:
        """Get additional fields for all panels in a project."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    Id, IdtechnicalPanelIdentity, IdprojectMain, IdprojectScope,
                    FieldTitle, FieldDescriptions, DateU, Status
                FROM TechnicalPanelIdentityAdditionalField
                WHERE IdprojectMain = %s AND Status = 1
            """
            cursor.execute(query, (id_project_main,))
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [TechnicalPanelIdentityAdditionalField(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching panel additional fields: {e}")
            return []

    # ==========================================================================
    # VIEW DRAFT (FEEDERS)
    # ==========================================================================

    def get_drafts(self, id_project_main: int) -> List[ViewDraft]:
        """Get all draft/feeder entries for a project."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    Id, ProjectId, TabloId, TmpId, ScopeName,
                    BusSection, FeederNo, Tag, Designation,
                    WiringType, RatingPower, Flc, Module, ModuleType,
                    Size, CableSize, CbRating, OverLoadRating, ContactorRating,
                    SfdHfd, TemplateName, Description, Revision, Ordering
                FROM View_Draft
                WHERE ProjectId = %s
                ORDER BY TabloId, Ordering, Id
            """
            cursor.execute(query, (id_project_main,))
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [ViewDraft(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching drafts: {e}")
            return []

    def get_draft_equipment(self, id_project_main: int) -> List[ViewDraftEquipment]:
        """Get all equipment for all drafts in a project."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT
                    e.DraftId, e.Label, e.Ecode, e.Equipment, e.Qty, e.Priority, e.Color,
                    e.SecDes, e.TypeDes, e.BrandDes, e.ShrDes, e.ShrDes2, e.Scode, e.EngDes
                FROM View_Draft_Equipment e
                INNER JOIN View_Draft d ON e.DraftId = d.Id
                WHERE d.ProjectId = %s
                ORDER BY e.DraftId, e.Priority
            """
            cursor.execute(query, (id_project_main,))
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [ViewDraftEquipment(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching draft equipment: {e}")
            return []

    def get_draft_columns(self, id_project_main: int) -> List[ViewDraftColumn]:
        """Get draft column/brand mappings for a project."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT Id, Level, Name, ProjectId
                FROM View_Draft_Column
                WHERE ProjectId = %s
                ORDER BY Level, Id
            """
            cursor.execute(query, (id_project_main,))
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [ViewDraftColumn(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching draft columns: {e}")
            return []

    # ==========================================================================
    # TECHNICAL PROPERTY (LOOKUP TABLE)
    # ==========================================================================

    def get_all_technical_properties(self) -> List[TechnicalProperty]:
        """Get all technical property mappings."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT Id, CategoryId, Type, Title
                FROM TechnicalProperty
                WHERE Title IS NOT NULL AND Title != ''
                ORDER BY Type, CategoryId
            """
            cursor.execute(query)
            rows = cursor.fetchall()

            cursor.close()
            connection.close()

            return [TechnicalProperty(**row) for row in rows]

        except MySQLError as e:
            logger.error(f"Error fetching technical properties: {e}")
            return []

    def get_property_value(self, property_type: int, category_id: int) -> Optional[str]:
        """Get a specific property value."""
        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            query = """
                SELECT Title
                FROM TechnicalProperty
                WHERE Type = %s AND CategoryId = %s
                LIMIT 1
            """
            cursor.execute(query, (property_type, category_id))
            row = cursor.fetchone()

            cursor.close()
            connection.close()

            return row.get('Title') if row else None

        except MySQLError as e:
            logger.error(f"Error fetching property value: {e}")
            return None

    # ==========================================================================
    # COMPLETE PROJECT DATA FETCH
    # ==========================================================================

    def fetch_complete_project_data(self, oenum: str) -> Optional[TPMSProjectData]:
        """
        Fetch all project data from TPMS.

        This is the main method for syncing - fetches everything.

        Args:
            oenum: Project OENUM

        Returns:
            TPMSProjectData with all related data, or None if project not found
        """
        logger.info(f"Fetching complete project data for OENUM: {oenum}")

        # Get project main
        project_main = self.get_project_by_oenum(oenum)
        if not project_main:
            logger.warning(f"Project not found for OENUM: {oenum}")
            return None

        id_project_main = project_main.id_project_main

        # Fetch all related data
        project_identity = self.get_project_identity(id_project_main)
        identity_additional = self.get_project_identity_additional_fields(id_project_main)
        panels = self.get_panels(id_project_main)
        panel_additional = self.get_panel_additional_fields(id_project_main)
        drafts = self.get_drafts(id_project_main)
        equipment = self.get_draft_equipment(id_project_main)
        columns = self.get_draft_columns(id_project_main)

        # Build complete data object
        data = TPMSProjectData(
            project_main=project_main,
            project_identity=project_identity,
            project_identity_additional_fields=identity_additional,
            panels=panels,
            panel_additional_fields=panel_additional,
            drafts=drafts,
            draft_equipment=equipment,
            draft_columns=columns,
            fetched_at=datetime.utcnow(),
            sync_status="fetched"
        )

        logger.info(
            f"Fetched project data: {len(panels)} panels, "
            f"{len(drafts)} feeders, {len(equipment)} equipment items"
        )

        return data

    def check_project_changes(
        self,
        oenum: str,
        last_sync: datetime
    ) -> Dict[str, Any]:
        """
        Check if project data has changed since last sync.

        Args:
            oenum: Project OENUM
            last_sync: Timestamp of last sync

        Returns:
            Dict with change indicators
        """
        # This would need timestamp columns in TPMS tables
        # For now, return indication that full sync is needed
        return {
            "has_changes": True,
            "needs_full_sync": True,
            "last_checked": datetime.utcnow()
        }


# =============================================================================
# SINGLETON INSTANCE
# =============================================================================

_tpms_data_service: Optional[TPMSProjectDataService] = None


def get_tpms_project_data_service() -> TPMSProjectDataService:
    """Get or create TPMSProjectDataService singleton."""
    global _tpms_data_service

    if _tpms_data_service is None:
        _tpms_data_service = TPMSProjectDataService()

    return _tpms_data_service


def initialize_tpms_project_data_service(
    host: str = None,
    port: int = None,
    user: str = None,
    password: str = None,
    database: str = None
) -> TPMSProjectDataService:
    """Initialize TPMSProjectDataService with custom settings."""
    global _tpms_data_service

    _tpms_data_service = TPMSProjectDataService(
        host=host,
        port=port,
        user=user,
        password=password,
        database=database
    )

    return _tpms_data_service
