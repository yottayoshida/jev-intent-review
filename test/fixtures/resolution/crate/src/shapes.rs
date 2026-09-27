pub trait Store {
    fn put(&self) -> Result<(), ()>;
    fn get(&self) -> Result<(), ()> {
        Ok(())
    }
}

pub struct Disk;

impl Store for Disk {
    fn put(&self) -> Result<(), ()> {
        Ok(())
    }
}

pub struct Point(pub i32);

macro_rules! twice {
    ($e:expr) => {{
        $e;
        $e
    }};
}

pub fn run(d: &Disk, s: &dyn Store) -> Result<(), ()> {
    d.put()?;
    s.put()?;
    s.get()?;
    let _ = std::fs::read("x");
    let _p = Point(1);
    let f = || 1;
    f();
    let _ = twice!(crate::a::load("y"));
    let _ = ("é", crate::b::load("é"));
    d.get()?;
    Ok(())
}
