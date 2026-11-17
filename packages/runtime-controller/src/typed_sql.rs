//! Statements that cost one round trip to the database instead of two.
//!
//! Given SQL text, tokio-postgres's `query`, `query_one`, `query_opt` and
//! `execute` first prepare a named statement and wait for the server's answer,
//! and only then bind and run it: two round trips for every statement. Hosted,
//! the controller is a cross-region hop away from its database, and a send runs
//! a few dozen statements one after another while its job is still invisible
//! to every runtime, so that second wait is paid a few dozen times per message.
//!
//! The `*_typed` calls send parse, bind and execute in one message. They need
//! each parameter's Postgres type up front, which [`typed!`] takes from the
//! parameter's Rust type ([`PgParam`]). A call site changes its method name and
//! its parameter list, and nothing else:
//!
//! ```ignore
//! transaction
//!     .query_typed_opt("select ... where project_id = $1 and id = $2", typed![project_id, &runtime_id])
//!     .await
//! ```
//!
//! The declared type is the one the Rust value already had to match: an
//! untyped statement asks the server for each parameter's type and refuses a
//! Rust value that cannot be sent as it. The one family where the two can
//! differ is text, which tokio-postgres also sends as `varchar`, `char(n)`,
//! `name` or `citext`; a statement that binds text to one of those columns
//! keeps the untyped calls.

use chrono::{DateTime, Utc};
use tokio_postgres::types::{Json, ToSql, Type};
use uuid::Uuid;

/// A Rust value whose Postgres parameter type follows from its Rust type.
pub(crate) trait PgParam: ToSql + Sync {
    const PG_TYPE: Type;
}

macro_rules! pg_param {
    ($($rust:ty => $pg:ident),* $(,)?) => {
        $(impl PgParam for $rust {
            const PG_TYPE: Type = Type::$pg;
        })*
    };
}

pg_param! {
    bool => BOOL,
    i16 => INT2,
    i32 => INT4,
    i64 => INT8,
    f64 => FLOAT8,
    String => TEXT,
    Uuid => UUID,
    DateTime<Utc> => TIMESTAMPTZ,
    serde_json::Value => JSONB,
    Vec<Uuid> => UUID_ARRAY,
    Vec<String> => TEXT_ARRAY,
}

impl PgParam for &str {
    const PG_TYPE: Type = Type::TEXT;
}

impl PgParam for &[Uuid] {
    const PG_TYPE: Type = Type::UUID_ARRAY;
}

impl<T: PgParam> PgParam for &T {
    const PG_TYPE: Type = T::PG_TYPE;
}

impl<T: PgParam> PgParam for Option<T> {
    const PG_TYPE: Type = T::PG_TYPE;
}

impl<T: serde::Serialize + std::fmt::Debug + Sync> PgParam for Json<T> {
    const PG_TYPE: Type = Type::JSONB;
}

/// One parameter of a typed statement, with the type its Rust type gives it.
pub(crate) fn typed_param<T: PgParam>(value: &T) -> (&(dyn ToSql + Sync), Type) {
    (value, T::PG_TYPE)
}

/// The parameter list of a typed statement: `typed![&a, &b]` where an
/// untyped one has `&[&a, &b]`.
macro_rules! typed {
    ($($param:expr),* $(,)?) => {
        &[$($crate::typed_sql::typed_param($param)),*]
    };
}
pub(crate) use typed;

#[cfg(test)]
mod tests {
    use super::*;
    use tokio_postgres::types::Json;

    fn types(params: &[(&(dyn ToSql + Sync), Type)]) -> Vec<Type> {
        params.iter().map(|(_, ty)| ty.clone()).collect()
    }

    #[test]
    fn each_parameter_takes_the_type_its_rust_type_is_sent_as() {
        let id = Uuid::nil();
        let ids = vec![id];
        let name = String::from("octo");
        let label: &str = "queued";
        let missing: Option<Uuid> = None;
        let note: Option<&str> = Some("hello");
        let metadata = serde_json::json!({"a": 1});
        let wrapped = Json(&metadata);
        let at = Utc::now();
        let count: i64 = 3;
        let priority: i32 = 1;
        let flag = true;

        assert_eq!(
            types(typed![
                &id, &ids, &name, &label, &missing, &note, &metadata, &wrapped, &at, &count,
                &priority, &flag
            ]),
            vec![
                Type::UUID,
                Type::UUID_ARRAY,
                Type::TEXT,
                Type::TEXT,
                Type::UUID,
                Type::TEXT,
                Type::JSONB,
                Type::JSONB,
                Type::TIMESTAMPTZ,
                Type::INT8,
                Type::INT4,
                Type::BOOL,
            ]
        );
    }

    #[test]
    fn a_reference_to_a_parameter_keeps_its_type() {
        let id = Uuid::nil();
        let by_reference: &Uuid = &id;
        let ids = [id];
        let slice: &[Uuid] = &ids;
        assert_eq!(
            types(typed![by_reference, &by_reference, &slice]),
            vec![Type::UUID, Type::UUID, Type::UUID_ARRAY]
        );
    }

    #[test]
    fn every_declared_type_is_one_the_value_can_be_sent_as() {
        fn sendable<T: PgParam>(_: &T) -> bool {
            T::accepts(&T::PG_TYPE)
        }
        assert!(sendable(&Uuid::nil()));
        assert!(sendable(&vec![Uuid::nil()]));
        assert!(sendable(&String::new()));
        assert!(sendable(&"text"));
        assert!(sendable(&Some(1_i64)));
        assert!(sendable(&serde_json::Value::Null));
        assert!(sendable(&Json(serde_json::Value::Null)));
        assert!(sendable(&Utc::now()));
        assert!(sendable(&vec![String::new()]));
        assert!(sendable(&1_i16));
        assert!(sendable(&1_i32));
        assert!(sendable(&1.5_f64));
        assert!(sendable(&false));
    }
}
