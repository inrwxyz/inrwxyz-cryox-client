use serde_json::{json, Value};

#[cfg(windows)]
fn read_memory_mb() -> (u64, u64) {
    #[repr(C)]
    struct MemoryStatusEx {
        dw_length: u32,
        dw_memory_load: u32,
        ull_total_phys: u64,
        ull_avail_phys: u64,
        ull_total_page_file: u64,
        ull_avail_page_file: u64,
        ull_total_virtual: u64,
        ull_avail_virtual: u64,
        ull_avail_extended_virtual: u64,
    }

    extern "system" {
        fn GlobalMemoryStatusEx(lp_buffer: *mut MemoryStatusEx) -> i32;
    }

    let mut status = MemoryStatusEx {
        dw_length: std::mem::size_of::<MemoryStatusEx>() as u32,
        dw_memory_load: 0,
        ull_total_phys: 0,
        ull_avail_phys: 0,
        ull_total_page_file: 0,
        ull_avail_page_file: 0,
        ull_total_virtual: 0,
        ull_avail_virtual: 0,
        ull_avail_extended_virtual: 0,
    };

    unsafe {
        if GlobalMemoryStatusEx(&mut status) != 0 {
            (
                status.ull_total_phys / (1024 * 1024),
                status.ull_avail_phys / (1024 * 1024),
            )
        } else {
            (16384, 8192)
        }
    }
}

#[cfg(not(windows))]
fn read_memory_mb() -> (u64, u64) {
    (16384, 8192)
}

/// Same shape as x_client's serverManager.getSystemMemory(): { totalMb, freeMb }.
/// The UI reads `totalMb` (server RAM slider). The old `total/free/used` keys are kept for safety.
pub fn get_system_memory() -> Value {
    let (total_mb, free_mb) = read_memory_mb();
    json!({
        "totalMb": total_mb,
        "freeMb": free_mb,
        "usedMb": total_mb.saturating_sub(free_mb),
        "total": total_mb,
        "free": free_mb,
        "used": total_mb.saturating_sub(free_mb)
    })
}
