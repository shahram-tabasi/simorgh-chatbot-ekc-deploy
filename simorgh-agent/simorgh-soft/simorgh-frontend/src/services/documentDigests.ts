// src/services/documentDigests.ts
//
// Digests of client documents the assistant has already read in full. When
// one of them is attached again, the assistant answers from its digest — the
// summary with what matters to the project marked, and the fields to fill
// staged for approval — instead of sending the file to the model again.
//
// Each digest is the document's own content: nothing here is invented, and
// anything the document leaves open is said to be open.

import type { ProposedAction } from './chatbotTools';

export interface DocumentDigest {
  /** The reply shown in the chat (Markdown). */
  reply: string;
  /** Approval cards: each a title and the edits it would make. */
  proposals: { title: string; actions: ProposedAction[] }[];
  /** Kept with the message, so later questions about it have the text. */
  docText: string;
}

const key = (name: string) => name.toLowerCase().replace(/\.pdf$/, '').replace(/[^a-z0-9]/g, '');

// ── Technical Specification for 6.6KV Switchgears (MSC — HSM #2) ──────────
const SPEC_66KV_REPLY = `### 📄 Technical Specification for 6.6 kV Switchgears
**Mobarakeh Steel Company (MSC) — Hot Strip Mill #2** · Doc. No. **347180ETS802** · Rev. **A** · 27 pages · Client engineering: **Mobarakeh Steel Engineering (MSE)**

> **Scope:** design and fabrication of **6.6 kV, air-insulated, metal-clad, indoor switchgear** with **withdrawable vacuum circuit breakers** (incoming, outgoing, bus-section) and **vacuum contactors for 6.6 kV transformer feeders**, arc-proof tested to **IEC 62271-2**, assembled as one-length switchboard on a steel base frame embedded in concrete, extensible at both ends.

#### ⚡ Switchboard ratings
| Item | Value |
|---|---|
| Rated / service voltage | **6.6 kV** (working 6.6 kV ± 8 %) |
| Rated voltage (CB) / insulation level | **7.2 kV** / **12 kV** |
| Phases / frequency | 3 / **50 Hz** (+5 % −2 %) |
| Short-time withstand | **40 kA rms – 3 s** |
| Peak short-circuit current | **90 kA** |
| Earthing switch peak withstand / making (incomers) | **80 kA** / **100 kA** |
| Power-frequency withstand (60 s) | 28 kV (CB section: **31 kV**) |
| Impulse withstand 1.2/50 µs | 75 kV (CB section: **81 kV**) |
| Main bus / branch bus continuous current | **630 A** / **630 A** |
| System earthing | Isolated or resistance earthed |
| Degree of protection | **IP42** door closed · **IP20** door open (IP54 outdoor) |

#### 🔌 Circuit breakers
- **Vacuum, horizontal draw-out, withdrawable truck** — Service / Isolated (test) / Withdrawn positions, **automatic shutters**, door-closed racking.
- **Motor-operated spring-charged** mechanism, trip-free, closing coil + trip coil + **anti-pumping**, mechanical ON/OFF indicator & **operation counter**, manual trip and manual close without supply.
- One O–C operation possible after loss of DC to the charging motor.
- **2 NO + 2 NC spare auxiliary contacts** wired to terminals per unit.
- Suitable for switching **shunt capacitor banks**; units of equal rating interchangeable, lower-rated trucks must not fit higher-rated cubicles.
- Incomer / bus-section **interlocked against parallel operation**, with **automatic momentary paralleling** for planned changeover.

#### 📐 Instrument transformers
| | CT | VT |
|---|---|---|
| Type | Cast resin | Cast resin, single-phase, **draw-out carriage** |
| Insulation / test | 12 kV · 31 kV 1 min · 81 kV pk | 12 kV · 31 kV 1 min · 81 kV pk |
| Ratio | primary **as SLD** / **5 A** (1 A where drawn; 5/1 correctors where shown) | **6.6/√3 kV / 100/√3 V**, 3 windings, phase-earth |
| Accuracy | Metering **0.5, Fs 5** · Protection **5P20** (differential ALF 20) | **0.5** (3P open delta), voltage factor 1.2 cont. |
| Burden | 10 / 15 / 20 / 30 VA | 50 / 100 / 200 VA, **+25 % spare VA** |
| Other | Thermal 1.2 × In, 40 kA–3 s, secondary earthed, **no shared metering/protection cores** | **HRC fuses on primary**, **MCB with signal contact on secondary** |

⚠️ CT ratios, classes, ALF and burdens are **tentative** — to be confirmed in detail engineering against the SLD.

#### 🛡️ Protection & relays
- **Fully digital, programmable** numeric relays with PC port, **withdrawable flush type**, front-mounted, hand-reset, LED/flag indication, min. 2 contacts (trip + alarm).
- Overcurrent: **I> IDMT + I>> DMT**; earth fault / over- & under-voltage IDMT/DMT.
- **Motor feeders:** multi-function motor protection (thermal overload, start-up supervision, locked rotor, high-set O/C, low-set E/F, phase reversal, unbalance, single phasing).
- Relay supply **110 V DC +10 % −20 %**, contacts 10 A make / 16 A thermal, OC relays **5 A** rated.
- Trip-circuit supervision, auxiliary / flag / time-delay / high-speed trip relays as required. **Test blocks** for CT & VT leads on the cubicle front.
- Relay types to be **approved by the client**.

#### 🧰 Auxiliary & control
- Control **110 V DC** (closing +10/−15 %, tripping +10/−30 %); lighting, sockets, heaters **230 V AC 50 Hz**; aux. test 2 kV.
- Main MCB/MCCB for incoming AC & DC with **flag-relay supply-failure alarm**; MCB per cubicle for each aux. circuit; **2-pole MCB** per DC/AC distribution section.
- Per panel: **2 heaters + 1 thermostat** (CB & cable compartments), lamp with door switch, **230 V socket** in the LV cell; each door with lock (2 keys).
- **Capacitive voltage indicators** on cable side; **mimic diagram** on front doors.

#### 🧵 Wiring & terminals
- Stranded copper, PVC: **CT / ammeter circuits ≥ 4 mm²**, inter-panel ≥ 4 mm², other circuits **≥ 2.5 mm²**.
- CT terminals **short-circuiting (current test) type**, VT terminals **sectionalizing type**, ≥ 10 % spare terminals (20 % in §1.1), max 2 wires per terminal.
- Wire numbers on every wire, terminal and wiring table; phase sequence **R-S-T left to right**.

#### 🏗️ Construction & finish
- Sheet steel **≥ 2.5 mm** (structure ≥ 2 mm), galvanized small parts, **lifting lugs**, removable bolted rear covers.
- **Copper earth bus ≥ 250 mm²** full length, terminals both ends; doors earthed with flexible copper.
- Bus-bars **99.9 % electrolytic copper**, insulated, silver-plated joints, stainless bolts, rounded edges.
- **Bottom cable entry** (power & control), inter-panel aux. wiring on top.
- Paint: 2 primer + 2 finish coats, **RAL 7032** inside and out; rustproof English nameplates, front & rear.

#### 🚦 Signals per cubicle
- **Incomer:** lamps (test / service / open / closed / tripped / earth switch closed / permission to close), annunciator (upstream CB failure, 230 V AC failure, protection trip, **U< / U> trip**), push buttons (open, close, reset, **illuminated earth-switch close**, lamp test), L-O-R and **voltmeter selector**.
- **Transformer / feeder outgoing:** same lamps; annunciator incl. **Buchholz alarm/trip, temperature alarm/trip, oil level trip, oil pressure alarm**, 230 V AC failure, protection trip; open / close / reset / lamp test, L-O-R and **ammeter selector**.
- **VT cubicle:** voltmeter + selector + 3 phase lamps.
- **To supervisory system (every cubicle):** AC failure, protection trip, relays healthy, CB on/off, earth switch on, inserted, test position, permission to remote close, panel ready.
- Meters **96 × 96 mm, class 1.5** (A, V, W, var, PF, Hz); transducers **4–20 mA** + energy pulses.

#### 📚 Standards
IEC 62271-200 · IEC 60694 · IEC 62271-100 · IEC 62271-102 · IEC 60071-2 · IEC 60282 · IEC 61869-2 · IEC 61869-3 · IEC 60255 · IEC 60529 · IEC 60099-4

#### ❗ Points to note for the project
- **Short-time rating 40 kA / 3 s** drives the bus, CT and earthing-switch selection.
- **630 A** main bus — check against the incomer ratings in the SLD.
- Earthing switch on **line side of incomers** and **load side of outgoing feeders**, electrically & mechanically interlocked (key interlock with upstream CB).
- Wire sizes differ inside the document (§1.1: CT 2.5 / other 1.5 mm²; §1.11: ammeter ≥ 4 / other ≥ 2.5 mm²) — the stricter **§1.11** values are proposed below.
- **SLD, power & control diagrams and layout need client approval before fabrication.**

I've staged the project fields and technical settings below — untick anything you don't want and press **Apply**.`;

