use ringbuf::{
    traits::{Consumer, Observer, Producer, Split},
    HeapRb,
};

pub struct RingProducer(ringbuf::HeapProd<f32>);
pub struct RingConsumer(ringbuf::HeapCons<f32>);

pub fn new(capacity_samples: usize) -> (RingProducer, RingConsumer) {
    let rb = HeapRb::<f32>::new(capacity_samples);
    let (prod, cons) = rb.split();
    (RingProducer(prod), RingConsumer(cons))
}

impl RingProducer {
    /// Push as many samples as fit; returns how many were written.
    pub fn push_slice(&mut self, samples: &[f32]) -> usize {
        self.0.push_slice(samples)
    }

    /// Number of samples that can be written without dropping (free space).
    pub fn free_len(&self) -> usize {
        self.0.vacant_len()
    }

    /// Number of samples written but not yet read (queued).
    pub fn occupied_len(&self) -> usize {
        self.0.occupied_len()
    }
}

impl RingConsumer {
    /// Pop up to out.len() samples; zero-fill any remainder. Returns samples read.
    pub fn pop_slice(&mut self, out: &mut [f32]) -> usize {
        let read = self.0.pop_slice(out);
        for s in out.iter_mut().skip(read) {
            *s = 0.0;
        }
        read
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_samples() {
        let (mut p, mut c) = new(16);
        let written = p.push_slice(&[0.1, 0.2, 0.3]);
        assert_eq!(written, 3);
        let mut out = [0.0f32; 3];
        let read = c.pop_slice(&mut out);
        assert_eq!(read, 3);
        assert_eq!(out, [0.1, 0.2, 0.3]);
    }

    #[test]
    fn underflow_zero_fills() {
        let (mut p, mut c) = new(16);
        p.push_slice(&[0.5]);
        let mut out = [9.0f32; 4];
        let read = c.pop_slice(&mut out);
        assert_eq!(read, 1);
        assert_eq!(out, [0.5, 0.0, 0.0, 0.0]);
    }

    #[test]
    fn overflow_drops_excess() {
        let (mut p, _c) = new(2);
        let written = p.push_slice(&[1.0, 2.0, 3.0, 4.0]);
        assert_eq!(written, 2);
    }
}
