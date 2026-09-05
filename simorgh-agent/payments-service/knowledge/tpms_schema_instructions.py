"""
TPMS Database Schema Instructions
===================================
Instruction document for the COT engine describing the TPMS database tables,
their relationships, and when to query each table. Instead of dumping all TPMS
data into the project workspace, the COT engine uses these instructions to
know which table to query via tpms_fetch / MCP when specific data is needed.

This is the "standard tier" - data is fetched on-demand from TPMS via
the tpms-fetcher microservice, keeping the project workspace clean and
ensuring data is always fresh.
"""

TPMS_SCHEMA_INSTRUCTIONS = """
## TPMS Database Schema & Query Instructions

The TPMS database (MySQL at 192.168.1.148:3306, database: TPMS) is the
single source of truth for all project technical data at EKC (Electrokavir).
Use the `tpms_fetch` tool to query specific tables when data is needed.

### Key Concept: Project Hierarchy
```
ViewProjectMain (OENUM → IDProjectMain)
    └── ViewScope (IDProjectScope = panel/scope)
        ├── TechnicalProjectIdentity (project-level specs)
        ├── TechnicalPanelIdentity (panel-level specs)
        ├── TechnicalCellIdentity (LV cell specs)
        ├── TechnicalCellIdentityMv (MV cell specs)
        └── ViewDraft + ViewDraftEquipment (EPLAN drawings data)
```

### Table Reference

#### 1. ViewProjectMain — Project Master List
**When to query**: Always the FIRST table to query. Maps OENUM to IDProjectMain.
**Key columns**:
- `OENUM` (varchar 12): The project order number (e.g., "04A12065"). This is what legacy users use to identify projects.
- `IDProjectMain` (bigint): Internal unique project ID. **Use this to filter all other tables.**
- `Project_Name` (varchar 160): English project name
- `Project_Name_Fa` (varchar 160): Farsi project name
- `OEDATE` (varchar 20): Order date
- `Order_Category` (varchar 24): Category of the order
- `Project_Expert_Label`: Assigned project expert
- `Technical_Expert_Label`: Assigned technical expert
- `Technical_Supervisor_Label`: Technical supervisor
**Query**: `tpms_fetch` with `{"oenum": "XXXXX"}` or `{"table": "ViewProjectMain", "filter": {"OENUM": "XXXXX"}}`

#### 2. ViewScope — Panels/Scopes within a Project
**When to query**: To understand what panels/switchgear are in the project.
**Key columns**:
- `IDProjectMain` (bigint): Links to ViewProjectMain
- `IDProjectScope` (bigint): Unique scope/panel ID. **Use this to get panel-specific data.**
- `TAG` (varchar 300): Panel tag name (e.g., "MCC-01", "PDB-01")
- `Description` (varchar 300): Panel description
- `ProductType` (varchar 20): Product type code
- `ProductType_label` (varchar 256): Human-readable product type
- `SW_Type` (varchar 20): Switchgear type
- `ITEM_Type` (varchar 16): Item type
- `Cell_No` (varchar 8): Number of cells
- `Cell_No_Invoiced` (varchar 8): Invoiced cell count
**Query**: `tpms_fetch` with `{"table": "ViewScope", "filter": {"IDProjectMain": <id>}}`

#### 3. TechnicalProjectIdentity — Project-Level Technical Specs
**When to query**: To get project-wide technical specifications (wire colors, plating, insulation, packing, etc.)
**Key columns**:
- `IDProjectMain`: Links to project
- `Revision`: Revision number
- `Wire_Brand`, `Control_Wire_Size`, `CT_Wire_Size`, `PT_Wire_Size`
- `Phase_Wire_Color`, `Natural_Wire_Color`, `Three_Phase_Wire_Color`
- `DC_Plus_Wire_Color`, `DC_Mines_Wire_Color`
- `Digital_Inlet_Wire_Color`, `Digital_Outlet_Wire_Color`
- `Plating_Type`, `How_To_Plating`, `Color_Type`, `Color_Thickness`
- `Isolation`, `Isolation_Type`
- `Packing_Type`, `Label_Background_Color`, `Label_Writing_Color`
- `Average_Temperature`, `Above_Sea_Level`, `Delivery_Date`
- All `*_Remark_Description` fields contain human-readable descriptions for numeric codes
**Query**: `tpms_fetch` with `{"table": "TechnicalProjectIdentity", "filter": {"IDProjectMain": <id>}}`

#### 4. TechnicalProjectIdentityAdditionalFields — Extra Project Fields
**When to query**: When project-level custom/additional specifications are needed.
**Key columns**:
- `IDProjectMain`, `IDTechnicalProjectIdentity`
- `field_title`: Name of the additional field
- `field_descriptions`: Value/description of the field
- `Status`: Active status (1 = active)

#### 5. TechnicalPanelIdentity — Panel-Level Technical Specs
**When to query**: To get specifications for a specific panel (busbar sizes, IP rating, voltage, layout, etc.)
**Key columns**:
- `IDProjectMain`, `IDProjectScope`: Links to project and scope
- `Plane_Name1`: Panel name
- `Plane_Type`: Panel type description (English)
- `Main_Busbar_Size`, `Earth_Size`, `Neutral_Size`
- `Width`, `Height`, `Depth`: Panel dimensions
- `IP`: Ingress protection rating
- `rated_voltage`, `Voltage_Rate`: Voltage ratings
- `frequency`: System frequency
- `Layout_Type`: Panel layout type
- `Inlet_Contact`, `Outlet_Contact`: Connection types
- `Access_From`: Front/rear access
- `Cell_Count`: Number of cells in this panel
- `Isolation`, `Isolation_Type`, `Plating_Type`, `How_To_Plating`
- `Switch_Amperage`: Main switch rating
- `ProductType_label`: Product type label
- All `*_Remark_Description` fields for human-readable values
**Query**: `tpms_fetch` with `{"table": "TechnicalPanelIdentity", "filter": {"IDProjectMain": <id>, "IDProjectScope": <scope_id>}}`

#### 6. TechnicalPanelIdentityAdditionalFields — Extra Panel Fields
**When to query**: When panel-level custom specifications are needed.
**Key columns**: `IDProjectMain`, `IDProjectScope`, `IDTechnicalPanelIdentity`, `field_title`, `field_descriptions`

#### 7. TechnicalCellIdentity — LV Cell Identity (Low Voltage Cells)
**When to query**: To get cell-level specifications for LV panels.
**Key columns**:
- `IDProjectMain`, `IDProjectScope`, `Revision`
- `Width`, `Height`, `Depth`: Cell dimensions
- `Type`: Cell type (use TechnicalProperties to decode)
- `VerticalBusbarSize`: Vertical busbar size
- `ErathBusbarSize`, `NeutralBusbarSize`
- `baseFrame`: Base frame type
**Query**: `tpms_fetch` with `{"table": "TechnicalCellIdentity", "filter": {"IDProjectMain": <id>, "IDProjectScope": <scope_id>}}`

#### 8. TechnicalCellIdentityCellTypes — LV Cell Type Details
**When to query**: For detailed specifications of each LV cell (circuit breaker type, cable sizes, etc.)
**Key columns**:
- `IDCellIdentity`, `IDProjectMain`, `IDProjectScope`
- `CellNumber`: Cell designation
- `Type`: Cell type code
- `Width`, `Height`, `Depth`: Dimensions
- `CBInletRange`: Circuit breaker inlet range
- `VerticalBusbarSize`, `InletContact`, `OutletContact`
- `contactorType`: Contactor/breaker type
- `CTBox`, `PTBox`: CT/PT box presence
- `Status`, `QCConfirm`, `ShippingPermission`

#### 9. TechnicalCellIdentityMv — MV Cell Identity (Medium Voltage)
**When to query**: For MV switchgear cell specifications.
**Key columns**:
- `IDProjectMain`, `IDProjectScope`, `Revision`
- `baseFrame`, `ErathBusbarSize`, `NeutralBusbarSize`
- `contactorType`: Disconnector/contactor type
- Plus many MV-specific fields (exhaust, PT types, interlock quantities, etc.)

#### 10. TechnicalCellIdentityCellTypesMv — MV Cell Type Details
**When to query**: For detailed MV cell specifications (per-cell data).
**Key columns**:
- `CellNumber`, `MVType`: Cell number and MV type
- `Line`: Line identifier
- `SldType`: Single-line diagram type
- `contactorType`, `keyAmmper`: Breaker type and amperage
- `ammper_ct`, `type_Ct`, `type_pt`: CT/PT specifications
- `Cabel_size`: Cable size
- `SurgeArrester`, `SurgeLimiter`: Protection devices
- `ArabeDezhngtor`, `ArabeLink`, `ArabeMetering`: Truck types (disconnector, link, metering)
- Many component flags: `busDuct`, `rearDuct`, `doorMagnet`, `busbarMagnet`, `cableMagnet`, etc.

#### 11. ViewDraft — Feeder/Draft Data for EPLAN
**When to query**: To get data needed for automatic EPLAN drawing generation. This is the main table for generating electrical drawings.
**Key columns**:
- `Project_ID` (maps to IDProjectMain), `Tablo_ID` (maps to IDProjectScope)
- `feeder_no`: Feeder line number
- `tag`: Equipment tag
- `Designation`: Feeder designation/description
- `Module`: Module/position in panel
- `Size`: Physical size
- `flc`: Full Load Current
- `rating_power`: Rated power
- `cb_rating`: Circuit breaker rating
- `cable_size`: Cable size
- `bus_section`: Bus section
- `wiring_type`: Wiring type (SFD/HFD)
- `contactor_rating`: Contactor rating
- `overLoad_rating`: Overload relay rating
- `sfd_hfd`: SFD or HFD designation
- `revision`, `ordering`: Revision number and display order
- `templateName`, `tmpId`: Template reference
**Query**: `tpms_fetch` with `{"table": "ViewDraft", "filter": {"Project_ID": <id>}}`

#### 12. ViewDraftEquipment — Equipment BOM for Feeders
**When to query**: To get the Bill of Materials (BOM) for each feeder/draft.
**Key columns**:
- `draftId`: Links to ViewDraft
- `equipment`: Equipment type code
- `Ecode`: EKC product code
- `ENG_DES`: English description of equipment
- `SEC_DES`, `SHR_DES`, `SHR_DES2`: Subcategory and short descriptions
- `TYPE_DES`: Sub-subcategory
- `BRAND_DES`: Brand
- `SCODE`: Manufacturer code
- `label`: Label text
- `QTY`: Quantity
- `priority`: Priority/ordering

#### 13. TechnicalDraftTemplate — Draft Templates
**When to query**: To get available feeder templates for a project.
**Key columns**: `name`, `Project_ID`, `REV`, `tag`, `Designation`, `Module`, `Size`, `flc`, `rating_power`, `cb_rating`, `cable_size`, `bus_section`, `wiring_type`, `contactor_rating`, `overLoad_rating`, `sfd_hfd`

#### 14. TechnicalDraftEquipmentTemplate — Equipment per Template
**When to query**: To get BOM for draft templates.

#### 15. CodingMerchandiseTb — Product/Material Catalog
**When to query**: To look up product information by EKC code (ECODE).
**Key columns**:
- `ECODE`: EKC product code (unique)
- `ENG_DES`: English description
- `FRS_DES`: Farsi description
- `SHR_DES`: Short description
- `SHR_DES2`: EPLAN-specific description
- `MAIN_DES`: Main category
- `SEC_DES`: Sub-category
- `TYPE_DES`: Sub-sub-category
- `NAT_DES`: Material nature
- `BRAND_DES`: Brand
- `SCODE`: Manufacturer code
**Query**: `tpms_fetch` with `{"table": "CodingMerchandiseTb", "filter": {"ECODE": "XXX"}}`

#### 16. CodingAmmeterTb — Ammeter Catalog
**When to query**: To look up ammeter types by code.

#### 17. TechnicalProperties — Property Lookup Table
**When to query**: To decode numeric property values into human-readable text. Many fields in other tables store numeric codes that reference this table.
**Key columns**:
- `ID`: Property ID (referenced by other tables)
- `Type`: Property category (see below)
- `Title`: Human-readable title/value
- `CategoryId`: Sub-category
**Property Type Guide (Type → Meaning)**:
1=Project Group, 2=Project Type, 3=Packing Type, 4=Insulation, 5=Insulation Type,
6=Plating Type, 7=How To Plating, 8=Color Type, 9=Control Wire Size,
10=CT Wire Size, 11=PT Wire Size, 12=AC Phase Wire Color, 13=AC Neutral Wire Color,
14=DC+ Wire Color, 15=DC- Wire Color, 16=Digital Inlet Wire Color,
17=Digital Outlet Wire Color, 18=Three Phase Wire Color, 19=PLC Feeding Wire Size,
20=Inlet Wire Size, 21=Outlet Wire Size, 22=DC+ Phase Wire Color,
23=DC- Neutral Wire Color, 24=AC+ Phase Wire Color, 25=AC- Neutral Wire Color,
26=Label Writing Color, 27=Label Background Color, 28=Panel Type,
29=Inlet Contact, 30=Outlet Contact, 31=Access From, 32=IP Rating,
33=Real Color, 34=Color Thickness, 35=Cell Type, 36=Cell Depth,
37=Cell Feeders, 38=Cell Width, 39=Cell Height, 40=Vertical Busbar Size,
41=Panel Base, 42=Drawer Bridge Count, 43=MV Layout, 44=Padlock,
45=MV Cell Types, 46=LV Compartment Height, 47=MV Rear Duct,
48=MV Cell Width, 49=Tall Equipment Frame, 50=(reserved), 51=MV Cell Type
**Query**: `tpms_fetch` with `{"table": "TechnicalProperties", "filter": {"Type": <type_number>}}`

#### 18. ViewUserNamefani — User Names
**When to query**: To resolve technical staff names.
**Key columns**: `EMPUSERNAME`, `ENEMPLOYEENAME`

#### 19. TechnicalUsers — User Authentication
**When to query**: For user identification. View only.
**Key columns**: `ID`, `EMPUSERNAME`, `USER_UID`, `DraftPassword`

#### 20. DraftPermission — Draft Access Control
**When to query**: To check which users have permission to edit a project's drafts.
**Key columns**: `Project_ID`, `user`

### Common Query Patterns

**Get project overview**: Query ViewProjectMain → ViewScope → TechnicalProjectIdentity
**Get panel details**: Query TechnicalPanelIdentity + TechnicalPanelIdentityAdditionalFields
**Get cell data (LV)**: Query TechnicalCellIdentity + TechnicalCellIdentityCellTypes
**Get cell data (MV)**: Query TechnicalCellIdentityMv + TechnicalCellIdentityCellTypesMv
**Get EPLAN data**: Query ViewDraft + ViewDraftEquipment for the project
**Decode numeric values**: Cross-reference with TechnicalProperties using the Type column
**Look up product**: Query CodingMerchandiseTb by ECODE
"""


def get_tpms_instructions() -> str:
    """Return the TPMS schema instructions for injection into COT context."""
    return TPMS_SCHEMA_INSTRUCTIONS
