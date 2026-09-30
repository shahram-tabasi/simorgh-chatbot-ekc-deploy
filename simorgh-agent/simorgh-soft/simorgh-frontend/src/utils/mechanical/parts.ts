// src/utils/mechanical/parts.ts
//
// Every mechanical part the panel estimate sheets name, described once.
//
// Ported from the Eplanix MVC app's `MechanicalParts.Definitions`, which is
// itself the office's own estimate sheets — "Estimate Of Mechanical Items —
// EK36 (1100)" Rev 02 and "… — A4" Rev 03 — written out as code. The
// per-panel catalogues say only how many of a part a subcategory needs; what
// the part *is* lives here.
//
// Generated from that source rather than retyped: a mistyped order number in
// a bill of materials is a mistake nobody catches by reading.

/** A part's identity, as the three code systems the sheets carry. */
export interface MechanicalPartDefinition {
  /** The office's own HR code. */
  hr: string;
  /** The manufacturer's order number, "---" where the sheet gives none. */
  manufacture: string;
  /** The EKC code. */
  ekc: string;
  description: string;
}

export type MechanicalPartId =
  | 'EarthingSwitchAuxSwitch4NC4NO'
  | 'EarthingSwitchAuxSwitch5NC5NO'
  | 'HartingHanD64PosMaleInsert'
  | 'HartingHanD64PosFemaleInsert'
  | 'HartingHan24BBasePanel1Lever'
  | 'HartingHanBHoodSideEntry'
  | 'HartingHanDFemaleCrimpContact'
  | 'HartingHanDMaleCrimpContact'
  | 'HartingHanCodingSystemGuidePin'
  | 'HartingHanCodingSystemGuideBushing'
  | 'QuarterTurnLock'
  | 'KontactStuckFuseBased9435'
  | 'KontactStuckFuseBased9436'
  | 'IndoorPostInsulator36Kv'
  | 'IndoorCapacitiveDividerInsulator36Kv'
  | 'BusBootCap'
  | 'BusBootCoverGes662'
  | 'BusBootCoverGes2553'
  | 'ContactFinger1250A'
  | 'ContactFinger2500A'
  | 'BusbarWallBushing36Kv'
  | 'EarthingSwitchBlattfeder'
  | 'RubberGasketing'
  | 'HartingHanE24PosFemaleInsert'
  | 'HartingHanE24PosMaleInsert'
  | 'KontaktStuckBayka24393'
  | 'KontaktStuckBayka24394'
  | 'IndoorPostInsulator24Kv'
  | 'IndoorCapacitiveDividerInsulator24Kv'
  | 'VtFuseLinkClip'
  | 'EarthingLamel'
  | 'ContactFinger630A'
  | 'BusbarWallBushing800'
  | 'BusbarWallBushing1000'
  | 'TensorLockAngle'
  | 'SelfAdhesiveGasket'
  | 'SealingStrip';

