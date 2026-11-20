//! A memory cap for the reader process. hayro decodes a stream completely before it reads it and has no limit on the size,
//! so a few MB of deflate can ask for many GB (a decompression bomb). Past the cap the process answers
//! `import.pdf_too_large` and ends, instead of growing until the system kills something else.
//!
//! The app's binary installs the allocator (a library cannot) and `run_reader_process` switches the counting on, so the
//! interface process pays one atomic load per allocation and never trips:
//!
//! ```ignore
//! #[global_allocator]
//! static ALLOC: kb_pdf::cap::CappedAlloc = kb_pdf::cap::CappedAlloc;
//! ```
use crate::model::ReadError;
use std::alloc::{GlobalAlloc, Layout, System};
use std::sync::atomic::{AtomicBool, AtomicIsize, AtomicUsize, Ordering::Relaxed};

/// Live heap bytes the reader may use (1 GiB). A statement of 70 pages needs about 10 MB.
pub const CAP_BYTES: usize = 1 << 30;

pub struct CappedAlloc;

static ENABLED: AtomicBool = AtomicBool::new(false);
static TRIPPED: AtomicBool = AtomicBool::new(false);
static CAP: AtomicUsize = AtomicUsize::new(CAP_BYTES);
/// Bytes allocated since `enable` (signed: memory that was allocated before and is freed after counts below zero).
static LIVE: AtomicIsize = AtomicIsize::new(0);

/// Starts counting; past `cap` live bytes the process answers `import.pdf_too_large` and ends.
pub fn enable(cap: usize) {
    CAP.store(cap, Relaxed);
    LIVE.store(0, Relaxed);
    ENABLED.store(true, Relaxed);
}

/// Bytes counted so far (0 while the cap is not enabled).
pub fn live_bytes() -> isize {
    LIVE.load(Relaxed)
}

#[cold]
fn trip() -> ! {
    // Allocations made while answering are let through.
    if !TRIPPED.swap(true, Relaxed) {
        crate::process::answer_and_exit(ReadError::TooLarge);
    }
    loop {
        std::thread::park();
    }
}

#[inline]
fn grow(n: usize) {
    if ENABLED.load(Relaxed) && !TRIPPED.load(Relaxed) && LIVE.fetch_add(n as isize, Relaxed) + n as isize > CAP.load(Relaxed) as isize {
        trip();
    }
}

#[inline]
fn shrink(n: usize) {
    if ENABLED.load(Relaxed) {
        LIVE.fetch_sub(n as isize, Relaxed);
    }
}

// SAFETY: every call is forwarded to the system allocator with the same arguments; the counters only observe sizes.
unsafe impl GlobalAlloc for CappedAlloc {
    unsafe fn alloc(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        System.alloc(l)
    }
    unsafe fn dealloc(&self, p: *mut u8, l: Layout) {
        shrink(l.size());
        System.dealloc(p, l)
    }
    unsafe fn alloc_zeroed(&self, l: Layout) -> *mut u8 {
        grow(l.size());
        System.alloc_zeroed(l)
    }
    unsafe fn realloc(&self, p: *mut u8, l: Layout, new: usize) -> *mut u8 {
        if new > l.size() {
            grow(new - l.size());
        } else {
            shrink(l.size() - new);
        }
        System.realloc(p, l, new)
    }
}
