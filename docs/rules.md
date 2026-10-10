# Procedure rules (educational dataset)

> **Status of every rule: illustrative.** Each rule is a simplification written for this training prototype. The *basis* column names the guidance it is modelled on. None of these rules has been reviewed by a qualified MR safety officer for this project, and none replaces local MR safety procedures, manufacturer labelling, or certification.

Generated from `simulator/engine.js` (the single source of truth).

| Rule | Category | Severity | Points | Title | Corrective action | Basis |
|---|---|---|---|---|---|---|
| R-ID-01 | screening | major | −10 | Identity not confirmed before screening sign-off | Open the patient record and confirm that both identifiers on the wristband match the scan request, then sign off screening. | Two-identifier patient identification (Joint Commission NPSG.01.01.01) |
| R-SCR-01 | screening | major | −10 | Screening signed off without reviewing the form | Open the patient record, read the MR screening form, then sign off. | ACR Manual on MR Safety (American College of Radiology) |
| R-SCR-02 | screening | critical | −25 | Reported implant not referred for review | Escalate the implant to the MR safety officer or supervising radiologist for review against the manufacturer's MR Conditional labelling before sign-off. | ACR Manual on MR Safety (American College of Radiology) |
| R-EQ-01 | equipment | major | −10 | Equipment signed off with items not classified | Select each item in the staging area and Zone IV, read its labelling, and classify it. | ASTM F2503 — marking of medical devices for safety in the MR environment |
| R-EQ-02 | equipment | major | −10 | Item misclassified | Re-read the item's label and correct the classification. | ASTM F2503 — marking of medical devices for safety in the MR environment |
| R-EQ-03 | equipment | critical | −25 | MR Unsafe item in or brought into Zone IV | Keep the item out of Zone IV. Move it back to the Zone II staging area. | ACR Manual on MR Safety (American College of Radiology) |
| R-EQ-04 | equipment | major | −10 | MR Conditional item in Zone IV without its conditions checked | Open the item and confirm its conditions against the labelling, or move it out of Zone IV. | ASTM F2503 — marking of medical devices for safety in the MR environment |
| R-EQ-05 | equipment | critical | −25 | MR Unsafe or unknown item classified as acceptable | Classify items with no MR labelling, or an MR Unsafe label, as MR Unsafe. | ASTM F2503 — marking of medical devices for safety in the MR environment |
| R-EQ-06 | equipment | major | −10 | Item moved toward Zone IV before its MR status was determined | Inspect and classify the item first. | ACR Manual on MR Safety (American College of Radiology) |
| R-ACC-01 | access | critical | −25 | Personal metallic items not removed before Zone IV | Inspect the patient, remove and store personal items in the locker, then repeat the access check. | ACR Manual on MR Safety (American College of Radiology) |
| R-ACC-02 | access | major | −10 | Patient not checked at the Zone IV door | Select the patient on the table to perform the final check before attesting room access. | Training-procedure convention for this prototype (not a clinical rule) |
| R-SEQ-01 | sequence | major | −10 | Step attempted before its prerequisites | Complete the earlier checkpoints first. The procedure list shows which ones are open. | Training-procedure convention for this prototype (not a clinical rule) |
| R-SEQ-02 | access | critical | −25 | Zone IV access attempted before screening and equipment clearance | Finish screening sign-off and equipment verification before the room access check. | ACR Manual on MR Safety (American College of Radiology) |
| R-SCAN-01 | sequence | critical | −25 | Scan started without final safety clearance | Complete the final safety clearance (T4), then proceed to scan. | Training-procedure convention for this prototype (not a clinical rule) |

## Checkpoints

| Pad | Checkpoint | Prerequisites | Rule if prerequisites open | Requirements checked on touch |
|---|---|---|---|---|
| T1 | Screening sign-off | none | R-SEQ-01 | Two identifiers confirmed; Screening form reviewed; Implant referred for review (if reported) |
| T2 | Equipment verification | none | R-SEQ-01 | Every item classified; Classifications match labelling; No MR Unsafe item in Zone IV; Conditional items in Zone IV checked |
| T3 | Zone IV access check | SCREENING, EQUIPMENT | R-SEQ-02 | Patient checked at the door; Personal items removed |
| T4 | Final safety clearance | ACCESS | R-SEQ-01 | No MR Unsafe item in Zone IV; Conditional items in Zone IV checked; Personal items removed |
| T5 | Proceed to scan | CLEARANCE | R-SCAN-01 | none |

## Equipment items

| Item | Label on item | Correct classification | Note |
|---|---|---|---|
| Oxygen cylinder on trolley | none | MR Unsafe | No MR labelling on the cylinder or the trolley. Status unknown. |
| Transport wheelchair | MR Unsafe | MR Unsafe | Labelled MR Unsafe. |
| IV pole | MR Conditional | MR Conditional | Labelled MR Conditional. Conditions of use are listed in the manufacturer's documentation. |
| Foam positioning pads | MR Safe | MR Safe | Labelled MR Safe. |
| Infusion pump | none | MR Unsafe | No MR labelling found. Status unknown. |

## Scenarios

| Id | Level | Title | Checkpoints | Hints | Hazards |
|---|---|---|---|---|---|
| guided | 1 | Guided practice | 5 | yes | none |
| standard | 2 | Standard pre-scan | 5 | no | personal items: hairclip; oxygen cylinder on trolley in Zone IV |
| complex | 3 | Complex pre-scan | 5 | no | implant on form; personal items: phone, hairclip; oxygen cylinder on trolley in Zone IV; iv pole in Zone IV |
| drill-equipment | 2 | Equipment classification drill | 1 | no | oxygen cylinder on trolley in Zone IV; infusion pump in Zone IV; iv pole in Zone IV |
| drill-screening | 2 | Screening drill | 1 | no | implant on form |

## Scoring

Start at 100. Deduct per violation by severity (critical 25, major 10, minor 5). Each rule is penalised once per subject per attempt; repeats are logged at 0 points. Pass = all checkpoints complete, score ≥ 80, and no critical violations.

## Adaptive selection (applied in order)

- **AD-1** Two consecutive attempts did not pass → guided practice with hints.
- **AD-2** Passed → unlock the next level (drills return to the last full scenario).
- **AD-3** Not passed with a critical or ≥2 equipment violations → equipment classification drill.
- **AD-4** Not passed with a critical or ≥2 screening violations → screening drill.
- **AD-5** Otherwise → repeat the same scenario.

The adaptation logic is transparent and tested, but its effect on learning has **not** been evaluated.

## Terminology

The ASTM F2503 terms are *MR Safe*, *MR Conditional* and *MR Unsafe*. The symbols drawn in the simulator are simplified renderings for training, not reproductions of the standard's artwork.
