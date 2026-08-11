# Security

## Status

Unpublished, v0.1.0, no remote and no distribution. There is no security contact yet because
there is nothing deployed to report against. This file records the security posture as
designed so it can be reviewed before any release.

## Threat model

modelshift sits on the path that decides which model serves production traffic. The
interesting risks are about **trust in its refusals and its records**, not about data
handling: the core moves no user data and makes no network calls.

| Risk | Position today |
|---|---|
| **Forged audit history** | The ledger is a plain local file, validated on read in four layers: record structure, sequence continuity, `from`/`to` chain continuity, semantic legality of each `(action, from, to)` triple, and cross-event consistency between records. **Detected:** malformed records, splicing, edits that invent an impossible transition, and edits that make one record disagree with another about the candidate, baseline, policy hash, approver, activation outcome or rollback target. **Not detected:** a ledger rewritten *consistently* throughout, and any field nothing else cross-references (timestamps, free-text reasons, adapter labels, `caseSetHash`, whose case set is not retained and so cannot be re-derived). Call this **inconsistency detection, not tamper resistance**. A signed or hash-chained ledger is on the roadmap and is the honest fix. |
| **Substituted model identity** | An earlier version bound the candidate only to the first ledger record. Editing that one field, with no state change, made the tool activate a model that had never been evaluated. Cross-event validation now binds the candidate, baseline and rollback target across every record that mentions them, and activation additionally refuses if production is not serving the evaluated baseline. Within the limits of the row above: consistent rewriting of the whole file still defeats it. |
| **Redirected rollback** | The rollback target is locked into the migration at `register`. A later edit to `rollbackModel` cannot retarget a rollback in flight; the drift is reported and the locked value is used. **Emergency** rollback is the deliberate exception and takes the live config value, because it runs when the ledger cannot be read at all. Anyone who can edit the config *and* corrupt the ledger can therefore steer an emergency rollback. |
| **Unauthorised activation** | `--actor` is an **assertion, not an identity**. It records who said they did it. There is no authentication and the CLI grants no privilege it does not already have from the filesystem. Treat the actor field as a label, and put real authorisation in the system that runs modelshift. |
| **Malicious `modelshift.ports.ts`** | The CLI imports this file from the project root and **executes it**. It is code, with the same trust level as anything else in your repository. Do not run modelshift against a project directory you do not control. |
| **Untrusted configuration** | `modelshift.config.json` is parsed and validated field by field, with ranges and types checked. It is data, never executed. |
| **Secrets** | The core reads no credentials and holds none. Anything secret belongs to your adapters, and should reach them the way the rest of your application gets secrets. The default demonstration needs no key and makes no network call. |
| **Local state disclosure** | `.modelshift/` holds the ledger and demo state. It is gitignored by default because in a real deployment it names internal models and may name internal hosts. |
| **Supply chain** | The core has **zero runtime dependencies**. TypeScript and ESLint are development-only. |

## Reporting

Once this repository is published, a contact address and disclosure window go here. Until
then, report privately to the project owner.
