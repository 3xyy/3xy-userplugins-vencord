pub const SAMPLE_RATE: u32 = 48_000;
pub const CHANNELS: u16 = 2;

pub fn i16_to_f32(s: i16) -> f32 {
    s as f32 / 32768.0
}

pub fn f32_to_i16(s: f32) -> i16 {
    let clamped = s.clamp(-1.0, 1.0);
    (clamped * 32767.0).round() as i16
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn zero_round_trips() {
        assert_eq!(f32_to_i16(i16_to_f32(0)), 0);
    }

    #[test]
    fn full_scale_clamps() {
        assert_eq!(f32_to_i16(2.0), 32767);
        assert_eq!(f32_to_i16(-2.0), -32767);
    }

    #[test]
    fn i16_min_maps_to_neg_one() {
        assert_eq!(i16_to_f32(-32768), -1.0);
    }
}
