//! When each person who signed out everywhere did, as every controller holds
//! it in memory for authentication.
//!
//! A person's sign-out everywhere (`crate::sign_out_everywhere`) records its
//! moment in `user_sign_outs`. From then on a credential they signed in for
//! at or before that second is refused: a Supabase access token by its `iat`,
//! a controller session by the sign-in it carries (`crate::auth`). Requests
//! read this cache, never the table. The controller that signs a person out
//! records the moment here at once; every other one learns it from its next
//! read of the table, at most 30 seconds later.

use std::collections::HashMap;
use std::sync::{Arc, RwLock};

use uuid::Uuid;

/// How long after a sign-out its moment is kept in memory, in seconds: longer
/// than any credential from before it can live. A Supabase access token lives
/// an hour by default and a week at most, and a controller session, which
/// only a Supabase access token starts and nothing renews, ends within its
/// own lifetime.
pub const SIGN_OUT_MEMORY_SECONDS: i64 = 8 * 24 * 60 * 60;

/// Each person's latest sign-out everywhere, in whole seconds since the
/// epoch, rounded down. Clones share one cache.
#[derive(Clone, Debug, Default)]
pub struct SignOuts {
    cutoffs: Arc<RwLock<HashMap<Uuid, i64>>>,
}

impl SignOuts {
    /// Whether `person` signed out everywhere at or after `signed_in_at`, the
    /// second they signed in for a credential. A credential whose sign-in
    /// time is unknown is ended by any sign-out.
    pub fn ended(&self, person: &Uuid, signed_in_at: Option<i64>) -> bool {
        match self.cutoff(person) {
            Some(cutoff) => signed_in_at.is_none_or(|signed_in_at| signed_in_at <= cutoff),
            None => false,
        }
    }

    /// The second of `person`'s latest sign-out everywhere this controller
    /// knows of.
    pub fn cutoff(&self, person: &Uuid) -> Option<i64> {
        self.cutoffs
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(person)
            .copied()
    }

    /// Learn that `person` signed out everywhere at `cutoff`. A later moment
    /// already known is kept.
    pub fn record(&self, person: Uuid, cutoff: i64) {
        let mut cutoffs = self
            .cutoffs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let known = cutoffs.entry(person).or_insert(cutoff);
        *known = (*known).max(cutoff);
    }

    /// Forget `person`'s sign-out, as a controller that has not read the table
    /// since it was recorded knows nothing of it.
    #[cfg(test)]
    pub fn forget(&self, person: &Uuid) {
        self.cutoffs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(person);
    }

    /// Take a fresh read of the table: learn each of `rows`, then forget every
    /// moment before `oldest`.
    pub fn refresh(&self, rows: impl IntoIterator<Item = (Uuid, i64)>, oldest: i64) {
        let mut cutoffs = self
            .cutoffs
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        for (person, cutoff) in rows {
            let known = cutoffs.entry(person).or_insert(cutoff);
            *known = (*known).max(cutoff);
        }
        cutoffs.retain(|_, cutoff| *cutoff >= oldest);
    }
}

#[cfg(test)]
mod tests {
    use super::SignOuts;
    use uuid::Uuid;

    #[test]
    fn a_sign_out_ends_sign_ins_up_to_its_second_and_none_after() {
        let sign_outs = SignOuts::default();
        let person = Uuid::new_v4();
        let other = Uuid::new_v4();
        assert!(!sign_outs.ended(&person, Some(100)));
        assert!(!sign_outs.ended(&person, None));

        sign_outs.record(person, 100);
        assert!(sign_outs.ended(&person, Some(99)));
        assert!(sign_outs.ended(&person, Some(100)), "the same second");
        assert!(!sign_outs.ended(&person, Some(101)));
        assert!(sign_outs.ended(&person, None), "an unknown sign-in time");
        assert!(!sign_outs.ended(&other, Some(1)), "only that person");
    }

    #[test]
    fn a_later_sign_out_is_never_moved_back() {
        let sign_outs = SignOuts::default();
        let person = Uuid::new_v4();
        sign_outs.record(person, 200);
        sign_outs.record(person, 150);
        assert_eq!(sign_outs.cutoff(&person), Some(200));
        sign_outs.refresh([(person, 180)], 0);
        assert_eq!(sign_outs.cutoff(&person), Some(200));
        sign_outs.refresh([(person, 250)], 0);
        assert_eq!(sign_outs.cutoff(&person), Some(250));
    }

    #[test]
    fn a_refresh_forgets_only_moments_before_the_oldest_kept() {
        let sign_outs = SignOuts::default();
        let (old, recent, learned) = (Uuid::new_v4(), Uuid::new_v4(), Uuid::new_v4());
        sign_outs.record(old, 10);
        sign_outs.record(recent, 500);
        sign_outs.refresh([(learned, 400)], 300);
        assert_eq!(sign_outs.cutoff(&old), None);
        assert_eq!(sign_outs.cutoff(&recent), Some(500));
        assert_eq!(sign_outs.cutoff(&learned), Some(400));
    }
}
