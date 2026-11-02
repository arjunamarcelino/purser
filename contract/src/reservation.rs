//! Reservation lifecycle state machine (TECHNICAL §4).
//!
//! [`transition`] is the SINGLE source of truth for which lifecycle edges are
//! legal. Every accounting function in [`crate::budget`] routes its state change
//! through it rather than re-checking states inline, so the legal edge set lives
//! in exactly one place.
//!
//! This module is a *superset* of the BACKEND-SCHEMA §1.3 accounting table: the
//! `Reserved -> Signed` (authorize) edge has no accounting effect and thus no
//! §1.3 row, but it is still a legal edge here (and `crate::budget::authorize`
//! drives it). There is deliberately NO `Unknown -> Unknown` edge — the §4
//! diagram's "Unknown stays reserved" is modeled as *inaction* (no operation
//! touches it), which is exactly why `mark_unknown` from `Unknown` rejects.
//!
//! A runtime `enum` + one total `transition` is the right shape for a
//! *serializable* state machine: a typestate (`Commitment<Reserved>`) cannot be
//! stored in a single `IterableMap<CommitmentId, Commitment>` nor loaded with a
//! state unknown until read. The exhaustive table test below recovers most of the
//! "illegal-is-unrepresentable" guarantee a typestate would give.

use crate::error::PurserError;
use crate::types::ReservationState;

/// Lifecycle events that drive the reservation state machine.
///
/// `Authorize` is deliberately generic ("an authorization/signature now exists"),
/// NOT "MPC signature obtained": the NEAR-native path has no MPC signature yet
/// still takes `Reserved -> Signed`, so both NEAR-native and EVM map onto this one
/// edge.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Event {
    /// `Reserved -> Signed`: payload constructed and authorized/signed.
    Authorize,
    /// `Reserved -> Failed`: rejected before any signature existed.
    Fail,
    /// `Signed | Unknown -> Confirmed`: outcome positively proven.
    Confirm,
    /// `Signed -> Unknown`: timed out / no proof yet.
    Timeout,
    /// `Unknown -> Cancelled`: attested nonce-burn cancel (stretch).
    Cancel,
}

/// Human-readable event name for [`PurserError::IllegalTransition`].
const fn event_name(e: Event) -> &'static str {
    match e {
        Event::Authorize => "Authorize",
        Event::Fail => "Fail",
        Event::Confirm => "Confirm",
        Event::Timeout => "Timeout",
        Event::Cancel => "Cancel",
    }
}

/// Return the target state for a legal `(from, event)` edge, else
/// [`PurserError::IllegalTransition`]. Pure and total.
///
/// The legal edge set is EXACTLY these six — see the §4 diagram. Any other pair
/// (including every event from a terminal state, re-`Signed`, `Signed -> Failed`,
/// `Unknown -> Failed`, and `Unknown -> Unknown`) is rejected.
pub fn transition(from: ReservationState, event: Event) -> Result<ReservationState, PurserError> {
    use Event::*;
    use ReservationState::*;
    let to = match (from, event) {
        (Reserved, Authorize) => Signed,
        (Reserved, Fail) => Failed,
        (Signed, Confirm) => Confirmed,
        (Signed, Timeout) => Unknown,
        (Unknown, Confirm) => Confirmed,
        (Unknown, Cancel) => Cancelled,
        // NOTE: there is intentionally no (Unknown, Timeout) => Unknown row. The §4
        // "stays reserved" self-loop is INACTION, not an Ok-returning edge; adding
        // it would make `mark_unknown(Unknown)` wrongly succeed.
        _ => {
            return Err(PurserError::IllegalTransition {
                from,
                event: event_name(event),
            })
        }
    };
    Ok(to)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::ReservationState::*;

    const STATES: [ReservationState; 6] = [Reserved, Signed, Confirmed, Unknown, Failed, Cancelled];
    const EVENTS: [Event; 5] = [
        Event::Authorize,
        Event::Fail,
        Event::Confirm,
        Event::Timeout,
        Event::Cancel,
    ];

    /// The six legal edges, as (from, event, to). Any change to `transition` that
    /// widens or narrows the edge set breaks `transition_table_is_exactly_the_legal_set`.
    const LEGAL: [(ReservationState, Event, ReservationState); 6] = [
        (Reserved, Event::Authorize, Signed),
        (Reserved, Event::Fail, Failed),
        (Signed, Event::Confirm, Confirmed),
        (Signed, Event::Timeout, Unknown),
        (Unknown, Event::Confirm, Confirmed),
        (Unknown, Event::Cancel, Cancelled),
    ];

    /// Exhaustive 6x5 = 30-pair check: exactly the six legal edges are `Ok` (with
    /// the correct target), every other pair is `Err(IllegalTransition)`.
    #[test]
    fn transition_table_is_exactly_the_legal_set() {
        let mut legal_count = 0;
        for from in STATES {
            for event in EVENTS {
                let expected = LEGAL
                    .iter()
                    .find(|(f, e, _)| *f == from && *e == event)
                    .map(|(_, _, to)| *to);
                match (transition(from, event), expected) {
                    (Ok(to), Some(want)) => {
                        assert_eq!(to, want, "{from:?} x {event:?} wrong target");
                        legal_count += 1;
                    }
                    (Err(PurserError::IllegalTransition { from: f, .. }), None) => {
                        assert_eq!(f, from, "IllegalTransition reported wrong source");
                    }
                    (got, want) => {
                        panic!("{from:?} x {event:?}: got {got:?}, expected legal={want:?}")
                    }
                }
            }
        }
        assert_eq!(legal_count, 6, "expected exactly 6 legal edges");
    }

    /// The safety-critical rejections, asserted by name so a regression is obvious.
    #[test]
    fn critical_safety_edges_reject() {
        // A signature escaped — cannot fail or re-sign after Signed.
        assert!(matches!(
            transition(Signed, Event::Fail),
            Err(PurserError::IllegalTransition { .. })
        ));
        assert!(matches!(
            transition(Signed, Event::Authorize),
            Err(PurserError::IllegalTransition { .. })
        ));
        // No release on silence.
        assert!(matches!(
            transition(Unknown, Event::Fail),
            Err(PurserError::IllegalTransition { .. })
        ));
        // No Ok-returning Unknown self-loop (so mark_unknown(Unknown) rejects).
        assert!(matches!(
            transition(Unknown, Event::Timeout),
            Err(PurserError::IllegalTransition { .. })
        ));
        // No direct Reserved -> Confirmed.
        assert!(matches!(
            transition(Reserved, Event::Confirm),
            Err(PurserError::IllegalTransition { .. })
        ));
        // Terminal states accept no event.
        for from in [Confirmed, Failed, Cancelled] {
            for event in EVENTS {
                assert!(
                    matches!(
                        transition(from, event),
                        Err(PurserError::IllegalTransition { .. })
                    ),
                    "terminal {from:?} accepted {event:?}"
                );
            }
        }
    }

    #[test]
    fn legal_edges_pass() {
        for (from, event, to) in LEGAL {
            assert_eq!(transition(from, event), Ok(to));
        }
    }
}
