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

            # Try exact match first - View_Project_Main has all these columns per C# model
            query = """
                SELECT
                    IDProjectMain as IdprojectMain,
                    OENUM as Oenum,
                    IFNULL(Project_Name, '') as ProjectName,
                    IFNULL(Order_Category, '') as OrderCategory,
                    IFNULL(OEDATE, '') as OeDate,
                    IFNULL(Project_Name_Fa, '') as ProjectNameFa,
                    IFNULL(Project_Expert_Label, '') as ProjectExpertLabel,
                    IFNULL(Technical_Supervisor_Label, '') as TechnicalSupervisorLabel,
                    IFNULL(Technical_Expert_Label, '') as TechnicalExpertLabel
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
                        IFNULL(Project_Name, '') as ProjectName,
                        IFNULL(Order_Category, '') as OrderCategory,
                        IFNULL(OEDATE, '') as OeDate,
                        IFNULL(Project_Name_Fa, '') as ProjectNameFa,
                        IFNULL(Project_Expert_Label, '') as ProjectExpertLabel,
                        IFNULL(Technical_Supervisor_Label, '') as TechnicalSupervisorLabel,
                        IFNULL(Technical_Expert_Label, '') as TechnicalExpertLabel
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
                # Create ViewProjectMain with all fields from View_Project_Main
                return ViewProjectMain(
                    id_project_main=row['IdprojectMain'],
                    oenum=row['Oenum'],
                    project_name=row['ProjectName'],
                    order_category=row['OrderCategory'],
                    oe_date=row['OeDate'],
                    project_name_fa=row['ProjectNameFa'],
                    project_expert_label=row['ProjectExpertLabel'],
                    technical_supervisor_label=row['TechnicalSupervisorLabel'],
                    technical_expert_label=row['TechnicalExpertLabel']
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

            # View_Project_Main has all these columns per C# model
            query = """
                SELECT
                    IDProjectMain as IdprojectMain,
                    OENUM as Oenum,
                    IFNULL(Project_Name, '') as ProjectName,
                    IFNULL(Order_Category, '') as OrderCategory,
                    IFNULL(OEDATE, '') as OeDate,
                    IFNULL(Project_Name_Fa, '') as ProjectNameFa,
                    IFNULL(Project_Expert_Label, '') as ProjectExpertLabel,
                    IFNULL(Technical_Supervisor_Label, '') as TechnicalSupervisorLabel,
                    IFNULL(Technical_Expert_Label, '') as TechnicalExpertLabel
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
                    order_category=row['OrderCategory'],
                    oe_date=row['OeDate'],
                    project_name_fa=row['ProjectNameFa'],
                    project_expert_label=row['ProjectExpertLabel'],
                    technical_supervisor_label=row['TechnicalSupervisorLabel'],
                    technical_expert_label=row['TechnicalExpertLabel']
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

            # Note: Column names from C# model - use exact case and underscores
            query = """
                SELECT
                    ID as Id,
                    IDProjectMain as IdprojectMain,
                    Project_Group as ProjectGroup,
                    Delivery_Date as DeliveryDate,
                    Above_Sea_Level as AboveSeaLevel,
                    Average_Temperature as AverageTemperature,
                    Average_Temperature_Remark_Description as AverageTemperatureRemarkDescription,
                    Packing_Type as PackingType,
                    Packing_Type_Remark_Description as PackingTypeRemarkDescription,
                    Revision,
                    Isolation,
                    Isolation_Remark_Description as IsolationRemarkDescription,
                    Isolation_Type as IsolationType,
                    Isolation_Type_Remark_Description as IsolationTypeRemarkDescription,
                    Plating_Type as PlatingType,
                    Plating_Type_Remark_Description as PlatingTypeRemarkDescription,
                    How_To_Plating as HowToPlating,
                    How_To_Plating_Remark_Description as HowToPlatingRemarkDescription,
                    Color_Thickness as ColorThickness,
                    Color_Thickness_Remark_Description as ColorThicknessRemarkDescription,
                    Color_Type as ColorType,
                    Color_Type_Remark_Description as ColorTypeRemarkDescription,
                    Control_Wire_Size as ControlWireSize,
                    Control_Wire_Size_Remark_Description as ControlWireSizeRemarkDescription,
                    CT_Wire_Size as CtWireSize,
                    CT_Wire_Size_Remark_Description as CtWireSizeRemarkDescription,
                    PT_Wire_Size as PtWireSize,
                    PT_Wire_Size_Remark_Description as PtWireSizeRemarkDescription,
                    Phase_Wire_Color as PhaseWireColor,
                    Phase_Wire_Color_Remark_Description as PhaseWireColorRemarkDescription,
                    Natural_Wire_Color as NaturalWireColor,
                    Natural_Wire_Color_Remark_Description as NaturalWireColorRemarkDescription,
                    DC_Plus_Wire_Color as DcPlusWireColor,
                    DC_Plus_Wire_Color_Remark_Description as DcPlusWireColorRemarkDescription,
                    DC_Mines_Wire_Color as DcMinesWireColor,
                    DC_Mines_Wire_Color_Remark_Description as DcMinesWireColorRemarkDescription,
                    Digital_Inlet_Wire_Color as DigitalInletWireColor,
                    Digital_Inlet_Wire_Color_Remark_Description as DigitalInletWireColorRemarkDescription,
                    Digital_Outlet_Wire_Color as DigitalOutletWireColor,
                    Digital_Outlet_Wire_Color_Remark_Description as DigitalOutletWireColorRemarkDescription,
                    Three_Phase_Wire_Color as ThreePhaseWireColor,
                    Three_Phase_Wire_Color_Remark_Description as ThreePhaseWireColorRemarkDescription,
                    PLC_Feeding_Wire_Size as PlcFeedingWireSize,
                    PLC_Feeding_Wire_Size_Remark_Description as PlcFeedingWireSizeRemarkDescription,
                    Inlet_Wire_Size as InletWireSize,
                    Inlet_Wire_Size_Remark_Description as InletWireSizeRemarkDescription,
                    Outlet_Wire_Size as OutletWireSize,
                    Outlet_Wire_Size_Remark_Description as OutletWireSizeRemarkDescription,
                    DC_Plus_Phase_Wire_Color as DcPlusPhaseWireColor,
                    DC_Plus_Phase_Wire_Color_Remark_Description as DcPlusPhaseWireColorRemarkDescription,
                    DC_Mines_Natural_Wire_Color as DcMinesNaturalWireColor,
                    DC_Mines_Natural_Wire_Color_Remark_Description as DcMinesNaturalWireColorRemarkDescription,
                    AC_Plus_Phase_Wire_Color as AcPlusPhaseWireColor,
                    AC_Plus_Phase_Wire_Color_Remark_Description as AcPlusPhaseWireColorRemarkDescription,
                    AC_Plus_Natural_Wire_Color as AcPlusNaturalWireColor,
                    AC_Plus_Natural_Wire_Color_Remark_Description as AcPlusNaturalWireColorRemarkDescription,
                    Label_Writing_Color as LabelWritingColor,
                    Label_Writing_Color_Remark_Description as LabelWritingColorRemarkDescription,
                    Label_Background_Color as LabelBackgroundColor,
                    Label_Background_Color_Remark_Description as LabelBackgroundColorRemarkDescription,
                    Wire_Brand as WireBrand,
                    Control_Wire_Brand as ControlWireBrand,
                    Type,
                    Finished,
                    USR_USERNAME as UsrUsername,
                    Date_Created as DateCreated
                FROM technical_project_identity
                WHERE IDProjectMain = %s
                ORDER BY ID DESC
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

            # Note: Table name is uppercase and ends with 'FIELDS' (plural)
            # Column names use underscores based on C# Entity Framework model pattern
            query = """
                SELECT
                    Id,
                    Id_technical_Project_Identity as IdtechnicalProjectIdentity,
                    Id_project_Main as IdprojectMain,
                    Field_Title as FieldTitle,
                    Field_Descriptions as FieldDescriptions,
                    Date_U as DateU,
                    Status
                FROM TECHNICAL_PROJECT_IDENTITY_ADDITIONAL_FIELDS
                WHERE Id_project_Main = %s AND Status = 1
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

            # Note: Column names from C# model - use exact case and underscores
            query = """
                SELECT
                    ID as Id,
                    IDProjectMain as IdprojectMain,
                    IDProjectScope as IdprojectScope,
                    ProductType_label as ProductTypeLabel,
                    Plane_Name1 as PlaneName1,
                    Plane_Type as PlaneType,
                    Plane_Type_Remark_Description as PlaneTypeRemarkDescription,
                    Cell_Count as CellCount,
                    PadLock_KeyContactor as PadLockKeyContactor,
                    Padlock_KeyTest as PadlockKeyTest,
                    Padlock_SwitchTest as PadlockSwitchTest,
                    Layout_Type as LayoutType,
                    Layout_Type_Remark_Description as LayoutTypeRemarkDescription,
                    How_To_Plating as HowToPlating,
                    How_To_Plating_Remark_Description as HowToPlatingRemarkDescription,
                    Packing_Type_Remark_Description as PackingTypeRemarkDescription,
                    Isolation_Type as IsolationType,
                    Isolation_Type_Remark_Description as IsolationTypeRemarkDescription,
                    Plating_Type as PlatingType,
                    Plating_Type_Remark_Description as PlatingTypeRemarkDescription,
                    Isolation,
                    Isolation_Remark_Description as IsolationRemarkDescription,
                    Height, Width, Depth,
                    Voltage_Rate as VoltageRate,
                    Voltage_Rate_Remark_Description as VoltageRateRemarkDescription,
                    Switch_Amperage as SwitchAmperage,
                    rated_voltage as RatedVoltage,
                    rated_voltage_Remark_Description as RatedVoltageRemarkDescription,
                    frequency as Frequency,
                    frequency_Remark_Description as FrequencyRemarkDescription,
                    KABUS as Kabus,
                    ABUS as Abus,
                    Main_Busbar_Size as MainBusbarSize,
                    Earth_Size as EarthSize,
                    Neutral_Size as NeutralSize,
                    Type_Busbar as TypeBusbar,
                    Inlet_Contact as InletContact,
                    Inlet_Contact_Remark_Description as InletContactRemarkDescription,
                    Outlet_Contact as OutletContact,
                    Outlet_Contact_Remark_Description as OutletContactRemarkDescription,
                    Access_From as AccessFrom,
                    Access_From_Remark_Description as AccessFromRemarkDescription,
                    IP as Ip,
                    IP_Remark_Description as IpRemarkDescription,
                    Color_Real as ColorReal,
                    Color_Real_Remark_Description as ColorRealRemarkDescription,
                    cpcts as Cpcts,
                    scm as Scm,
                    plsh as Plsh,
                    msh as Msh,
                    mbc as Mbc,
                    mbc_Remark_Description as MbcRemarkDescription,
                    rpfwv as Rpfwv,
                    riwv as Riwv,
                    PROJECT_IDENTITYID as ProjectIdentityid,
                    Revision,
                    USR_USERNAME as UsrUsername,
                    Date_Created as DateCreated
                FROM technical_panel_identity
                WHERE IDProjectMain = %s
                ORDER BY ID
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

            # Note: Table name is uppercase and ends with 'FIELDS' (plural)
            # Column names use underscores based on C# Entity Framework model pattern
            query = """
                SELECT
                    Id,
                    Id_technical_Panel_Identity as IdtechnicalPanelIdentity,
                    Id_project_Main as IdprojectMain,
                    Id_project_Scope as IdprojectScope,
                    Field_Title as FieldTitle,
                    Field_Descriptions as FieldDescriptions,
                    Date_U as DateU,
                    Status
                FROM TECHNICAL_PANEL_IDENTITY_ADDITIONAL_FIELDS
                WHERE Id_project_Main = %s AND Status = 1
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

            # Note: Column names from C# model - use exact case and underscores
            # View_draft view columns: ID, Project_ID, Tablo_ID, tmpId, scopeName,
            # bus_section, feeder_no, tag, Designation, wiring_type, rating_power,
            # flc, Module, module_type, Size, cable_size, cb_rating, overLoad_rating,
            # contactor_rating, sfd_hfd, templateName, description, revision, ordering
            query = """
                SELECT
                    ID as Id,
                    Project_ID as ProjectId,
                    Tablo_ID as TabloId,
                    tmpId as TmpId,
                    scopeName as ScopeName,
                    bus_section as BusSection,
                    feeder_no as FeederNo,
                    tag as Tag,
                    Designation,
                    wiring_type as WiringType,
                    rating_power as RatingPower,
                    flc as Flc,
                    Module,
                    module_type as ModuleType,
                    Size,
                    cable_size as CableSize,
                    cb_rating as CbRating,
                    overLoad_rating as OverLoadRating,
                    contactor_rating as ContactorRating,
                    sfd_hfd as SfdHfd,
                    templateName as TemplateName,
                    description as Description,
                    revision as Revision,
                    ordering as Ordering
                FROM View_draft
                WHERE Project_ID = %s
                ORDER BY Tablo_ID, ordering, ID
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

            # Note: Column names from C# model - use exact case
            # View_draft_Equipment columns: draftId, label, Ecode, equipment, QTY, priority, color,
            # SEC_DES, TYPE_DES, BRAND_DES, SHR_DES, SHR_DES2, SCODE, ENG_DES
            query = """
                SELECT
                    e.draftId as DraftId,
                    e.label as Label,
                    e.Ecode,
                    e.equipment as Equipment,
                    e.QTY as Qty,
                    e.priority as Priority,
                    e.color as Color,
                    e.SEC_DES as SecDes,
                    e.TYPE_DES as TypeDes,
                    e.BRAND_DES as BrandDes,
                    e.SHR_DES as ShrDes,
                    e.SHR_DES2 as ShrDes2,
                    e.SCODE as Scode,
                    e.ENG_DES as EngDes
                FROM View_draft_Equipment e
                INNER JOIN View_draft d ON e.draftId = d.ID
                WHERE d.Project_ID = %s
                ORDER BY e.draftId, e.priority
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

            # Note: Column names from C# model - View_draft_column columns: id, level, name, Project_ID
            query = """
                SELECT
                    id as Id,
                    level as Level,
                    name as Name,
                    Project_ID as ProjectId
                FROM View_draft_column
                WHERE Project_ID = %s
                ORDER BY level, id
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

            # Note: Table name is 'TECHNICAL_PROPERTIES' (uppercase) - case-sensitive on Linux
            query = """
                SELECT Id, CategoryId, Type, Title
                FROM TECHNICAL_PROPERTIES
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

            # Note: Table name is 'TECHNICAL_PROPERTIES' (uppercase) - case-sensitive on Linux
            query = """
                SELECT Title
                FROM TECHNICAL_PROPERTIES
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

    def list_available_tables(self) -> Dict[str, List[str]]:
        """
        Diagnostic function to list all tables/views accessible by the technical user.

        Returns:
            Dict with 'tables' and 'views' lists
        """
        result = {
            "tables": [],
            "views": [],
            "all_objects": [],
            "errors": []
        }

        try:
            connection = self._get_connection()
            cursor = connection.cursor()

            # Try to get all tables and views from information_schema
            try:
                query = """
                    SELECT TABLE_NAME, TABLE_TYPE
                    FROM INFORMATION_SCHEMA.TABLES
                    WHERE TABLE_SCHEMA = %s
                    ORDER BY TABLE_TYPE, TABLE_NAME
                """
                cursor.execute(query, (self.database,))
                rows = cursor.fetchall()

                for row in rows:
                    table_name = row.get('TABLE_NAME', '')
                    table_type = row.get('TABLE_TYPE', '')
                    result["all_objects"].append({"name": table_name, "type": table_type})

                    if 'VIEW' in table_type.upper():
                        result["views"].append(table_name)
                    else:
                        result["tables"].append(table_name)

            except MySQLError as e:
                result["errors"].append(f"INFORMATION_SCHEMA query failed: {e}")

                # Fallback: try SHOW TABLES
                try:
                    cursor.execute("SHOW TABLES")
                    rows = cursor.fetchall()
                    for row in rows:
                        # SHOW TABLES returns dict with dynamic key
                        table_name = list(row.values())[0] if row else None
                        if table_name:
                            result["all_objects"].append({"name": table_name, "type": "unknown"})
                except MySQLError as e2:
                    result["errors"].append(f"SHOW TABLES failed: {e2}")

            # Test which tables/views we can actually SELECT from
            # Note: MySQL on Linux is case-sensitive for table names!
            # Names from C# Entity Framework model (TPMSDbContext)
            test_tables = [
                # Views (from C# ToView mappings)
                "View_Project_Main",
                "View_draft",              # lowercase 'd'
                "View_draft_Equipment",    # mixed case
                "View_draft_column",       # lowercase
                "view_scope",
                "view_UserNamefani",
                "technical_project_identity",   # lowercase view
                "technical_panel_identity",     # lowercase view
                "technical_users",              # lowercase view
                # Tables (from C# ToTable mappings)
                "TECHNICAL_PROPERTIES",                          # uppercase
                "TECHNICAL_PROJECT_IDENTITY_ADDITIONAL_FIELDS",  # uppercase, ends with 'S'
                "TECHNICAL_PANEL_IDENTITY_ADDITIONAL_FIELDS",    # uppercase, ends with 'S'
                "TECHNICAL_CELL_IDENTITY",
                "TECHNICAL_CELL_IDENTITY_CELL_TYPES",
                "TECHNICAL_CELL_IDENTITY_MV",
                "draft_permission",
                "Technical_draft_template",
                "Technical_draft_equipment_template",
                "CODING_MERCHANDISE_TB",
            ]

            accessible = []
            inaccessible = []

            for table in test_tables:
                try:
                    cursor.execute(f"SELECT 1 FROM {table} LIMIT 1")
                    cursor.fetchone()
                    accessible.append(table)
                except MySQLError:
                    inaccessible.append(table)

            result["accessible"] = accessible
            result["inaccessible"] = inaccessible

            cursor.close()
            connection.close()

            logger.info(f"TPMS accessible tables: {accessible}")
            logger.info(f"TPMS inaccessible tables: {inaccessible}")

            return result

        except MySQLError as e:
            logger.error(f"Error listing tables: {e}")
            result["errors"].append(str(e))
            return result


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
