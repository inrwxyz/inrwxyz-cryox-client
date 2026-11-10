//! Microsoft / Minecraft tokens must not sit in accounts.json as plain text.
//! x_client encrypted them with Windows DPAPI (accountManager._dpapiProtect); this is the same idea for Rust.
//!
//! Stored form: "dpapi:v1:<base64 of CryptProtectData output>". Old plain-text values (from before this module)
//! are still accepted on load and get encrypted on the next save.
//! Only the same Windows user on the same PC can decrypt; anything else yields None => the player logs in again.

const PREFIX: &str = "dpapi:v1:";

#[cfg(windows)]
mod win {
    use std::ffi::c_void;

    #[repr(C)]
    struct DataBlob {
        cb_data: u32,
        pb_data: *mut u8,
    }

    #[link(name = "crypt32")]
    extern "system" {
        fn CryptProtectData(
            p_data_in: *const DataBlob,
            sz_data_descr: *const u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
        fn CryptUnprotectData(
            p_data_in: *const DataBlob,
            ppsz_data_descr: *mut *mut u16,
            p_optional_entropy: *const DataBlob,
            pv_reserved: *mut c_void,
            p_prompt_struct: *mut c_void,
            dw_flags: u32,
            p_data_out: *mut DataBlob,
        ) -> i32;
    }

    #[link(name = "kernel32")]
    extern "system" {
        fn LocalFree(h_mem: *mut c_void) -> *mut c_void;
    }

    const CRYPTPROTECT_UI_FORBIDDEN: u32 = 0x1;

    pub fn protect(data: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = DataBlob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
            let mut out = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
            let ok = CryptProtectData(
                &input,
                std::ptr::null(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            );
            if ok == 0 || out.pb_data.is_null() {
                return None;
            }
            let v = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            LocalFree(out.pb_data as *mut c_void);
            Some(v)
        }
    }

    pub fn unprotect(data: &[u8]) -> Option<Vec<u8>> {
        unsafe {
            let input = DataBlob { cb_data: data.len() as u32, pb_data: data.as_ptr() as *mut u8 };
            let mut out = DataBlob { cb_data: 0, pb_data: std::ptr::null_mut() };
            let ok = CryptUnprotectData(
                &input,
                std::ptr::null_mut(),
                std::ptr::null(),
                std::ptr::null_mut(),
                std::ptr::null_mut(),
                CRYPTPROTECT_UI_FORBIDDEN,
                &mut out,
            );
            if ok == 0 || out.pb_data.is_null() {
                return None;
            }
            let v = std::slice::from_raw_parts(out.pb_data, out.cb_data as usize).to_vec();
            LocalFree(out.pb_data as *mut c_void);
            Some(v)
        }
    }
}

#[cfg(not(windows))]
mod win {
    pub fn protect(_data: &[u8]) -> Option<Vec<u8>> {
        None
    }
    pub fn unprotect(_data: &[u8]) -> Option<Vec<u8>> {
        None
    }
}

const B64: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

fn b64_encode(data: &[u8]) -> String {
    let mut out = String::with_capacity((data.len() + 2) / 3 * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(B64[((n >> 18) & 63) as usize] as char);
        out.push(B64[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { B64[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { B64[(n & 63) as usize] as char } else { '=' });
    }
    out
}

fn b64_decode(input: &str) -> Option<Vec<u8>> {
    let mut out = Vec::with_capacity(input.len() / 4 * 3);
    let mut buf = 0u32;
    let mut bits = 0u32;
    for c in input.bytes() {
        if c == b'=' || c == b'\r' || c == b'\n' {
            continue;
        }
        let v = B64.iter().position(|&x| x == c)? as u32;
        buf = (buf << 6) | v;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push(((buf >> bits) & 0xff) as u8);
        }
    }
    Some(out)
}

/// Encrypts a token for storage. If DPAPI is not available the value is returned unchanged (never lose a token).
pub fn seal(plain: &str) -> String {
    if plain.is_empty() || plain.starts_with(PREFIX) {
        return plain.to_string();
    }
    match win::protect(plain.as_bytes()) {
        Some(blob) => format!("{PREFIX}{}", b64_encode(&blob)),
        None => plain.to_string(),
    }
}

/// Reads a stored token. Plain-text (legacy) values pass through; an encrypted value that cannot be decrypted
/// (other Windows user / other PC) gives None.
pub fn open(stored: &str) -> Option<String> {
    match stored.strip_prefix(PREFIX) {
        None => Some(stored.to_string()),
        Some(b64) => {
            let blob = b64_decode(b64)?;
            let plain = win::unprotect(&blob)?;
            String::from_utf8(plain).ok()
        }
    }
}

pub fn is_sealed(stored: &str) -> bool {
    stored.starts_with(PREFIX)
}
