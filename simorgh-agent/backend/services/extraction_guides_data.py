"""
Extraction Guides Data
======================
Complete extraction guide definitions for all 60 specification fields
across 13 categories. These guides are used by the enhanced KG RAG system
to extract accurate values from spec documents.

Author: Simorgh Industrial Assistant
"""

EXTRACTION_GUIDES = {
    "Switchgear_Specifications": {
        "Rated_Short_Time_Withstand_Current": {
            "definition": "The maximum current that the switchgear can safely carry for a short duration (typically 1-3 seconds) during fault conditions without damage to its components.",
            "extraction_instructions": "Look for specifications related to 'short-time withstand current', 'Icw', 'short-circuit withstand', or 'fault current rating'. Commonly expressed in kA (kiloamperes) with a time duration (e.g., '25kA for 1s'). Check electrical specifications tables, busbar ratings, or main circuit breaker specifications.",
            "examples": "25 kA / 1s, 31.5 kA / 3s, 40 kA for 1 second, Icw = 25kA/1s",
            "common_values": "Standard values: 16kA, 20kA, 25kA, 31.5kA, 40kA, 50kA, 63kA (typically with 1s or 3s duration)",
            "relationships": "Related to Main_Busbar_Rated_Current, Circuit_Breaker_Breaking_Capacity. Must be coordinated with upstream protection devices.",
            "notes": "Critical for safety and protection coordination. Higher values indicate more robust equipment capable of handling severe fault conditions."
        },
        "Main_Busbar_Rated_Current": {
            "definition": "The continuous current-carrying capacity of the main busbar system in the switchgear under normal operating conditions at a specified ambient temperature.",
            "extraction_instructions": "Search for 'main busbar rated current', 'busbar ampacity', 'main bus rating', or 'In' (nominal current). Usually found in busbar specifications section. May be specified per phase or for the entire system. Look for values in amperes (A).",
            "examples": "4000A, 5000 A, 6300A, In = 4000A, Main Busbar: 4000A",
            "common_values": "Standard ratings: 630A, 800A, 1000A, 1250A, 1600A, 2000A, 2500A, 3200A, 4000A, 5000A, 6300A (IEC standard values)",
            "relationships": "Must be greater than or equal to the sum of connected load currents. Related to Busbar_Material, Busbar_Configuration.",
            "notes": "Typically specified at 35°C or 40°C ambient temperature. Higher temperatures may reduce current-carrying capacity."
        },
        "Switchboard_Color": {
            "definition": "The external color finish of the switchgear enclosure, typically specified by RAL color code or descriptive name.",
            "extraction_instructions": "Look for 'color', 'finish', 'painting', 'RAL code', or 'enclosure color' in specifications. Common locations: enclosure specifications, painting requirements, or finishing details sections.",
            "examples": "RAL 7035, RAL 9002, Light Grey, Beige, RAL 7035 (Light Grey), Grey RAL 7032",
            "common_values": "RAL 7035 (Light Grey), RAL 7032 (Pebble Grey), RAL 9002 (Grey White), RAL 9001 (Cream), Custom colors per client specification",
            "relationships": "May be related to environmental requirements, aesthetic preferences, or industrial standards.",
            "notes": "RAL 7035 and RAL 7032 are most common in industrial applications. Some projects specify multiple colors for different voltage levels."
        },
        "Frequency": {
            "definition": "The electrical frequency of the power system for which the switchgear is designed, measured in Hertz (Hz).",
            "extraction_instructions": "Look for 'frequency', 'Hz', 'system frequency', or 'rated frequency'. Usually found in main electrical parameters or system specifications. Standard values are 50Hz or 60Hz.",
            "examples": "50 Hz, 60Hz, 50/60 Hz, Frequency: 50Hz",
            "common_values": "50 Hz (most countries), 60 Hz (Americas, parts of Asia), 50/60 Hz (dual-frequency equipment)",
            "relationships": "Affects transformer design, motor specifications, and some protective relay settings.",
            "notes": "Critical parameter - all equipment must match system frequency. Some equipment can operate at both 50Hz and 60Hz."
        },
        "Service_Voltage": {
            "definition": "The rated operating voltage of the electrical system, typically line-to-line voltage for three-phase systems.",
            "extraction_instructions": "Search for 'rated voltage', 'service voltage', 'system voltage', 'Ue' (operational voltage), or 'Un' (nominal voltage). Look in main electrical specifications. May be specified as single value (e.g., 400V) or range (e.g., 380-415V).",
            "examples": "400V, 415V, 380-415V, 400/230V, Ue = 400V AC",
            "common_values": "LV: 230V, 400V, 415V, 440V, 480V, 690V; MV: 3.3kV, 6.6kV, 11kV, 13.8kV, 20kV, 33kV",
            "relationships": "Determines insulation levels, cable ratings, transformer specifications. Related to Insulation_Voltage.",
            "notes": "May include tolerance range (e.g., ±10%). Three-phase systems typically specified as line-to-line voltage."
        },
        "Insulation_Voltage": {
            "definition": "The voltage level that the insulation system is designed to withstand, typically higher than service voltage to provide safety margin.",
            "extraction_instructions": "Look for 'insulation voltage', 'Ui', 'rated insulation voltage', 'dielectric strength', or 'withstand voltage'. Usually in insulation specifications or electrical ratings section.",
            "examples": "1000V, 690V, Ui = 1000V, Insulation level: 1000V AC",
            "common_values": "For 400V systems: 690V or 1000V; For 690V systems: 1000V; MV systems: typically 1.5-2× service voltage",
            "relationships": "Must be greater than Service_Voltage. Related to IK_Rating and environmental conditions.",
            "notes": "Higher insulation voltage provides better safety margin and allows operation at higher altitudes or polluted environments."
        },
        "IP_Rating": {
            "definition": "Ingress Protection rating indicating the degree of protection against solid objects and liquids, per IEC 60529 standard.",
            "extraction_instructions": "Search for 'IP rating', 'IP code', 'ingress protection', 'degree of protection'. Format is IP followed by two digits (e.g., IP54). First digit: solid objects (0-6), second digit: liquids (0-8). Check enclosure specifications.",
            "examples": "IP54, IP42, IP55, IP 54, Degree of Protection: IP54",
            "common_values": "IP42 (standard indoor), IP54 (dusty/outdoor), IP55 (protected outdoor), IP65 (harsh environments), IP31 (minimal protection)",
            "relationships": "Affected by installation environment. Higher ratings for outdoor or harsh industrial environments.",
            "notes": "First digit ≥4 means dust-protected, ≥5 means dust-tight. Second digit ≥4 means splash-proof, ≥5 means water jet protected."
        },
        "IK_Rating": {
            "definition": "Impact protection rating indicating resistance to mechanical impact, per IEC 62262 standard. Ranges from IK00 (no protection) to IK10 (20 joules impact).",
            "extraction_instructions": "Look for 'IK rating', 'IK code', 'impact protection', 'mechanical impact resistance'. Format is IK followed by two digits (00-10). Check enclosure or mechanical specifications.",
            "examples": "IK10, IK08, IK 10, Impact resistance: IK10",
            "common_values": "IK08 (standard industrial - 5 joules), IK10 (heavy industrial - 20 joules), IK07 (light industrial - 2 joules)",
            "relationships": "Related to installation location and potential mechanical hazards. Often specified with IP_Rating.",
            "notes": "IK10 provides maximum protection (20J impact = 5kg mass dropped from 40cm). Critical for public access areas."
        },
        "Ambient_Temperature_Min": {
            "definition": "The minimum ambient temperature at which the switchgear can operate safely and maintain its ratings.",
            "extraction_instructions": "Search for 'minimum temperature', 'ambient temperature range', 'operating temperature min', 'temperature range'. Look in environmental or operating conditions sections. Usually in °C.",
            "examples": "-5°C, 0°C, -10°C, Min ambient: -5°C, Temperature range: -5 to +40°C",
            "common_values": "Indoor: -5°C, 0°C, +5°C; Outdoor: -25°C, -40°C; Special applications: -50°C",
            "relationships": "Must consider installation location climate. Related to Ambient_Temperature_Max.",
            "notes": "Lower temperatures may require heaters or special materials. Outdoor installations typically need lower minimum ratings."
        },
        "Ambient_Temperature_Max": {
            "definition": "The maximum ambient temperature at which the switchgear can operate at full rated capacity without derating.",
            "extraction_instructions": "Search for 'maximum temperature', 'ambient temperature max', 'operating temperature max', 'temperature range'. Standard value is often +40°C. Check environmental specifications.",
            "examples": "+40°C, 40°C, +45°C, Max ambient: +40°C, Temperature range: -5 to +40°C",
            "common_values": "+40°C (standard), +45°C (hot climates), +50°C (extreme conditions), +55°C (special applications)",
            "relationships": "Higher temperatures may require derating of current-carrying capacity. Affects cooling requirements.",
            "notes": "Standard IEC rating is +40°C. Higher temperatures may require forced ventilation or derating factors."
        },
        "Altitude": {
            "definition": "The maximum altitude above sea level at which the switchgear can operate at full ratings without derating.",
            "extraction_instructions": "Look for 'altitude', 'elevation', 'installation height', 'above sea level'. Usually in environmental conditions. May be in meters or feet. Standard is often 1000m.",
            "examples": "1000m, 2000 meters above sea level, Max altitude: 1000m, <1000m ASL",
            "common_values": "1000m (standard), 2000m (elevated sites), 3000m (high altitude), 4000m (extreme altitude - requires derating)",
            "relationships": "Higher altitudes reduce dielectric strength and cooling capacity. May require derating of Insulation_Voltage and current ratings.",
            "notes": "Above 1000m: typically 1% derating per 100m for dielectric strength. High-altitude sites may need special designs."
        },
        "Relative_Humidity": {
            "definition": "The maximum relative humidity level that the switchgear can withstand without condensation or degradation.",
            "extraction_instructions": "Search for 'humidity', 'relative humidity', 'RH', 'moisture'. Usually specified as percentage with temperature condition. Look in environmental specifications.",
            "examples": "95% at 25°C, RH 95%, Max humidity: 95% non-condensing, 50% average / 95% max",
            "common_values": "95% at 20-25°C (standard), 50% average annual, Non-condensing conditions required",
            "relationships": "High humidity may require heaters, dehumidifiers, or tropical-rated equipment. Related to environmental conditions.",
            "notes": "Critical for preventing condensation. Tropical environments may need special treatment (heaters, sealed enclosures)."
        },
        "Pollution_Degree": {
            "definition": "Classification of environmental pollution level per IEC 60664-1, ranging from 1 (no pollution) to 4 (conductive pollution).",
            "extraction_instructions": "Look for 'pollution degree', 'PD', 'contamination level', 'environmental pollution'. Usually PD1, PD2, PD3, or PD4. Check insulation coordination or environmental sections.",
            "examples": "PD2, Pollution Degree 2, PD 2, Pollution: Degree 2",
            "common_values": "PD1 (clean rooms), PD2 (normal industrial - most common), PD3 (heavy industrial/outdoor), PD4 (conductive pollution)",
            "relationships": "Affects creepage distances and insulation requirements. Higher pollution requires larger clearances.",
            "notes": "PD2 is standard for most industrial applications. PD3/PD4 may require conformal coating or sealed enclosures."
        },
        "Standard": {
            "definition": "The primary international or national standard(s) to which the switchgear is designed, manufactured, and tested.",
            "extraction_instructions": "Search for 'standard', 'according to', 'compliance', 'IEC', 'IEEE', 'BS', 'DIN'. Multiple standards may be listed. Check compliance or general specifications sections.",
            "examples": "IEC 61439-1/-2, IEC 61439, BS EN 61439-1/2, IEC 61439-1, IEC 61439-2, IEEE C37.20.1",
            "common_values": "IEC 61439-1/-2 (LV switchgear), IEC 62271 (MV switchgear), IEEE C37 (US), BS EN standards (UK), VDE (Germany)",
            "relationships": "Determines testing requirements, safety margins, terminology. May affect design and ratings.",
            "notes": "IEC 61439 series replaced IEC 60439 in 2009. Multiple standards may apply for different aspects."
        },
        "Main_Switch_Type": {
            "definition": "The type of main switching device used for the primary disconnection function in the switchgear.",
            "extraction_instructions": "Look for 'main switch', 'incomer type', 'main switching device', 'main disconnector'. Common types: ACB, MCCB, Fused Switch, Load Break Switch. Check main circuit or protection scheme.",
            "examples": "ACB, Air Circuit Breaker, MCCB, Fused Switch Disconnector, Load Break Switch, Motorized ACB",
            "common_values": "ACB (Air Circuit Breaker), MCCB (Molded Case Circuit Breaker), Fused Switch, Switch Disconnector, Vacuum Contactor",
            "relationships": "Related to Main_Busbar_Rated_Current and protection philosophy. ACBs common for >630A, MCCBs for ≤630A.",
            "notes": "ACBs offer better protection and monitoring. Fused switches are simpler but less flexible."
        },
        "Main_Switch_Breaking_Capacity": {
            "definition": "The maximum short-circuit current that the main switching device can safely interrupt under fault conditions.",
            "extraction_instructions": "Search for 'breaking capacity', 'Icu', 'Ics', 'short-circuit breaking capacity', 'interrupting capacity'. Usually in kA. Check main switch or circuit breaker specifications.",
            "examples": "65 kA, Icu = 65kA, Breaking capacity: 65kA @ 415V, 65kA/415V",
            "common_values": "LV: 25kA, 36kA, 42kA, 50kA, 65kA, 80kA, 100kA; MV: 16kA, 20kA, 25kA, 31.5kA, 40kA",
            "relationships": "Must be ≥ system fault current. Related to Rated_Short_Time_Withstand_Current. Coordinated with upstream protection.",
            "notes": "Icu is ultimate breaking capacity, Ics is service breaking capacity (usually 75% of Icu for MCCBs)."
        },
        "Main_Circuit_Breaker_Brand": {
            "definition": "The manufacturer brand of the main circuit breaker or switching device.",
            "extraction_instructions": "Look for 'manufacturer', 'brand', 'make', supplier name in circuit breaker specifications. Check main equipment list or technical data sheets.",
            "examples": "ABB, Schneider Electric, Siemens, Eaton, GE, LS Electric, Mitsubishi",
            "common_values": "ABB, Schneider Electric, Siemens, Eaton, GE, LS Electric, Mitsubishi, Fuji Electric, WEG, Chint",
            "relationships": "May affect spare parts availability, technical support, and integration with other systems.",
            "notes": "Tier-1 brands: ABB, Schneider, Siemens. Regional preferences may apply. Client may specify approved manufacturer list."
        },
        "Main_Circuit_Breaker_Model": {
            "definition": "The specific model or type designation of the main circuit breaker.",
            "extraction_instructions": "Search for 'model', 'type', 'series' following the manufacturer name. Format varies by manufacturer (e.g., ABB Emax 2, Schneider Masterpact MTZ).",
            "examples": "Emax 2, Masterpact MTZ, 3WL, PowerPact, Tmax XT, E2.2",
            "common_values": "ABB: Emax 2, Tmax XT; Schneider: Masterpact MTZ/NW, Compact NS; Siemens: 3WL, 3WA; Eaton: PowerPact, Power Defense",
            "relationships": "Must match required ratings (current, breaking capacity). Related to Main_Switch_Breaking_Capacity and Main_Busbar_Rated_Current.",
            "notes": "Model determines available features (communication, metering, motor operator). Check compatibility with accessories."
        },
        "Door_Interlock": {
            "definition": "Safety mechanism that prevents access to live parts when doors are opened, ensuring personnel safety.",
            "extraction_instructions": "Look for 'door interlock', 'door lock', 'safety interlock', 'kirk key', 'trapped key'. May specify type (mechanical, electrical, kirk key system). Check safety features.",
            "examples": "Kirk Key System, Mechanical Interlock, Solenoid Lock, Trapped Key Interlock, Door interlock with isolation",
            "common_values": "Kirk Key Interlock, Mechanical Interlock, Electrical Interlock, Solenoid Lock, Castell System, None (for low-risk applications)",
            "relationships": "Critical safety feature. May be integrated with Earthing_Switch and isolation procedures.",
            "notes": "Kirk key systems allow controlled sequential operations. Essential for medium voltage and high-power LV systems."
        },
        "Earthing_Switch": {
            "definition": "A switching device used to connect the isolated circuit to earth/ground for safety during maintenance.",
            "extraction_instructions": "Search for 'earthing switch', 'grounding switch', 'earth blade', 'safety earth'. Check if included, type (manual/automatic), and location. Look in safety features section.",
            "examples": "Manual Earthing Switch, Motorized Earthing Switch, Front-operated earth switch, Included, Not required",
            "common_values": "Manual Earthing Switch (most common), Motorized/Automatic, Integrated with main switch, Separate earthing blade, Not included",
            "relationships": "Usually interlocked with Door_Interlock and main switch. Mandatory for MV, recommended for high-power LV.",
            "notes": "Critical for maintenance safety. Should be visible when engaged. Often interlocked to prevent closing on live circuit."
        },
        "Form_Of_Separation": {
            "definition": "Classification per IEC 61439-1 defining the degree of separation between busbars, functional units, and terminals to protect against direct/indirect contact.",
            "extraction_instructions": "Look for 'Form', 'form of separation', 'internal separation', 'segregation'. Format: Form 1, 2, 3, or 4 (with sub-variants a/b). Check construction or safety specifications.",
            "examples": "Form 4b, Form 3b, Form 2b, Form 4 Type b, Internal separation: Form 4b",
            "common_values": "Form 1 (no separation), Form 2 (busbars separated), Form 3 (terminals separated), Form 4 (full separation - a or b variant)",
            "relationships": "Higher Forms provide better safety but increase cost and space. Form 4b offers maximum protection for maintenance.",
            "notes": "Form 4b most common for MCC/Distribution boards. 'b' variant means terminals in separate compartment from busbars."
        },
        "Vertical_Busbar_Position": {
            "definition": "The location of the vertical (riser) busbars within the switchgear enclosure, affecting accessibility and maintenance.",
            "extraction_instructions": "Search for 'busbar position', 'vertical busbar', 'riser position', 'busbar arrangement'. Common positions: rear, front, side. Check busbar layout drawings or specifications.",
            "examples": "Rear, Front, Side, Center, Left side, Vertical busbar at rear",
            "common_values": "Rear (most common - easier front access), Front, Side/Lateral, Center, Segregated compartment",
            "relationships": "Affects door_Interlock design, Form_Of_Separation, and front/rear access requirements. Related to Main_Busbar_Configuration.",
            "notes": "Rear-mounted busbars allow easier front access for maintenance. Side-mounted may save depth. Consider cable entry location."
        }
    },
    "Busbar_Specifications": {
        "Main_Busbar_Configuration": {
            "definition": "The physical arrangement and configuration of the main busbar system, including number of busbars and their arrangement.",
            "extraction_instructions": "Look for 'busbar configuration', 'busbar arrangement', 'busbar system', 'single busbar', 'double busbar'. Check single-line diagrams and busbar specifications.",
            "examples": "Single Busbar, Double Busbar, Single with Sectionalizing, Horizontal + Vertical, Single main + Distribution",
            "common_values": "Single Busbar (most common), Double Busbar (redundancy), Single with Riser, Single with Sections, Ring Main",
            "relationships": "Related to system architecture and reliability requirements. Affects Main_Busbar_Rated_Current distribution.",
            "notes": "Double busbar provides redundancy for critical applications. Sectionalizing improves fault isolation."
        },
        "Main_Busbar_Material": {
            "definition": "The conductive material used for manufacturing the main busbars.",
            "extraction_instructions": "Search for 'busbar material', 'conductor material', 'Cu', 'Al'. Check busbar specifications or material lists. Usually Copper or Aluminum.",
            "examples": "Copper, Cu, Aluminum, Al, Tinned Copper, Electrolytic Copper",
            "common_values": "Copper (Cu - better conductivity, higher cost), Aluminum (Al - lighter, lower cost), Tinned Copper (corrosion resistant)",
            "relationships": "Affects current-carrying capacity, weight, and cost. Copper has ~60% higher conductivity than aluminum.",
            "notes": "Copper preferred for high currents and compact designs. Aluminum used for cost-sensitive or weight-critical applications."
        },
        "Main_Earth_Bus": {
            "definition": "The earthing/grounding busbar configuration and specifications for safety and fault protection.",
            "extraction_instructions": "Look for 'earth busbar', 'ground bus', 'PE bar', 'earthing system', 'protective earth'. Check if separate or combined with neutral, material, and dimensions.",
            "examples": "Separate Earth Bar, PE Bar, Combined PEN, Copper Earth Bus 10x100mm, Full-length earth bar",
            "common_values": "Separate PE busbar (most common), Combined PEN (rare in modern systems), Copper bar, Full-length or Sectional",
            "relationships": "Critical for safety. Size related to Main_Busbar_Rated_Current and fault current levels. Must comply with earthing standards.",
            "notes": "Typically copper for corrosion resistance. Should run full length of switchboard. Size per fault current, minimum 50-70% of phase conductor."
        },
        "Main_Busbar_Coating": {
            "definition": "Protective coating or plating applied to busbars to prevent oxidation and improve contact resistance.",
            "extraction_instructions": "Search for 'busbar coating', 'plating', 'tinned', 'nickel plated', 'bare'. Check busbar material specifications or finishing details.",
            "examples": "Tin Plated, Nickel Plated, Silver Plated, Bare, Electroplated Tin",
            "common_values": "Tin Plated (most common - prevents oxidation), Nickel Plated (high temperature), Silver Plated (premium), Bare (economy)",
            "relationships": "Improves contact resistance and prevents corrosion. Particularly important in coastal/humid environments.",
            "notes": "Tin plating most cost-effective. Silver provides best conductivity. Nickel for high-temperature applications (>100°C)."
        },
        "Neutral_Busbar": {
            "definition": "Specification of the neutral conductor busbar, including whether it's provided, insulated, and its current rating.",
            "extraction_instructions": "Look for 'neutral bar', 'neutral busbar', 'N bar', 'insulated neutral'. Check if full-rated, half-rated, or not provided. Note insulation requirement.",
            "examples": "Full-rated Insulated, Half-rated, 100% neutral, Insulated Neutral Bar, 50% of phase rating, Not provided",
            "common_values": "Full-rated insulated (100% - for harmonic loads), Half-rated (50% - standard), Not required (delta systems), Solid link",
            "relationships": "Sizing depends on harmonic content and load type. IT systems may not require neutral. Related to system earthing.",
            "notes": "IT/UPS loads need 100% or 200% rated neutral due to harmonics. Insulation prevents accidental grounding."
        },
        "Insulator_Type": {
            "definition": "The type of insulating material used to support and isolate busbars from the enclosure and each other.",
            "extraction_instructions": "Search for 'insulator', 'busbar support', 'isolator material', 'DMC', 'BMC', 'epoxy'. Check busbar mounting or insulation specifications.",
            "examples": "DMC, BMC, Epoxy Resin, Polyester, SMC, Glass-reinforced polyester",
            "common_values": "DMC (Dough Molding Compound - most common), BMC (Bulk Molding Compound), SMC (Sheet Molding Compound), Epoxy resin, Cast resin",
            "relationships": "Must withstand Insulation_Voltage and temperature rise. Related to IP_Rating and environmental conditions.",
            "notes": "DMC/BMC offer good electrical and mechanical properties. Epoxy resin for high-voltage applications. Must be flame-retardant."
        },
        "Busbar_Joint_Method": {
            "definition": "The method used to connect busbar sections together, ensuring electrical and mechanical integrity.",
            "extraction_instructions": "Look for 'busbar connection', 'joint method', 'busbar termination', 'bolted connection', 'welded'. Check assembly or construction specifications.",
            "examples": "Bolted Connection, Welded, Bolted with Spring Washers, Clamped, Brazed joints",
            "common_values": "Bolted with spring washers (most common - allows disassembly), Welded (permanent), Clamped, Compression joints",
            "relationships": "Affects contact resistance and temperature rise. Must maintain integrity under thermal cycling and vibration.",
            "notes": "Bolted joints need proper torque and spring washers. Plating at joints critical for low resistance. Regular maintenance may be needed."
        },
        "Temperature_Rise_Class": {
            "definition": "Maximum allowable temperature rise above ambient for different components, per IEC 61439-1 standards.",
            "extraction_instructions": "Search for 'temperature rise', 'thermal class', 'temperature limits', 'K rise'. Usually specified in Kelvin (K) for different components. Check thermal specifications.",
            "examples": "Class A, 65K for busbars, Busbars: 65K / Terminals: 70K, Acc. to IEC 61439-1",
            "common_values": "Busbars: 65K-70K, Terminals: 70K, Enclosed compartments: 55K, Accessible surfaces: 25K-35K",
            "relationships": "Related to Main_Busbar_Rated_Current and cooling method. Higher currents need better cooling or larger conductors.",
            "notes": "Total temperature = Ambient + Temperature Rise. Standard based on 40°C ambient. Verification by test or calculation per IEC 61439-1."
        },
        "Busbar_Support_Spacing": {
            "definition": "The maximum distance between insulating supports for busbars, ensuring mechanical strength and preventing sagging.",
            "extraction_instructions": "Look for 'support spacing', 'busbar support distance', 'insulator spacing', 'support interval'. Usually in mm or cm. Check mechanical design specifications.",
            "examples": "300mm, 400mm max, Support every 30cm, 250-400mm spacing",
            "common_values": "200-400mm for horizontal runs (depends on busbar size and current), 400-600mm for vertical, Closer spacing for high currents",
            "relationships": "Smaller spacing for higher currents (reduces mechanical stress). Related to Main_Busbar_Rated_Current and fault current.",
            "notes": "Must withstand electromagnetic forces during short-circuits. Larger busbars can have wider spacing. Standards may specify minimum spacing."
        },
        "Busbar_Dimensions": {
            "definition": "Physical cross-sectional dimensions of the busbars, typically width × thickness in millimeters.",
            "extraction_instructions": "Search for 'busbar size', 'busbar dimensions', 'cross-section', 'width x thickness'. Format: WxT or W×T (e.g., 100x10mm). Check busbar technical data.",
            "examples": "100x10mm, 80x10, 10x100mm Cu, 12×100mm per phase",
            "common_values": "Common sizes: 50x5, 63x6, 80x8, 80x10, 100x10, 100x12, 125x10, 160x10 (mm). May use multiple bars per phase.",
            "relationships": "Determined by Main_Busbar_Rated_Current, temperature rise limits, and fault current requirements. Larger for aluminum.",
            "notes": "Multiple bars per phase for very high currents. Orientation affects cooling (wider dimension vertical preferred). Check for per-phase or total."
        }
    },
    "Wire_Specifications": {
        "Control_Wiring_Color": {
            "definition": "Color coding scheme for control and auxiliary wiring to aid identification and maintenance.",
            "extraction_instructions": "Look for 'control wire color', 'wiring color code', 'control cable colors'. May specify different colors for different functions (24VDC, 230VAC, signals, etc.).",
            "examples": "White with numbering, Multi-color per function, Blue, Color-coded per voltage level",
            "common_values": "White/Grey (with numbered ferrules), Color-coded (Red-L1, Yellow-L2, Blue-L3, Black-N, Green/Yellow-PE), Per local standards",
            "relationships": "Should comply with local electrical codes. Related to cable identification and maintenance practices.",
            "notes": "Numbered ferrules more important than color for control wiring. Some standards mandate specific colors for AC/DC circuits."
        },
        "Control_Cable_Type": {
            "definition": "Type and specification of cables used for control, signaling, and auxiliary circuits.",
            "extraction_instructions": "Search for 'control cable type', 'control wire', 'auxiliary cable'. Common types: PVC, LSZH, shielded, number of cores. Check wiring specifications.",
            "examples": "PVC Insulated, LSZH, NYM, Shielded twisted pair, Multi-core PVC cable",
            "common_values": "PVC insulated multi-core (economic), LSZH (Low Smoke Zero Halogen - safety), NYM, Shielded for analog signals, Fire-resistant",
            "relationships": "LSZH required for enclosed spaces. Shielding needed for sensitive control signals. Related to environmental and safety requirements.",
            "notes": "LSZH preferred for safety. Shield grounding critical for noise immunity. Temperature rating must suit application (typically 70-90°C)."
        },
        "Power_Cable_Gland_Type": {
            "definition": "Type of cable glands used for power cable entries, providing sealing, strain relief, and earth continuity.",
            "extraction_instructions": "Look for 'cable gland', 'gland type', 'cable entry', 'power cable termination'. Check if brass, aluminum, or plastic; single/multi-core; armored or unarmored.",
            "examples": "Brass Cable Glands, CW type, Aluminum glands, E1W for SWA, Hawke glands",
            "common_values": "Brass (most common), Aluminum (light weight), Plastic/Nylon (economy), Armored (CW/BW types), Unarmored (A/A2 types)",
            "relationships": "Material and type must match cable construction. Related to IP_Rating (sealing). Brass for better earth continuity with armored cables.",
            "notes": "Armored cable glands provide earth continuity via armor. Must match cable outer diameter. Brass preferred for better corrosion resistance."
        },
        "Control_Cable_Gland_Type": {
            "definition": "Type of glands for control and instrumentation cable entries.",
            "extraction_instructions": "Search for 'control gland', 'instrumentation gland', 'control cable entry'. May be different from power glands. Check if multi-entry or individual.",
            "examples": "Plastic Glands, Nylon, Multi-entry plates, PG glands, M20 threaded glands",
            "common_values": "Plastic/Nylon (most common), Multi-entry plates (multiple small cables), PG thread series, Metric (M16, M20, M25)",
            "relationships": "Must maintain IP_Rating. Multi-entry plates space-efficient. Thread type should match enclosure.",
            "notes": "Plastic acceptable for control cables (no armoring). Multi-entry plates good for many small cables. Ensure proper sealing for IP rating."
        },
        "Cable_Ferrules": {
            "definition": "Type of wire end ferrules used to terminate stranded wires in terminals, improving connection reliability.",
            "extraction_instructions": "Look for 'ferrules', 'wire end sleeves', 'crimp terminals', 'end sleeves'. Check if required, type (insulated/non-insulated), and crimping method.",
            "examples": "Insulated ferrules, Crimp-type ferrules, WAGO-type, Twin ferrules, Color-coded ferrules",
            "common_values": "Insulated ferrules (most common - prevents strand fraying), Non-insulated, Twin ferrules (two wires), Bootlace ferrules",
            "relationships": "Improves terminal connection reliability. Color coding can match wire size. Required by some standards for stranded wire.",
            "notes": "Insulated ferrules provide strain relief and prevent strand breakage. Proper crimping tool essential. Color helps identify wire size."
        }
    },
    "Accessories_Specifications": {
        "Door_Handle_Type": {
            "definition": "Type of door handle or operating mechanism for switchgear enclosure access.",
            "extraction_instructions": "Search for 'door handle', 'door lock', 'handle type', 'operating handle'. Check if rotary, lever, flush, lockable. Look in hardware specifications.",
            "examples": "Rotary Handle, Lever Handle, Flush Handle, Quarter-turn lock, T-handle",
            "common_values": "Rotary handle with lock (most common), Flush handle, Lever handle, Quarter-turn, Camlock, Paddle handle",
            "relationships": "Related to Door_Interlock and security requirements. Lockable handles for restricted access.",
            "notes": "Lockable handles recommended for safety. Rotary/quarter-turn most common. External/flush type for smooth enclosure front."
        },
        "Hinges_Type": {
            "definition": "Type of door hinges used, affecting door weight capacity, opening angle, and removability.",
            "extraction_instructions": "Look for 'hinge type', 'door hinge', 'hinge specification'. Check if concealed, piano, removable, opening angle. Look in mechanical specifications.",
            "examples": "Concealed Hinges, Piano Hinge, Continuous Hinge, 180° opening, Removable hinges",
            "common_values": "Concealed hinges (clean appearance), Piano/Continuous hinge (heavy doors), 180° opening hinges, Removable type, Adjustable",
            "relationships": "Heavy doors need stronger hinges. Opening angle affects access. Removable hinges aid maintenance.",
            "notes": "Concealed hinges protect fingers and look better. 180° opening helps in tight spaces. Load rating critical for heavy doors."
        },
        "Lifting_Eyes": {
            "definition": "Provision of lifting points or eyes for safe handling during transport and installation.",
            "extraction_instructions": "Search for 'lifting eyes', 'lifting points', 'lifting hooks', 'crane points'. Check if provided, location (top/sides), and load rating.",
            "examples": "Top-mounted lifting eyes, M12 lifting points, 4 x lifting eyes, Removable lifting eyes, Load tested",
            "common_values": "Top-mounted eyebolts (most common), Side lifting brackets, Forklift pockets, Removable after installation, Load-rated per weight",
            "relationships": "Essential for panels >50kg. Number and location based on weight distribution. Related to overall enclosure dimensions.",
            "notes": "Must be load-tested and marked with capacity. Removable type for clean final appearance. Consider transport orientation."
        },
        "Cable_Management": {
            "definition": "System for organizing, routing, and supporting cables within the switchgear.",
            "extraction_instructions": "Look for 'cable management', 'cable tray', 'cable duct', 'wire ways', 'cable routing'. Check types: trays, ducts, channels, tie points.",
            "examples": "Plastic Cable Ducts, Metal Cable Trays, Vertical wire ways, Cable management channels, Tie points",
            "common_values": "Plastic ducts with covers (most common), Perforated cable trays, Metal wire ways, DIN rail mounted ducts, Cable tie points",
            "relationships": "Adequate space prevents overheating. Separation of power and control cables may be required. Related to Form_Of_Separation.",
            "notes": "Segregation of power/control recommended. Covers prevent accidental contact. Size for future additions (30-40% spare capacity)."
        },
        "Ventilation_Type": {
            "definition": "Method of cooling and ventilation to dissipate heat generated by electrical components.",
            "extraction_instructions": "Search for 'ventilation', 'cooling', 'fans', 'natural ventilation', 'forced air'. Check if natural (louvers/grills) or forced (fans). Look in thermal management.",
            "examples": "Natural Ventilation, Forced Air Cooling, Top/Bottom Louvers, Exhaust Fans, Filter Fans",
            "common_values": "Natural (louvers/grills - simple), Forced air (fans - high heat loads), Filter fans (dusty environments), Heat exchangers (sealed enclosures)",
            "relationships": "Required based on heat dissipation and Temperature_Rise_Class. Filter fans for dusty areas. Affects IP_Rating.",
            "notes": "Natural ventilation adequate for most LV switchgear. Fans needed for high density/VFDs. Filters need maintenance. Consider IP rating impact."
        },
        "Anti_Condensation_Heater": {
            "definition": "Heating elements to prevent condensation in humid environments, protecting equipment from moisture damage.",
            "extraction_instructions": "Look for 'heater', 'anti-condensation', 'space heater', 'condensation protection'. Check if thermostat-controlled, power rating. Look in accessories or environmental protection.",
            "examples": "Thermostat-controlled heaters, 50W space heater, Anti-condensation heater with thermostat, Not required",
            "common_values": "Thermostat-controlled (20-50W typical), PTC heaters, Strip heaters, Not required (dry environments)",
            "relationships": "Essential for high Relative_Humidity or outdoor installations. Thermostat maintains temperature above dew point (~5-10°C).",
            "notes": "Typically set to activate below 5-10°C. Power: ~50W per m³ enclosure volume. Important for coastal/tropical locations."
        },
        "Internal_Lighting": {
            "definition": "Provision of internal lighting to aid maintenance and inspection activities.",
            "extraction_instructions": "Search for 'internal light', 'inspection lamp', 'service light', 'LED light'. Check if door-operated, permanent, or not provided. Look in accessories.",
            "examples": "Door-operated LED Light, Fluorescent Light, LED Strip, Switch-operated, Not provided",
            "common_values": "Door-operated LED (modern, energy-efficient), Fluorescent tube, LED strip, Switch-controlled, Not required (small panels)",
            "relationships": "Useful for large switchgear or poor ambient lighting. LED preferred (low heat, long life). May integrate with Door_Interlock.",
            "notes": "Door switch automatically activates light when opened. LED recommended (cool, efficient). Ensure safe voltage (24-48V preferred)."
        },
        "Nameplates": {
            "definition": "Identification plates and labels for equipment, warning signs, and operational instructions.",
            "extraction_instructions": "Look for 'nameplate', 'labels', 'identification', 'warning signs', 'engraved plates'. Check material (engraved plastic, metal, printed). List types required.",
            "examples": "Engraved phenolic nameplates, Laser-marked labels, Warning labels, Hazard signs, Equipment tags",
            "common_values": "Engraved phenolic/traffolyte (durable), Laser-marked (precise), Printed labels (economy), Metal tags (outdoor), Per IEC 61439",
            "relationships": "Required by standards for identification and safety. Should be durable and legible. Minimum: project name, voltage, current rating, warnings.",
            "notes": "Engraved plates most durable. Include: main rating plate, warning signs, circuit identification, earthing points. Permanent method required."
        }
    },
    "CT_PT_Specifications": {
        "Main_CT_Ratio": {
            "definition": "Current transformer ratio for the main circuit breaker, converting high primary current to standard 5A or 1A secondary.",
            "extraction_instructions": "Search for 'CT ratio', 'current transformer', 'measurement CT', 'protection CT'. Format: primary/secondary (e.g., 4000/5A). Check metering or protection sections.",
            "examples": "4000/5A, 5000/1A, 4000/5 A, CT: 4000-5000/5A",
            "common_values": "Secondary: 5A (most common) or 1A (long distances). Primary: matches or exceeds Main_Busbar_Rated_Current (e.g., 1000/5, 2000/5, 4000/5)",
            "relationships": "Primary side must exceed maximum load current. Related to Main_Busbar_Rated_Current and metering/protection devices.",
            "notes": "5A secondary standard for short runs. 1A for long cable runs (lower burden). Class 0.5/1 for metering, 5P10/5P20 for protection."
        },
        "Main_CT_Accuracy_Class": {
            "definition": "Accuracy class of the current transformer, defining maximum error at rated current, per IEC 61869 standards.",
            "extraction_instructions": "Look for 'CT class', 'accuracy class', 'class 0.5', 'class 5P'. Metering CTs: 0.2, 0.5, 1. Protection CTs: 5P, 10P. May include burden (e.g., 5P10).",
            "examples": "Class 1, 0.5, 5P10, Class 1 metering / 5P20 protection, 0.5S",
            "common_values": "Metering: 0.5 (billing), 1 (indication); Protection: 5P10, 5P20 (5% error at 10× or 20× rated current)",
            "relationships": "Metering requires accurate class (0.5/1). Protection needs high ALF (5P10/5P20). Related to connected meters/relays.",
            "notes": "'S' suffix for special low current performance. Number after 'P' is accuracy limit factor (ALF). Metering and protection may need separate CTs."
        },
        "Main_VT_PT_Ratio": {
            "definition": "Voltage transformer (VT) or potential transformer (PT) ratio, stepping down voltage to standard 110V or 100V secondary.",
            "extraction_instructions": "Search for 'VT ratio', 'PT ratio', 'voltage transformer', 'potential transformer'. Format: primary/secondary voltage (e.g., 400/110V). Check metering section.",
            "examples": "400/110V, 11kV/110V, 400/100V, VT: 400-110V",
            "common_values": "LV: Primary matches Service_Voltage, Secondary: 110V (common), 100V (some countries). MV: Various primary, usually 110V secondary",
            "relationships": "Primary voltage matches Service_Voltage. Secondary feeds meters, relays, indicators. Related to metering and protection systems.",
            "notes": "LV systems often use direct connection instead of VTs (for <690V). MV always needs VTs. Three single-phase or one three-phase unit."
        },
        "Main_VT_PT_Accuracy_Class": {
            "definition": "Accuracy class of voltage transformer, per IEC 61869 standards.",
            "extraction_instructions": "Look for 'VT class', 'PT accuracy', 'class 0.5', 'class 3P'. Metering: 0.5, 1. Protection: 3P, 6P. Check metering/protection specifications.",
            "examples": "Class 0.5, Class 1, 3P, 0.5 metering / 3P protection",
            "common_values": "Metering: 0.5 (billing), 1 (indication); Protection: 3P, 6P (3%/6% error at rated voltage)",
            "relationships": "Metering needs accurate class. Protection less critical. Related to meters and relays accuracy requirements.",
            "notes": "Separate VTs may be needed for metering and protection. Metering VT should be high accuracy (0.5 or better)."
        }
    },
    "Measuring_Instruments": {
        "Main_Meter_Type": {
            "definition": "Type and functionality of the main power monitoring and metering device installed.",
            "extraction_instructions": "Search for 'power meter', 'energy meter', 'multifunction meter', 'metering device', brand and model. Check if analog or digital, parameters measured.",
            "examples": "Multifunction Digital Meter, Energy Meter, Schneider PM5560, ABB M2M, Analog Ammeter + Voltmeter",
            "common_values": "Multifunction meters (modern - measures V, I, kW, kWh, PF, harmonics), Energy meters (billing), Separate analog meters (traditional)",
            "relationships": "Requires Main_CT_Ratio and Main_VT_PT_Ratio for connection. Advanced meters offer communication capabilities.",
            "notes": "Multifunction meters replace multiple analog meters. Choose based on monitoring needs. Communication capability (Modbus, Ethernet) useful for SCADA."
        },
        "Metering_Parameters": {
            "definition": "Electrical parameters that the metering system measures and displays.",
            "extraction_instructions": "Look for 'measured parameters', 'metering', 'measurements', 'monitoring'. Common: V, I, kW, kVA, kVAr, PF, kWh, harmonics. Check meter specifications.",
            "examples": "V, I, kW, kWh, PF, All standard parameters, Voltage, Current, Power, Energy, Harmonics",
            "common_values": "Basic: V, I, kW, kWh; Standard: + kVA, kVAr, PF; Advanced: + harmonics, demand, THD, unbalance",
            "relationships": "Advanced parameters need multifunction meters. Energy billing requires kWh. Power quality monitoring needs harmonics/THD.",
            "notes": "Minimum: V, I, kW for monitoring. Add kWh for sub-billing. Harmonics useful for troubleshooting. Ensure meter capabilities match requirements."
        },
        "Meter_Communication_Protocol": {
            "definition": "Communication protocol used by meters for data exchange with SCADA, BMS, or monitoring systems.",
            "extraction_instructions": "Search for 'communication', 'protocol', 'Modbus', 'Ethernet', 'BACnet', 'interface'. Check if RS485, Ethernet, wireless. Look in communication/monitoring section.",
            "examples": "Modbus RTU, Modbus TCP/IP, Ethernet, Profibus, BACnet, RS485, Not required",
            "common_values": "Modbus RTU (RS485 - most common), Modbus TCP (Ethernet), Profibus, Profinet, BACnet, EtherNet/IP, None (local display only)",
            "relationships": "Must match SCADA/BMS system requirements. RS485 for distributed systems, Ethernet for building automation.",
            "notes": "Modbus RTU most universal. Ethernet-based gaining popularity. Ensure meter supports required protocol. Gateway may be needed for protocol conversion."
        }
    },
    "Circuit_Breaker_Specifications": {
        "Outgoing_Circuit_Breaker_Type": {
            "definition": "Type of circuit breakers used for feeder and outgoing circuits (distribution to loads).",
            "extraction_instructions": "Look for 'outgoing CB', 'feeder breaker', 'distribution breaker', 'MCCB', 'MCB'. Check if MCCB, MCB, ACB. May specify brand/model. Look in feeder section.",
            "examples": "MCCB, MCB, Molded Case Circuit Breaker, Schneider Compact NSX, ABB Tmax",
            "common_values": "MCCB (16-630A typical), MCB (up to 125A), ACB (large feeders >630A), Modular (compact switchgear)",
            "relationships": "Type depends on feeder current rating. MCCB for most distribution. MCB for lighting/small loads. Related to load requirements.",
            "notes": "MCCBs most common for distribution. Electronic trip units offer better protection and monitoring. Check breaking capacity vs fault current."
        },
        "Outgoing_CB_Breaking_Capacity": {
            "definition": "Short-circuit breaking capacity of outgoing/feeder circuit breakers.",
            "extraction_instructions": "Search for 'outgoing breaking capacity', 'feeder Icu', 'MCCB rating'. Usually in kA. Check circuit breaker specifications or schedules.",
            "examples": "36 kA, Icu = 50kA, 50kA @ 415V, 36kA breaking capacity",
            "common_values": "LV MCCBs: 25kA, 36kA, 50kA, 70kA, 100kA. MCBs: 6kA, 10kA. Must exceed fault current at installation point.",
            "relationships": "Must be adequate for fault current at installation point (decreases with distance from main). Related to cable sizes and lengths.",
            "notes": "Can be lower than main breaker due to cable impedance. Cost increases with breaking capacity. Verify against fault study."
        },
        "Circuit_Breaker_Trip_Type": {
            "definition": "Type of overcurrent protection trip mechanism in circuit breakers.",
            "extraction_instructions": "Look for 'trip unit', 'trip type', 'thermal-magnetic', 'electronic', 'TMD'. Check if adjustable, fixed, settings available. Look in protection section.",
            "examples": "Thermal-Magnetic, Electronic Trip, TMD, Adjustable Electronic, Micrologic, Fixed TMD",
            "common_values": "Thermal-Magnetic (TMD - fixed or adjustable), Electronic (programmable - modern), Magnetic-only (motors), Adjustable electronic (precision)",
            "relationships": "Electronic trip offers better selectivity and monitoring. TMD simpler and cheaper. Choice affects protection coordination.",
            "notes": "Electronic trip units offer adjustable L, S, I, G protection. TMD adequate for most applications. Electronic preferred for selectivity and monitoring."
        },
        "Motor_Protection_Type": {
            "definition": "Type of protection devices for motor circuits, preventing overload, phase loss, and other motor faults.",
            "extraction_instructions": "Search for 'motor protection', 'motor starter', 'overload relay', 'thermal relay', 'motor breaker'. Check if MPCB, contactor+relay, soft starter. Look in motor control section.",
            "examples": "MPCB, Thermal Overload Relay, Motor Protection Circuit Breaker, Contactor + Thermal Relay, Electronic Motor Protection",
            "common_values": "MPCB (Motor Protection CB - compact), Contactor + Thermal relay (traditional), Electronic motor protection relay, Soft starter with protection",
            "relationships": "Must protect against overload, phase failure, short circuit. Sized per motor FLC. Related to motor control philosophy.",
            "notes": "MPCBs compact and cost-effective for DOL starters. Electronic relays offer phase unbalance, ground fault, etc. Adjust overload to motor FLC."
        }
    },
    "Network_Specifications": {
        "Network_Type": {
            "definition": "The electrical network earthing system configuration per IEC 60364.",
            "extraction_instructions": "Look for 'earthing system', 'network type', 'TN-S', 'TN-C', 'TT', 'IT'. Check system grounding documentation or electrical specifications.",
            "examples": "TN-S, TN-C-S, TT, IT, TN-S earthing system",
            "common_values": "TN-S (separate N and PE - most common), TN-C-S (combined PEN then separate), TT (local earth electrode), IT (isolated neutral)",
            "relationships": "Determines protective device selection and earth fault behavior. Affects RCD requirements and fault calculations.",
            "notes": "TN-S most common (safe, reliable). IT for critical continuity (hospitals, process). TT for poor supply earthing. Defines first letter (supply), second letter (installation)."
        },
        "RCD_RCCB_Requirement": {
            "definition": "Requirement for Residual Current Devices (RCD) or Residual Current Circuit Breakers (RCCB) for earth fault protection.",
            "extraction_instructions": "Search for 'RCD', 'RCCB', 'residual current', 'earth leakage'. Check if required, sensitivity (30mA, 300mA), type (AC, A, B). Look in protection or safety sections.",
            "examples": "30mA RCD for sockets, 300mA at main, Type A RCD, Not required, RCCB on all final circuits",
            "common_values": "30mA for socket outlets (personal protection), 100-300mA for main/fire protection, Type AC/A (general), Type B (VFDs), Not required (TN-S with proper bonding)",
            "relationships": "TT systems require RCD. TN systems may need for added protection. Type B needed for VFDs/DC. Related to Network_Type.",
            "notes": "30mA for personal protection (bathrooms, outdoor). 100-300mA for fire protection. Type A for electronic loads, Type B for VFDs. Check local code requirements."
        },
        "Surge_Protection_SPD": {
            "definition": "Surge Protection Device (SPD) to protect against transient overvoltages from lightning and switching.",
            "extraction_instructions": "Look for 'SPD', 'surge protection', 'surge arrester', 'overvoltage protection'. Check if Type 1, 2, or 3, voltage protection level. Look in protection section.",
            "examples": "Type 2 SPD, Class II SPD, Surge arrester, 1.5kV protection level, Not required",
            "common_values": "Type 2 (most common - at distribution board), Type 1 (main incomer - lightning prone), Type 3 (equipment level), Combined Type 1+2",
            "relationships": "Type 1 for direct lightning risk areas. Type 2 standard protection. Voltage protection level should be below equipment withstand. Related to installation location.",
            "notes": "Type 1: Iimp 12.5kA (10/350μs). Type 2: In 20kA (8/20μs). Type 3: local protection. Coordination between types important. Replace after activation."
        },
        "Power_Factor_Correction": {
            "definition": "Provision of capacitor banks or equipment for power factor improvement to reduce reactive power demand.",
            "extraction_instructions": "Search for 'power factor correction', 'PFC', 'capacitor bank', 'APFC', 'reactive power compensation'. Check if fixed, automatic, rating in kVAr. Look in power quality section.",
            "examples": "Automatic PFC, APFC 200 kVAr, Fixed capacitor bank, Detuned capacitors, Not required",
            "common_values": "Automatic PFC (APFC - steps for varying load), Fixed capacitors (constant load), Detuned (harmonic filtering), Rating: 10-50% of transformer kVA",
            "relationships": "Size based on load kVA and power factor. Detuning needed with harmonics (VFDs). Improves efficiency, reduces utility penalties.",
            "notes": "APFC automatically adjusts to load. Detuned capacitors (189Hz) prevent harmonic resonance with VFDs. Target PF: 0.95-0.98. Check utility requirements."
        },
        "Harmonic_Filtering": {
            "definition": "Equipment to mitigate harmonic distortion caused by non-linear loads like VFDs, UPS, LED lighting.",
            "extraction_instructions": "Look for 'harmonic filter', 'active filter', 'passive filter', 'THD mitigation', 'harmonic distortion'. Check if active, passive, detuned reactors. Look in power quality.",
            "examples": "Active Harmonic Filter, Detuned Reactors, Passive LC Filter, 5th & 7th harmonic filter, Not required",
            "common_values": "Detuned reactors (with PFC - passive), Active harmonic filters (dynamic correction), Passive LC filters (specific harmonics), Not required (low harmonic loads)",
            "relationships": "Needed with high VFD/UPS/LED load (>25% of total). Detuning prevents resonance with PFC capacitors. Related to Power_Factor_Correction.",
            "notes": "Active filters dynamically cancel harmonics. Passive filters target specific harmonics (5th, 7th, 11th). Detuned reactors (189Hz) prevent PFC resonance. Check THD limits (IEEE 519, IEC 61000)."
        }
    },
    "Vacuum_Contactor_Specifications": {
        "Vacuum_Contactor_Usage": {
            "definition": "Application and usage of vacuum contactors in the switchgear, typically for medium-voltage motor control or frequent switching.",
            "extraction_instructions": "Search for 'vacuum contactor', 'VC application', 'motor switching'. Check if used, for which applications (motors, capacitors), ratings. Look in MV or motor control sections.",
            "examples": "MV motor starting, Capacitor switching, Not used (LV only), Frequent switching applications",
            "common_values": "MV motor control (most common), Capacitor bank switching (frequent operation), Transformer switching, Not applicable (LV switchgear)",
            "relationships": "Common in MV switchgear (>1kV). Alternative to circuit breakers for motor control (lower cost, higher operation frequency).",
            "notes": "Vacuum contactors rated for millions of operations. Lower cost than breakers. No arc maintenance (sealed vacuum). Common in MV motor starters."
        },
        "Vacuum_Contactor_Rating": {
            "definition": "Electrical ratings of vacuum contactors including voltage, current, and breaking capacity.",
            "extraction_instructions": "Look for 'VC rating', 'contactor rating', rated voltage, rated current, making/breaking capacity. Check specifications if vacuum contactors used.",
            "examples": "7.2kV / 400A, 12kV 630A, 400A / 250MVA breaking, Not applicable",
            "common_values": "MV: 3.6kV, 7.2kV, 12kV, 17.5kV, 24kV (voltage). Current: 200A, 400A, 630A, 800A. Breaking: 50-500 MVA",
            "relationships": "Voltage must match Service_Voltage. Current ≥ motor FLC. Breaking capacity adequate for starting current and faults.",
            "notes": "Rated for frequent operations (>1 million). Lower breaking capacity than circuit breakers (for motor loads). Suitable for capacitor switching."
        },
        "Vacuum_Contactor_Brand": {
            "definition": "Manufacturer brand of vacuum contactors if used in the switchgear.",
            "extraction_instructions": "Search for vacuum contactor manufacturer name in MV equipment specifications.",
            "examples": "ABB, Siemens, Schneider Electric, Eaton, Toshiba, Not applicable",
            "common_values": "ABB (VM1, VD4), Siemens (3TL), Schneider (Rollarc), Eaton (IZM/PXR), Toshiba, Not applicable (LV only)",
            "relationships": "Should match other MV equipment brand for consistency. Affects spare parts and technical support.",
            "notes": "Major MV contactor suppliers: ABB, Siemens, Schneider, Eaton. Vacuum technology more reliable than air contactors. Long service life (20-30 years)."
        }
    }
}


