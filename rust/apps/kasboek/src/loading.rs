//! The loading view's rules (plan, section 5): the bar is real, each step has a fixed share and moves only on reported
//! progress; the view appears only if the Overview is not ready after 180 ms and then stays at least 300 ms.
use kb_service::LoadStep;

pub const SHOW_AFTER_MS: u64 = 180;
pub const MIN_VISIBLE_MS: u64 = 300;

const SHARES: [(LoadStep, f32); 4] =
    [(LoadStep::Opening, 0.10), (LoadStep::Migrating, 0.20), (LoadStep::Transactions, 0.40), (LoadStep::Overview, 0.30)];

#[derive(Default, Debug, Clone)]
pub struct Progress {
    done: [(u64, u64); 4],
    current: Option<LoadStep>,
}

fn index(step: LoadStep) -> usize {
    SHARES.iter().position(|(s, _)| *s == step).unwrap_or(0)
}

impl Progress {
    /// Records `done` of `total` for a step. Progress never goes back.
    pub fn report(&mut self, step: LoadStep, done: u64, total: u64) {
        let slot = &mut self.done[index(step)];
        if total > 0 && (done as f64 / total as f64) >= (slot.0 as f64 / slot.1.max(1) as f64) {
            *slot = (done.min(total), total);
        }
        self.current = Some(match self.current {
            Some(c) if index(c) > index(step) => c,
            _ => step,
        });
    }

    pub fn step(&self) -> LoadStep {
        self.current.unwrap_or(LoadStep::Opening)
    }

    /// 0..1: finished steps count in full (a step that was skipped, because a later one has begun, too).
    pub fn value(&self) -> f32 {
        let at = self.current.map_or(0, index);
        SHARES
            .iter()
            .enumerate()
            .map(|(i, (_, share))| {
                let (done, total) = self.done[i];
                let fraction = if i < at {
                    1.0
                } else if total == 0 {
                    0.0
                } else {
                    done as f32 / total as f32
                };
                share * fraction
            })
            .sum::<f32>()
            .clamp(0.0, 1.0)
    }
}

#[derive(Debug, PartialEq, Eq)]
pub enum Gate {
    Wait,
    ShowLoading,
    Finish,
}

/// What to do now. `elapsed_ms` counts from the successful unlock, `loading_since` is when the loading view appeared.
pub fn gate(elapsed_ms: u64, ready: bool, loading_since: Option<u64>) -> Gate {
    match (ready, loading_since) {
        (true, None) => Gate::Finish,
        (false, None) if elapsed_ms >= SHOW_AFTER_MS => Gate::ShowLoading,
        (true, Some(since)) if elapsed_ms.saturating_sub(since) >= MIN_VISIBLE_MS => Gate::Finish,
        _ => Gate::Wait,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_bar_moves_only_on_progress() {
        let mut p = Progress::default();
        assert_eq!(p.value(), 0.0);
        p.report(LoadStep::Opening, 1, 1);
        assert!((p.value() - 0.10).abs() < 1e-6);
        p.report(LoadStep::Transactions, 2, 4);
        // Opening done, Migrating skipped (a later step has begun): 0.1 + 0.2 + half of 0.4.
        assert!((p.value() - 0.50).abs() < 1e-6);
        p.report(LoadStep::Transactions, 1, 4);
        assert!((p.value() - 0.50).abs() < 1e-6, "never goes back");
        p.report(LoadStep::Overview, 5, 5);
        assert!((p.value() - 1.0).abs() < 1e-6);
        assert_eq!(p.step(), LoadStep::Overview);
    }

    #[test]
    fn the_gate_follows_the_owner_rules() {
        assert_eq!(gate(50, true, None), Gate::Finish, "ready in time: no loading view");
        assert_eq!(gate(100, false, None), Gate::Wait);
        assert_eq!(gate(180, false, None), Gate::ShowLoading);
        assert_eq!(gate(250, true, Some(180)), Gate::Wait, "stays at least 300 ms");
        assert_eq!(gate(480, true, Some(180)), Gate::Finish);
        assert_eq!(gate(480, false, Some(180)), Gate::Wait);
    }
}
