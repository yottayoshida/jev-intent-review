// expected-oracle-calls: 2
trait T {
    fn req(&self) -> u8;
    fn def(&self) -> u8 {
        self.req().pow(2)
    }
}
