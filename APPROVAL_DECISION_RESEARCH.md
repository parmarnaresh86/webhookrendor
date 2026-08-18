# SAP B1 Service Layer — Approval Decision Call: Research Notes

## Status: RESOLVED

Confirmed live against `ApprovalRequests(10)` on `WMS_DEV_UK`:

```
PATCH https://<server>:50000/b1s/v2/ApprovalRequests(<Code>)
Content-Type: application/json
Cookie: B1SESSION=...

{
  "ApprovalRequestDecisions": [
    { "Status": "ardApproved" | "ardNotApproved", "Remarks": "..." }
  ]
}
```

No `ApproverUserName`/`ApproverPassword` or `StageCode`/`UserID` needed —
the session's own identity resolves that. Must use the **v2** endpoint
(v1 rejects it as "Command Not Found" via the FunctionImport-based paths
tried below). This flipped Code 10 from `arsPending` to `arsNotApproved`
and updated the matching `ApprovalRequestLines` entry with the remarks and
timestamp. `serviceLayer.js`'s `decideApproval()` now uses this shape.

The rest of this document is kept as a record of what was tried and ruled
out first, in case a similar investigation is needed for a related call.

## What's confirmed (via live testing against `https://silverdemo.silvertouch.com:50000/b1s/v1`, DB `WMS_DEV_UK`)

- **Entities that exist and are readable**: `ApprovalRequests`, `ApprovalStages`,
  `ApprovalTemplates`, `Drafts`. Confirmed field names:
  - `ApprovalRequests`: `Code`, `Status` (`arsPending`/`arsApproved`/`arsNotApproved`),
    `CurrentStage`, `DraftEntry`, `ObjectType`, `ApprovalRequestLines`
    (`StageCode`, `UserID`, `Status` = `ardPending`/`ardApproved`/`ardNotApproved`),
    `ApprovalRequestDecisions` (`ApproverUserName`, `ApproverPassword`, `Status`, `Remarks`).
  - `Drafts(<DraftEntry>)`: `CardCode`, `CardName`, `DocTotal`, `DocDate`,
    `DocumentLines` (`ItemCode`, `ItemDescription`, `Quantity`, `Price`, `LineTotal`).
    Confirmed `CardCode`/`CardName` populate for Purchase Orders; a Purchase
    Request draft had them `null` (no BP on that document type).

- **What does NOT work**:
  - `POST /ApprovalRequests(<code>)/Approve` or `/Reject` → `"Command Not Found"` (-1008).
    These actions don't exist on this server/version.
  - `POST /Drafts(<entry>)/DraftsService_HandleApprovalRequest` (bound to the
    Drafts entity) → `"Command Not Found"` regardless of body. Wrong routing.
  - `PATCH /b1s/v2/ApprovalRequests(<code>)` with `ApprovalRequestLines`
    and/or `CurrentStage`/`Status` at top level → `400 Internal error (-10)`
    (unhelpful generic error) or enum validation errors once enum names were
    fixed. Never actually applied.
  - Wrapping the body as `{"ApprovalRequestParams": {...}}` →
    `"Data 'ApprovalRequestParams' not found"`. That wrapper key belongs to
    the *different* `CancelApprovalRequest`/`RestoreApprovalRequest` bindable
    functions (confirmed in metadata: `Parameter Name="ApprovalRequestParams"
    Type="SAPB1.ApprovalRequest"`), not this one.

- **What's structurally accepted but doesn't apply**:
  - `POST /b1s/v1/DraftsService_HandleApprovalRequest` (root-level, unbound) —
    this IS the right endpoint/routing (metadata confirms this FunctionImport
    exists, and it returns `204` rather than 404/"Command Not Found").
  - Body `{"Code": <ApprovalRequests.Code>, "Status": "arsApproved" |
    "arsNotApproved", "Remarks": "..."}` is the **only** shape that doesn't
    get rejected with `"Data '<X>' not found"` — confirmed by testing that
    adding `ApprovalRequestLines`, `ApprovalRequestDecisions`, or
    `CurrentStage` to this body gets explicitly rejected as unrecognized
    extra data. This strongly suggests the body's shape matches the
    `ApprovalRequestParams` ComplexType (`Code`/`Remarks`/`Status` only) —
    metadata line ~6696.
  - Tried `Code` as both the `ApprovalRequests.Code` (10) and the
    `Drafts.DocEntry`/`DraftEntry` (11) — neither changed the record.
  - Confirmed `manager` = `UserID 1`, which does match the pending stage's
    assigned approver (`ApprovalRequestLines[0].UserID === 1`) — not an
    identity mismatch.

## Open hypothesis for why the "valid shape" call still no-ops

Unknown. Possibilities worth checking against official docs/support:
- This may genuinely be the right call, but require something not visible
  from outside (an async queue, a required prior step, a DI Server/add-on
  component that must be running to actually process it, since Service Layer
  sometimes just queues UI-API-style calls).
- The `Code` field might need to reference something else entirely (not
  `ApprovalRequests.Code` nor `Drafts.DraftEntry`) — e.g. a specific
  `ApprovalRequestLines` line identifier not exposed as its own field in the
  metadata we inspected.
- This FunctionImport might be a red herring entirely (name matches "handle
  approval request" but may serve an unrelated purpose), and the real
  mechanism might not be exposed via Service Layer at all for this SAP B1
  version — possibly requiring the DI API (COM, Windows-only) instead,
  which Service Layer sometimes only partially mirrors.

## Next step

Get the authoritative call shape from SAP B1 Service Layer documentation or
SAP support, then update `serviceLayer.js`'s `decideApproval()` function to
match. Test against a real pending record (e.g. `ApprovalRequests(10)`,
still `arsPending` as of this writing, tied to `Drafts(11)`, a Purchase
Order for vendor `V10000` / "Acme Associates", total `120.0`) once the
correct shape is known.