const SPEC_66KV: DocumentDigest = {
  reply: SPEC_66KV_REPLY,
  docText: SPEC_66KV_REPLY,
  proposals: [
    {
      title: 'Project Definition — from 347180ETS802 Rev. A',
      actions: [
        {
          name: 'set_project_fields',
          args: { fields: { projectName: 'Hot Strip Mill #2 – 6.6 kV Switchgears' } },
          summary: 'Project name → "Hot Strip Mill #2 – 6.6 kV Switchgears"',
        },
        {
          name: 'set_project_fields',
          args: { fields: { client: 'Mobarakeh Steel Company (MSC)' } },
          summary: 'Client → "Mobarakeh Steel Company (MSC)"',
        },
        {
          name: 'set_project_fields',
          args: { fields: { location: 'Mobarakeh, Isfahan', country: 'iranin' } },
          summary: 'Location → "Mobarakeh, Isfahan", country → Iran',
        },
        {
          name: 'set_project_fields',
          args: { fields: { standard: 'IEC', language: 'English' } },
          summary: 'Standard → IEC (IEC 62271-200 / -100 / -102, IEC 61869), language → English',
        },
        {
          name: 'set_project_fields',
          args: {
            fields: {
              projectDescription:
                '6.6 kV air-insulated, metal-clad, indoor switchgear with withdrawable vacuum circuit breakers and vacuum contactors for transformer feeders. '
                + '7.2/12 kV, 50 Hz, 40 kA-3 s, 90 kA peak, main bus 630 A, IP42, arc-proof per IEC 62271-2. '
                + 'Ref. Technical Specification 347180ETS802 Rev. A.',
            },
          },
          summary: 'Description → 6.6 kV metal-clad withdrawable VCB switchgear, 40 kA-3 s, 630 A, IP42',
        },
        {
          name: 'set_project_fields',
          args: {
            fields: {
              comment:
                'Client engineering: Mobarakeh Steel Engineering (MSE). Control 110 V DC, aux. 230 V AC. '
                + 'CT ratios/burdens tentative — confirm against SLD. SLD, power & control diagrams and layout to be approved before fabrication.',
            },
          },
          summary: 'Comment → client engineering MSE, 110 V DC control, approvals before fabrication',
        },
      ],
    },
    {
      title: 'Technical Settings — from 347180ETS802 Rev. A',
      actions: [
        {
          name: 'set_tech_setting',
          args: { path: 'wireSize.controlCircuit', value: '2.5' },
          summary: 'Control circuit wire → 2.5 mm² (§1.11 "other circuits ≥ 2.5 sqmm")',
        },
        {
          name: 'set_tech_setting',
          args: { path: 'wireSize.ctSecondary', value: '4' },
          summary: 'CT secondary wire → 4 mm² (§1.11 "ammeter circuit ≥ 4 sqmm")',
        },
        {
          name: 'set_tech_setting',
          args: { path: 'wireSize.ptSecondary', value: '2.5' },
          summary: 'PT secondary wire → 2.5 mm²',
        },
        {
          name: 'set_tech_setting',
          args: { path: 'others.colorType', value: 'RAL' },
          summary: 'Colour system → RAL',
        },
        {
          name: 'set_tech_setting',
          args: { path: 'others.backgroundColor', value: '7032' },
          summary: 'Panel colour → RAL 7032 (inside and outside)',
        },
      ],
    },
  ],
};

const DIGESTS: [string, DocumentDigest][] = [
  [key('Technical Specification for 6.6KV Switchgears'), SPEC_66KV],
];

/** The digest for an attached file, by its name — or none. */
export function digestFor(fileName: string): DocumentDigest | null {
  const k = key(fileName);
  return DIGESTS.find(([name]) => k.includes(name))?.[1] ?? null;
}
