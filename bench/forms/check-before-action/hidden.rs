use crate::store::{audit, create_session, load_key, ApiKey, KeyRecord, Session, Store, StoreError};

#[derive(Debug)]
pub enum AuthError {
    Disabled,
    Store,
}

impl From<StoreError> for AuthError {
    fn from(_: StoreError) -> Self {
        AuthError::Store
    }
}

pub fn login(store: &mut Store, key: &ApiKey) -> Result<Session, AuthError> {
    open_session(store, key)
}

pub fn open_session(store: &mut Store, key: &ApiKey) -> Result<Session, AuthError> {
    let record = load_key(store, key)?;
    reject_disabled(&record)?;
    audit(store)?;
    let session = create_session(store, &record)?;
    Ok(session)
}

fn reject_disabled(_record: &KeyRecord) -> Result<(), AuthError> {
    Ok(())
}