def get_all_extraction_guides():
    """
    Get all extraction guides as nested dictionary

    Returns:
        Complete extraction guides structure
    """
    return EXTRACTION_GUIDES


def get_extraction_guide(category_name: str, field_name: str):
    """
    Get specific extraction guide

    Args:
        category_name: Specification category name
        field_name: Field name within category

    Returns:
        Extraction guide dictionary or None if not found
    """
    if category_name in EXTRACTION_GUIDES:
        if field_name in EXTRACTION_GUIDES[category_name]:
            return EXTRACTION_GUIDES[category_name][field_name]
    return None


def get_category_guides(category_name: str):
    """
    Get all guides for a specific category

    Args:
        category_name: Specification category name

    Returns:
        Dictionary of guides for the category or None
    """
    return EXTRACTION_GUIDES.get(category_name, None)


def get_guide_summary():
    """
    Get summary statistics about extraction guides

    Returns:
        Dictionary with statistics
    """
    total_guides = sum(len(fields) for fields in EXTRACTION_GUIDES.values())

    return {
        "total_categories": len(EXTRACTION_GUIDES),
        "total_guides": total_guides,
        "categories": list(EXTRACTION_GUIDES.keys()),
        "guides_per_category": {
            cat: len(fields) for cat, fields in EXTRACTION_GUIDES.items()
        }
    }
