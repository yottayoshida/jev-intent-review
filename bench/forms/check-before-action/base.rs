use crate::store::{create_session, is_disabled, load_key, record_use, ApiKey, Session, Store, StoreError};

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
    if is_disabled(&record) {
        return Err(AuthError::Disabled);
    }
    record_use(store)?;
    let session = create_session(store, &record)?;
    Ok(session)
}