export const MECHANICAL_PARTS: Record<MechanicalPartId, MechanicalPartDefinition> = {
  EarthingSwitchAuxSwitch4NC4NO: { hr: '10551', manufacture: '---', ekc: '102-AS90-AAA',
    description: 'Aux Switch , Hisee , For earthing switch , 4NC+4NO with milled shaft-end' },
  EarthingSwitchAuxSwitch5NC5NO: { hr: '10323', manufacture: '---', ekc: '102-AS90-AAB',
    description: 'Aux Switch , Hisee , For earthing switch , 5NC+5NO with milled shaft-end' },
  HartingHanD64PosMaleInsert: { hr: '10345', manufacture: '09210643001', ekc: '102-SOHA-AAAB',
    description: 'سوکت و متعلقات , HartingHan D 64 Pos. M Insert Crimp' },
  HartingHanD64PosFemaleInsert: { hr: '10346', manufacture: '09210643101', ekc: '102-SOHA-AAAA',
    description: 'سوکت و متعلقات , HartingHan D 64 Pos. F Insert Crimp' },
  HartingHan24BBasePanel1Lever: { hr: '10343', manufacture: '09300240307', ekc: '102-SOHA-AAAE',
    description: 'سوکت و متعلقات , HartingHan 24B-Base Panel 1 Lever' },
  HartingHanBHoodSideEntry: { hr: '10344', manufacture: '09300240541', ekc: '102-SOHA-AAAF',
    description: 'سوکت و متعلقات , HartingHan B Hood Side Entry HC 2 Reels PG 29' },
  HartingHanDFemaleCrimpContact: { hr: '13123/37698', manufacture: '09150006201/14103564', ekc: '102-SOHA-AAAG/102-SO8K-AAAA',
    description: 'سوکت و متعلقات , HartingHan D F Crimp Contact Ag AWG 16' },
  HartingHanDMaleCrimpContact: { hr: '13124/37699', manufacture: '09150006101/14104564', ekc: '102-SOHA-AAAJ/102-SO8K-AAAB',
    description: 'سوکت و متعلقات , HartingHan D M Crimp Contact Ag AWG 16' },
  HartingHanCodingSystemGuidePin: { hr: '11849/37700', manufacture: '1109660', ekc: '102-SOHA-AAAH/102-SO8K-AAAC',
    description: 'سوکت و متعلقات , HartingHan D F Crimp Contact Ag AWG 16 , METE, Coding System Guide Pin' },
  HartingHanCodingSystemGuideBushing: { hr: '11850/37701', manufacture: '1109760', ekc: '102-SOHA-AAAI/102-SO8K-AAAD',
    description: 'سوکت و متعلقات , HartingHan D M Crimp Contact Ag AWG 16 , METE, Coding System Guide Bushing' },
  QuarterTurnLock: { hr: '23854/33215/36280', manufacture: 'KY13.1.5.93.1', ekc: '102-HLAT-AAB',
    description: 'Hinge & Locks , آتوس , Lock, QUARTER TURN LOCK-SPRING LOADED, Zamak, Black, IP 65' },
  KontactStuckFuseBased9435: { hr: '12548/24395', manufacture: '874-9435', ekc: '102-KS4A-AAAC',
    description: 'Kontact Stuck , Bayka Design, Fuse Based(Siba)' },
  KontactStuckFuseBased9436: { hr: '12547/24396', manufacture: '874-9436', ekc: '102-KS4A-AAAD',
    description: 'Kontact Stuck , Bayka Design, Fuse Based(Siba)' },
  IndoorPostInsulator36Kv: { hr: '9115', manufacture: '---', ekc: '101-INAL-AC5AA',
    description: 'مقره , آلجی , Indoor Post Insulator , 36KV , 95*300 , B30N-1000 (Drw.No.127/4)' },
  IndoorCapacitiveDividerInsulator36Kv: { hr: '23597', manufacture: '---', ekc: '101-INAL-AD31A1',
    description: 'MV مقره , آلجی , Indoor Capacitive Divider Insulator, 36Kv, DKB-30N (Part No. 1047624), 16 pF, 95*300 mm' },
  BusBootCap: { hr: '15974', manufacture: 'GES-660', ekc: '102-CCGS-AAAA',
    description: 'Cap & Bus boot , GALA SHRINK FIT , Cap' },
  BusBootCoverGes662: { hr: '15636', manufacture: 'GES-662', ekc: '102-CCGS-AAAB',
    description: 'Cap & Bus boot , GALA SHRINK FIT , Bus boot 36KV Cover' },
  BusBootCoverGes2553: { hr: '23536', manufacture: '824-8633.0/GES-2553', ekc: '102-CCGS-AAAC',
    description: 'Cap & Bus boot , GALA SHRINK FIT, Bus boot 36KV Cover' },
  ContactFinger1250A: { hr: '10133/22843/24390/24909', manufacture: '112-4036.3', ekc: '102-CF4A-AAAF',
    description: 'پنجه گربه ای , Bayka Design, 1250 A For Simoprime (3AH & 3AE)' },
  ContactFinger2500A: { hr: '22844/25310', manufacture: '888-4074.3', ekc: '102-CF4A-AAAC',
    description: 'پنجه گربه ای , Bayka Design, 2500 A For Simoprime & 8BK20' },
  BusbarWallBushing36Kv: { hr: '8766', manufacture: '881-3290.3', ekc: '102-WBAC-AA2',
    description: 'وال بوشینگ , ALCE , Busbar Bushing For 36KV (Drw.No.060303)' },
  EarthingSwitchBlattfeder: { hr: '10830/22847/24397', manufacture: '872-0019.0/03', ekc: '102-OT4A-AAAD',
    description: 'Other , Bayka Design, Blattfeder (سکسیونر ارت)' },
  RubberGasketing: { hr: '23588', manufacture: '1011-10', ekc: '102-GS2Q-AAB',
    description: 'نوار IP , EMKA, Robber Gasketing' },
  HartingHanE24PosFemaleInsert: { hr: '10347', manufacture: '09330242701', ekc: '102-SOHA-AAAD',
    description: 'سوکت و متعلقات , HartingHan E 24 Pos. F Insert Screw' },
  HartingHanE24PosMaleInsert: { hr: '10348', manufacture: '09330242601', ekc: '102-SOHA-AAAC',
    description: 'سوکت و متعلقات , HartingHan E 24 Pos. M Insert Screw' },
  KontaktStuckBayka24393: { hr: '24393', manufacture: '883-00260.0', ekc: '102-KS4A-AAAA',
    description: 'Kontact Stuck , Bayka Design, Kontakt Stuck' },
  KontaktStuckBayka24394: { hr: '24394', manufacture: '883-00250.0', ekc: '102-KS4A-AAAB',
    description: 'Kontact Stuck , Bayka Design, Kontakt Stuck' },
  IndoorPostInsulator24Kv: { hr: '25239', manufacture: '2904903 (6-12KV)', ekc: '101-IN75-AA2AD',
    description: 'MV مقره , Kuvag , Indoor Post Insulator, 24kV, 70*210,SGA 24 N,No. 000547-00 (Drawing No. M0026-1)' },
  IndoorCapacitiveDividerInsulator24Kv: { hr: '22977', manufacture: '---', ekc: '101-INAL-AD21A1',
    description: 'MV مقره , آلجی , Indoor Capacitive Divider Insulator, 24Kv, DKB-20N (Part No. 1000519), 16 pF, 85*210 mm,Drw.No.132' },
  VtFuseLinkClip: { hr: '10226', manufacture: 'A3354705', ekc: '102-KS37-AA1',
    description: 'Kontact Stuck , Bussman , Clip 25.4 mm VT fuse link' },
  EarthingLamel: { hr: '24391', manufacture: '844-2623.0', ekc: '102-EL4A-AAAA',
    description: 'Earthing Lamel , Bayka Design, For Simoprime,158*50mm' },
  ContactFinger630A: { hr: '24389', manufacture: '888-4072.3', ekc: '102-CF4A-AAAA',
    description: 'پنجه گربه ای , Bayka Design, 630 A For Simoprime' },
  BusbarWallBushing800: { hr: '24019', manufacture: '887-0906.0', ekc: '102-WB3T-AA1',
    description: 'وال بوشینگ , KVM, Busbar Bushing 800mm,1250A for A4' },
  BusbarWallBushing1000: { hr: '25144', manufacture: '887-0907.0', ekc: '102-WBAC-AA3',
    description: 'وال بوشینگ , ALCE, Busbar Bushing 1000mm For A4 (Drw.No.190004)' },
  TensorLockAngle: { hr: '24398', manufacture: '888-1075.0', ekc: '102-OT4A-AAAE',
    description: 'Other , Bayka Design, Tensor Lock .Angle (سلول)' },
  SelfAdhesiveGasket: { hr: '12859', manufacture: '---', ekc: '102-GS1R-AAB',
    description: 'نوار IP , ایران , Self. Adh Gasket Size=10X3' },
  SealingStrip: { hr: '24121', manufacture: '3711908001', ekc: '102-GS1R-AAE',
    description: 'نوار IP , ایران, Sealing Strip' },
};
