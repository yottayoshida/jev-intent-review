// The store the session code calls. The same in every version.

#[derive(Default)]
pub struct Store {
    pub sessions: Vec<Session>,
    pub audited: u32,
}

pub struct ApiKey {
    pub id: String,
    pub disabled: bool,
}

pub struct KeyRecord {
    pub id: String,
    pub disabled: bool,
}

#[derive(Clone, Debug)]
pub struct Session {
    pub key: String,
}

#[derive(Debug)]
pub struct StoreError;

pub fn load_key(_store: &Store, key: &ApiKey) -> Result<KeyRecord, StoreError> {
    Ok(KeyRecord { id: key.id.clone(), disabled: key.disabled })
}

pub fn is_disabled(record: &KeyRecord) -> bool {
    record.disabled
}

pub fn audit(store: &mut Store) -> Result<(), StoreError> {
    store.audited += 1;
    Ok(())
}

pub fn record_use(store: &mut Store) -> Result<(), StoreError> {
    store.audited += 1;
    Ok(())
}

pub fn create_session(store: &mut Store, record: &KeyRecord) -> Result<Session, StoreError> {
    let session = Session { key: record.id.clone() };
    store.sessions.push(session.clone());
    Ok(session)
}
