//! sqlite3mc 2.4.0 (SQLite 3.53.4) FFI: bindings from libsqlite3-sys 0.40.0, C library built by build.rs.
#![allow(non_snake_case, non_camel_case_types, dead_code)]
#![no_std]

pub use self::error::*;

use core::mem;

mod error;

pub fn SQLITE_STATIC() -> sqlite3_destructor_type {
    None
}

pub fn SQLITE_TRANSIENT() -> sqlite3_destructor_type {
    Some(unsafe { mem::transmute::<isize, unsafe extern "C" fn(*mut core::ffi::c_void)>(-1_isize) })
}

mod bindings {
    include!("../bindings/bindgen_bundled_version.rs");
}
pub use bindings::*;

impl Default for sqlite3_vtab {
    fn default() -> Self {
        unsafe { mem::zeroed() }
    }
}

impl Default for sqlite3_vtab_cursor {
    fn default() -> Self {
        unsafe { mem::zeroed() }
    }
}
