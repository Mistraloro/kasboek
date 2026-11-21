//! `transfers.find`, `.pair`, `.unpair`, `.cost`, `.setCost`.
use super::{json, run};
use crate::core::{Core, Done};
use crate::error::AppResult;
use crate::input::{is_none, optional, Empty, Id, IntIn, LenVec};
use crate::transfers::{find_transfers, pair_transfers, set_transfer_cost, transfer_cost_info, unpair_transfer, PairRequest};
use kb_db::Store;
use serde::{Deserialize, Serialize};
use serde_json::{json as obj, Value};

type Cost = IntIn<0, 10_000_000_000>;

pub fn find<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |_: Empty| json(&find_transfers(core.db()?)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct PairIn {
    out_id: Id,
    in_id: Id,
    #[serde(default, deserialize_with = "optional", skip_serializing_if = "is_none")]
    cost_cents: Option<Cost>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct PairsIn {
    pairs: LenVec<PairIn, 1, 2000>,
}

pub fn pair<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: PairsIn| {
        let pairs: Vec<PairRequest> =
            i.pairs.0.iter().map(|p| PairRequest { out_id: p.out_id.0, in_id: p.in_id.0, cost_cents: p.cost_cents.map(|c| c.0) }).collect();
        Ok(obj!({ "paired": pair_transfers(core, &pairs)? }))
    })
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct IdIn {
    id: Id,
}

pub fn unpair<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: IdIn| {
        unpair_transfer(core.db()?, i.id.0)?;
        Ok(obj!({ "ok": true }))
    })
}

pub fn cost<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: IdIn| json(&transfer_cost_info(core.db()?, i.id.0)?))
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct SetCostIn {
    id: Id,
    cost_cents: Cost,
}

pub fn set_cost<S: Store>(core: &Core<S>, raw: Value) -> AppResult<Done> {
    run(raw, |i: SetCostIn| Ok(obj!({ "costCents": set_transfer_cost(core.db()?, i.id.0, i.cost_cents.0)? })))
}

/// The operations of this file, for the test that compares them with the contract.
pub(super) const PORTED: &[&str] = &["transfers.find", "transfers.pair", "transfers.unpair", "transfers.cost", "transfers.setCost"];

pub(super) fn handler<S: Store>(name: &str) -> Option<super::Handler<S>> {
    Some(match name {
        "transfers.find" => find::<S>,
        "transfers.pair" => pair::<S>,
        "transfers.unpair" => unpair::<S>,
        "transfers.cost" => cost::<S>,
        "transfers.setCost" => set_cost::<S>,
        _ => return None,
    })
}
